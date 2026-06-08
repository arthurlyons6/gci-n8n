import type { User, WorkflowEntity } from '@n8n/db';
import { ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';

import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { ProjectService } from '@/services/project.service.ee';

import type { ImportedWorkflowSummary } from '../../n8n-packages.types';
import type { PreparedWorkflow, WorkflowImportOutcome } from './workflow-conflict-policy.types';
import { WorkflowPublishingPolicyApplier } from './workflow-publishing-policy.applier';
import type { WorkflowPublishingPolicy } from './workflow-publishing-policy.types';

export interface WorkflowPublishingImportRequest {
	user: User;
	projectId: string;
	publishingPolicy: WorkflowPublishingPolicy;
	prepared: PreparedWorkflow[];
	outcomes: WorkflowImportOutcome[];
	matchesBySourceWorkflowId: Map<string, WorkflowEntity>;
}

/**
 * Applies {@link WorkflowPublishingPolicy} after workflow import: permission
 * preflight, per-workflow publish/unpublish, and response summary assembly.
 */
@Service()
export class WorkflowPublishingImporter {
	constructor(
		private readonly projectRepository: ProjectRepository,
		private readonly projectService: ProjectService,
		private readonly publishingPolicyApplier: WorkflowPublishingPolicyApplier,
	) {}

	async preflight(
		user: User,
		projectId: string,
		publishingPolicy: WorkflowPublishingPolicy,
	): Promise<void> {
		if (publishingPolicy !== 'all-published') {
			return;
		}

		const project = await this.projectService.getProjectWithScope(user, projectId, [
			'workflow:publish',
		]);
		if (project) {
			return;
		}

		if (!(await this.projectRepository.existsBy({ id: projectId }))) {
			throw new NotFoundError(`Project not found: ${projectId}`);
		}
		throw new ForbiddenError('You do not have permission to publish workflows in this project.');
	}

	async applyPublishingPolicy(
		request: WorkflowPublishingImportRequest,
	): Promise<ImportedWorkflowSummary[]> {
		const preparedBySourceId = new Map(
			request.prepared.map((entry) => [entry.sourceWorkflowId, entry] as const),
		);

		const publishingResults = await this.publishingPolicyApplier.apply(
			request.outcomes,
			preparedBySourceId,
			request.matchesBySourceWorkflowId,
			request.publishingPolicy,
			request.user,
		);

		return request.outcomes.map(({ workflow, sourceWorkflowId, status }) => {
			const publishingResult = publishingResults.get(workflow.id);
			const resolvedWorkflow = publishingResult?.workflow ?? workflow;

			return {
				sourceWorkflowId,
				localId: resolvedWorkflow.id,
				name: resolvedWorkflow.name,
				projectId: request.projectId,
				parentFolderId: resolvedWorkflow.parentFolder?.id ?? null,
				active: !!resolvedWorkflow.activeVersionId,
				activeVersionId: resolvedWorkflow.activeVersionId ?? null,
				status,
			};
		});
	}
}

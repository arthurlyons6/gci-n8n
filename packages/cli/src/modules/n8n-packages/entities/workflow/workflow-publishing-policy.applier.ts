import type { User, WorkflowEntity } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from 'n8n-workflow';

import { WorkflowService } from '@/workflows/workflow.service';

import type { PreparedWorkflow, WorkflowImportOutcome } from './workflow-conflict-policy.types';
import { resolvePublishing } from './workflow-publishing-policy.resolver';
import type {
	PublishingOutcome,
	WorkflowPublishingPolicy,
} from './workflow-publishing-policy.types';

export interface WorkflowPublishingApplyResult {
	publishingOutcome: PublishingOutcome;
	workflow: WorkflowEntity;
}

@Service()
export class WorkflowPublishingPolicyApplier {
	constructor(private readonly workflowService: WorkflowService) {}

	async apply(
		outcomes: WorkflowImportOutcome[],
		preparedBySourceId: Map<string, PreparedWorkflow>,
		matchesBySourceId: Map<string, WorkflowEntity>,
		policy: WorkflowPublishingPolicy,
		user: User,
	): Promise<Map<string, WorkflowPublishingApplyResult>> {
		const results = new Map<string, WorkflowPublishingApplyResult>();

		for (const outcome of outcomes) {
			const prepared = preparedBySourceId.get(outcome.sourceWorkflowId);
			if (!prepared) {
				throw new Error(
					`Missing prepared workflow for sourceWorkflowId ${outcome.sourceWorkflowId}`,
				);
			}

			const match = matchesBySourceId.get(outcome.sourceWorkflowId) ?? null;
			const priorWasPublished = outcome.status === 'updated' && !!match?.activeVersionId;
			const currentlyPublished = !!outcome.workflow.activeVersionId;

			const { action, result } = resolvePublishing({
				policy,
				status: outcome.status,
				sourceActive: prepared.sourceActive,
				priorWasPublished,
				currentlyPublished,
				isArchived: outcome.workflow.isArchived,
			});

			let workflow = outcome.workflow;

			if (action === 'noop') {
				results.set(workflow.id, {
					publishingOutcome: { result },
					workflow,
				});
				continue;
			}

			try {
				if (action === 'publish') {
					workflow = await this.workflowService.activateWorkflow(user, workflow.id, {
						versionId: workflow.versionId,
						source: 'import',
					});
				} else {
					workflow = await this.workflowService.deactivateWorkflow(user, workflow.id, {
						source: 'import',
					});
				}

				results.set(workflow.id, {
					publishingOutcome: { result },
					workflow,
				});
			} catch (error) {
				results.set(outcome.workflow.id, {
					publishingOutcome: {
						result: 'failed',
						reason: ensureError(error).message,
					},
					workflow: outcome.workflow,
				});
			}
		}

		return results;
	}
}

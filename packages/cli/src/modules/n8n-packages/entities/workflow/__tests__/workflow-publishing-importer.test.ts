import type { Project, User } from '@n8n/db';
import { mock } from 'jest-mock-extended';

import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { ProjectService } from '@/services/project.service.ee';

import type { WorkflowPublishingPolicyApplier } from '../workflow-publishing-policy.applier';
import { WorkflowPublishingImporter } from '../workflow-publishing-importer';

// End-to-end publishing behavior (publish/unpublish/summary mapping) is covered
// by `import-pipeline.integration.test.ts`. These unit tests cover the permission
// preflight edges the integration suite can't reach (it always runs as an
// authorized owner).
describe('WorkflowPublishingImporter', () => {
	const user = mock<User>({ id: 'user-1' });
	const projectRepository = mock<{ existsBy: jest.Mock }>();
	const projectService = mock<ProjectService>();
	const publishingPolicyApplier = mock<WorkflowPublishingPolicyApplier>();
	let importer: WorkflowPublishingImporter;

	beforeEach(() => {
		jest.clearAllMocks();
		importer = new WorkflowPublishingImporter(
			projectRepository as never,
			projectService,
			publishingPolicyApplier,
		);
	});

	describe('preflight', () => {
		it('does nothing for policies other than all-published', async () => {
			await importer.preflight(user, 'project-1', 'match-source');

			expect(projectService.getProjectWithScope).not.toHaveBeenCalled();
		});

		it('passes when the user can publish in the target project', async () => {
			projectService.getProjectWithScope.mockResolvedValue(mock<Project>({ id: 'project-1' }));

			await expect(importer.preflight(user, 'project-1', 'all-published')).resolves.toBeUndefined();
		});

		it('throws ForbiddenError when the project exists but publish scope is missing', async () => {
			projectService.getProjectWithScope.mockResolvedValue(null);
			projectRepository.existsBy.mockResolvedValue(true);

			await expect(importer.preflight(user, 'project-1', 'all-published')).rejects.toThrow(
				ForbiddenError,
			);
		});

		it('throws NotFoundError when the project does not exist', async () => {
			projectService.getProjectWithScope.mockResolvedValue(null);
			projectRepository.existsBy.mockResolvedValue(false);

			await expect(importer.preflight(user, 'missing-project', 'all-published')).rejects.toThrow(
				NotFoundError,
			);
		});
	});
});

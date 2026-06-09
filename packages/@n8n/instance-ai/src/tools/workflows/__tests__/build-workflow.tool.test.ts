import { executeTool } from '../../../__tests__/tool-test-utils';
import type { InstanceAiContext } from '../../../types';
import { parseAndValidate, partitionWarnings } from '../../../workflow-builder';
import type { WorkflowBuildOutcome } from '../../../workflow-loop/workflow-loop-state';
import { createBuildWorkflowTool } from '../build-workflow.tool';
import { resolveCredentials } from '../resolve-credentials';
import { stripStaleCredentialsFromWorkflow } from '../setup-workflow.service';
import { ensureWebhookIds } from '../submit-workflow.tool';

vi.mock('../../../workflow-builder', () => ({
	parseAndValidate: vi.fn(() => ({
		workflow: {
			name: 'Generated workflow',
			nodes: [
				{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
				{ name: 'Respond to Webhook', type: 'n8n-nodes-base.respondToWebhook', parameters: {} },
			],
			connections: {
				Webhook: {
					main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]],
				},
			},
		},
		warnings: [],
	})),
	partitionWarnings: vi.fn((warnings: unknown[]) => ({ errors: [], informational: warnings })),
}));

vi.mock('../resolve-credentials', () => ({
	buildCredentialMap: vi.fn(async () => await Promise.resolve(new Map())),
	resolveCredentials: vi.fn(
		async () =>
			await Promise.resolve({
				mockedNodeNames: [],
				mockedCredentialTypes: [],
				mockedCredentialsByNode: {},
				verificationPinData: {},
				usesWorkflowPinDataForVerification: false,
			}),
	),
}));

vi.mock('../setup-workflow.service', () => ({
	stripStaleCredentialsFromWorkflow: vi.fn(async () => await Promise.resolve()),
}));

vi.mock('../submit-workflow.tool', () => ({
	ensureWebhookIds: vi.fn(async () => await Promise.resolve()),
}));

describe('createBuildWorkflowTool', () => {
	const requiredFinalActions = [
		{ description: 'respond to webhook', nodeNames: ['Respond to Webhook'] },
	];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns repair guidance for malformed Code node JavaScript', async () => {
		const warning = {
			code: 'INVALID_PARAMETER',
			nodeName: 'Normalize Contact Submission',
			message: 'Code node JavaScript failed to parse: Invalid or unexpected token',
		};
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: { name: 'Broken workflow', nodes: [], connections: {} },
			warnings: [warning],
		});
		vi.mocked(partitionWarnings).mockReturnValueOnce({
			errors: [warning],
			informational: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Broken workflow',
		});

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'[INVALID_PARAMETER] (Normalize Contact Submission): Code node JavaScript failed to parse:',
				),
				expect.stringContaining('Code node guidance: keep embedded jsCode parseable'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows direct new single-workflow builds outside a planned follow-up', async () => {
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, {
			code: 'workflow code',
			name: 'Daily Mlada Boleslav Weather to Slack',
			requiredFinalActions,
		});
		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-1',
		});
		expect(context.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Daily Mlada Boleslav Weather to Slack' }),
			{ markAsAiTemporary: true },
		);
	});

	it('requires final action contract for new main workflow builds', async () => {
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Incomplete workflow',
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([expect.stringContaining('Final action contract missing')]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects control-flow nodes as claimed terminal final actions', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Rain warning',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{ name: 'Rain Expected?', type: 'n8n-nodes-base.if', parameters: {} },
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Rain Expected?', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Rain warning',
			requiredFinalActions: [
				{ description: 'send rain warning email', nodeNames: ['Rain Expected?'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('not a terminal action node'),
				expect.stringContaining('does not match the named service/action'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects terminal final action nodes that are not reachable from a trigger', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Rain warning',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{ name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: {} },
				],
				connections: {},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Rain warning',
			requiredFinalActions: [{ description: 'send rain warning email', nodeNames: ['Send Email'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([expect.stringContaining('not reachable from any trigger')]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects new main workflows that miss terminal effects from the trusted build objective', async () => {
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective: 'I want a daily rain warning every morning by email.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Rain warning',
			requiredFinalActions,
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Trusted build objective requires the workflow to send an email'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('does not treat source-only Slack mentions as required Slack terminal effects', async () => {
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'When a webhook is called, fetch Slack channel history for analysis and respond to the webhook.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Slack source analysis',
			requiredFinalActions,
		});

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(createFromWorkflowJSON).toHaveBeenCalled();
	});

	it('does not count Slack history reads as Slack terminal post effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Fetch Slack History',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'channel', operation: 'history' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Fetch Slack History', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective: 'Every day, fetch Slack history and post the digest to a Slack channel.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Slack digest',
			requiredFinalActions: [{ description: 'post to Slack', nodeNames: ['Fetch Slack History'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining(
				'Trusted build objective requires the workflow to post or send a Slack message',
			),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('counts Slack file uploads as terminal Slack effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Webhook image upload',
				nodes: [
					{ name: 'Receive Upload', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Upload File to Slack',
						type: 'n8n-nodes-base.slack',
						parameters: {
							resource: 'file',
							operation: 'upload',
							binaryPropertyName: 'image',
							initialComment: '={{ $json.body.caption }}',
						},
					},
					{
						name: 'Respond OK',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					'Receive Upload': {
						main: [[{ node: 'Upload File to Slack', type: 'main', index: 0 }]],
					},
					'Upload File to Slack': {
						main: [[{ node: 'Respond OK', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Create a webhook that forwards an uploaded image to a Slack channel using files.upload and replies with the Slack file ID.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Webhook image upload',
			requiredFinalActions: [
				{ description: 'upload the file to Slack', nodeNames: ['Upload File to Slack'] },
				{ description: 'respond to webhook', nodeNames: ['Respond OK'] },
			],
		});

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(createFromWorkflowJSON).toHaveBeenCalled();
	});

	it('rejects independent final effect nodes without graceful error handling', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Send Auto-Reply'),
				expect.stringContaining('Notify Team'),
				expect.stringContaining('Log Submission'),
			]),
		);
		expect(result.errors).not.toEqual(
			expect.arrayContaining([expect.stringContaining('Respond Success')]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows independent final effect nodes with graceful error handling', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(createFromWorkflowJSON).toHaveBeenCalled();
	});

	it('rejects repeated independent source reads without graceful error handling', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get #general History',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Get #engineering History',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [
							[
								{ node: 'Get #general History', type: 'main', index: 0 },
								{ node: 'Get #engineering History', type: 'main', index: 0 },
							],
						],
					},
					'Get #general History': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
					'Get #engineering History': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Slack digest',
			requiredFinalActions: [{ description: 'post to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Get #general History'),
				expect.stringContaining('Get #engineering History'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects all-or-nothing validation gates before independent intake effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Valid Submission?',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								combinator: 'and',
								conditions: [
									{ leftValue: '{{ $json.body.name }}', operation: 'notEmpty' },
									{ leftValue: '{{ $json.body.email }}', operation: 'contains', rightValue: '@' },
									{ leftValue: '{{ $json.body.message }}', operation: 'notEmpty' },
								],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
					{
						name: 'Respond Invalid',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Valid Submission?', type: 'main', index: 0 }]],
					},
					'Valid Submission?': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
							[{ node: 'Respond Invalid', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake validation gate "Valid Submission?"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects intake validation gates even when final actions are under-reported', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Validate Required Fields',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								combinator: 'and',
								conditions: [
									{ leftValue: '{{ $json.name }}', operation: 'notEmpty' },
									{ leftValue: '{{ $json.email }}', operation: 'notEmpty' },
									{ leftValue: '{{ $json.message }}', operation: 'notEmpty' },
								],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
					{
						name: 'Respond Error',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Validate Required Fields', type: 'main', index: 0 }]],
					},
					'Validate Required Fields': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
							[{ node: 'Respond Error', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [{ description: 'respond to webhook', nodeNames: ['Respond Success'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake validation gate "Validate Required Fields"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('keeps intake validation guard active when updating an AI-created workflow', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Is Valid Submission',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								combinator: 'and',
								conditions: [
									{ leftValue: '{{ $json.body.name }}', operation: 'notEmpty' },
									{ leftValue: '{{ $json.body.email }}', operation: 'regex' },
									{ leftValue: '{{ $json.body.message }}', operation: 'notEmpty' },
								],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Invalid',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Is Valid Submission', type: 'main', index: 0 }]],
					},
					'Is Valid Submission': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
							],
							[{ node: 'Respond Invalid', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const updateFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			aiCreatedWorkflowIds: new Set(['wf-1']),
			workflowService: {
				updateFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { updateWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			workflowId: 'wf-1',
			code: 'workflow code',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake validation gate "Is Valid Submission"'),
		]);
		expect(updateFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects merging multiple triggers before shared external work', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Linear contribution report',
				nodes: [
					{ name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
					{ name: 'Weekly Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Trigger Merge',
						type: 'n8n-nodes-base.merge',
						parameters: { mode: 'append', numberInputs: 2 },
					},
					{
						name: 'Fetch Linear Issues',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'POST', url: 'https://api.linear.app/graphql' },
					},
					{
						name: 'Build Report',
						type: 'n8n-nodes-base.code',
						parameters: {},
					},
					{
						name: 'Post Report',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Manual Trigger': {
						main: [[{ node: 'Trigger Merge', type: 'main', index: 0 }]],
					},
					'Weekly Schedule': {
						main: [[{ node: 'Trigger Merge', type: 'main', index: 1 }]],
					},
					'Trigger Merge': {
						main: [[{ node: 'Fetch Linear Issues', type: 'main', index: 0 }]],
					},
					'Fetch Linear Issues': {
						main: [[{ node: 'Build Report', type: 'main', index: 0 }]],
					},
					'Build Report': {
						main: [[{ node: 'Post Report', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Linear contribution report',
			requiredFinalActions: [{ description: 'post report to Slack', nodeNames: ['Post Report'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multiple triggers feed Merge node "Trigger Merge"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects schedule cadence gates that can skip the only final action', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly leaderboard',
				nodes: [
					{ name: 'Bi-weekly Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Compute Fortnight',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: 'return [{ json: { isPostingFortnight: false } }];' },
					},
					{
						name: 'Is Posting Fortnight',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.isPostingFortnight }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Fetch Linear Bugs',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'POST', url: 'https://api.linear.app/graphql' },
					},
					{
						name: 'Post Leaderboard',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Bi-weekly Schedule': {
						main: [[{ node: 'Compute Fortnight', type: 'main', index: 0 }]],
					},
					'Compute Fortnight': {
						main: [[{ node: 'Is Posting Fortnight', type: 'main', index: 0 }]],
					},
					'Is Posting Fortnight': {
						main: [[{ node: 'Fetch Linear Bugs', type: 'main', index: 0 }], []],
					},
					'Fetch Linear Bugs': {
						main: [[{ node: 'Post Leaderboard', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly leaderboard',
			requiredFinalActions: [
				{ description: 'post leaderboard to Slack', nodeNames: ['Post Leaderboard'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Schedule cadence gate "Is Posting Fortnight"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects schedule cadence gates when the no-op branch is omitted', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly leaderboard',
				nodes: [
					{ name: 'Bi-weekly Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Compute Window',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode: 'return [{ json: { isFortnight: false, weeksSinceAnchor: -1 } }];',
						},
					},
					{
						name: 'Is Fortnight Week',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.isFortnight }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Fetch Linear Bugs',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'POST', url: 'https://api.linear.app/graphql' },
					},
					{
						name: 'Post Leaderboard',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Bi-weekly Schedule': {
						main: [[{ node: 'Compute Window', type: 'main', index: 0 }]],
					},
					'Compute Window': {
						main: [[{ node: 'Is Fortnight Week', type: 'main', index: 0 }]],
					},
					'Is Fortnight Week': {
						main: [[{ node: 'Fetch Linear Bugs', type: 'main', index: 0 }]],
					},
					'Fetch Linear Bugs': {
						main: [[{ node: 'Post Leaderboard', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly leaderboard',
			requiredFinalActions: [
				{ description: 'post leaderboard to Slack', nodeNames: ['Post Leaderboard'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Schedule cadence gate "Is Fortnight Week"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects schedule cadence gates that replace the required final action', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly leaderboard',
				nodes: [
					{ name: 'Bi-weekly Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Compute Window',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: 'return [{ json: { isPostingWeek: false } }];' },
					},
					{
						name: 'Is Posting Week',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.isPostingWeek }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Post Leaderboard',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
					{
						name: 'Post Skip Notice',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Bi-weekly Schedule': {
						main: [[{ node: 'Compute Window', type: 'main', index: 0 }]],
					},
					'Compute Window': {
						main: [[{ node: 'Is Posting Week', type: 'main', index: 0 }]],
					},
					'Is Posting Week': {
						main: [
							[{ node: 'Post Leaderboard', type: 'main', index: 0 }],
							[{ node: 'Post Skip Notice', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly leaderboard',
			requiredFinalActions: [
				{ description: 'post leaderboard to Slack', nodeNames: ['Post Leaderboard'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Schedule cadence gate "Is Posting Week"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects filter branches that can drop every item before a final digest action', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily API digest',
				nodes: [
					{ name: 'Daily Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Fetch Posts',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' },
					},
					{
						name: 'Keep Posts Without Qui',
						type: 'n8n-nodes-base.filter',
						parameters: {
							conditions: {
								conditions: [
									{ leftValue: '={{ $json.title }}', operation: 'notContains', rightValue: 'qui' },
								],
							},
						},
					},
					{
						name: 'Build Digest',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { message: 'Remaining posts: ' + $input.all().length } }];",
						},
					},
					{
						name: 'Post API Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Daily Schedule': {
						main: [[{ node: 'Fetch Posts', type: 'main', index: 0 }]],
					},
					'Fetch Posts': {
						main: [[{ node: 'Keep Posts Without Qui', type: 'main', index: 0 }]],
					},
					'Keep Posts Without Qui': {
						main: [[{ node: 'Build Digest', type: 'main', index: 0 }]],
					},
					'Build Digest': {
						main: [[{ node: 'Post API Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Daily, fetch posts from an API, drop posts whose title contains qui, then post a Slack message saying how many posts remain and listing each remaining title.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily API digest',
			requiredFinalActions: [
				{ description: 'post API digest to Slack', nodeNames: ['Post API Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Zero-item gate "Keep Posts Without Qui"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows final digest filters with an explicit empty fallback branch', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily API digest',
				nodes: [
					{ name: 'Daily Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Fetch Posts',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' },
					},
					{
						name: 'Keep Posts Without Qui',
						type: 'n8n-nodes-base.filter',
						parameters: {
							conditions: {
								conditions: [
									{ leftValue: '={{ $json.title }}', operation: 'notContains', rightValue: 'qui' },
								],
							},
						},
					},
					{
						name: 'Build Digest',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { message: 'Remaining posts: ' + $input.all().length } }];",
						},
					},
					{
						name: 'Post API Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
					{
						name: 'No Posts Fallback',
						type: 'n8n-nodes-base.noOp',
						parameters: {},
					},
				],
				connections: {
					'Daily Schedule': {
						main: [[{ node: 'Fetch Posts', type: 'main', index: 0 }]],
					},
					'Fetch Posts': {
						main: [[{ node: 'Keep Posts Without Qui', type: 'main', index: 0 }]],
					},
					'Keep Posts Without Qui': {
						main: [
							[{ node: 'Build Digest', type: 'main', index: 0 }],
							[{ node: 'No Posts Fallback', type: 'main', index: 0 }],
						],
					},
					'Build Digest': {
						main: [[{ node: 'Post API Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Daily, fetch posts from an API, drop posts whose title contains qui, then post a Slack message saying how many posts remain and listing each remaining title.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily API digest',
			requiredFinalActions: [
				{ description: 'post API digest to Slack', nodeNames: ['Post API Digest'] },
			],
		});

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(createFromWorkflowJSON).toHaveBeenCalled();
	});

	it('rejects direct multi-input merge into all-item aggregate before final effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Fetch General',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Fetch Engineering',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Merge Channels',
						type: 'n8n-nodes-base.merge',
						parameters: { mode: 'append', numberInputs: 2 },
					},
					{
						name: 'Collect Messages',
						type: 'n8n-nodes-base.aggregate',
						parameters: { aggregate: 'aggregateAllItemData', destinationFieldName: 'data' },
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [
							[
								{ node: 'Fetch General', type: 'main', index: 0 },
								{ node: 'Fetch Engineering', type: 'main', index: 0 },
							],
						],
					},
					'Fetch General': {
						main: [[{ node: 'Merge Channels', type: 'main', index: 0 }]],
					},
					'Fetch Engineering': {
						main: [[{ node: 'Merge Channels', type: 'main', index: 1 }]],
					},
					'Merge Channels': {
						main: [[{ node: 'Collect Messages', type: 'main', index: 0 }]],
					},
					'Collect Messages': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining(
				'Aggregate node "Collect Messages" reads directly from multi-input Merge node "Merge Channels"',
			),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects pairedItem source identity inference before final effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Tag Messages With Channel',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"const channels = ['#general', '#engineering']; return $input.all().map((item) => ({ json: { ...item.json, channel: channels[item.pairedItem.item] ?? 'unknown' } }));",
						},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Get Channel History', type: 'main', index: 0 }]],
					},
					'Get Channel History': {
						main: [[{ node: 'Tag Messages With Channel', type: 'main', index: 0 }]],
					},
					'Tag Messages With Channel': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('uses `pairedItem.item` to infer source identity'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects pairedItem source identity inference through an index variable', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Channels To Read',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"const channels = [{ channelName: '#general' }, { channelName: '#engineering' }]; return channels.map((c) => ({ json: c }));",
						},
					},
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Build Digest Input',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode: [
								'const msgs = $input.all();',
								'const channelDefs = $("Channels To Read").all().map((i) => i.json);',
								'for (const m of msgs) {',
								'  let idx = 0;',
								'  const p = m.pairedItem;',
								'  if (p && typeof p.item === "number") idx = p.item;',
								'  const def = channelDefs[idx] || channelDefs[0];',
								'  const channelName = def.channelName;',
								'}',
								"return [{ json: { transcript: 'digest' } }];",
							].join('\n'),
						},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Channels To Read', type: 'main', index: 0 }]],
					},
					'Channels To Read': {
						main: [[{ node: 'Get Channel History', type: 'main', index: 0 }]],
					},
					'Get Channel History': {
						main: [[{ node: 'Build Digest Input', type: 'main', index: 0 }]],
					},
					'Build Digest Input': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('uses `pairedItem.item` to infer source identity'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects per-source external reads without graceful error handling', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Channels To Read',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"const channels = ['C04GENERAL01', 'C04ENGINEER1', 'C04PRODUCT01']; return channels.map((channelId) => ({ json: { channelId } }));",
						},
					},
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						parameters: {
							resource: 'channel',
							operation: 'history',
							channelId: '={{ $json.channelId }}',
						},
					},
					{
						name: 'Build Digest Input',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: "return [{ json: { transcript: 'digest' } }];" },
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Channels To Read', type: 'main', index: 0 }]],
					},
					'Channels To Read': {
						main: [[{ node: 'Get Channel History', type: 'main', index: 0 }]],
					},
					'Get Channel History': {
						main: [[{ node: 'Build Digest Input', type: 'main', index: 0 }]],
					},
					'Build Digest Input': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([expect.stringContaining('reads per-source input')]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects split-in-batches loop-body collection on the final path', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Channels To Read',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"return ['C04GENERAL01', 'C04ENGINEER1', 'C04PRODUCT01'].map((channelId) => ({ json: { channelId } }));",
						},
					},
					{
						name: 'Loop Channels',
						type: 'n8n-nodes-base.splitInBatches',
						parameters: { batchSize: 1 },
					},
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: {
							resource: 'channel',
							operation: 'history',
							channelId: '={{ $json.channelId }}',
						},
					},
					{
						name: 'Collapse Channel Messages',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: "return [{ json: { channelName: '#general', messages: [] } }];" },
					},
					{
						name: 'Build Combined Prompt',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								'const channelSummaries = $("Collapse Channel Messages").all(); return [{ json: { transcript: channelSummaries.length } }];',
						},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Channels To Read', type: 'main', index: 0 }]],
					},
					'Channels To Read': {
						main: [[{ node: 'Loop Channels', type: 'main', index: 0 }]],
					},
					'Loop Channels': {
						main: [
							[{ node: 'Build Combined Prompt', type: 'main', index: 0 }],
							[{ node: 'Get Channel History', type: 'main', index: 0 }],
						],
					},
					'Get Channel History': {
						main: [[{ node: 'Collapse Channel Messages', type: 'main', index: 0 }]],
					},
					'Collapse Channel Messages': {
						main: [[{ node: 'Loop Channels', type: 'main', index: 0 }]],
					},
					'Build Combined Prompt': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([expect.stringContaining('Split In Batches')]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects split-in-batches source loops that feed the final digest from the done branch', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Channels To Read',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"return ['C04GENERAL01', 'C04ENGINEER1', 'C04PRODUCT01'].map((channelId) => ({ json: { channelId } }));",
						},
					},
					{
						name: 'Loop Over Channels',
						type: 'n8n-nodes-base.splitInBatches',
						parameters: { batchSize: 1 },
					},
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: {
							resource: 'channel',
							operation: 'history',
							channelId: '={{ $json.channelId }}',
						},
					},
					{
						name: 'Collapse Channel Messages',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return [{ json: { transcript: $input.all().length } }];',
						},
					},
					{
						name: 'Build Digest Prompt',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { prompt: 'summary ' + $input.all().length } }];",
						},
					},
					{
						name: 'Summarize Channels',
						type: '@n8n/n8n-nodes-langchain.chainLlm',
						parameters: {},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Channels To Read', type: 'main', index: 0 }]],
					},
					'Channels To Read': {
						main: [[{ node: 'Loop Over Channels', type: 'main', index: 0 }]],
					},
					'Loop Over Channels': {
						main: [
							[{ node: 'Build Digest Prompt', type: 'main', index: 0 }],
							[{ node: 'Get Channel History', type: 'main', index: 0 }],
						],
					},
					'Get Channel History': {
						main: [[{ node: 'Collapse Channel Messages', type: 'main', index: 0 }]],
					},
					'Collapse Channel Messages': {
						main: [[{ node: 'Loop Over Channels', type: 'main', index: 0 }]],
					},
					'Build Digest Prompt': {
						main: [[{ node: 'Summarize Channels', type: 'main', index: 0 }]],
					},
					'Summarize Channels': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'loops over external source reads and sends its done branch into a final digest/report path',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects split-in-batches workflows with work wired only to the done output', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'GitHub bugs to Notion',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Normalize GitHub Issues',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return $input.all();',
						},
					},
					{
						name: 'Loop Each Bug',
						type: 'n8n-nodes-base.splitInBatches',
						parameters: { batchSize: 1 },
					},
					{
						name: 'Find Existing Page',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'getAll' },
					},
					{
						name: 'Create Bug Page',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'create' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Normalize GitHub Issues', type: 'main', index: 0 }]],
					},
					'Normalize GitHub Issues': {
						main: [[{ node: 'Loop Each Bug', type: 'main', index: 0 }]],
					},
					'Loop Each Bug': {
						main: [[{ node: 'Find Existing Page', type: 'main', index: 0 }], []],
					},
					'Find Existing Page': {
						main: [[{ node: 'Create Bug Page', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'GitHub bugs to Notion',
			requiredFinalActions: [
				{ description: 'create Notion pages for new GitHub bugs', nodeNames: ['Create Bug Page'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('wires work from output 0 (done) while output 1 (loop/each batch)'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects Notion existence lookups that can drop source items before create', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'GitHub bugs to Notion',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Normalize GitHub Issues',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return $input.all();',
						},
					},
					{
						name: 'Find Existing Page',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'getAll', returnAll: false },
					},
					{
						name: 'Page Does Not Exist',
						type: 'n8n-nodes-base.if',
						parameters: { conditions: {} },
					},
					{
						name: 'Create Bug Page',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'create' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Normalize GitHub Issues', type: 'main', index: 0 }]],
					},
					'Normalize GitHub Issues': {
						main: [[{ node: 'Find Existing Page', type: 'main', index: 0 }]],
					},
					'Find Existing Page': {
						main: [[{ node: 'Page Does Not Exist', type: 'main', index: 0 }]],
					},
					'Page Does Not Exist': {
						main: [[{ node: 'Create Bug Page', type: 'main', index: 0 }], []],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'GitHub bugs to Notion',
			requiredFinalActions: [
				{ description: 'create Notion pages for new GitHub bugs', nodeNames: ['Create Bug Page'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Notion lookup "Find Existing Page" feeds gate'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects SQL merges that select only one input before create/update actions', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'GitHub bugs to Notion',
				nodes: [
					{ name: 'Daily 9am', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Fetch Open Bugs',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { method: 'GET', url: 'https://api.github.com/repos/acme/backend/issues' },
					},
					{
						name: 'Normalize Bugs',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return $input.all().map(item => ({ json: item.json }));',
						},
					},
					{
						name: 'Fetch Existing Notion Pages',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'getAll' },
					},
					{
						name: 'Combine Bugs + Existing',
						type: 'n8n-nodes-base.merge',
						parameters: {
							mode: 'combine',
							combineBy: 'combineBySql',
							query: 'SELECT * FROM input1',
						},
					},
					{
						name: 'Flag Already In Notion',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode:
								'return $input.all().map(item => ({ json: { ...item.json, exists: false } }));',
						},
					},
					{
						name: 'Is New Bug?',
						type: 'n8n-nodes-base.if',
						parameters: { conditions: {} },
					},
					{
						name: 'Create Bug Page',
						type: 'n8n-nodes-base.notion',
						parameters: { resource: 'databasePage', operation: 'create' },
					},
				],
				connections: {
					'Daily 9am': {
						main: [
							[
								{ node: 'Fetch Open Bugs', type: 'main', index: 0 },
								{ node: 'Fetch Existing Notion Pages', type: 'main', index: 0 },
							],
						],
					},
					'Fetch Open Bugs': {
						main: [[{ node: 'Normalize Bugs', type: 'main', index: 0 }]],
					},
					'Normalize Bugs': {
						main: [[{ node: 'Combine Bugs + Existing', type: 'main', index: 0 }]],
					},
					'Fetch Existing Notion Pages': {
						main: [[{ node: 'Combine Bugs + Existing', type: 'main', index: 1 }]],
					},
					'Combine Bugs + Existing': {
						main: [[{ node: 'Flag Already In Notion', type: 'main', index: 0 }]],
					},
					'Flag Already In Notion': {
						main: [[{ node: 'Is New Bug?', type: 'main', index: 0 }]],
					},
					'Is New Bug?': {
						main: [[{ node: 'Create Bug Page', type: 'main', index: 0 }], []],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'GitHub bugs to Notion',
			requiredFinalActions: [
				{ description: 'create Notion pages for new GitHub bugs', nodeNames: ['Create Bug Page'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'Merge node "Combine Bugs + Existing" uses a SQL query that selects only input1',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects email digest empty branches placed after a zero-item Gmail read', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Gmail action digest',
				nodes: [
					{ name: 'Every Morning', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get Last 24h Emails',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'getAll' },
					},
					{
						name: 'Any Emails?',
						type: 'n8n-nodes-base.if',
						parameters: { conditions: { leftValue: '={{ $items().length }}' } },
					},
					{
						name: 'Compile Email Text',
						type: 'n8n-nodes-base.code',
						parameters: { mode: 'runOnceForAllItems', jsCode: 'return $input.all();' },
					},
					{
						name: 'No Emails Digest',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: {
								assignments: [{ name: 'digest', value: 'No action needed today.' }],
							},
						},
					},
					{
						name: 'Send Digest Email',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Every Morning': {
						main: [[{ node: 'Get Last 24h Emails', type: 'main', index: 0 }]],
					},
					'Get Last 24h Emails': {
						main: [[{ node: 'Any Emails?', type: 'main', index: 0 }]],
					},
					'Any Emails?': {
						main: [
							[{ node: 'Compile Email Text', type: 'main', index: 0 }],
							[{ node: 'No Emails Digest', type: 'main', index: 0 }],
						],
					},
					'Compile Email Text': {
						main: [[{ node: 'Send Digest Email', type: 'main', index: 0 }]],
					},
					'No Emails Digest': {
						main: [[{ node: 'Send Digest Email', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				buildObjective:
					'Every morning, read Gmail emails from the last 24 hours and send me a structured daily digest email of action items.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Gmail action digest',
			requiredFinalActions: [
				{ description: 'send daily digest email', nodeNames: ['Send Digest Email'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'Email digest source "Get Last 24h Emails" feeds zero-input-sensitive node "Any Emails?"',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects linear email digest processors placed directly after a zero-item Gmail read', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Gmail action digest',
				nodes: [
					{ name: 'Every Morning', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get Recent Emails',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'getAll' },
					},
					{
						name: 'Build Email Context',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode: "return [{ json: { digest: 'No recent email needs attention today.' } }];",
						},
					},
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.chainLlm',
						parameters: {},
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Every Morning': {
						main: [[{ node: 'Get Recent Emails', type: 'main', index: 0 }]],
					},
					'Get Recent Emails': {
						main: [[{ node: 'Build Email Context', type: 'main', index: 0 }]],
					},
					'Build Email Context': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				buildObjective:
					'Every morning, read Gmail emails from the last 24 hours and send me a structured daily digest email of action items.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Gmail action digest',
			requiredFinalActions: [
				{ description: 'send daily digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'Email digest source "Get Recent Emails" feeds zero-input-sensitive node "Build Email Context"',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects parallel source branches feeding a code aggregator without merge', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get #general History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Get #engineering History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Get #product History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Tag #general',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: { assignments: [{ name: 'channelName', value: '#general' }] },
						},
					},
					{
						name: 'Tag #engineering',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: { assignments: [{ name: 'channelName', value: '#engineering' }] },
						},
					},
					{
						name: 'Tag #product',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: { assignments: [{ name: 'channelName', value: '#product' }] },
						},
					},
					{
						name: 'Build Transcript',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: 'return [{ json: { transcript: $input.all().length } }];' },
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [
							[{ node: 'Get #general History', type: 'main', index: 0 }],
							[{ node: 'Get #engineering History', type: 'main', index: 0 }],
							[{ node: 'Get #product History', type: 'main', index: 0 }],
						],
					},
					'Get #general History': {
						main: [[{ node: 'Tag #general', type: 'main', index: 0 }]],
					},
					'Get #engineering History': {
						main: [[{ node: 'Tag #engineering', type: 'main', index: 0 }]],
					},
					'Get #product History': {
						main: [[{ node: 'Tag #product', type: 'main', index: 0 }]],
					},
					'Tag #general': {
						main: [[{ node: 'Build Transcript', type: 'main', index: 0 }]],
					},
					'Tag #engineering': {
						main: [[{ node: 'Build Transcript', type: 'main', index: 0 }]],
					},
					'Tag #product': {
						main: [[{ node: 'Build Transcript', type: 'main', index: 0 }]],
					},
					'Build Transcript': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([expect.stringContaining('without a Merge or Aggregate')]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects source-list item references after external fan-out reads', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Channels To Read',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"return [{ json: { channelId: 'C04GENERAL01', channelName: '#general' } }, { json: { channelId: 'C04ENGINEER1', channelName: '#engineering' } }];",
						},
					},
					{
						name: 'Get Channel History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueErrorOutput',
						parameters: {
							resource: 'channel',
							operation: 'history',
							channelId: '={{ $json.channelId }}',
						},
					},
					{
						name: 'Stamp Channel Success',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: {
								assignments: [
									{
										name: 'channelName',
										value: '={{ $("Channels To Read").item.json.channelName }}',
									},
								],
							},
						},
					},
					{
						name: 'Channel Fetch Failed',
						type: 'n8n-nodes-base.set',
						parameters: {
							assignments: {
								assignments: [
									{
										name: 'channelName',
										value: '={{ $("Channels To Read").item.json.channelName }}',
									},
								],
							},
						},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Channels To Read', type: 'main', index: 0 }]],
					},
					'Channels To Read': {
						main: [[{ node: 'Get Channel History', type: 'main', index: 0 }]],
					},
					'Get Channel History': {
						main: [
							[{ node: 'Stamp Channel Success', type: 'main', index: 0 }],
							[{ node: 'Channel Fetch Failed', type: 'main', index: 0 }],
						],
					},
					'Stamp Channel Success': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
					'Channel Fetch Failed': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("reads source identity from `$('Channels To Read').item.json...`"),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects executeOnce on all-items Code aggregators after multi-input merge', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get #general History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Get #engineering History',
						type: 'n8n-nodes-base.slack',
						onError: 'continueRegularOutput',
						parameters: { resource: 'channel', operation: 'history' },
					},
					{
						name: 'Merge Channels',
						type: 'n8n-nodes-base.merge',
						parameters: { mode: 'append', numberInputs: 2 },
					},
					{
						name: 'Build Transcript',
						type: 'n8n-nodes-base.code',
						executeOnce: true,
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode:
								"const items = $input.all(); return [{ json: { transcript: 'messages: ' + items.length } }];",
						},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [
							[
								{ node: 'Get #general History', type: 'main', index: 0 },
								{ node: 'Get #engineering History', type: 'main', index: 0 },
							],
						],
					},
					'Get #general History': {
						main: [[{ node: 'Merge Channels', type: 'main', index: 0 }]],
					},
					'Get #engineering History': {
						main: [[{ node: 'Merge Channels', type: 'main', index: 1 }]],
					},
					'Merge Channels': {
						main: [[{ node: 'Build Transcript', type: 'main', index: 0 }]],
					},
					'Build Transcript': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining(
				'Code node "Build Transcript" has `executeOnce` enabled after multi-input Merge node "Merge Channels"',
			),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects report workflows that omit required external data sources from the objective', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly team engagement ranking',
				nodes: [
					{ name: 'Every Monday 09:00', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Build Ranking',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { message: 'Everyone: 0 tickets (0 execs, 0 hours)' } }];",
						},
					},
					{
						name: 'Post Ranking to Slack',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Every Monday 09:00': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 0 }]],
					},
					'Build Ranking': {
						main: [[{ node: 'Post Ranking to Slack', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Post a bi-weekly Slack ranking using Linear bug tickets and BigQuery usage hours and execs.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly team engagement ranking',
			requiredFinalActions: [
				{ description: 'post ranking to Slack', nodeNames: ['Post Ranking to Slack'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('depends on Linear issue or bug data'),
				expect.stringContaining('depends on BigQuery usage data'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects report merge inputs that are not fed by required external source results', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly team engagement ranking',
				nodes: [
					{ name: 'Every Monday 09:00', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Is Posting Week',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: { conditions: [{ leftValue: '={{ $json.isPostingWeek }}' }] },
						},
					},
					{
						name: 'Query BigQuery Usage',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { url: 'https://bigquery.googleapis.com/bigquery/v2/projects/p/queries' },
					},
					{
						name: 'Fetch Linear Bugs',
						type: 'n8n-nodes-base.httpRequest',
						parameters: {
							url: 'https://api.linear.app/graphql',
							body: 'issues { nodes { title } }',
						},
					},
					{
						name: 'Combine Sources',
						type: 'n8n-nodes-base.merge',
						parameters: { mode: 'combine', combineBy: 'combineByPosition', numberInputs: 2 },
					},
					{
						name: 'Build Ranking',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { message: 'Everyone: 0 tickets (0 execs, 0 hours)' } }];",
						},
					},
					{
						name: 'Post Ranking to Slack',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Every Monday 09:00': {
						main: [[{ node: 'Is Posting Week', type: 'main', index: 0 }]],
					},
					'Is Posting Week': {
						main: [
							[
								{ node: 'Query BigQuery Usage', type: 'main', index: 0 },
								{ node: 'Fetch Linear Bugs', type: 'main', index: 0 },
								{ node: 'Combine Sources', type: 'main', index: 0 },
								{ node: 'Combine Sources', type: 'main', index: 1 },
							],
							[],
						],
					},
					'Combine Sources': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 0 }]],
					},
					'Query BigQuery Usage': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 0 }]],
					},
					'Fetch Linear Bugs': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 1 }]],
					},
					'Build Ranking': {
						main: [[{ node: 'Post Ranking to Slack', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Post a bi-weekly Slack ranking using Linear bug tickets and BigQuery usage hours and execs.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly team engagement ranking',
			requiredFinalActions: [
				{ description: 'post ranking to Slack', nodeNames: ['Post Ranking to Slack'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'Merge node "Combine Sources" feeds a final report/ranking/post but its inputs are not fed by required',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects source-specific consumers wired from schedule gates instead of source reads', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Bi-weekly team engagement ranking',
				nodes: [
					{ name: 'Every Monday 09:00', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Is Reporting Week',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: { conditions: [{ leftValue: '={{ $json.isReportingWeek }}' }] },
						},
					},
					{
						name: 'Get Linear Bugs',
						type: 'n8n-nodes-base.httpRequest',
						parameters: {
							url: 'https://api.linear.app/graphql',
							body: 'issues { nodes { title } }',
						},
					},
					{
						name: 'Get n8n Usage',
						type: 'n8n-nodes-base.httpRequest',
						parameters: { url: 'https://bigquery.googleapis.com/bigquery/v2/projects/p/queries' },
					},
					{
						name: 'Count Linear Bugs',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return [{ json: { bugsByUser: {} } }];',
						},
					},
					{
						name: 'Normalize Usage',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: 'return [{ json: { execsByUser: {} } }];',
						},
					},
					{
						name: 'Build Ranking',
						type: 'n8n-nodes-base.code',
						parameters: {
							mode: 'runOnceForAllItems',
							jsCode: "return [{ json: { message: 'Everyone: 0 tickets (0 execs, 0 hours)' } }];",
						},
					},
					{
						name: 'Post Ranking to Slack',
						type: 'n8n-nodes-base.slack',
						parameters: { resource: 'message', operation: 'post' },
					},
				],
				connections: {
					'Every Monday 09:00': {
						main: [[{ node: 'Is Reporting Week', type: 'main', index: 0 }]],
					},
					'Is Reporting Week': {
						main: [
							[
								{ node: 'Get Linear Bugs', type: 'main', index: 0 },
								{ node: 'Get n8n Usage', type: 'main', index: 0 },
								{ node: 'Count Linear Bugs', type: 'main', index: 0 },
								{ node: 'Normalize Usage', type: 'main', index: 0 },
							],
							[],
						],
					},
					'Count Linear Bugs': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 0 }]],
					},
					'Normalize Usage': {
						main: [[{ node: 'Build Ranking', type: 'main', index: 1 }]],
					},
					'Build Ranking': {
						main: [[{ node: 'Post Ranking to Slack', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'build-run-1',
				workItemId: 'wi-1',
				buildObjective:
					'Post a bi-weekly Slack ranking using Linear bug tickets and BigQuery usage hours and execs.',
			},
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Bi-weekly team engagement ranking',
			requiredFinalActions: [
				{ description: 'post ranking to Slack', nodeNames: ['Post Ranking to Slack'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Node "Normalize Usage" appears to consume BigQuery usage data'),
				expect.stringContaining('source-specific counters, normalizers, and aggregators'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects LLM Chain output reads through a non-existent response envelope', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily Slack digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Build Digest Prompt',
						type: 'n8n-nodes-base.code',
						parameters: { jsCode: "return [{ json: { prompt: 'summarize channels' } }];" },
					},
					{
						name: 'Summarize Channels',
						type: '@n8n/n8n-nodes-langchain.chainLlm',
						parameters: {},
					},
					{
						name: 'Post Digest',
						type: 'n8n-nodes-base.slack',
						parameters: {
							resource: 'message',
							operation: 'post',
							text: '={{ "*Daily Slack Digest*\\n\\n" + $json.response.text }}',
						},
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Build Digest Prompt', type: 'main', index: 0 }]],
					},
					'Build Digest Prompt': {
						main: [[{ node: 'Summarize Channels', type: 'main', index: 0 }]],
					},
					'Summarize Channels': {
						main: [[{ node: 'Post Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily Slack digest',
			requiredFinalActions: [{ description: 'post digest to Slack', nodeNames: ['Post Digest'] }],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'reads `$json.response.text` directly after LLM Chain node "Summarize Channels"',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects OpenAI Responses output reads through non-existent top-level text fields', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily email digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Get Recent Emails',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'getAll' },
					},
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.openAi',
						parameters: { resource: 'text', operation: 'response', simplify: true },
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: {
							resource: 'message',
							operation: 'send',
							message: '={{ $json.text }}',
						},
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Get Recent Emails', type: 'main', index: 0 }]],
					},
					'Get Recent Emails': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily email digest',
			requiredFinalActions: [
				{ description: 'send digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'reads `$json.text`, `$json.content`, or `$json.message` directly after OpenAI Responses node "Extract & Prioritize"',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects Code nodes that parse OpenAI Responses output from top-level fallback fields', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily email digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.openAi',
						parameters: { resource: 'text', operation: 'response', simplify: true },
					},
					{
						name: 'Build Digest HTML',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								'const raw = $json.text || $json.content || $json.message || ""; return [{ json: { html: String(raw) } }];',
						},
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Build Digest HTML', type: 'main', index: 0 }]],
					},
					'Build Digest HTML': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily email digest',
			requiredFinalActions: [
				{ description: 'send digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'reads `$json.text`, `$json.content`, or `$json.message` directly after OpenAI Responses node "Extract & Prioritize"',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects Code nodes that JSON.parse OpenAI Responses content without a string guard', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily email digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.openAi',
						parameters: { resource: 'text', operation: 'response', simplify: true },
					},
					{
						name: 'Build Digest HTML',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode: [
								'const raw = $input.first().json.output[0].content[0].text;',
								'const digest = JSON.parse(raw);',
								'return [{ json: { html: digest.summary, count: digest.actionItems.length } }];',
							].join('\n'),
						},
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Build Digest HTML', type: 'main', index: 0 }]],
					},
					'Build Digest HTML': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily email digest',
			requiredFinalActions: [
				{ description: 'send digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'parses OpenAI Responses content from `$json.output[0].content[0].text` with `JSON.parse`',
				),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows Code nodes that type-guard OpenAI Responses content before JSON.parse', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily email digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.openAi',
						parameters: { resource: 'text', operation: 'response', simplify: true },
					},
					{
						name: 'Build Digest HTML',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode: [
								'const raw = $input.first().json.output[0].content[0].text;',
								"const digest = typeof raw === 'string' ? JSON.parse(raw) : raw;",
								'return [{ json: { html: digest.summary, count: digest.actionItems.length } }];',
							].join('\n'),
						},
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Build Digest HTML', type: 'main', index: 0 }]],
					},
					'Build Digest HTML': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily email digest',
			requiredFinalActions: [
				{ description: 'send digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: true });
		expect(createFromWorkflowJSON).toHaveBeenCalledOnce();
	});

	it('rejects OpenAI Responses prompt content that mixes leading equals with interpolation', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Daily email digest',
				nodes: [
					{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
					{
						name: 'Build Email Context',
						type: 'n8n-nodes-base.code',
						parameters: {
							jsCode:
								"return [{ json: { emailCount: 0, emailsText: 'No emails were received.' } }];",
						},
					},
					{
						name: 'Extract & Prioritize',
						type: '@n8n/n8n-nodes-langchain.openAi',
						parameters: {
							resource: 'text',
							operation: 'response',
							simplify: true,
							messages: {
								values: [
									{
										role: 'user',
										content: '=Here are {{ $json.emailCount }} emails:\n\n{{ $json.emailsText }}',
									},
								],
							},
						},
					},
					{
						name: 'Send Daily Digest',
						type: 'n8n-nodes-base.gmail',
						parameters: { resource: 'message', operation: 'send' },
					},
				],
				connections: {
					'Schedule Trigger': {
						main: [[{ node: 'Build Email Context', type: 'main', index: 0 }]],
					},
					'Build Email Context': {
						main: [[{ node: 'Extract & Prioritize', type: 'main', index: 0 }]],
					},
					'Extract & Prioritize': {
						main: [[{ node: 'Send Daily Digest', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Daily email digest',
			requiredFinalActions: [
				{ description: 'send digest email', nodeNames: ['Send Daily Digest'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('uses mixed prompt expression syntax like `=text {{ ... }}`'),
			]),
		);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects Google Sheets resource-mapper writes directly from webhook body fields', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact form handler',
				nodes: [
					{ name: 'Contact Form Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Log to Google Sheets',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: {
							resource: 'sheet',
							operation: 'append',
							columns: {
								mappingMode: 'defineBelow',
								value: {
									Name: '={{ $json.body.name }}',
									Email: '={{ $json.body.email }}',
									Message: '={{ $json.body.message }}',
								},
								schema: [
									{ id: 'Name', displayName: 'Name', type: 'string' },
									{ id: 'Email', displayName: 'Email', type: 'string' },
									{ id: 'Message', displayName: 'Message', type: 'string' },
								],
							},
						},
					},
				],
				connections: {
					'Contact Form Webhook': {
						main: [[{ node: 'Log to Google Sheets', type: 'main', index: 0 }]],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact form handler',
			requiredFinalActions: [
				{ description: 'log submission to Google Sheets', nodeNames: ['Log to Google Sheets'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('maps resource-mapper columns from nested `$json.body...` fields'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows intake workflows that gate only whole-payload usability before per-effect handling', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Has Usable Contact Details?',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.hasUsableContact }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
					{
						name: 'Respond Invalid',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Has Usable Contact Details?', type: 'main', index: 0 }]],
					},
					'Has Usable Contact Details?': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
							[{ node: 'Respond Invalid', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(createFromWorkflowJSON).toHaveBeenCalled();
	});

	it('rejects content-field gates that block only some required intake effects', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{ name: 'Normalize Submission', type: 'n8n-nodes-base.set', parameters: {} },
					{
						name: 'Has Name & Message?',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.hasContent }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
					{
						name: 'Respond Invalid',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Normalize Submission', type: 'main', index: 0 }]],
					},
					'Normalize Submission': {
						main: [
							[
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Has Name & Message?', type: 'main', index: 0 },
							],
						],
					},
					'Has Name & Message?': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
							[{ node: 'Respond Invalid', type: 'main', index: 0 }],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake content gate "Has Name & Message?"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects email eligibility gates that also require optional message content', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Valid Email?',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								combinator: 'and',
								conditions: [
									{ leftValue: '{{ $json.email }}', operation: 'regex' },
									{ leftValue: '{{ $json.message }}', operation: 'notEmpty' },
								],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [
							[
								{ node: 'Valid Email?', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
						],
					},
					'Valid Email?': {
						main: [[{ node: 'Send Auto-Reply', type: 'main', index: 0 }], []],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake content gate "Valid Email?"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects generic validity flags used as per-effect gates', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Has Valid Email?',
						type: 'n8n-nodes-base.if',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.isValid }}', operation: 'true' }],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
					{
						name: 'Respond Success',
						type: 'n8n-nodes-base.respondToWebhook',
						parameters: {},
					},
				],
				connections: {
					Webhook: {
						main: [
							[
								{ node: 'Has Valid Email?', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
								{ node: 'Respond Success', type: 'main', index: 0 },
							],
						],
					},
					'Has Valid Email?': {
						main: [[{ node: 'Send Auto-Reply', type: 'main', index: 0 }], []],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
				{ description: 'respond to webhook', nodeNames: ['Respond Success'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake content gate "Has Valid Email?"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects filter validation gates with omitted unmatched output', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{
						name: 'Valid Email?',
						type: 'n8n-nodes-base.filter',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.email }}', operation: 'regex' }],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Valid Email?', type: 'main', index: 0 }]],
					},
					'Valid Email?': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
							],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake validation gate "Valid Email?"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('rejects filter content gates with omitted unmatched output', async () => {
		vi.mocked(parseAndValidate).mockReturnValueOnce({
			workflow: {
				name: 'Contact handler',
				nodes: [
					{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
					{ name: 'Normalize Submission', type: 'n8n-nodes-base.set', parameters: {} },
					{
						name: 'Has Name And Message',
						type: 'n8n-nodes-base.filter',
						parameters: {
							conditions: {
								conditions: [{ leftValue: '{{ $json.message }}', operation: 'notEmpty' }],
							},
						},
					},
					{
						name: 'Send Auto-Reply',
						type: 'n8n-nodes-base.gmail',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'send' },
					},
					{
						name: 'Notify Team',
						type: 'n8n-nodes-base.telegram',
						onError: 'continueRegularOutput',
						parameters: { resource: 'message', operation: 'sendMessage' },
					},
					{
						name: 'Log Submission',
						type: 'n8n-nodes-base.googleSheets',
						onError: 'continueRegularOutput',
						parameters: { resource: 'sheet', operation: 'append' },
					},
				],
				connections: {
					Webhook: {
						main: [[{ node: 'Normalize Submission', type: 'main', index: 0 }]],
					},
					'Normalize Submission': {
						main: [
							[
								{ node: 'Send Auto-Reply', type: 'main', index: 0 },
								{ node: 'Has Name And Message', type: 'main', index: 0 },
							],
						],
					},
					'Has Name And Message': {
						main: [
							[
								{ node: 'Notify Team', type: 'main', index: 0 },
								{ node: 'Log Submission', type: 'main', index: 0 },
							],
						],
					},
				},
			},
			warnings: [],
		});
		const createFromWorkflowJSON = vi.fn(async () => await Promise.resolve({ id: 'wf-1' }));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON,
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const result = await executeTool(createBuildWorkflowTool(context), {
			code: 'workflow code',
			name: 'Contact handler',
			requiredFinalActions: [
				{ description: 'send auto-reply email', nodeNames: ['Send Auto-Reply'] },
				{ description: 'notify team on Telegram', nodeNames: ['Notify Team'] },
				{ description: 'log submission to Google Sheets', nodeNames: ['Log Submission'] },
			],
		});

		expect(result).toMatchObject({ success: false });
		expect(result.errors).toEqual([
			expect.stringContaining('Multi-effect intake content gate "Has Name And Message"'),
		]);
		expect(createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('allows direct new workflow builds without a name parameter when code provides one', async () => {
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, { code: 'workflow code', requiredFinalActions });

		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-1',
		});
		expect(context.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Generated workflow' }),
			{ markAsAiTemporary: true },
		);
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-1');
	});

	it('suspends existing workflow edits before saving by default', async () => {
		const context = {
			workflowService: {
				getAsWorkflowJSON: async () => await Promise.resolve({ name: 'Target workflow' }),
				updateFromWorkflowJSON: () => {
					throw new Error('should not update workflow');
				},
			},
			permissions: { updateWorkflow: 'require_approval' },
		} as unknown as InstanceAiContext;
		let suspension: unknown;
		const suspend = async (request: unknown) => {
			suspension = request;
			return await Promise.reject(new Error('suspended'));
		};

		await expect(
			executeTool(
				createBuildWorkflowTool(context),
				{ workflowId: 'wf-1', code: 'workflow code' },
				{ suspend },
			),
		).rejects.toThrow('suspended');

		expect(suspension).toEqual(
			expect.objectContaining({
				message: 'Edit Target workflow (ID: wf-1)?',
				severity: 'warning',
			}),
		);
	});

	it('allows new workflow builds during post-plan follow-up repairs', async () => {
		const reportBuildOutcome = vi.fn(
			async () => await Promise.resolve({ type: 'verify' as const, workflowId: 'wf-1' }),
		);
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-1',
				allowPostPlanWorkflowCreate: true,
				workflowTaskService: {
					reportBuildOutcome,
				},
			},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, { code: 'workflow code', requiredFinalActions });

		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-1',
			workItemId: 'wi-1',
		});
		expect(context.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Generated workflow' }),
			{ markAsAiTemporary: true },
		);
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-1');
		expect(reportBuildOutcome).toHaveBeenCalledWith(
			expect.objectContaining<Partial<WorkflowBuildOutcome>>({
				workItemId: 'wi-1',
				owner: { type: 'direct' },
				workflowId: 'wf-1',
				submitted: true,
			}),
		);
	});

	it('updates existing workflows during post-plan follow-ups without redundant approval', async () => {
		const reportBuildOutcome = vi.fn(
			async () => await Promise.resolve({ type: 'verify' as const, workflowId: 'wf-1' }),
		);
		const suspend = vi.fn();
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				updateFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-1',
				allowPostPlanWorkflowCreate: true,
				workflowTaskService: {
					reportBuildOutcome,
				},
			},
			permissions: { updateWorkflow: 'ask' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(
			tool,
			{ workflowId: 'wf-1', code: 'workflow code' },
			{ suspend },
		);

		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-1',
			workItemId: 'wi-1',
		});
		expect(suspend).not.toHaveBeenCalled();
		expect(context.workflowService.updateFromWorkflowJSON).toHaveBeenCalledWith(
			'wf-1',
			expect.objectContaining({ name: 'Generated workflow' }),
			undefined,
		);
		expect(reportBuildOutcome).toHaveBeenCalledWith(
			expect.objectContaining<Partial<WorkflowBuildOutcome>>({
				workItemId: 'wi-1',
				workflowId: 'wf-1',
				submitted: true,
			}),
		);
	});

	it('does not finalize the planned task when saving a supporting workflow', async () => {
		const reportBuildOutcome = vi.fn<
			(outcome: WorkflowBuildOutcome) => Promise<{ type: 'verify'; workflowId: string }>
		>(async () => await Promise.resolve({ type: 'verify', workflowId: 'wf-support' }));
		const markSucceeded = vi.fn(async () => await Promise.resolve(null));
		const onBuildOutcome = vi.fn();
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-support' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-main',
				plannedTaskService: {
					markSucceeded,
				},
				workflowTaskService: {
					reportBuildOutcome,
				},
				onBuildOutcome,
			},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, {
			code: 'workflow code',
			isSupportingWorkflow: true,
		});
		const supportingWorkItemId = result.workItemId;

		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-support',
			isSupportingWorkflow: true,
		});
		expect(typeof supportingWorkItemId).toBe('string');
		expect(supportingWorkItemId).not.toBe('wi-main');
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-support');
		expect(onBuildOutcome).not.toHaveBeenCalled();
		expect(markSucceeded).not.toHaveBeenCalled();
		const reportedOutcome = reportBuildOutcome.mock.calls[0]?.[0];
		expect(reportedOutcome).toMatchObject({
			workItemId: supportingWorkItemId,
			owner: { type: 'direct' },
			workflowId: 'wf-support',
			submitted: true,
		});
		expect(reportedOutcome?.taskId).toEqual(expect.stringMatching(/^task-1:supporting-/));
		expect(reportedOutcome?.plannedTaskId).toBeUndefined();
	});

	it('finalizes the planned task when the task deliverable is a supporting workflow', async () => {
		const reportBuildOutcome = vi.fn<
			(outcome: WorkflowBuildOutcome) => Promise<{ type: 'verify'; workflowId: string }>
		>(async () => await Promise.resolve({ type: 'verify', workflowId: 'wf-support' }));
		const markSucceeded = vi.fn<
			(
				threadId: string,
				taskId: string,
				update: { result?: string; outcome?: WorkflowBuildOutcome },
			) => Promise<null>
		>(async () => await Promise.resolve(null));
		const onBuildOutcome = vi.fn();
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-support' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-main',
				isSupportingWorkflowTask: true,
				plannedTaskService: {
					markSucceeded,
				},
				workflowTaskService: {
					reportBuildOutcome,
				},
				onBuildOutcome,
			},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, {
			code: 'workflow code',
			isSupportingWorkflow: true,
		});

		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-support',
			workItemId: 'wi-main',
			isSupportingWorkflow: true,
		});
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-support');
		expect(onBuildOutcome).toHaveBeenCalledWith(
			expect.objectContaining<Partial<WorkflowBuildOutcome>>({
				workItemId: 'wi-main',
				taskId: 'task-1',
				owner: { type: 'planned', taskId: 'task-1' },
				plannedTaskId: 'task-1',
				workflowId: 'wf-support',
				submitted: true,
			}),
		);
		expect(reportBuildOutcome).toHaveBeenCalledWith(
			expect.objectContaining<Partial<WorkflowBuildOutcome>>({
				workItemId: 'wi-main',
				taskId: 'task-1',
				owner: { type: 'planned', taskId: 'task-1' },
				plannedTaskId: 'task-1',
				workflowId: 'wf-support',
				submitted: true,
			}),
		);
		expect(markSucceeded).toHaveBeenCalledWith('thread-1', 'task-1', expect.any(Object));
		const succeededUpdate = markSucceeded.mock.calls[0]?.[2];
		expect(succeededUpdate?.result).toBe(
			'Created supporting workflow "Generated workflow" (wf-support).',
		);
		expect(succeededUpdate?.outcome).toMatchObject({
			workItemId: 'wi-main',
			taskId: 'task-1',
			owner: { type: 'planned', taskId: 'task-1' },
			plannedTaskId: 'task-1',
			workflowId: 'wf-support',
		});
	});

	it('reports a workflow-loop outcome when saving succeeds', async () => {
		const reportBuildOutcome = vi.fn(
			async () => await Promise.resolve({ type: 'verify' as const, workflowId: 'wf-1' }),
		);
		const markSucceeded = vi.fn<
			(
				threadId: string,
				taskId: string,
				update: { result?: string; outcome?: WorkflowBuildOutcome },
			) => Promise<null>
		>(async () => await Promise.resolve(null));
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => await Promise.resolve()),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-1',
				workflowTaskService: {
					reportBuildOutcome,
				},
				plannedTaskService: {
					markSucceeded,
				},
			},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn: vi.fn() },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, { code: 'workflow code', requiredFinalActions });

		expect(context.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Generated workflow' }),
			{ markAsAiTemporary: true },
		);
		expect(resolveCredentials).toHaveBeenCalled();
		expect(stripStaleCredentialsFromWorkflow).toHaveBeenCalled();
		expect(ensureWebhookIds).toHaveBeenCalled();
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-1');
		expect(result).toMatchObject({
			success: true,
			workflowId: 'wf-1',
			workItemId: 'wi-1',
			verificationReadiness: { status: 'ready' },
			setupRequirement: { status: 'not_required' },
			triggerNodes: [{ nodeName: 'Webhook', nodeType: 'n8n-nodes-base.webhook' }],
		});
		expect(reportBuildOutcome).toHaveBeenCalledWith(
			expect.objectContaining<Partial<WorkflowBuildOutcome>>({
				workItemId: 'wi-1',
				runId: 'run-1',
				taskId: 'task-1',
				owner: { type: 'planned', taskId: 'task-1' },
				plannedTaskId: 'task-1',
				workflowId: 'wf-1',
				submitted: true,
				verificationReadiness: { status: 'ready' },
				setupRequirement: { status: 'not_required' },
			}),
		);
		expect(markSucceeded).toHaveBeenCalledWith('thread-1', 'task-1', expect.any(Object));
		const succeededUpdate = markSucceeded.mock.calls[0]?.[2];
		expect(succeededUpdate?.result).toBe('Created workflow "Generated workflow" (wf-1).');
		expect(succeededUpdate?.outcome).toMatchObject({
			workItemId: 'wi-1',
			owner: { type: 'planned', taskId: 'task-1' },
			plannedTaskId: 'task-1',
			workflowId: 'wf-1',
		});
	});

	it('keeps the build successful when main workflow promotion fails', async () => {
		const warn = vi.fn();
		const context = {
			userId: 'user-1',
			runId: 'run-1',
			workflowService: {
				createFromWorkflowJSON: vi.fn(async () => await Promise.resolve({ id: 'wf-1' })),
				clearAiTemporary: vi.fn(async () => {
					await Promise.resolve();
					throw new Error('temporary marker cleanup failed');
				}),
			},
			credentialService: {},
			nodeService: {},
			dataTableService: {},
			executionService: {},
			workflowBuildContext: {
				threadId: 'thread-1',
				runId: 'run-1',
				taskId: 'task-1',
				workItemId: 'wi-1',
				workflowTaskService: {
					reportBuildOutcome: vi.fn(
						async () => await Promise.resolve({ type: 'verify' as const, workflowId: 'wf-1' }),
					),
				},
				plannedTaskService: {
					markSucceeded: vi.fn(async () => await Promise.resolve(null)),
				},
			},
			permissions: { createWorkflow: 'always_allow' },
			logger: { warn },
		} as unknown as InstanceAiContext;

		const tool = createBuildWorkflowTool(context);
		const result = await executeTool(tool, { code: 'workflow code', requiredFinalActions });

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(context.workflowService.clearAiTemporary).toHaveBeenCalledWith('wf-1');
		expect(warn).toHaveBeenCalledWith(
			'Failed to clear AI-builder temporary marker on main workflow wf-1: temporary marker cleanup failed',
		);
	});
});

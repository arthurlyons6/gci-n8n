import { Tool } from '@n8n/agents';
import { instanceAiConfirmationSeveritySchema } from '@n8n/api-types';
import { hasPlaceholderDeep } from '@n8n/utils';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { buildCredentialMap, resolveCredentials } from './resolve-credentials';
import { stripStaleCredentialsFromWorkflow } from './setup-workflow.service';
import { ensureWebhookIds } from './submit-workflow.tool';
import {
	getReferencedWorkflowIds,
	isMockableTriggerNodeType,
	isTriggerNodeType,
} from './workflow-json-utils';
import type { InstanceAiContext } from '../../types';
import type { ValidationWarning } from '../../workflow-builder';
import { parseAndValidate, partitionWarnings } from '../../workflow-builder';
import { extractWorkflowCode } from '../../workflow-builder/extract-code';
import { applyPatches } from '../../workflow-builder/patch-code';
import { createRemediation } from '../../workflow-loop/remediation';
import type {
	WorkflowBuildOutcome,
	WorkflowSetupRequirement,
	WorkflowVerificationMode,
	WorkflowVerificationReadiness,
} from '../../workflow-loop/workflow-loop-state';

const patchSchema = z.object({
	old_str: z.string().describe('Exact string to find in the code'),
	new_str: z.string().describe('Replacement string'),
});

const requiredFinalActionSchema = z.object({
	description: z
		.string()
		.min(1)
		.describe('User-requested terminal effect, e.g. "send rain warning email".'),
	nodeNames: z
		.array(z.string().min(1))
		.min(1)
		.describe('Enabled terminal action node names that perform this effect.'),
});

const confirmationSuspendSchema = z.object({
	requestId: z.string(),
	message: z.string(),
	severity: instanceAiConfirmationSeveritySchema,
});

const confirmationResumeSchema = z.object({
	approved: z.boolean(),
});

interface BuildCtx {
	resumeData?: z.infer<typeof confirmationResumeSchema>;
	suspend?: (payload: z.infer<typeof confirmationSuspendSchema>) => Promise<never>;
}

// Coerce JSON-stringified arrays into arrays. The model sometimes sends `patches`
// as a JSON string because the payload contains escaped code. Leave non-strings
// untouched so Zod can validate them normally.
function coercePatches(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export const buildWorkflowInputSchema = z.object({
	code: z
		.string()
		.optional()
		.describe('Full TypeScript workflow code using @n8n/workflow-sdk. Required for new workflows.'),
	patches: z
		.preprocess(coercePatches, z.array(patchSchema))
		.optional()
		.describe(
			'Array of {old_str, new_str} replacements to apply to existing workflow code. ' +
				'Requires workflowId. More efficient than resending full code for small fixes.',
		),
	workflowId: z.string().optional().describe('Existing workflow ID to update (omit to create new)'),
	projectId: z
		.string()
		.optional()
		.describe('Project ID to create the workflow in. Defaults to personal project.'),
	name: z.string().optional().describe('Workflow name (required for new workflows)'),
	workItemId: z
		.string()
		.optional()
		.describe(
			'Existing workflow-loop work item ID when patching a workflow from verification guidance.',
		),
	isSupportingWorkflow: z
		.boolean()
		.optional()
		.describe(
			'Set true when saving a supporting sub-workflow that will be referenced by the main workflow. ' +
				'In a planned build task, this completes the task only when the task itself is marked isSupportingWorkflow; otherwise save the main workflow later.',
		),
	requiredFinalActions: z
		.array(requiredFinalActionSchema)
		.optional()
		.describe(
			'Required for new main workflow saves. One entry per user-requested final external effect ' +
				'(send/post/respond/create/update/notify/log/upsert). Each entry must point to the actual enabled terminal action node(s), not preprocessing, validation, aggregation, prompt construction, trigger, or control-flow nodes.',
		),
});

type RequiredFinalAction = z.infer<typeof requiredFinalActionSchema>;

const triggerNodeOutputSchema = z.object({
	nodeName: z.string(),
	nodeType: z.string(),
});

const verificationReadinessOutputSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('ready') }),
	z.object({ status: z.literal('already_verified') }),
	z.object({
		status: z.literal('needs_setup'),
		reason: z.enum([
			'unresolved-placeholders',
			'missing-mocked-credential-pin-data',
			'workflow-needs-setup',
		]),
		guidance: z.string(),
	}),
	z.object({
		status: z.literal('not_verifiable'),
		reason: z.enum(['not-submitted', 'missing-workflow-id', 'non-mockable-trigger']),
		guidance: z.string(),
	}),
]);

const setupRequirementOutputSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('not_required') }),
	z.object({
		status: z.literal('required'),
		reason: z.enum(['mocked-credentials', 'unresolved-placeholders', 'workflow-needs-setup']),
		guidance: z.string(),
	}),
]);

const verificationModeOutputSchema = z.enum([
	'mocked_credentials',
	'real_credentials',
	'not_verified',
]);

function hasMockedCredentials(
	outcome: Pick<WorkflowBuildOutcome, 'mockedCredentialTypes' | 'mockedCredentialsByNode'>,
): boolean {
	return (
		(outcome.mockedCredentialTypes?.length ?? 0) > 0 ||
		Object.keys(outcome.mockedCredentialsByNode ?? {}).length > 0
	);
}

function hasCredentialVerificationData(
	outcome: Pick<WorkflowBuildOutcome, 'verificationPinData' | 'usesWorkflowPinDataForVerification'>,
): boolean {
	return (
		Object.keys(outcome.verificationPinData ?? {}).length > 0 ||
		outcome.usesWorkflowPinDataForVerification === true
	);
}

function hasSuccessfulStructuredVerification(
	outcome: Pick<WorkflowBuildOutcome, 'verification'>,
): boolean {
	return (
		outcome.verification?.attempted === true &&
		outcome.verification.success &&
		!!outcome.verification.executionId
	);
}

function determineVerificationMode(
	outcome: Pick<
		WorkflowBuildOutcome,
		'verification' | 'mockedCredentialTypes' | 'mockedCredentialsByNode'
	>,
): WorkflowVerificationMode {
	if (!hasSuccessfulStructuredVerification(outcome)) {
		return 'not_verified';
	}

	return hasMockedCredentials(outcome) ? 'mocked_credentials' : 'real_credentials';
}

function determineVerificationReadiness(
	outcome: Pick<
		WorkflowBuildOutcome,
		| 'submitted'
		| 'workflowId'
		| 'triggerNodes'
		| 'mockedCredentialTypes'
		| 'mockedCredentialsByNode'
		| 'verificationPinData'
		| 'usesWorkflowPinDataForVerification'
		| 'hasUnresolvedPlaceholders'
	>,
): WorkflowVerificationReadiness {
	if (!outcome.submitted) {
		return {
			status: 'not_verifiable',
			reason: 'not-submitted',
			guidance: 'The build did not submit a workflow, so there is nothing to verify.',
		};
	}

	if (!outcome.workflowId) {
		return {
			status: 'not_verifiable',
			reason: 'missing-workflow-id',
			guidance: 'The build outcome does not include a workflow ID.',
		};
	}

	if (outcome.hasUnresolvedPlaceholders) {
		return {
			status: 'needs_setup',
			reason: 'unresolved-placeholders',
			guidance: 'Route the workflow through setup before verification.',
		};
	}

	if (hasMockedCredentials(outcome) && !hasCredentialVerificationData(outcome)) {
		return {
			status: 'needs_setup',
			reason: 'missing-mocked-credential-pin-data',
			guidance: 'Route the workflow through setup because mocked credentials cannot be verified.',
		};
	}

	if (!outcome.triggerNodes?.some((node) => isMockableTriggerNodeType(node.nodeType))) {
		return {
			status: 'not_verifiable',
			reason: 'non-mockable-trigger',
			guidance: 'The workflow does not have a trigger the post-build verifier can exercise.',
		};
	}

	return { status: 'ready' };
}

function determineSetupRequirement(
	outcome: Pick<
		WorkflowBuildOutcome,
		| 'submitted'
		| 'workflowId'
		| 'mockedCredentialTypes'
		| 'mockedCredentialsByNode'
		| 'hasUnresolvedPlaceholders'
	>,
): WorkflowSetupRequirement {
	if (!outcome.submitted || !outcome.workflowId) {
		return { status: 'not_required' };
	}

	if (outcome.hasUnresolvedPlaceholders) {
		return {
			status: 'required',
			reason: 'unresolved-placeholders',
			guidance: 'Route the workflow through setup so the user can fill unresolved values.',
		};
	}

	if (hasMockedCredentials(outcome)) {
		return {
			status: 'required',
			reason: 'mocked-credentials',
			guidance: 'Route the workflow through setup so the user can add real credentials.',
		};
	}

	return { status: 'not_required' };
}

function formatValidationErrors(errors: ValidationWarning[]): string[] {
	const formatted = errors.map(
		(e) => `[${e.code}]${e.nodeName ? ` (${e.nodeName})` : ''}: ${e.message}`,
	);

	if (!formatted.some((error) => error.includes('Code node JavaScript failed to parse'))) {
		return formatted;
	}

	return [
		...formatted,
		'Code node guidance: keep embedded jsCode parseable after saving. Do not use String.raw in SDK code; avoid raw newlines inside quoted strings, nested template literals, and escape-heavy regex literals. Prefer const LF = String.fromCharCode(10), arrays joined with LF, and simple string helpers.',
	];
}

type WorkflowNodeSummary = {
	name: string;
	type: string;
	parameters?: Record<string, unknown>;
	onError?: string;
	disabled?: boolean;
	executeOnce?: boolean;
	alwaysOutputData?: boolean;
};

type TerminalEffectExpectation = {
	id: string;
	label: string;
	matches: (node: WorkflowNodeSummary) => boolean;
};

type ExternalSourceExpectation = {
	id: string;
	label: string;
	matches: (node: WorkflowNodeSummary) => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectConnectionTargets(value: unknown, targets: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectConnectionTargets(item, targets);
		return;
	}

	if (!isRecord(value)) return;

	const node = value.node;
	if (typeof node === 'string' && node.trim().length > 0) {
		targets.add(node);
		return;
	}

	for (const child of Object.values(value)) collectConnectionTargets(child, targets);
}

function collectMainConnectionTargets(value: unknown, visit: (targetName: string) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) collectMainConnectionTargets(item, visit);
		return;
	}

	if (!isRecord(value)) return;

	const node = value.node;
	if (typeof node === 'string' && node.trim().length > 0) {
		visit(node);
		return;
	}

	for (const child of Object.values(value)) collectMainConnectionTargets(child, visit);
}

function getActiveWorkflowNodes(workflow: WorkflowJSON): WorkflowNodeSummary[] {
	return (workflow.nodes ?? [])
		.map((node) => ({
			name: typeof node.name === 'string' ? node.name : '',
			type: typeof node.type === 'string' ? node.type : '',
			parameters: isRecord(node.parameters) ? node.parameters : undefined,
			onError: typeof node.onError === 'string' ? node.onError : undefined,
			disabled: node.disabled,
			executeOnce: node.executeOnce === true,
			alwaysOutputData: isRecord(node) && node.alwaysOutputData === true,
		}))
		.filter((node) => node.name.length > 0 && node.type.length > 0 && node.disabled !== true);
}

function collectReachableNodes(workflow: WorkflowJSON): Set<string> {
	const activeNodes = getActiveWorkflowNodes(workflow);
	const activeNames = new Set(activeNodes.map((node) => node.name));
	const startNodes = activeNodes.filter((node) => isTriggerNodeType(node.type));
	const queue = startNodes.map((node) => node.name);
	const reachable = new Set<string>(queue);
	const connections = isRecord(workflow.connections) ? workflow.connections : {};

	for (let index = 0; index < queue.length; index++) {
		const source = queue[index];
		const next = new Set<string>();
		collectConnectionTargets(connections[source], next);

		for (const target of next) {
			if (!activeNames.has(target) || reachable.has(target)) continue;
			reachable.add(target);
			queue.push(target);
		}
	}

	return reachable;
}

function collectReachableNodesFrom(
	workflow: WorkflowJSON,
	startNames: Iterable<string>,
): Set<string> {
	const activeNames = new Set(getActiveWorkflowNodes(workflow).map((node) => node.name));
	const queue = [...startNames].filter((name) => activeNames.has(name));
	const reachable = new Set<string>(queue);
	const connections = isRecord(workflow.connections) ? workflow.connections : {};

	for (let index = 0; index < queue.length; index++) {
		const source = queue[index];
		const next = new Set<string>();
		collectConnectionTargets(connections[source], next);

		for (const target of next) {
			if (!activeNames.has(target) || reachable.has(target)) continue;
			reachable.add(target);
			queue.push(target);
		}
	}

	return reachable;
}

function collectConnectionBranches(workflow: WorkflowJSON, sourceName: string): Array<Set<string>> {
	const connections = isRecord(workflow.connections) ? workflow.connections : {};
	const sourceConnections = connections[sourceName];
	if (!isRecord(sourceConnections)) return [];

	const branches: Array<Set<string>> = [];
	for (const outputGroups of Object.values(sourceConnections)) {
		if (!Array.isArray(outputGroups)) continue;

		for (const outputGroup of outputGroups) {
			const targets = new Set<string>();
			collectConnectionTargets(outputGroup, targets);
			branches.push(targets);
		}
	}

	return branches;
}

function collectMainConnectionBranches(
	workflow: WorkflowJSON,
	sourceName: string,
): Array<Set<string>> {
	const connections = isRecord(workflow.connections) ? workflow.connections : {};
	const sourceConnections = connections[sourceName];
	if (!isRecord(sourceConnections) || !Array.isArray(sourceConnections.main)) return [];

	return sourceConnections.main.map((outputGroup) => {
		const targets = new Set<string>();
		collectConnectionTargets(outputGroup, targets);
		return targets;
	});
}

function collectControlConnectionBranches(
	workflow: WorkflowJSON,
	node: WorkflowNodeSummary,
): Array<Set<string>> {
	const branches = collectConnectionBranches(workflow, node.name);

	if (node.type.toLowerCase().endsWith('.if') && branches.length === 1) {
		return [...branches, new Set<string>()];
	}

	if (node.type.toLowerCase().endsWith('.filter') && branches.length === 1) {
		return [...branches, new Set<string>()];
	}

	return branches;
}

function collectIncomingSources(workflow: WorkflowJSON): Map<string, Set<string>> {
	const connections = isRecord(workflow.connections) ? workflow.connections : {};
	const incoming = new Map<string, Set<string>>();

	for (const [sourceName, sourceConnections] of Object.entries(connections)) {
		const targets = new Set<string>();
		collectConnectionTargets(sourceConnections, targets);

		for (const targetName of targets) {
			const sources = incoming.get(targetName) ?? new Set<string>();
			sources.add(sourceName);
			incoming.set(targetName, sources);
		}
	}

	return incoming;
}

function collectIncomingMainSources(workflow: WorkflowJSON): Map<string, Set<string>> {
	const connections = isRecord(workflow.connections) ? workflow.connections : {};
	const incoming = new Map<string, Set<string>>();

	for (const [sourceName, sourceConnections] of Object.entries(connections)) {
		if (!isRecord(sourceConnections)) continue;

		const mainConnections = sourceConnections.main;
		const targets = new Set<string>();
		collectConnectionTargets(mainConnections, targets);

		for (const targetName of targets) {
			const sources = incoming.get(targetName) ?? new Set<string>();
			sources.add(sourceName);
			incoming.set(targetName, sources);
		}
	}

	return incoming;
}

function collectIncomingMainSourceList(workflow: WorkflowJSON): Map<string, string[]> {
	const connections = isRecord(workflow.connections) ? workflow.connections : {};
	const incoming = new Map<string, string[]>();

	for (const [sourceName, sourceConnections] of Object.entries(connections)) {
		if (!isRecord(sourceConnections)) continue;

		const mainConnections = sourceConnections.main;
		collectMainConnectionTargets(mainConnections, (targetName) => {
			const sources = incoming.get(targetName) ?? [];
			sources.push(sourceName);
			incoming.set(targetName, sources);
		});
	}

	return incoming;
}

function isPassiveNodeType(nodeType: string): boolean {
	if (isTriggerNodeType(nodeType)) return true;

	const normalized = nodeType.toLowerCase();
	return [
		'.if',
		'.switch',
		'.merge',
		'.code',
		'.set',
		'.filter',
		'.splitinbatches',
		'.aggregate',
		'.itemlists',
		'.limit',
		'.noop',
		'.sticky',
	].some((suffix) => normalized.endsWith(suffix));
}

function nodeTypeMatchesActionDescription(nodeType: string, nodeName: string, description: string) {
	const haystack = `${nodeType} ${nodeName}`.toLowerCase();
	const action = description.toLowerCase();
	const serviceExpectations: Array<{ terms: string[]; allowed: string[] }> = [
		{ terms: ['email', 'gmail', 'mail'], allowed: ['gmail', 'email', 'smtp', 'mail'] },
		{ terms: ['slack'], allowed: ['slack'] },
		{ terms: ['telegram'], allowed: ['telegram'] },
		{ terms: ['airtable'], allowed: ['airtable'] },
		{ terms: ['google sheets', 'sheet', 'sheets'], allowed: ['googlesheets', 'sheet'] },
		{ terms: ['webhook response', 'respond'], allowed: ['respondtowebhook', 'webhook'] },
	];

	for (const expectation of serviceExpectations) {
		if (!expectation.terms.some((term) => action.includes(term))) continue;
		return expectation.allowed.some((term) => haystack.includes(term));
	}

	return true;
}

function textHasAny(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function paramValue(node: WorkflowNodeSummary, key: string): string {
	const value = node.parameters?.[key];
	return typeof value === 'string' ? value.toLowerCase() : '';
}

function nodeOperationText(node: WorkflowNodeSummary): string {
	return [
		node.type,
		node.name,
		paramValue(node, 'resource'),
		paramValue(node, 'operation'),
		paramValue(node, 'action'),
	]
		.join(' ')
		.toLowerCase();
}

function isSendLikeNode(node: WorkflowNodeSummary): boolean {
	const text = nodeOperationText(node);
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		/\b(send|post|create|append|add|update|upsert|upload|respond|reply|message)\b/.test(text) ||
		[
			'emailsend',
			'sendmessage',
			'postmessage',
			'fileupload',
			'filesupload',
			'respondtowebhook',
			'appendsheet',
			'appendrow',
		].some((term) => compact.includes(term))
	);
}

function matchesEmailSend(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	const text = nodeOperationText(node);
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		(text.includes('email') || text.includes('gmail') || text.includes('smtp')) &&
		(/\b(send|reply|create|message|email)\b/.test(text) || compact.includes('emailsend'))
	);
}

function matchesSlackPost(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	const text = nodeOperationText(node);
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		text.includes('slack') &&
		(/\b(send|post|message|create|upload|file)\b/.test(text) ||
			compact.includes('postmessage') ||
			compact.includes('sendmessage') ||
			compact.includes('fileupload') ||
			compact.includes('filesupload'))
	);
}

function matchesTelegramSend(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	const text = nodeOperationText(node);
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		text.includes('telegram') &&
		(/\b(send|message|reply|post)\b/.test(text) ||
			compact.includes('sendmessage') ||
			compact.includes('postmessage'))
	);
}

function matchesGoogleSheetsWrite(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	const text = nodeOperationText(node);
	return text.includes('googlesheets') && /\b(append|add|create|update|upsert|write)\b/.test(text);
}

function matchesAirtableWrite(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	const text = nodeOperationText(node);
	return text.includes('airtable') && /\b(create|update|upsert|append|add|write)\b/.test(text);
}

function matchesWebhookResponse(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;

	return nodeOperationText(node).includes('respondtowebhook');
}

function matchesLinearSource(node: WorkflowNodeSummary): boolean {
	const text =
		`${nodeOperationText(node)} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		(text.includes('linear') || text.includes('api.linear.app')) &&
		(/\b(issue|issues|bug|bugs|query|graphql|search|list|fetch|get|report)\b/.test(text) ||
			compact.includes('graphql'))
	);
}

function matchesBigQuerySource(node: WorkflowNodeSummary): boolean {
	const text =
		`${nodeOperationText(node)} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return (
		text.includes('bigquery') ||
		text.includes('bigquery.googleapis.com') ||
		text.includes('googlebigquery')
	);
}

function hasGracefulErrorHandling(node: WorkflowNodeSummary): boolean {
	return Boolean(node.onError && node.onError !== 'stopWorkflow');
}

function externalServiceFamily(node: WorkflowNodeSummary): string | undefined {
	const text = nodeOperationText(node);

	if (text.includes('slack')) return 'Slack';
	if (text.includes('telegram')) return 'Telegram';
	if (text.includes('gmail') || text.includes('email') || text.includes('smtp')) return 'Email';
	if (text.includes('googlesheets')) return 'Google Sheets';
	if (text.includes('airtable')) return 'Airtable';
	if (text.includes('notion')) return 'Notion';
	if (text.includes('bigquery')) return 'BigQuery';
	if (text.includes('linear')) return 'Linear';
	if (text.includes('httprequest')) return 'HTTP Request';

	return undefined;
}

function isExternalSideEffectNode(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type) || matchesWebhookResponse(node)) return false;

	const service = externalServiceFamily(node);
	if (!service) return false;

	const text = nodeOperationText(node);
	return (
		isSendLikeNode(node) ||
		/\b(send|post|create|append|add|update|upsert|write|message)\b/.test(text)
	);
}

function isReadLikeExternalSourceNode(node: WorkflowNodeSummary): boolean {
	if (isPassiveNodeType(node.type)) return false;
	if (!externalServiceFamily(node)) return false;

	const text = nodeOperationText(node);
	return /\b(fetch|get|getall|list|search|query|read|history)\b/.test(text);
}

function isNotionLookupNode(node: WorkflowNodeSummary): boolean {
	if (externalServiceFamily(node) !== 'Notion' || !isReadLikeExternalSourceNode(node)) return false;

	const text =
		`${nodeOperationText(node)} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return /\b(find|existing|exists|lookup|search|query|get|getall|list)\b/.test(text);
}

function isNotionCreateLikeNode(node: WorkflowNodeSummary): boolean {
	if (externalServiceFamily(node) !== 'Notion' || !isExternalSideEffectNode(node)) return false;

	const text = nodeOperationText(node);
	return /\b(create|add|upsert)\b/.test(text);
}

function isIntakeTriggerNode(node: WorkflowNodeSummary): boolean {
	const text = `${node.type} ${node.name}`.toLowerCase();
	return text.includes('webhook') || text.includes('formtrigger') || text.includes('form trigger');
}

function isScheduleTriggerNode(node: WorkflowNodeSummary): boolean {
	return `${node.type} ${node.name}`.toLowerCase().includes('schedule');
}

function isBranchingControlNode(node: WorkflowNodeSummary): boolean {
	const normalized = node.type.toLowerCase();
	return (
		normalized.endsWith('.if') || normalized.endsWith('.switch') || normalized.endsWith('.filter')
	);
}

function isMergeNode(node: WorkflowNodeSummary): boolean {
	return node.type.toLowerCase().endsWith('.merge');
}

function mergeSqlInputReferences(node: WorkflowNodeSummary): Set<number> {
	const text = stringifyParameterText(node.parameters).toLowerCase();
	const references = new Set<number>();

	for (const match of text.matchAll(/\binput\s*([1-9]\d*)\b/g)) {
		references.add(Number(match[1]));
	}

	return references;
}

function isSingleInputSqlMerge(node: WorkflowNodeSummary): boolean {
	if (!isMergeNode(node)) return false;

	const text = stringifyParameterText(node.parameters).toLowerCase();
	if (!text.includes('combinebysql') && !/\bselect\b[\s\S]*\binput\s*[1-9]\d*\b/.test(text)) {
		return false;
	}

	return mergeSqlInputReferences(node).size === 1;
}

function isAggregateNode(node: WorkflowNodeSummary): boolean {
	return node.type.toLowerCase().endsWith('.aggregate');
}

function isSplitInBatchesNode(node: WorkflowNodeSummary): boolean {
	return node.type.toLowerCase().endsWith('.splitinbatches');
}

function isCodeNode(node: WorkflowNodeSummary): boolean {
	return node.type.toLowerCase().endsWith('.code');
}

function isLlmChainNode(node: WorkflowNodeSummary): boolean {
	const text = `${node.type} ${node.name}`.toLowerCase();
	return text.includes('chainllm') || text.includes('chain llm');
}

function isOpenAiTextResponseNode(node: WorkflowNodeSummary): boolean {
	const text = nodeOperationText(node);
	return text.includes('openai') && /\btext\b/.test(text) && /\bresponse\b/.test(text);
}

function stringifyParameterText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map(stringifyParameterText).join(' ');
	if (!isRecord(value)) return '';

	return Object.values(value).map(stringifyParameterText).join(' ');
}

function collectStringParameterEntries(
	value: unknown,
	path: string[] = [],
): Array<{ path: string[]; value: string }> {
	if (typeof value === 'string') return [{ path, value }];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) =>
			collectStringParameterEntries(item, [...path, String(index)]),
		);
	}
	if (!isRecord(value)) return [];

	return Object.entries(value).flatMap(([key, child]) =>
		collectStringParameterEntries(child, [...path, key]),
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidationLikeGate(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return /\b(valid|invalid|required|missing|notempty|contains|email|e-mail|message|name|phone|company|subject)\b/.test(
		text,
	);
}

function isContentFieldGate(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return /\b(name|message|subject|phone|company|content|hascontent|isvalid|validsubmission)\b/.test(
		text.replace(/[^a-z0-9]+/g, ' '),
	);
}

function isZeroItemRiskGate(node: WorkflowNodeSummary): boolean {
	const normalizedType = node.type.toLowerCase();
	if (normalizedType.endsWith('.filter')) return true;

	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	const compact = text.replace(/[^a-z0-9$]+/g, '');
	return (
		/\b(?:any|has|no|empty|zero|remaining|filtered|matched|matches|contains|count|length)\b/.test(
			text,
		) ||
		[
			'$itemslength',
			'$inputalllength',
			'noresults',
			'nomatches',
			'norecent',
			'nobugs',
			'anyemails',
			'anyitems',
			'hasitems',
			'hasemails',
		].some((term) => compact.includes(term))
	);
}

function isFinalAggregateObjective(text: string): boolean {
	return textHasAny(text.toLowerCase(), [
		/\b(?:digest|summary|summarize|report|ranking|leaderboard)\b/,
		/\bhow\s+many\b/,
		/\bcount(?:s|ed|ing)?\b/,
		/\blist\s+(?:each|the|all|remaining)\b/,
		/\bremaining\s+(?:items|posts|records|emails|issues|bugs)\b/,
	]);
}

function isEmailDigestObjective(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		/\b(?:gmail|email|e-mail|mail|inbox)\b/.test(normalized) &&
		/\b(?:digest|summary|summarize|action\s+items?|prioriti[sz]e|needs\s+my\s+attention)\b/.test(
			normalized,
		)
	);
}

function isZeroInputSensitiveDigestNode(node: WorkflowNodeSummary): boolean {
	return (
		(isBranchingControlNode(node) && isZeroItemRiskGate(node)) ||
		isCodeAllItemsAggregator(node) ||
		isAggregateNode(node) ||
		isLlmChainNode(node)
	);
}

function isEmailDigestProcessingNode(node: WorkflowNodeSummary): boolean {
	if (isZeroInputSensitiveDigestNode(node)) return true;
	if (!isCodeNode(node)) return false;

	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return /\b(?:digest|summary|summar|context|action|prioriti[sz]e|email|e-mail|mail|inbox)\b/.test(
		text,
	);
}

function isExplicitEmptyFallbackNode(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		/\b(?:fallback|no-op|noop|complete|done|empty|nothing|no\s+results|no\s+matches|no\s+items|no\s+posts|no\s+emails|no\s+bugs|no\s+action|no\s+recent|skip)\b/.test(
			text,
		) ||
		[
			'noresults',
			'nomatches',
			'noitems',
			'noposts',
			'noemails',
			'nobugs',
			'noaction',
			'norecent',
			'nothingtodo',
		].some((term) => compact.includes(term))
	);
}

function isScheduleCadenceGate(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return (
		/\b(posting|biweekly|bi-weekly|fortnight|fortnightly|every other week|every two weeks|every 2 weeks|two-week|2-week|cadence|schedule|week number|run today|should (?:post|send|run))\b/.test(
			text,
		) ||
		['ispostingweek', 'ispostingfortnight', 'shouldpost', 'shouldsend', 'shouldrun'].some((term) =>
			compact.includes(term),
		)
	);
}

function isAllItemDataAggregate(node: WorkflowNodeSummary): boolean {
	const text = stringifyParameterText(node.parameters).toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');
	return compact.includes('aggregateallitemdata') || text.includes('all item');
}

function hasDefineBelowResourceMapperColumns(node: WorkflowNodeSummary): boolean {
	const columns = node.parameters?.columns;
	if (!isRecord(columns)) return false;

	const mappingMode = columns.mappingMode;
	return typeof mappingMode === 'string' && mappingMode.toLowerCase() === 'definebelow';
}

function mapsResourceColumnsFromNestedTriggerBody(node: WorkflowNodeSummary): boolean {
	if (!hasDefineBelowResourceMapperColumns(node)) return false;

	const columns = node.parameters?.columns;
	if (!isRecord(columns)) return false;

	const valueText = stringifyParameterText(columns.value).toLowerCase();
	return /\$json\s*\.\s*body\s*(?:\.|\[)/.test(valueText);
}

function hasSourceIdentityTerm(text: string): boolean {
	return /\b(?:channel|city|source|account|request|team|label|origin)\w*\b/.test(text);
}

function infersSourceIdentityFromPairedItem(node: WorkflowNodeSummary): boolean {
	if (!isCodeNode(node)) return false;

	const text = stringifyParameterText(node.parameters).toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');
	if (!compact.includes('paireditem')) return false;

	if (!hasSourceIdentityTerm(text)) return false;

	if (compact.includes('paireditemitem')) return true;

	const sourceListLookup =
		/\b\w*(?:channel|city|source|account|request|team|label|origin)\w*\s*\[\s*\w+\s*\]/;
	if (!sourceListLookup.test(text)) return false;

	const pairedItemAliases = new Set<string>();
	for (const match of text.matchAll(
		/\b(?:const|let|var)\s+([a-z_$][\w$]*)\s*=\s*[^;\n]*\bpaireditem\b/g,
	)) {
		pairedItemAliases.add(match[1]);
	}

	if (pairedItemAliases.size === 0) return false;

	for (const alias of pairedItemAliases) {
		const aliasItemPattern = new RegExp(`\\b\\w+\\s*=\\s*${alias}\\s*\\.\\s*item\\b`);
		if (aliasItemPattern.test(text)) return true;
	}

	return false;
}

function referencesSourceListItemForIdentity(
	node: WorkflowNodeSummary,
	sourceName: string,
): boolean {
	const text = stringifyParameterText(node.parameters);
	if (!hasSourceIdentityTerm(text.toLowerCase())) return false;

	const escapedSourceName = escapeRegExp(sourceName);
	const sourceItemPattern = new RegExp(
		`\\$\\(\\s*(['"])${escapedSourceName}\\1\\s*\\)\\s*\\.\\s*item\\s*\\.\\s*json\\b`,
		'i',
	);

	return sourceItemPattern.test(text);
}

function isCodeAllItemsAggregator(node: WorkflowNodeSummary): boolean {
	if (!isCodeNode(node)) return false;

	const text = stringifyParameterText(node.parameters).toLowerCase();
	const compact = text.replace(/[^a-z0-9$]+/g, '');
	return (
		text.includes('$input.all') ||
		text.includes('runonceforallitems') ||
		compact.includes('$inputall')
	);
}

function readsSourceIdentityFromCurrentItem(node: WorkflowNodeSummary): boolean {
	const text = stringifyParameterText(node.parameters).toLowerCase();

	return /\$json(?:\s*\.\s*|\s*\[\s*["'])(?:channel|city|source|account|request|team|label|origin)\w*/.test(
		text,
	);
}

function looksLikeSourceListProducer(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	if (!hasSourceIdentityTerm(text)) return false;

	return (
		/\b(?:list|to read|source|sources|channels|cities|accounts|requests|teams|labels|origins)\b/.test(
			text,
		) ||
		text.includes('.map(') ||
		text.includes('return')
	);
}

function looksLikeSourceSpecificBranch(node: WorkflowNodeSummary): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	return hasSourceIdentityTerm(text) || /\btag\b/.test(text) || /#[a-z0-9_-]+/.test(text);
}

function hasUpstreamMatchingExpectation(input: {
	startName: string;
	expectation: ExternalSourceExpectation;
	activeNodeByName: Map<string, WorkflowNodeSummary>;
	incomingMainSources: Map<string, Set<string>>;
	reachable: Set<string>;
}): boolean {
	const queue = [input.startName];
	const visited = new Set<string>();

	for (let index = 0; index < queue.length; index++) {
		const nodeName = queue[index];
		if (visited.has(nodeName)) continue;
		visited.add(nodeName);

		const node = input.activeNodeByName.get(nodeName);
		if (node && input.reachable.has(node.name) && input.expectation.matches(node)) {
			return true;
		}

		for (const sourceName of input.incomingMainSources.get(nodeName) ?? []) {
			if (!visited.has(sourceName)) queue.push(sourceName);
		}
	}

	return false;
}

function nodeHasDownstreamMatchingExpectation(input: {
	workflow: WorkflowJSON;
	startName: string;
	expectation: ExternalSourceExpectation;
	activeNodes: WorkflowNodeSummary[];
	reachable: Set<string>;
}): boolean {
	const downstream = collectReachableNodesFrom(input.workflow, [input.startName]);
	return input.activeNodes.some(
		(node) =>
			node.name !== input.startName &&
			input.reachable.has(node.name) &&
			downstream.has(node.name) &&
			input.expectation.matches(node),
	);
}

function consumesExpectedSourceData(
	node: WorkflowNodeSummary,
	expectation: ExternalSourceExpectation,
): boolean {
	const text = `${node.name} ${stringifyParameterText(node.parameters)}`.toLowerCase();
	const compact = text.replace(/[^a-z0-9]+/g, '');

	switch (expectation.id) {
		case 'linear':
			return /\b(linear|issue|issues|bug|bugs|ticket|tickets)\b/.test(text);
		case 'bigquery':
			return (
				/\b(bigquery|bq|usage|exec|execs|execution|executions|hour|hours)\b/.test(text) ||
				compact.includes('bigquery')
			);
		default:
			return false;
	}
}

function nodeReachesExternalEffect(
	workflow: WorkflowJSON,
	nodeName: string,
	activeNodes: WorkflowNodeSummary[],
): boolean {
	const downstream = collectReachableNodesFrom(workflow, [nodeName]);
	return activeNodes.some(
		(candidate) => downstream.has(candidate.name) && isExternalSideEffectNode(candidate),
	);
}

function collectCodeNodeAllReferences(node: WorkflowNodeSummary): Set<string> {
	if (!isCodeNode(node)) return new Set();

	const text = stringifyParameterText(node.parameters);
	const references = new Set<string>();
	for (const match of text.matchAll(/\$\(\s*(['"])([^'"]+)\1\s*\)\s*\.all\s*\(/g)) {
		references.add(match[2]);
	}

	return references;
}

function referencesCurrentJsonResponseText(node: WorkflowNodeSummary): boolean {
	const text = stringifyParameterText(node.parameters);
	return /\$json\s*\.\s*response\s*(?:\?\.|\.)\s*text\b/i.test(text);
}

function referencesNamedNodeResponseText(node: WorkflowNodeSummary, sourceName: string): boolean {
	const text = stringifyParameterText(node.parameters);
	const escapedSourceName = escapeRegExp(sourceName);
	const namedNodePattern = new RegExp(
		`\\$\\(\\s*(['"])${escapedSourceName}\\1\\s*\\)\\s*\\.\\s*(?:item\\s*\\.\\s*)?json\\s*\\.\\s*response\\s*(?:\\?\\.|\\.)\\s*text\\b`,
		'i',
	);

	return namedNodePattern.test(text);
}

function referencesCurrentJsonOpenAiResponseShortcut(node: WorkflowNodeSummary): boolean {
	const text = stringifyParameterText(node.parameters);
	if (/\$json\s*\.\s*output\b/i.test(text)) return false;

	return /\$json\s*\.\s*(?:text|content|message)\b/i.test(text);
}

function referencesNamedNodeOpenAiResponseShortcut(
	node: WorkflowNodeSummary,
	sourceName: string,
): boolean {
	const text = stringifyParameterText(node.parameters);
	const escapedSourceName = escapeRegExp(sourceName);
	const namedPrefix = `\\$\\(\\s*(['"])${escapedSourceName}\\1\\s*\\)\\s*\\.\\s*(?:item\\s*\\.\\s*)?json\\s*\\.\\s*`;

	if (new RegExp(`${namedPrefix}output\\b`, 'i').test(text)) return false;

	return new RegExp(`${namedPrefix}(?:text|content|message)\\b`, 'i').test(text);
}

function referencesNamedNodeOpenAiResponseContentText(
	node: WorkflowNodeSummary,
	sourceName: string,
): boolean {
	const text = stringifyParameterText(node.parameters);
	const escapedSourceName = escapeRegExp(sourceName);
	const namedPrefix = `\\$\\(\\s*(['"])${escapedSourceName}\\1\\s*\\)\\s*\\.\\s*(?:item\\s*\\.\\s*)?json\\s*\\.\\s*`;
	const outputContentText = `${namedPrefix}output\\s*(?:\\?\\.|\\.)?\\s*\\[\\s*0\\s*\\]\\s*(?:\\?\\.|\\.)\\s*content\\s*(?:\\?\\.|\\.)?\\s*\\[\\s*0\\s*\\]\\s*(?:\\?\\.|\\.)\\s*text\\b`;

	return new RegExp(outputContentText, 'i').test(text);
}

function referencesOpenAiResponseContentTextPath(text: string): boolean {
	return /\boutput\s*(?:\?\.|\.)?\s*\[\s*0\s*\]\s*(?:\?\.|\.)\s*content\s*(?:\?\.|\.)?\s*\[\s*0\s*\]\s*(?:\?\.|\.)\s*text\b/i.test(
		text,
	);
}

function hasStringTypeGuardForJsonParse(text: string): boolean {
	const parseOperands = [...text.matchAll(/\bJSON\s*\.\s*parse\s*\(\s*([a-z_$][\w$]*)\s*\)/gi)].map(
		(match) => match[1],
	);

	for (const operand of parseOperands) {
		const escapedOperand = escapeRegExp(operand);
		const operandGuard = new RegExp(
			`\\btypeof\\s+${escapedOperand}\\s*(?:={2,3}|!==?)\\s*['"]string['"]`,
			'i',
		);
		if (operandGuard.test(text)) return true;
	}

	return /\btypeof\b[\s\S]{0,200}\bstring\b/i.test(text);
}

function parsesOpenAiResponseContentTextWithoutTypeGuard(node: WorkflowNodeSummary): boolean {
	if (!isCodeNode(node)) return false;

	const text = stringifyParameterText(node.parameters);
	return (
		/\bJSON\s*\.\s*parse\s*\(/i.test(text) &&
		referencesOpenAiResponseContentTextPath(text) &&
		!hasStringTypeGuardForJsonParse(text)
	);
}

function isOpenAiPromptLikeParameterPath(path: string[]): boolean {
	const last = path.at(-1)?.toLowerCase() ?? '';
	return ['content', 'text', 'prompt', 'message', 'systemmessage', 'usermessage'].includes(last);
}

function hasMixedLeadingEqualsInterpolation(value: string): boolean {
	return /^=(?!\{\{)[\s\S]*\{\{[\s\S]*\}\}/.test(value.trim());
}

function hasOpenAiMixedInterpolationPrompt(node: WorkflowNodeSummary): boolean {
	if (!isOpenAiTextResponseNode(node)) return false;

	return collectStringParameterEntries(node.parameters).some(
		(entry) =>
			isOpenAiPromptLikeParameterPath(entry.path) &&
			hasMixedLeadingEqualsInterpolation(entry.value),
	);
}

function inferTerminalEffectExpectations(
	objective: string | undefined,
): TerminalEffectExpectation[] {
	if (!objective?.trim()) return [];

	const text = objective.toLowerCase();
	const expectations: TerminalEffectExpectation[] = [];

	if (
		textHasAny(text, [
			/\b(email|e-mail)\b/,
			/\bgmail\b/,
			/\bsend\s+(?:an?\s+)?mail\b/,
			/\bby\s+mail\b/,
		])
	) {
		expectations.push({ id: 'email', label: 'send an email', matches: matchesEmailSend });
	}

	if (
		textHasAny(text, [
			/\b(?:post|send|publish|notify|alert|message)\b[\s\S]{0,80}\bslack\b/,
			/\bslack\b[\s\S]{0,80}\b(?:post|send|publish|notify|alert)\b/,
			/\bto\s+(?:a\s+)?slack\s+(?:channel|message)\b/,
		])
	) {
		expectations.push({
			id: 'slack',
			label: 'post or send a Slack message',
			matches: matchesSlackPost,
		});
	}

	if (
		textHasAny(text, [
			/\b(?:send|notify|alert|message|reply|post)\b[\s\S]{0,80}\btelegram\b/,
			/\btelegram\b[\s\S]{0,80}\b(?:send|notify|alert|message|reply|post)\b/,
			/\btelegram\s+(?:alert|message|notification)\b/,
		])
	) {
		expectations.push({
			id: 'telegram',
			label: 'send a Telegram message',
			matches: matchesTelegramSend,
		});
	}

	if (
		textHasAny(text, [
			/\b(?:log|append|add|write|insert|upsert|update|create)\b[\s\S]{0,80}\b(?:google\s+sheets?|spreadsheet)\b/,
			/\b(?:google\s+sheets?|spreadsheet)\b[\s\S]{0,80}\b(?:log|append|add|write|insert|upsert|update|create)\b/,
		])
	) {
		expectations.push({
			id: 'google-sheets',
			label: 'write to Google Sheets',
			matches: matchesGoogleSheetsWrite,
		});
	}

	if (
		textHasAny(text, [
			/\b(?:log|append|add|write|insert|upsert|update|create)\b[\s\S]{0,80}\bairtable\b/,
			/\bairtable\b[\s\S]{0,80}\b(?:log|append|add|write|insert|upsert|update|create)\b/,
		])
	) {
		expectations.push({
			id: 'airtable',
			label: 'write to Airtable',
			matches: matchesAirtableWrite,
		});
	}

	if (
		textHasAny(text, [
			/\brespond\b[\s\S]{0,80}\bwebhook\b/,
			/\bwebhook\b[\s\S]{0,80}\b(?:respond|response|reply|acknowledge)\b/,
			/\bhttp\s+response\b/,
		])
	) {
		expectations.push({
			id: 'webhook-response',
			label: 'respond to the webhook',
			matches: matchesWebhookResponse,
		});
	}

	return expectations;
}

function inferExternalSourceExpectations(
	objective: string | undefined,
): ExternalSourceExpectation[] {
	if (!objective?.trim()) return [];

	const text = objective.toLowerCase();
	const expectations: ExternalSourceExpectation[] = [];

	if (
		text.includes('linear') &&
		/\b(issue|issues|bug|bugs|ticket|tickets|filed|contribution|report)\b/.test(text)
	) {
		expectations.push({
			id: 'linear',
			label: 'Linear issue or bug data',
			matches: matchesLinearSource,
		});
	}

	if (
		/\b(bigquery|bq)\b/.test(text) ||
		(/\busage\b/.test(text) && /\b(exec|execs|execution|executions|hours?)\b/.test(text))
	) {
		expectations.push({
			id: 'bigquery',
			label: 'BigQuery usage data',
			matches: matchesBigQuerySource,
		});
	}

	return expectations;
}

function validateObjectiveTerminalEffects(input: {
	workflow: WorkflowJSON;
	objective: string | undefined;
	requireEffects: boolean;
}): string[] {
	if (!input.requireEffects) return [];

	const expectations = inferTerminalEffectExpectations(input.objective);
	if (expectations.length === 0) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const reachableNodes = activeNodes.filter((node) => reachable.has(node.name));
	const errors: string[] = [];

	for (const expectation of expectations) {
		if (reachableNodes.some((node) => expectation.matches(node) && isSendLikeNode(node))) {
			continue;
		}

		errors.push(
			`Trusted build objective requires the workflow to ${expectation.label}, but no enabled reachable terminal action node for that effect was found. Add and connect the actual terminal action node before saving; preprocessing, validation, aggregation, or an unwired branch is not enough.`,
		);
	}

	return errors;
}

function validateObjectiveExternalSources(input: {
	workflow: WorkflowJSON;
	objective: string | undefined;
	requireSources: boolean;
}): string[] {
	if (!input.requireSources) return [];

	const expectations = inferExternalSourceExpectations(input.objective);
	if (expectations.length === 0) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const errors: string[] = [];

	for (const expectation of expectations) {
		const hasSource = activeNodes.some(
			(node) =>
				reachable.has(node.name) &&
				expectation.matches(node) &&
				nodeReachesExternalEffect(input.workflow, node.name, activeNodes),
		);
		if (hasSource) continue;

		errors.push(
			`Trusted build objective depends on ${expectation.label}, but no enabled reachable source/read node for that data was found before the final effect. Add a configured ${expectation.label} fetch before aggregating, ranking, reporting, or posting; a schedule/window item, placeholder rows, or final formatter alone is not enough.`,
		);
	}

	return errors;
}

function validateExternalSourceMergeProvenance(input: {
	workflow: WorkflowJSON;
	objective: string | undefined;
	requireSources: boolean;
}): string[] {
	if (!input.requireSources) return [];

	const expectations = inferExternalSourceExpectations(input.objective);
	if (expectations.length < 2) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const incomingMainSourceList = collectIncomingMainSourceList(input.workflow);
	const errors: string[] = [];

	for (const mergeNode of activeNodes) {
		if (
			!reachable.has(mergeNode.name) ||
			!isMergeNode(mergeNode) ||
			!nodeReachesExternalEffect(input.workflow, mergeNode.name, activeNodes)
		) {
			continue;
		}

		const directSourceNames = incomingMainSourceList.get(mergeNode.name) ?? [];
		if (directSourceNames.length < 2) continue;

		const missingExpectations = expectations.filter(
			(expectation) =>
				!directSourceNames.some((sourceName) =>
					hasUpstreamMatchingExpectation({
						startName: sourceName,
						expectation,
						activeNodeByName,
						incomingMainSources,
						reachable,
					}),
				),
		);
		if (missingExpectations.length === 0) continue;

		errors.push(
			`Merge node "${mergeNode.name}" feeds a final report/ranking/post but its inputs are not fed by required ${missingExpectations.map((expectation) => expectation.label).join(' and ')} source results. Connect each Merge input from the actual Linear/BigQuery/API read output or a normalizer downstream of that read; do not feed multiple Merge inputs from the same schedule/window/gate item.`,
		);
	}

	return errors;
}

function validateExpectedSourceConsumerProvenance(input: {
	workflow: WorkflowJSON;
	objective: string | undefined;
	requireSources: boolean;
}): string[] {
	if (!input.requireSources) return [];

	const expectations = inferExternalSourceExpectations(input.objective);
	if (expectations.length === 0) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			(!isCodeNode(node) && !isAggregateNode(node)) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)
		) {
			continue;
		}

		for (const expectation of expectations) {
			if (!consumesExpectedSourceData(node, expectation)) continue;
			if (
				nodeHasDownstreamMatchingExpectation({
					workflow: input.workflow,
					startName: node.name,
					expectation,
					activeNodes,
					reachable,
				})
			) {
				continue;
			}
			if (
				hasUpstreamMatchingExpectation({
					startName: node.name,
					expectation,
					activeNodeByName,
					incomingMainSources,
					reachable,
				})
			) {
				continue;
			}

			errors.push(
				`Node "${node.name}" appears to consume ${expectation.label}, but its upstream path does not include a matching source/read node. Wire source-specific counters, normalizers, and aggregators from the actual ${expectation.label} fetch output or a downstream normalizer, not from a schedule/window/gate item.`,
			);
		}
	}

	return errors;
}

function validateResourceMapperNestedTriggerWrites(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!matchesGoogleSheetsWrite(node) ||
			!mapsResourceColumnsFromNestedTriggerBody(node)
		) {
			continue;
		}

		const directIntakeParents = [...(incomingMainSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(sourceNode): sourceNode is WorkflowNodeSummary =>
					sourceNode !== undefined &&
					reachable.has(sourceNode.name) &&
					isIntakeTriggerNode(sourceNode),
			);
		if (directIntakeParents.length === 0) continue;

		errors.push(
			`Google Sheets node "${node.name}" maps resource-mapper columns from nested \`$json.body...\` fields directly after ${directIntakeParents.map((sourceNode) => `"${sourceNode.name}"`).join(', ')}. Normalize trigger body fields into top-level fields with Set or Code before the write, then map columns from \`$json.name\`, \`$json.email\`, \`$json.message\`, etc.; passing the raw trigger envelope can produce blank destination columns or auto-mapped headers/body fields.`,
		);
	}

	return errors;
}

function validateIndependentFailureHandling(input: {
	workflow: WorkflowJSON;
	actions: RequiredFinalAction[] | undefined;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const errors: string[] = [];
	const actionEntries = input.actions ?? [];

	const externalFinalEffects = actionEntries.flatMap((action) =>
		action.nodeNames
			.map((nodeName) => activeNodeByName.get(nodeName))
			.filter(
				(node): node is WorkflowNodeSummary =>
					node !== undefined && reachable.has(node.name) && isExternalSideEffectNode(node),
			)
			.map((node) => ({ action, node })),
	);

	if (externalFinalEffects.length > 1) {
		for (const { action, node } of externalFinalEffects) {
			if (hasGracefulErrorHandling(node)) continue;

			const service = externalServiceFamily(node) ?? 'external service';
			errors.push(
				`Independent final effect "${action.description}" uses ${service} node "${node.name}" without graceful error handling. In a multi-effect workflow, configure supported \`onError\` behavior such as \`continueRegularOutput\` or \`continueErrorOutput\` so one effect failure does not abort unrelated effects.`,
			);
		}
	}

	const readLikeNodesByService = new Map<string, WorkflowNodeSummary[]>();
	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isReadLikeExternalSourceNode(node)) continue;
		const service = externalServiceFamily(node);
		if (!service) continue;
		const nodes = readLikeNodesByService.get(service) ?? [];
		nodes.push(node);
		readLikeNodesByService.set(service, nodes);
	}

	for (const [service, nodes] of readLikeNodesByService) {
		if (nodes.length < 2) continue;
		for (const node of nodes) {
			if (hasGracefulErrorHandling(node)) continue;
			errors.push(
				`Independent ${service} source "${node.name}" has no graceful error handling. When a workflow reads from multiple independent ${service} sources, configure supported \`onError\` behavior so one source failure does not discard successful sources.`,
			);
		}
	}

	return errors;
}

function validateIteratedSourceReadErrorHandling(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingSources = collectIncomingSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!isReadLikeExternalSourceNode(node) ||
			hasGracefulErrorHandling(node) ||
			!readsSourceIdentityFromCurrentItem(node)
		) {
			continue;
		}

		const sourceListParents = [...(incomingSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(source): source is WorkflowNodeSummary =>
					source !== undefined && reachable.has(source.name) && looksLikeSourceListProducer(source),
			);
		if (sourceListParents.length === 0) continue;
		if (!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)) continue;

		const service = externalServiceFamily(node) ?? 'external source';
		errors.push(
			`${service} source "${node.name}" reads per-source input from ${sourceListParents.map((source) => `"${source.name}"`).join(', ')} without graceful error handling. When one channel, city, account, team, label, or origin can fail independently, configure supported \`onError\` behavior such as \`continueRegularOutput\` or \`continueErrorOutput\` before the final effect so successful sources are not discarded.`,
		);
	}

	return errors;
}

function validateSplitInBatchesLoopCollection(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const errors: string[] = [];

	for (const splitNode of activeNodes) {
		if (!reachable.has(splitNode.name) || !isSplitInBatchesNode(splitNode)) continue;

		const splitBranches = collectConnectionBranches(input.workflow, splitNode.name);
		const mainBranches = collectMainConnectionBranches(input.workflow, splitNode.name);
		const doneTargets = mainBranches[0] ?? new Set<string>();
		const loopTargets = mainBranches[1] ?? new Set<string>();
		if (doneTargets.size > 0 && loopTargets.size === 0) {
			const doneReachable = collectReachableNodesFrom(input.workflow, doneTargets);
			const doneBranchDoesWork = activeNodes.some(
				(node) =>
					doneReachable.has(node.name) &&
					(isReadLikeExternalSourceNode(node) ||
						isExternalSideEffectNode(node) ||
						isCodeNode(node) ||
						isAggregateNode(node) ||
						isLlmChainNode(node)),
			);

			if (doneBranchDoesWork) {
				errors.push(
					`Split In Batches node "${splitNode.name}" wires work from output 0 (done) while output 1 (loop/each batch) has no downstream nodes. In n8n v3, output 0 runs only after batches are exhausted; put per-item lookup/create/post work on the loop output with \`.onEachBatch(...)\` and loop back with \`nextBatch(...)\`, then reserve \`.onDone(...)\` for after-loop finalization.`,
				);
			}
		}

		const splitReachable = collectReachableNodesFrom(input.workflow, [splitNode.name]);
		const loopBranchReachable = splitBranches
			.map((targets) => collectReachableNodesFrom(input.workflow, targets))
			.find((branchReachable) => branchReachable.has(splitNode.name));
		const doneBranchReachable = splitBranches
			.map((targets) => collectReachableNodesFrom(input.workflow, targets))
			.find((branchReachable) => !branchReachable.has(splitNode.name));

		if (loopBranchReachable && doneBranchReachable) {
			const loopReadsExternalSource = activeNodes.some(
				(node) => loopBranchReachable.has(node.name) && isReadLikeExternalSourceNode(node),
			);
			const doneReachesFinalEffect = activeNodes.some(
				(node) => doneBranchReachable.has(node.name) && isExternalSideEffectNode(node),
			);
			const doneHasAggregator = activeNodes.some(
				(node) =>
					doneBranchReachable.has(node.name) &&
					(isCodeAllItemsAggregator(node) || isAggregateNode(node) || isLlmChainNode(node)),
			);

			if (loopReadsExternalSource && doneReachesFinalEffect && doneHasAggregator) {
				errors.push(
					`Split In Batches node "${splitNode.name}" loops over external source reads and sends its done branch into a final digest/report path. Split In Batches does not collect loop-body outputs on the done branch, and empty source reads can leave the final aggregator with zero items. Avoid the loop for fixed source lists, or explicitly accumulate one success/empty/failure record per source before the final summary/post.`,
				);
			}
		}

		for (const codeNode of activeNodes) {
			if (!splitReachable.has(codeNode.name) || !isCodeNode(codeNode)) continue;
			if (!nodeReachesExternalEffect(input.workflow, codeNode.name, activeNodes)) continue;

			const loopBodyReferences = [...collectCodeNodeAllReferences(codeNode)]
				.map((nodeName) => activeNodeByName.get(nodeName))
				.filter(
					(referencedNode): referencedNode is WorkflowNodeSummary =>
						referencedNode !== undefined &&
						referencedNode.name !== codeNode.name &&
						splitReachable.has(referencedNode.name),
				);
			if (loopBodyReferences.length === 0) continue;

			errors.push(
				`Code node "${codeNode.name}" runs after Split In Batches node "${splitNode.name}" and reads ${loopBodyReferences.map((node) => `\`$('${node.name}').all()\``).join(', ')} before a final external effect. Split In Batches does not accumulate successful loop-body outputs on the done path; this pattern often keeps only the last channel/source. Accumulate explicitly during the loop, or avoid the loop and use source-preserving branches/merge before summarizing or posting.`,
			);
		}
	}

	return errors;
}

function validateLlmChainOutputEnvelope(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const llmChainNodes = activeNodes.filter(
		(node) => reachable.has(node.name) && isLlmChainNode(node),
	);
	if (llmChainNodes.length === 0) return [];

	const errors: string[] = [];
	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)
		) {
			continue;
		}

		const directChainSources = [...(incomingMainSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(sourceNode): sourceNode is WorkflowNodeSummary =>
					sourceNode !== undefined && reachable.has(sourceNode.name) && isLlmChainNode(sourceNode),
			);
		if (directChainSources.length > 0 && referencesCurrentJsonResponseText(node)) {
			errors.push(
				`Node "${node.name}" reads \`$json.response.text\` directly after LLM Chain node "${directChainSources[0].name}". LLM Chain outputs the generated text on \`$json.text\`; normalize that value into a named field or read \`$json.text\` in the final post/action.`,
			);
			continue;
		}

		const namedChainReference = llmChainNodes.find((chainNode) =>
			referencesNamedNodeResponseText(node, chainNode.name),
		);
		if (!namedChainReference) continue;

		errors.push(
			`Node "${node.name}" reads \`$('${namedChainReference.name}').item.json.response.text\`, but LLM Chain node "${namedChainReference.name}" outputs generated text on \`json.text\`. Use that field, or normalize it before the final post/action.`,
		);
	}

	return errors;
}

function validateOpenAiResponseOutputEnvelope(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const openAiResponseNodes = activeNodes.filter(
		(node) => reachable.has(node.name) && isOpenAiTextResponseNode(node),
	);
	if (openAiResponseNodes.length === 0) return [];

	const errors: string[] = [];
	for (const openAiNode of openAiResponseNodes) {
		if (
			!nodeReachesExternalEffect(input.workflow, openAiNode.name, activeNodes) ||
			!hasOpenAiMixedInterpolationPrompt(openAiNode)
		) {
			continue;
		}

		errors.push(
			`OpenAI Responses node "${openAiNode.name}" uses mixed prompt expression syntax like \`=text {{ ... }}\`. For OpenAI text/response prompts, use a full expression such as \`={{ "Here are " + $json.emailCount + " emails\\n\\n" + $json.emailsText }}\`, or build a \`prompt\` field upstream and read it with \`={{ $json.prompt }}\`; mixed syntax can be treated as an empty prompt at runtime.`,
		);
	}

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)
		) {
			continue;
		}

		const directOpenAiSources = [...(incomingMainSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(sourceNode): sourceNode is WorkflowNodeSummary =>
					sourceNode !== undefined &&
					reachable.has(sourceNode.name) &&
					isOpenAiTextResponseNode(sourceNode),
			);
		if (directOpenAiSources.length > 0 && referencesCurrentJsonOpenAiResponseShortcut(node)) {
			errors.push(
				`Node "${node.name}" reads \`$json.text\`, \`$json.content\`, or \`$json.message\` directly after OpenAI Responses node "${directOpenAiSources[0].name}". OpenAI text/response with simplified output returns messages under \`$json.output\`; normalize the generated text from \`$json.output[0].content[0].text\` before the final post/action.`,
			);
			continue;
		}

		if (directOpenAiSources.length > 0 && parsesOpenAiResponseContentTextWithoutTypeGuard(node)) {
			errors.push(
				`Code node "${node.name}" parses OpenAI Responses content from \`$json.output[0].content[0].text\` with \`JSON.parse\` without first checking whether that value is already an object. OpenAI text/response with JSON schema can return parsed content there; use \`typeof value === 'string' ? JSON.parse(value) : value\` before formatting the final post/action.`,
			);
			continue;
		}

		const namedOpenAiReference = openAiResponseNodes.find((openAiNode) =>
			referencesNamedNodeOpenAiResponseShortcut(node, openAiNode.name),
		);
		if (!namedOpenAiReference) continue;

		errors.push(
			`Node "${node.name}" reads a top-level text/content/message field from OpenAI Responses node "${namedOpenAiReference.name}". OpenAI text/response simplified output stores generated content under \`json.output[0].content[0].text\`; normalize that value before the final post/action.`,
		);
	}

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes) ||
			!parsesOpenAiResponseContentTextWithoutTypeGuard(node)
		) {
			continue;
		}

		const namedOpenAiReference = openAiResponseNodes.find((openAiNode) =>
			referencesNamedNodeOpenAiResponseContentText(node, openAiNode.name),
		);
		if (!namedOpenAiReference) continue;

		errors.push(
			`Code node "${node.name}" parses OpenAI Responses content from node "${namedOpenAiReference.name}" with \`JSON.parse\` without first checking whether that value is already an object. OpenAI text/response with JSON schema can return parsed content at \`json.output[0].content[0].text\`; use \`typeof value === 'string' ? JSON.parse(value) : value\` before formatting the final post/action.`,
		);
	}

	return errors;
}

function validateUnmergedParallelSourceFanIn(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isCodeNode(node)) continue;
		if (isMergeNode(node) || isAggregateNode(node)) continue;

		const sources = [...(incomingMainSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(source): source is WorkflowNodeSummary =>
					source !== undefined && reachable.has(source.name),
			);
		if (sources.length < 2) continue;
		if (!sources.some(looksLikeSourceSpecificBranch)) continue;
		if (!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)) continue;

		errors.push(
			`Code node "${node.name}" has multiple main inputs from ${sources.map((source) => `"${source.name}"`).join(', ')} without a Merge or Aggregate node before a final external effect. n8n executes parallel input branches separately; it does not automatically combine channel/source branches into one item stream. Merge or aggregate the branches first, then build one transcript/report/digest from the merged input.`,
		);
	}

	return errors;
}

function validatePairedItemSourceIdentity(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !infersSourceIdentityFromPairedItem(node)) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [node.name]);
		const reachesExternalEffect = activeNodes.some(
			(candidate) => downstream.has(candidate.name) && isExternalSideEffectNode(candidate),
		);
		if (!reachesExternalEffect) continue;

		errors.push(
			`Code node "${node.name}" uses \`pairedItem.item\` to infer source identity such as channel, city, account, team, label, or origin before a final external effect. After nodes that fan one source request into many records, paired item indexes are record positions, not source-list indexes. Stamp the source identity before flattening, or carry it in the same transformation that expands records.`,
		);
	}

	return errors;
}

function validateSourceListItemReferencesAfterFanOut(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const sourceListNodes = activeNodes.filter(
		(node) => reachable.has(node.name) && looksLikeSourceListProducer(node),
	);
	if (sourceListNodes.length === 0) return [];

	const externalReadNodes = activeNodes.filter(
		(node) => reachable.has(node.name) && isReadLikeExternalSourceNode(node),
	);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)
		) {
			continue;
		}

		for (const sourceNode of sourceListNodes) {
			if (sourceNode.name === node.name) continue;
			if (!referencesSourceListItemForIdentity(node, sourceNode.name)) continue;

			const sourceReachable = collectReachableNodesFrom(input.workflow, [sourceNode.name]);
			const unsafeRead = externalReadNodes.find((readNode) => {
				if (readNode.name === node.name || !sourceReachable.has(readNode.name)) return false;
				return collectReachableNodesFrom(input.workflow, [readNode.name]).has(node.name);
			});
			if (!unsafeRead) continue;

			errors.push(
				`Node "${node.name}" reads source identity from \`$('${sourceNode.name}').item.json...\` after external source "${unsafeRead.name}" before a final effect. Upstream \`.item\` pairing can be missing or point at the wrong source after fan-out, multi-record reads, or error outputs. Carry channel, city, account, team, label, or origin fields on the current item before fan-out, and create failure records with explicit source fields only on the real error path.`,
			);
		}
	}

	return errors;
}

function validateMergeAggregateDataRetention(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingSources = collectIncomingSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isAggregateNode(node) || !isAllItemDataAggregate(node)) {
			continue;
		}

		const directMergeSources = [...(incomingSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter(
				(source): source is WorkflowNodeSummary =>
					source !== undefined && reachable.has(source.name) && isMergeNode(source),
			);
		if (directMergeSources.length === 0) continue;

		const riskyMerge = directMergeSources.find(
			(source) => (incomingSources.get(source.name)?.size ?? 0) > 1,
		);
		if (!riskyMerge) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [node.name]);
		const reachesExternalEffect = activeNodes.some(
			(candidate) => downstream.has(candidate.name) && isExternalSideEffectNode(candidate),
		);
		if (!reachesExternalEffect) continue;

		errors.push(
			`Aggregate node "${node.name}" reads directly from multi-input Merge node "${riskyMerge.name}" before a final external effect. This pattern often drops or collapses appended source-list items in digests and summaries. Preserve all merged items explicitly before summarizing, for example with a Code node that uses \`$input.all()\` to build the prompt/report from every item, or another verified structure that keeps the merged item count intact.`,
		);
	}

	return errors;
}

function validateMergeCodeAggregatorExecuteOnce(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			node.executeOnce !== true ||
			!isCodeAllItemsAggregator(node) ||
			!nodeReachesExternalEffect(input.workflow, node.name, activeNodes)
		) {
			continue;
		}

		const riskyMerge = [...(incomingMainSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.find(
				(sourceNode): sourceNode is WorkflowNodeSummary =>
					sourceNode !== undefined &&
					reachable.has(sourceNode.name) &&
					isMergeNode(sourceNode) &&
					(incomingMainSources.get(sourceNode.name)?.size ?? 0) > 1,
			);
		if (!riskyMerge) continue;

		errors.push(
			`Code node "${node.name}" has \`executeOnce\` enabled after multi-input Merge node "${riskyMerge.name}" before a final external effect. This can make the aggregator process only one merged item. Remove \`executeOnce\` and use Code mode \`runOnceForAllItems\` with \`$input.all()\` so every merged item contributes to the digest, report, or summary.`,
		);
	}

	return errors;
}

function validateSharedTriggerFanIn(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingSources = collectIncomingSources(input.workflow);
	const errors: string[] = [];

	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isMergeNode(node)) continue;

		const sources = [...(incomingSources.get(node.name) ?? [])]
			.map((sourceName) => activeNodeByName.get(sourceName))
			.filter((source): source is WorkflowNodeSummary => source !== undefined);
		const directTriggerSources = sources.filter((source) => isTriggerNodeType(source.type));
		if (directTriggerSources.length < 2) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [node.name]);
		const reachesExternalWork = activeNodes.some(
			(candidate) =>
				candidate.name !== node.name &&
				downstream.has(candidate.name) &&
				(isReadLikeExternalSourceNode(candidate) || isExternalSideEffectNode(candidate)),
		);
		if (!reachesExternalWork) continue;

		errors.push(
			`Multiple triggers feed Merge node "${node.name}" before shared external work. Do not merge Manual, Schedule, Webhook, or other trigger start items into the same fetch, aggregate, or side-effect path: that can duplicate source reads, counts, and final actions. Use one trigger for the requested cadence, or keep trigger paths isolated until after shared data has been deduplicated.`,
		);
	}

	return errors;
}

function validateRedundantScheduleCadenceGates(input: {
	workflow: WorkflowJSON;
	actions: RequiredFinalAction[] | undefined;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const hasScheduleTrigger = activeNodes.some(
		(node) => reachable.has(node.name) && isScheduleTriggerNode(node),
	);
	if (!hasScheduleTrigger) return [];

	const externalEffectNames = new Set<string>();
	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isExternalSideEffectNode(node)) continue;
		externalEffectNames.add(node.name);
	}
	const requiredTerminalNames = new Set(
		(input.actions ?? [])
			.flatMap((action) => action.nodeNames)
			.filter((nodeName) => reachable.has(nodeName) && activeNodeByName.has(nodeName)),
	);
	const terminalNames =
		requiredTerminalNames.size > 0 ? requiredTerminalNames : externalEffectNames;
	if (terminalNames.size === 0) return [];

	const errors: string[] = [];
	for (const node of activeNodes) {
		if (
			!reachable.has(node.name) ||
			!isBranchingControlNode(node) ||
			!isScheduleCadenceGate(node)
		) {
			continue;
		}

		const branches = collectControlConnectionBranches(input.workflow, node);
		if (branches.length < 2) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [node.name]);
		const downstreamTerminalNames = [...terminalNames].filter((nodeName) =>
			downstream.has(nodeName),
		);
		if (downstreamTerminalNames.length === 0) continue;

		const reachableByBranch = branches.map((targets) =>
			collectReachableNodesFrom(input.workflow, targets),
		);
		const hasBranchWithAllTerminalEffects = reachableByBranch.some((branchReachable) =>
			downstreamTerminalNames.every((nodeName) => branchReachable.has(nodeName)),
		);
		const hasBranchMissingTerminalEffects = reachableByBranch.some((branchReachable) =>
			downstreamTerminalNames.some((nodeName) => !branchReachable.has(nodeName)),
		);
		if (!hasBranchWithAllTerminalEffects || !hasBranchMissingTerminalEffects) continue;

		errors.push(
			`Schedule cadence gate "${node.name}" can route scheduled runs away from required terminal action(s) (${downstreamTerminalNames.join(', ')}) even though the Schedule trigger already controls when the workflow runs. Put the cadence in the schedule configuration; do not add a posting-week/run-today IF or Switch that routes send/post/update paths to a replacement, unconnected, or omitted no-op branch unless the user explicitly asked for runtime suppression.`,
		);
	}

	return errors;
}

function validateZeroItemFinalPathBranches(input: {
	workflow: WorkflowJSON;
	actions: RequiredFinalAction[] | undefined;
	objective: string | undefined;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const actionText = (input.actions ?? []).map((action) => action.description).join(' ');
	if (!isFinalAggregateObjective(`${input.objective ?? ''} ${actionText}`)) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const terminalNames = new Set(
		(input.actions ?? [])
			.flatMap((action) => action.nodeNames)
			.filter((nodeName) => reachable.has(nodeName) && activeNodeByName.has(nodeName)),
	);
	if (terminalNames.size === 0) return [];

	const errors: string[] = [];
	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isBranchingControlNode(node) || !isZeroItemRiskGate(node)) {
			continue;
		}

		const branches = collectControlConnectionBranches(input.workflow, node);
		if (branches.length < 2) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [node.name]);
		const downstreamTerminalNames = [...terminalNames].filter((nodeName) =>
			downstream.has(nodeName),
		);
		if (downstreamTerminalNames.length === 0) continue;

		const reachableByBranch = branches.map((targets) =>
			collectReachableNodesFrom(input.workflow, targets),
		);
		const branchReachesFinalAction = reachableByBranch.map((branchReachable) =>
			downstreamTerminalNames.some((nodeName) => branchReachable.has(nodeName)),
		);
		if (!branchReachesFinalAction.some(Boolean)) continue;

		const branchHasFallback = reachableByBranch.map((branchReachable, index) =>
			activeNodes.some(
				(candidate) =>
					branchReachable.has(candidate.name) &&
					!branchReachesFinalAction[index] &&
					isExplicitEmptyFallbackNode(candidate),
			),
		);
		const hasUncoveredBranch = branchReachesFinalAction.some(
			(reachesFinalAction, index) => !reachesFinalAction && !branchHasFallback[index],
		);
		if (!hasUncoveredBranch) continue;

		errors.push(
			`Zero-item gate "${node.name}" can route all items away from final digest/report action(s) (${downstreamTerminalNames.join(', ')}). A Code, AI, or formatting node after only the matched branch will not run when that branch receives zero items. Build the no-results item before dropping the stream to zero, connect the unmatched/empty branch to the final message, or add an explicit no-op/fallback terminal for the empty case.`,
		);
	}

	return errors;
}

function validateEmailDigestZeroItemSourcePath(input: {
	workflow: WorkflowJSON;
	actions: RequiredFinalAction[] | undefined;
	objective: string | undefined;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const actionText = (input.actions ?? []).map((action) => action.description).join(' ');
	const workflowText = [
		input.objective ?? '',
		actionText,
		...activeNodes.map((node) => node.name),
	].join(' ');
	if (!isEmailDigestObjective(workflowText)) return [];

	const reachable = collectReachableNodes(input.workflow);
	const terminalNames = new Set(
		(input.actions ?? [])
			.flatMap((action) => action.nodeNames)
			.filter((nodeName) => reachable.has(nodeName) && activeNodeByName.has(nodeName)),
	);
	if (terminalNames.size === 0) return [];

	const errors: string[] = [];
	for (const sourceNode of activeNodes) {
		if (
			!reachable.has(sourceNode.name) ||
			sourceNode.alwaysOutputData === true ||
			!isReadLikeExternalSourceNode(sourceNode) ||
			externalServiceFamily(sourceNode) !== 'Email'
		) {
			continue;
		}

		const downstream = collectReachableNodesFrom(input.workflow, [sourceNode.name]);
		const downstreamTerminalNames = [...terminalNames].filter((nodeName) =>
			downstream.has(nodeName),
		);
		if (downstreamTerminalNames.length === 0) continue;

		const directRiskNode = collectMainConnectionBranches(input.workflow, sourceNode.name)
			.flatMap((targets) => [...targets])
			.map((nodeName) => activeNodeByName.get(nodeName))
			.find(
				(node): node is WorkflowNodeSummary =>
					node !== undefined && reachable.has(node.name) && isEmailDigestProcessingNode(node),
			);
		if (!directRiskNode) continue;

		errors.push(
			`Email digest source "${sourceNode.name}" feeds zero-input-sensitive node "${directRiskNode.name}" before required digest action(s) ${downstreamTerminalNames.join(', ')}. Gmail/email reads can emit zero items; when that happens downstream IF/Filter/Code/Aggregate/AI nodes do not execute, so a no-recent-email digest or fallback branch is unreachable. Preserve one scheduled seed item before the read, emit one source-preserving summary item such as { emailCount, emails } before branching, or configure a deliberate empty-output path before the final digest action.`,
		);
	}

	return errors;
}

function validateNotionLookupBeforeCreate(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSources = collectIncomingMainSources(input.workflow);
	const errors: string[] = [];

	for (const lookupNode of activeNodes) {
		if (!reachable.has(lookupNode.name) || !isNotionLookupNode(lookupNode)) continue;

		const directChildren = collectMainConnectionBranches(input.workflow, lookupNode.name).flatMap(
			(targets) => [...targets],
		);
		const directGate = directChildren
			.map((nodeName) => activeNodeByName.get(nodeName))
			.find(
				(node): node is WorkflowNodeSummary =>
					node !== undefined && reachable.has(node.name) && isBranchingControlNode(node),
			);
		if (!directGate) continue;

		const upstreamSources = [...(incomingMainSources.get(lookupNode.name) ?? [])]
			.map((nodeName) => activeNodeByName.get(nodeName))
			.filter(
				(node): node is WorkflowNodeSummary =>
					node !== undefined && reachable.has(node.name) && !isTriggerNodeType(node.type),
			);
		if (upstreamSources.length === 0) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [lookupNode.name]);
		const createNodes = activeNodes.filter(
			(node) => downstream.has(node.name) && isNotionCreateLikeNode(node),
		);
		if (createNodes.length === 0) continue;

		errors.push(
			`Notion lookup "${lookupNode.name}" feeds gate "${directGate.name}" before create node(s) ${createNodes.map((node) => `"${node.name}"`).join(', ')}. Notion lookups can emit zero items or collapse multiple paired source items when no page exists, so the create branch can drop or ambiguously reference the original source records. Preserve the candidate source items before the lookup, fetch existing pages once and compare in Code, or emit exactly one exists/missing record per candidate before creating pages.`,
		);
	}

	return errors;
}

function validateSingleInputSqlMergeBeforeSideEffect(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const incomingMainSourceList = collectIncomingMainSourceList(input.workflow);
	const errors: string[] = [];

	for (const mergeNode of activeNodes) {
		if (!reachable.has(mergeNode.name) || !isSingleInputSqlMerge(mergeNode)) continue;

		const directSourceNames = incomingMainSourceList.get(mergeNode.name) ?? [];
		if (directSourceNames.length < 2) continue;

		const downstream = collectReachableNodesFrom(input.workflow, [mergeNode.name]);
		const downstreamEffects = activeNodes.filter(
			(node) => downstream.has(node.name) && isExternalSideEffectNode(node),
		);
		if (downstreamEffects.length === 0) continue;

		const referencedInputs = [...mergeSqlInputReferences(mergeNode)]
			.sort((left, right) => left - right)
			.map((inputIndex) => `input${inputIndex}`)
			.join(', ');

		errors.push(
			`Merge node "${mergeNode.name}" uses a SQL query that selects only ${referencedInputs} while multiple inputs feed it before external action(s) ${downstreamEffects.map((node) => `"${node.name}"`).join(', ')}. Empty candidate/source lists can emit placeholder rows or let lookup data drive creates/updates. Keep the candidate source stream as the current item, join lookup data in Code with \`$input.all()\`, and return zero items when the candidate list is empty; do not rely on a SQL Merge that selects only one input as an empty guard.`,
		);
	}

	return errors;
}

function validateMultiEffectIntakeGates(input: {
	workflow: WorkflowJSON;
	requireHandling: boolean;
}): string[] {
	if (!input.requireHandling) return [];

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const reachable = collectReachableNodes(input.workflow);
	const hasIntakeTrigger = activeNodes.some(
		(node) => reachable.has(node.name) && isIntakeTriggerNode(node),
	);
	if (!hasIntakeTrigger) return [];

	const externalEffectNames = new Set<string>();
	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isExternalSideEffectNode(node)) continue;
		externalEffectNames.add(node.name);
	}
	if (externalEffectNames.size < 2) return [];

	const errors: string[] = [];
	const nodesWithGateErrors = new Set<string>();
	for (const node of activeNodes) {
		if (!reachable.has(node.name) || !isBranchingControlNode(node) || !isValidationLikeGate(node)) {
			continue;
		}

		const branches = collectControlConnectionBranches(input.workflow, node);
		if (branches.length < 2) continue;

		const reachableByBranch = branches.map((targets) =>
			collectReachableNodesFrom(input.workflow, targets),
		);
		const branchWithAllExternalEffects = reachableByBranch.find((branchReachable) =>
			[...externalEffectNames].every((nodeName) => branchReachable.has(nodeName)),
		);
		if (!branchWithAllExternalEffects) continue;

		const hasBranchWithoutExternalEffects = reachableByBranch.some((branchReachable) =>
			[...externalEffectNames].every((nodeName) => !branchReachable.has(nodeName)),
		);
		if (!hasBranchWithoutExternalEffects) continue;

		errors.push(
			`Multi-effect intake validation gate "${node.name}" routes all independent final effects through one branch and no independent effects through another. Normalize the intake payload first, then gate each effect separately: a missing or invalid value needed by one effect must not block logging, notifications, acknowledgements, or other effects that can use the remaining data.`,
		);
		nodesWithGateErrors.add(node.name);
	}

	for (const node of activeNodes) {
		if (
			nodesWithGateErrors.has(node.name) ||
			!reachable.has(node.name) ||
			!isBranchingControlNode(node) ||
			!isValidationLikeGate(node) ||
			!isContentFieldGate(node)
		) {
			continue;
		}

		const branches = collectControlConnectionBranches(input.workflow, node);
		if (branches.length < 2) continue;

		const reachableByBranch = branches.map((targets) =>
			collectReachableNodesFrom(input.workflow, targets),
		);
		const externalEffectCounts = reachableByBranch.map(
			(branchReachable) =>
				[...externalEffectNames].filter((nodeName) => branchReachable.has(nodeName)).length,
		);
		if (!externalEffectCounts.some((count) => count > 0)) continue;
		if (!externalEffectCounts.some((count) => count === 0)) continue;

		errors.push(
			`Multi-effect intake content gate "${node.name}" blocks required final effects based on optional content fields such as name, message, subject, phone, or company. Do not use content presence as eligibility for email, notifications, logging, acknowledgements, or responses; use fallback text and gate only effects that truly require a specific field.`,
		);
	}

	return errors;
}

function validateRequiredFinalActions(input: {
	workflow: WorkflowJSON;
	actions: RequiredFinalAction[] | undefined;
	requireActions: boolean;
}): string[] {
	if (!input.actions?.length) {
		return input.requireActions
			? [
					'Final action contract missing: include `requiredFinalActions` with one entry for every user-requested terminal effect before saving a new main workflow. Point each entry at the actual enabled action node, not preprocessing or control flow.',
				]
			: [];
	}

	const activeNodes = getActiveWorkflowNodes(input.workflow);
	const activeNodeByName = new Map(activeNodes.map((node) => [node.name, node]));
	const allNodesByName = new Map(
		(input.workflow.nodes ?? [])
			.map((node) => ({
				name: typeof node.name === 'string' ? node.name : '',
				type: typeof node.type === 'string' ? node.type : '',
				disabled: node.disabled,
			}))
			.filter((node) => node.name.length > 0)
			.map((node) => [node.name, node]),
	);
	const reachable = collectReachableNodes(input.workflow);
	const errors: string[] = [];

	for (const action of input.actions) {
		for (const nodeName of action.nodeNames) {
			const node = activeNodeByName.get(nodeName);
			const disabledNode = allNodesByName.get(nodeName);

			if (!node) {
				errors.push(
					disabledNode?.disabled === true
						? `Final action "${action.description}" points to disabled node "${nodeName}". Enable the terminal action node or point to an enabled replacement.`
						: `Final action "${action.description}" points to missing node "${nodeName}". Add the terminal action node and reference its exact name.`,
				);
				continue;
			}

			if (isPassiveNodeType(node.type)) {
				errors.push(
					`Final action "${action.description}" points to "${nodeName}" (${node.type}), but that is not a terminal action node. Point to the node that actually sends, posts, responds, creates, updates, notifies, logs, or upserts.`,
				);
			}

			if (!reachable.has(node.name)) {
				errors.push(
					`Final action "${action.description}" points to "${nodeName}", but that node is not reachable from any trigger. Connect the action node before saving.`,
				);
			}

			if (!nodeTypeMatchesActionDescription(node.type, node.name, action.description)) {
				errors.push(
					`Final action "${action.description}" points to "${nodeName}" (${node.type}), which does not match the named service/action. Use the actual node for that terminal effect.`,
				);
			}
		}
	}

	return errors;
}

function withDeterministicRouting(
	outcome: Omit<
		WorkflowBuildOutcome,
		'verificationReadiness' | 'setupRequirement' | 'verificationMode'
	>,
): WorkflowBuildOutcome {
	return {
		...outcome,
		verificationReadiness: determineVerificationReadiness(outcome),
		verificationMode: determineVerificationMode(outcome),
		setupRequirement: determineSetupRequirement(outcome),
	};
}

function isApprovedBuildContext(context: InstanceAiContext): boolean {
	const buildContext = context.workflowBuildContext;
	return Boolean(buildContext?.plannedTaskService ?? buildContext?.allowPostPlanWorkflowCreate);
}

function requiresMainBuildProof(
	context: InstanceAiContext,
	workflowId: string | undefined,
	isSupportingWorkflow: boolean,
): boolean {
	if (isSupportingWorkflow) return false;
	if (!workflowId) return true;

	return context.aiCreatedWorkflowIds?.has(workflowId) === true;
}

async function resolveWorkflowName(
	context: InstanceAiContext,
	workflowId: string,
): Promise<string> {
	try {
		return (await context.workflowService.getAsWorkflowJSON(workflowId)).name || 'workflow';
	} catch {
		return 'workflow';
	}
}

async function reportWorkflowBuildOutcome(
	context: InstanceAiContext,
	outcome: WorkflowBuildOutcome,
	options: { storeOnRunContext?: boolean; markPlannedTaskSucceeded?: boolean } = {},
): Promise<void> {
	const buildContext = context.workflowBuildContext;
	if (!buildContext) return;

	if (options.storeOnRunContext !== false) {
		try {
			await buildContext.onBuildOutcome?.(outcome);
		} catch (error) {
			context.logger?.warn('Failed to store workflow build outcome on run context', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	try {
		await buildContext.workflowTaskService?.reportBuildOutcome(outcome);
	} catch (error) {
		context.logger?.warn('Failed to report workflow build outcome to workflow loop', {
			workItemId: outcome.workItemId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (options.markPlannedTaskSucceeded === false) return;

	try {
		await buildContext.plannedTaskService?.markSucceeded(
			buildContext.threadId,
			buildContext.taskId,
			{
				result: outcome.summary,
				outcome,
			},
		);
	} catch (error) {
		context.logger?.warn('Failed to mark planned workflow build task succeeded', {
			taskId: buildContext.taskId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// Clear the AI-builder temporary marker from the main workflow so run-finish
// cleanup only reaps scratch artifacts, not the saved deliverable.
async function promoteMainWorkflow(context: InstanceAiContext, workflowId: string): Promise<void> {
	try {
		await context.workflowService.clearAiTemporary(workflowId);
	} catch (error) {
		context.logger?.warn(
			`Failed to clear AI-builder temporary marker on main workflow ${workflowId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export function createBuildWorkflowTool(context: InstanceAiContext) {
	// Keeps the last code submitted (or patched) so patches work even before save,
	// and always match the LLM's own code — not a roundtripped version.
	// lastCodeVersionId pins the cache to the workflow version it was derived
	// from; a mismatch on the next turn (user edited the workflow in the canvas)
	// invalidates the cache so patches don't silently overwrite the user's work.
	let lastCode: string | null = null;
	let lastCodeVersionId: string | null = null;

	return new Tool('build-workflow')
		.description(
			'Build a workflow from TypeScript SDK code. Two modes:\n' +
				'1. Full code: pass `code` to create/update a workflow from scratch.\n' +
				'2. Patch mode: pass `patches` (+ optional `workflowId`) to apply str_replace fixes. ' +
				'Patches apply to last submitted code, or auto-fetch from saved workflow if workflowId given.',
		)
		.input(buildWorkflowInputSchema)
		.output(
			z.object({
				success: z.boolean(),
				workflowId: z.string().optional(),
				workflowName: z.string().optional(),
				workItemId: z.string().optional(),
				triggerNodes: z.array(triggerNodeOutputSchema).optional(),
				verificationReadiness: verificationReadinessOutputSchema.optional(),
				verificationMode: verificationModeOutputSchema.optional(),
				setupRequirement: setupRequirementOutputSchema.optional(),
				isSupportingWorkflow: z.boolean().optional(),
				mockedNodeNames: z.array(z.string()).optional(),
				mockedCredentialTypes: z.array(z.string()).optional(),
				mockedCredentialsByNode: z.record(z.array(z.string())).optional(),
				verificationPinData: z.record(z.array(z.record(z.unknown()))).optional(),
				usesWorkflowPinDataForVerification: z.boolean().optional(),
				referencedWorkflowIds: z.array(z.string()).optional(),
				hasUnresolvedPlaceholders: z.boolean().optional(),
				denied: z.boolean().optional(),
				reason: z.string().optional(),
				errors: z.array(z.string()).optional(),
				warnings: z.array(z.string()).optional(),
			}),
		)
		.suspend(confirmationSuspendSchema)
		.resume(confirmationResumeSchema)
		.handler(async (input, ctx: BuildCtx) => {
			const permKey = input.workflowId ? 'updateWorkflow' : 'createWorkflow';
			if (context.permissions?.[permKey] === 'blocked') {
				return { success: false, errors: ['Action blocked by admin'] };
			}

			if (
				input.workflowId &&
				!isApprovedBuildContext(context) &&
				context.permissions?.updateWorkflow !== 'always_allow'
			) {
				if (ctx.resumeData && !ctx.resumeData.approved) {
					return {
						success: false,
						denied: true,
						reason: 'User denied the action',
						errors: ['User denied the action'],
					};
				}
				if (!ctx.resumeData) {
					if (!ctx.suspend) {
						return { success: false, errors: ['Workflow edit approval is required.'] };
					}
					const workflowName = await resolveWorkflowName(context, input.workflowId);
					return await ctx.suspend({
						requestId: nanoid(),
						message: `Edit ${workflowName} (ID: ${input.workflowId})?`,
						severity: 'warning',
					});
				}
			}

			const { code, patches, workflowId, projectId, name, workItemId, requiredFinalActions } =
				input;
			const isSupportingWorkflow = input.isSupportingWorkflow === true;
			let finalCode: string;

			if (patches) {
				// Patch mode: apply str_replace to existing code.
				// Cache-hit fast path uses a cheap head check (versionId only, no
				// nodes/connections payload) to confirm `lastCode` still matches the
				// server. On match we reuse the cached code; on drift we invalidate
				// and fall through to the snapshot fetch below, which returns body
				// + versionId in one round-trip.
				if (lastCode && lastCodeVersionId && workflowId) {
					try {
						const head = await context.workflowService.getWorkflowHead(workflowId);
						if (head.versionId !== lastCodeVersionId) {
							lastCode = null;
							lastCodeVersionId = null;
						}
					} catch {
						// Best-effort: a transient head-lookup failure shouldn't break
						// patch mode. If the cache is stale, patches will either fail to
						// apply cleanly or the next save will surface the conflict.
					}
				}

				let baseCode = lastCode;
				if (!baseCode && workflowId) {
					try {
						const snapshot = await context.workflowService.getWorkflowSnapshot(workflowId);
						baseCode = generateWorkflowCode(snapshot.json);
						lastCode = baseCode;
						lastCodeVersionId = snapshot.versionId;
					} catch {
						return {
							success: false,
							errors: [
								'Patch mode: no previous code and could not fetch workflow. Send full code instead.',
							],
						};
					}
				}
				if (!baseCode) {
					return {
						success: false,
						errors: [
							'Patch mode requires either a previous build-workflow call or a workflowId to fetch from.',
						],
					};
				}

				const patchResult = applyPatches(baseCode, patches);
				if (!patchResult.success) {
					return { success: false, errors: [patchResult.error] };
				}

				finalCode = patchResult.code;
			} else if (code) {
				finalCode = extractWorkflowCode(code);
			} else {
				return {
					success: false,
					errors: ['Either `code` (full code) or `patches` (to fix previous code) is required.'],
				};
			}

			// Remember for future patches
			lastCode = finalCode;

			// Parse TypeScript to WorkflowJSON with two-stage validation
			let result;
			try {
				result = parseAndValidate(finalCode, {
					nodeTypesProvider: context.nodeTypesProvider,
				});
			} catch (error) {
				return {
					success: false,
					errors: [error instanceof Error ? error.message : 'Failed to parse workflow code'],
				};
			}

			// Partition validation results into blocking errors and informational warnings
			const { errors, informational } = partitionWarnings(result.warnings);

			if (errors.length > 0) {
				return {
					success: false,
					errors: formatValidationErrors(errors),
					warnings:
						informational.length > 0
							? informational.map((w) => `[${w.code}]: ${w.message}`)
							: undefined,
				};
			}

			const json = result.workflow;
			if (name) {
				json.name = name;
			} else if (!json.name && !workflowId) {
				return {
					success: false,
					errors: [
						'Workflow name is required for new workflows. Provide a name parameter or set it in the SDK code.',
					],
				};
			}

			const finalActionErrors = validateRequiredFinalActions({
				workflow: json,
				actions: requiredFinalActions,
				requireActions: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const objectiveFinalEffectErrors = validateObjectiveTerminalEffects({
				workflow: json,
				objective: context.workflowBuildContext?.buildObjective,
				requireEffects: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const objectiveExternalSourceErrors = validateObjectiveExternalSources({
				workflow: json,
				objective: context.workflowBuildContext?.buildObjective,
				requireSources: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const externalSourceMergeProvenanceErrors = validateExternalSourceMergeProvenance({
				workflow: json,
				objective: context.workflowBuildContext?.buildObjective,
				requireSources: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const expectedSourceConsumerProvenanceErrors = validateExpectedSourceConsumerProvenance({
				workflow: json,
				objective: context.workflowBuildContext?.buildObjective,
				requireSources: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const independentFailureHandlingErrors = validateIndependentFailureHandling({
				workflow: json,
				actions: requiredFinalActions,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const resourceMapperNestedTriggerWriteErrors = validateResourceMapperNestedTriggerWrites({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const iteratedSourceReadErrorHandlingErrors = validateIteratedSourceReadErrorHandling({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const splitInBatchesLoopCollectionErrors = validateSplitInBatchesLoopCollection({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const unmergedParallelSourceFanInErrors = validateUnmergedParallelSourceFanIn({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const llmChainOutputEnvelopeErrors = validateLlmChainOutputEnvelope({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const openAiResponseOutputEnvelopeErrors = validateOpenAiResponseOutputEnvelope({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const multiEffectIntakeGateErrors = validateMultiEffectIntakeGates({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const sharedTriggerFanInErrors = validateSharedTriggerFanIn({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const redundantScheduleCadenceGateErrors = validateRedundantScheduleCadenceGates({
				workflow: json,
				actions: requiredFinalActions,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const zeroItemFinalPathBranchErrors = validateZeroItemFinalPathBranches({
				workflow: json,
				actions: requiredFinalActions,
				objective: context.workflowBuildContext?.buildObjective,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const emailDigestZeroItemSourcePathErrors = validateEmailDigestZeroItemSourcePath({
				workflow: json,
				actions: requiredFinalActions,
				objective: context.workflowBuildContext?.buildObjective,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const notionLookupBeforeCreateErrors = validateNotionLookupBeforeCreate({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const singleInputSqlMergeBeforeSideEffectErrors = validateSingleInputSqlMergeBeforeSideEffect(
				{
					workflow: json,
					requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
				},
			);
			const mergeAggregateDataRetentionErrors = validateMergeAggregateDataRetention({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const mergeCodeAggregatorExecuteOnceErrors = validateMergeCodeAggregatorExecuteOnce({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const pairedItemSourceIdentityErrors = validatePairedItemSourceIdentity({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			const sourceListItemReferenceErrors = validateSourceListItemReferencesAfterFanOut({
				workflow: json,
				requireHandling: requiresMainBuildProof(context, workflowId, isSupportingWorkflow),
			});
			if (
				finalActionErrors.length > 0 ||
				objectiveFinalEffectErrors.length > 0 ||
				objectiveExternalSourceErrors.length > 0 ||
				externalSourceMergeProvenanceErrors.length > 0 ||
				expectedSourceConsumerProvenanceErrors.length > 0 ||
				independentFailureHandlingErrors.length > 0 ||
				resourceMapperNestedTriggerWriteErrors.length > 0 ||
				iteratedSourceReadErrorHandlingErrors.length > 0 ||
				splitInBatchesLoopCollectionErrors.length > 0 ||
				unmergedParallelSourceFanInErrors.length > 0 ||
				llmChainOutputEnvelopeErrors.length > 0 ||
				openAiResponseOutputEnvelopeErrors.length > 0 ||
				multiEffectIntakeGateErrors.length > 0 ||
				sharedTriggerFanInErrors.length > 0 ||
				redundantScheduleCadenceGateErrors.length > 0 ||
				zeroItemFinalPathBranchErrors.length > 0 ||
				emailDigestZeroItemSourcePathErrors.length > 0 ||
				notionLookupBeforeCreateErrors.length > 0 ||
				singleInputSqlMergeBeforeSideEffectErrors.length > 0 ||
				mergeAggregateDataRetentionErrors.length > 0 ||
				mergeCodeAggregatorExecuteOnceErrors.length > 0 ||
				pairedItemSourceIdentityErrors.length > 0 ||
				sourceListItemReferenceErrors.length > 0
			) {
				return {
					success: false,
					errors: [
						...finalActionErrors,
						...objectiveFinalEffectErrors,
						...objectiveExternalSourceErrors,
						...externalSourceMergeProvenanceErrors,
						...expectedSourceConsumerProvenanceErrors,
						...independentFailureHandlingErrors,
						...resourceMapperNestedTriggerWriteErrors,
						...iteratedSourceReadErrorHandlingErrors,
						...splitInBatchesLoopCollectionErrors,
						...unmergedParallelSourceFanInErrors,
						...llmChainOutputEnvelopeErrors,
						...openAiResponseOutputEnvelopeErrors,
						...multiEffectIntakeGateErrors,
						...sharedTriggerFanInErrors,
						...redundantScheduleCadenceGateErrors,
						...zeroItemFinalPathBranchErrors,
						...emailDigestZeroItemSourcePathErrors,
						...notionLookupBeforeCreateErrors,
						...singleInputSqlMergeBeforeSideEffectErrors,
						...mergeAggregateDataRetentionErrors,
						...mergeCodeAggregatorExecuteOnceErrors,
						...pairedItemSourceIdentityErrors,
						...sourceListItemReferenceErrors,
					],
				};
			}

			// Resolve undefined/null credentials before saving.
			// newCredential() produces NewCredentialImpl which serializes to undefined.
			const credentialMap = await buildCredentialMap(context.credentialService);
			const mockResult = await resolveCredentials(json, workflowId, context, credentialMap);

			// Strip credential entries that are no longer valid for the current
			// parameters. Resolution above (and the LLM itself) can re-emit stale
			// references between turns; without this, setup analysis would surface
			// a credential request for a node that no longer needs one.
			await stripStaleCredentialsFromWorkflow(context, json);

			// Ensure webhook nodes have a webhookId so n8n registers clean paths
			await ensureWebhookIds(json, workflowId, context);

			try {
				const hasMockedCredentialNodes = mockResult.mockedNodeNames.length > 0;
				const referencedWorkflowIds = getReferencedWorkflowIds(json);
				const triggerNodes = (json.nodes ?? [])
					.filter((n) => isTriggerNodeType(n.type))
					.map((n) => ({ nodeName: n.name, nodeType: n.type }))
					.filter(
						(t): t is { nodeName: string; nodeType: string } =>
							Boolean(t.nodeName) && Boolean(t.nodeType),
					);
				const hasPlaceholders = (json.nodes ?? []).some((n) => hasPlaceholderDeep(n.parameters));
				const buildContext = context.workflowBuildContext;
				const isAuxiliarySupportingWorkflow =
					isSupportingWorkflow && buildContext?.isSupportingWorkflowTask !== true;
				const plannedTaskId =
					buildContext?.plannedTaskService && !isAuxiliarySupportingWorkflow
						? buildContext.taskId
						: undefined;
				const owner = plannedTaskId
					? { type: 'planned' as const, taskId: plannedTaskId }
					: { type: 'direct' as const };
				const resolvedWorkItemId =
					workItemId ??
					(isAuxiliarySupportingWorkflow ? undefined : buildContext?.workItemId) ??
					`wi_${nanoid(8)}`;
				const resolvedTaskId = isAuxiliarySupportingWorkflow
					? `${buildContext?.taskId ?? (context.runId ? `build-${context.runId}` : 'build')}:supporting-${nanoid(6)}`
					: (buildContext?.taskId ??
						(context.runId ? `build-${context.runId}` : `build-${nanoid(8)}`));

				const createSuccessResponse = async (savedId: string) => {
					const runId = buildContext?.runId ?? context.runId;
					const workflowName = json.name || 'workflow';
					const summary = `${workflowId ? 'Updated' : 'Created'} ${isSupportingWorkflow ? 'supporting ' : ''}workflow "${workflowName}" (${savedId}).`;
					const placeholderRemediation = hasPlaceholders
						? createRemediation({
								category: 'needs_setup',
								shouldEdit: false,
								reason: 'mocked_credentials_or_placeholders',
								guidance:
									'Workflow submitted successfully, but unresolved setup values remain. Stop code edits and route to workflows(action="setup").',
							})
						: undefined;
					const outcome = withDeterministicRouting({
						workItemId: resolvedWorkItemId,
						...(runId ? { runId } : {}),
						taskId: resolvedTaskId,
						owner,
						plannedTaskId,
						workflowId: savedId,
						submitted: true,
						triggerType: 'manual_or_testable',
						triggerNodes,
						needsUserInput: hasPlaceholders,
						blockingReason: placeholderRemediation?.guidance,
						mockedNodeNames: hasMockedCredentialNodes ? mockResult.mockedNodeNames : undefined,
						mockedCredentialTypes: hasMockedCredentialNodes
							? mockResult.mockedCredentialTypes
							: undefined,
						mockedCredentialsByNode: hasMockedCredentialNodes
							? mockResult.mockedCredentialsByNode
							: undefined,
						verificationPinData:
							hasMockedCredentialNodes && Object.keys(mockResult.verificationPinData).length > 0
								? mockResult.verificationPinData
								: undefined,
						usesWorkflowPinDataForVerification:
							mockResult.usesWorkflowPinDataForVerification || undefined,
						supportingWorkflowIds:
							referencedWorkflowIds.length > 0 ? referencedWorkflowIds : undefined,
						hasUnresolvedPlaceholders: hasPlaceholders || undefined,
						remediation: placeholderRemediation,
						summary,
					});

					await promoteMainWorkflow(context, savedId);
					await reportWorkflowBuildOutcome(context, outcome, {
						storeOnRunContext: !isAuxiliarySupportingWorkflow,
						markPlannedTaskSucceeded: !isAuxiliarySupportingWorkflow,
					});

					return {
						success: true,
						workflowId: savedId,
						workflowName: json.name || undefined,
						workItemId: resolvedWorkItemId,
						isSupportingWorkflow: isSupportingWorkflow || undefined,
						triggerNodes,
						verificationReadiness: outcome.verificationReadiness,
						verificationMode: outcome.verificationMode,
						setupRequirement: outcome.setupRequirement,
						mockedNodeNames: hasMockedCredentialNodes ? mockResult.mockedNodeNames : undefined,
						mockedCredentialTypes: hasMockedCredentialNodes
							? mockResult.mockedCredentialTypes
							: undefined,
						mockedCredentialsByNode: hasMockedCredentialNodes
							? mockResult.mockedCredentialsByNode
							: undefined,
						verificationPinData:
							hasMockedCredentialNodes && Object.keys(mockResult.verificationPinData).length > 0
								? mockResult.verificationPinData
								: undefined,
						usesWorkflowPinDataForVerification:
							mockResult.usesWorkflowPinDataForVerification || undefined,
						referencedWorkflowIds:
							referencedWorkflowIds.length > 0 ? referencedWorkflowIds : undefined,
						hasUnresolvedPlaceholders: hasPlaceholders || undefined,
						warnings:
							informational.length > 0
								? informational.map((w) => `[${w.code}]: ${w.message}`)
								: undefined,
					};
				};

				if (workflowId) {
					const updated = await context.workflowService.updateFromWorkflowJSON(
						workflowId,
						json,
						projectId ? { projectId } : undefined,
					);
					lastCodeVersionId = updated.versionId;
					return await createSuccessResponse(updated.id);
				} else {
					const created = await context.workflowService.createFromWorkflowJSON(json, {
						...(projectId ? { projectId } : {}),
						markAsAiTemporary: true,
					});
					(context.aiCreatedWorkflowIds ??= new Set<string>()).add(created.id);
					lastCodeVersionId = created.versionId;
					return await createSuccessResponse(created.id);
				}
			} catch (error) {
				return {
					success: false,
					errors: [
						`Workflow save failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
					],
				};
			}
		})
		.build();
}

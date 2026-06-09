import type { BinaryCheck } from '../types';
import { SET_NODE_TYPE } from '../utils';

/**
 * Set nodes should have at least one effective assignment configured.
 * Empty or malformed Set nodes do nothing and usually indicate the builder
 * forgot to configure them with the current assignmentCollection shape.
 */
export const noEmptySetNodes: BinaryCheck = {
	name: 'no_empty_set_nodes',
	description: 'Set nodes have at least one effective assignment configured',
	kind: 'deterministic',
	dimension: 'parameter_correctness',
	run(workflow) {
		const setNodes = (workflow.nodes ?? []).filter((n) => n.type === SET_NODE_TYPE);
		if (setNodes.length === 0) return { pass: true, applicable: false };

		const empty: string[] = [];
		const malformed: string[] = [];
		const legacyFields: string[] = [];
		for (const node of setNodes) {
			const params = node.parameters ?? {};

			// Raw/JSON mode uses jsonOutput instead of assignments
			if (params.mode === 'raw') {
				if (!params.jsonOutput) {
					empty.push(node.name);
				}
				continue;
			}

			const entries = getAssignmentEntries(params);
			const count = entries.length;

			if (
				usesLegacyFieldsValues(params) &&
				usesAssignmentCollection(node.typeVersion) &&
				count === 0
			) {
				legacyFields.push(node.name);
				continue;
			}

			if (count === 0) {
				empty.push(node.name);
				continue;
			}

			if (!entries.every(hasEffectiveAssignmentValue)) {
				malformed.push(node.name);
			}
		}

		const pass = empty.length === 0 && legacyFields.length === 0 && malformed.length === 0;
		const comments = [
			...(empty.length > 0 ? [`Set node(s) with no assignments: ${empty.join(', ')}`] : []),
			...(legacyFields.length > 0
				? [
						`Set node(s) using legacy fields.values instead of assignments: ${legacyFields.join(', ')}`,
					]
				: []),
			...(malformed.length > 0
				? [`Set node(s) with malformed assignments missing "value": ${malformed.join(', ')}`]
				: []),
		];

		return {
			pass,
			...(comments.length > 0 ? { comment: comments.join('; ') } : {}),
		};
	},
};

function usesAssignmentCollection(typeVersion: number | undefined): boolean {
	return typeVersion === undefined || typeVersion >= 3.3;
}

function getAssignmentEntries(params: Record<string, unknown>): unknown[] {
	const assignments = params.assignments;
	if (!isRecord(assignments)) return [];

	const entries = assignments.assignments;
	return Array.isArray(entries) ? entries : [];
}

function hasEffectiveAssignmentValue(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.name === 'string' && 'value' in entry;
}

function usesLegacyFieldsValues(params: Record<string, unknown>): boolean {
	const fields = params.fields;
	return isRecord(fields) && Array.isArray(fields.values) && fields.values.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

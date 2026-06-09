/**
 * Parse and Validate Handler
 *
 * Handles parsing TypeScript workflow code to WorkflowJSON and validation.
 * Adapted from ai-workflow-builder.ee/code-builder/handlers/parse-validate-handler.ts
 * without Logger or LangChain dependencies.
 */

import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import type { INodeTypes } from 'n8n-workflow';
import { Script } from 'node:vm';

import { stripImportStatements } from './extract-code';
import type { ParseAndValidateResult, ValidationWarning } from './types';

export interface ParseAndValidateOptions {
	/** Synchronous node-types provider used by both graph and schema validators.
	 *  Without it, AI-aware checks (`MISSING_REQUIRED_INPUT`,
	 *  `UNSUPPORTED_SUBNODE_INPUT`, `SUBNODE_PARAMETER_MISMATCH`,
	 *  `INVALID_INPUT_INDEX`) are silently skipped. */
	nodeTypesProvider?: INodeTypes;
}

/** Validation issue from graph or JSON validation */
interface ValidationIssue {
	code: string;
	message: string;
	nodeName?: string;
}

/**
 * Collect validation issues into the warnings array.
 */
function collectValidationIssues(
	issues: ValidationIssue[],
	allWarnings: ValidationWarning[],
): void {
	for (const issue of issues) {
		allWarnings.push({
			code: issue.code,
			message: issue.message,
			nodeName: issue.nodeName,
		});
	}
}

const CODE_NODE_TYPE = 'n8n-nodes-base.code';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCodeNodeSyntax(json: WorkflowJSON): ValidationWarning[] {
	const warnings: ValidationWarning[] = [];

	for (const node of json.nodes ?? []) {
		if (node.type !== CODE_NODE_TYPE) continue;

		const parameters = isRecord(node.parameters) ? node.parameters : undefined;
		const language = typeof parameters?.language === 'string' ? parameters.language : undefined;
		const jsCode = typeof parameters?.jsCode === 'string' ? parameters.jsCode : undefined;

		if (!jsCode) continue;
		if (language && language !== 'javaScript') continue;

		try {
			// Wrap in an async function so Code node source with top-level await or
			// return statements still parses like it does at n8n runtime.
			new Script(`(async () => {\n${jsCode}\n})();`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown syntax error';
			warnings.push({
				code: 'INVALID_PARAMETER',
				nodeName: node.name,
				message: `Code node JavaScript failed to parse: ${message}`,
			});
		}
	}

	return warnings;
}

/**
 * Parse TypeScript workflow SDK code and validate it in two stages:
 *
 * 1. **Structural validation** (`builder.validate()`) — graph consistency,
 *    disconnected nodes, missing triggers
 * 2. **Schema validation** (`validateWorkflow(json)`) — Zod schema checks
 *    against node parameter definitions loaded via `setSchemaBaseDirs()`
 *
 * @param code - The TypeScript workflow code to parse
 * @returns ParseAndValidateResult with workflow JSON and any warnings/errors
 * @throws Error if parsing fails
 */
export function parseAndValidate(
	code: string,
	options: ParseAndValidateOptions = {},
): ParseAndValidateResult {
	// Strip import statements before parsing — SDK functions are available as globals
	const codeToParse = stripImportStatements(code);

	const { nodeTypesProvider } = options;

	try {
		// Parse the TypeScript code to WorkflowBuilder
		const builder = parseWorkflowCodeToBuilder(codeToParse);

		// Regenerate node IDs deterministically to ensure stable IDs across re-parses
		builder.regenerateNodeIds();

		const allWarnings: ValidationWarning[] = [];

		// Stage 1: Structural validation via graph validators
		const graphValidation = builder.validate({ nodeTypesProvider });
		collectValidationIssues(graphValidation.errors, allWarnings);
		collectValidationIssues(graphValidation.warnings, allWarnings);

		const json = builder.toJSON({ tidyUp: true });

		// Stage 2: Schema validation via Zod schemas from schemaBaseDirs.
		// strictMode is hardcoded on at AI-builder call sites — we want every
		// catchable bug surfaced as a blocking error so the agent can self-correct.
		const schemaValidation = validateWorkflow(json, { nodeTypesProvider, strictMode: true });
		collectValidationIssues(schemaValidation.errors, allWarnings);
		collectValidationIssues(schemaValidation.warnings, allWarnings);
		allWarnings.push(...validateCodeNodeSyntax(json));

		return { workflow: json, warnings: allWarnings };
	} catch (error) {
		throw new Error(
			`Failed to parse workflow code: ${error instanceof Error ? error.message : 'Unknown error'}`,
		);
	}
}

/**
 * Separate errors (blocking) from warnings (informational) in validation results.
 *
 * Error codes that are structural blockers (from graph validation errors or schema
 * validation errors) should prevent saving. Warnings are informational only.
 */
export function partitionWarnings(warnings: ValidationWarning[]): {
	errors: ValidationWarning[];
	informational: ValidationWarning[];
} {
	// Known informational-only codes (not blockers)
	const informationalCodes = new Set(['MISSING_TRIGGER', 'DISCONNECTED_NODE']);

	const errors: ValidationWarning[] = [];
	const informational: ValidationWarning[] = [];

	for (const w of warnings) {
		if (informationalCodes.has(w.code)) {
			informational.push(w);
		} else {
			errors.push(w);
		}
	}

	return { errors, informational };
}

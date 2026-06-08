import type { WorkflowImportOutcome } from './workflow-conflict-policy.types';
import type {
	PublishingAction,
	PublishingResult,
	WorkflowPublishingPolicy,
} from './workflow-publishing-policy.types';

export interface PublishingDecisionInput {
	policy: WorkflowPublishingPolicy;
	status: WorkflowImportOutcome['status'];
	sourceActive: boolean;
	priorWasPublished: boolean;
	currentlyPublished: boolean;
	isArchived: boolean;
}

export function decidePolicyAction(input: {
	policy: WorkflowPublishingPolicy;
	status: WorkflowImportOutcome['status'];
	sourceActive: boolean;
	priorWasPublished: boolean;
}): PublishingAction {
	const { policy, status, sourceActive, priorWasPublished } = input;

	if (status === 'skipped') {
		return 'noop';
	}

	switch (policy) {
		case 'preserve-published-version':
			return status === 'updated' && priorWasPublished ? 'publish' : 'noop';
		case 'match-source':
			if (sourceActive && (status === 'created' || status === 'updated')) {
				return 'publish';
			}
			if (status === 'updated' && !sourceActive && priorWasPublished) {
				return 'unpublish';
			}
			return 'noop';
		case 'all-published':
			return 'publish';
		case 'all-unpublished':
			return status === 'updated' && priorWasPublished ? 'unpublish' : 'noop';
	}
}

export function resolvePublishing(input: PublishingDecisionInput): {
	action: PublishingAction;
	result: PublishingResult;
} {
	if (input.status === 'skipped') {
		return { action: 'noop', result: 'unchanged' };
	}

	if (input.isArchived) {
		return {
			action: input.priorWasPublished || input.currentlyPublished ? 'unpublish' : 'noop',
			result: 'forced-unpublished-archived',
		};
	}

	const action = decidePolicyAction(input);

	switch (action) {
		case 'publish':
			return { action, result: 'published' };
		case 'unpublish':
			return { action, result: 'unpublished' };
		case 'noop':
			return { action, result: 'unchanged' };
	}
}

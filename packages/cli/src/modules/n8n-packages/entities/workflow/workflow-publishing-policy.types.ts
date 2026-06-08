export type WorkflowPublishingPolicy =
	| 'preserve-published-version'
	| 'match-source'
	| 'all-published'
	| 'all-unpublished';

export type PublishingAction = 'publish' | 'unpublish' | 'noop';

export type PublishingResult =
	| 'published'
	| 'unpublished'
	| 'unchanged'
	| 'forced-unpublished-archived';

export type PublishingOutcome = { result: PublishingResult } | { result: 'failed'; reason: string };

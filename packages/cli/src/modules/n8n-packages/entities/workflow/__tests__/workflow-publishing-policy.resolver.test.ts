import { resolvePublishing } from '../workflow-publishing-policy.resolver';

describe('resolvePublishing', () => {
	it.each([
		{
			policy: 'preserve-published-version' as const,
			status: 'created' as const,
			sourceActive: true,
			priorWasPublished: false,
			currentlyPublished: false,
			expected: { action: 'noop', result: 'unchanged' },
		},
		{
			policy: 'preserve-published-version' as const,
			status: 'updated' as const,
			sourceActive: false,
			priorWasPublished: true,
			currentlyPublished: true,
			expected: { action: 'publish', result: 'published' },
		},
		{
			policy: 'match-source' as const,
			status: 'created' as const,
			sourceActive: true,
			priorWasPublished: false,
			currentlyPublished: false,
			expected: { action: 'publish', result: 'published' },
		},
		{
			policy: 'match-source' as const,
			status: 'updated' as const,
			sourceActive: false,
			priorWasPublished: true,
			currentlyPublished: true,
			expected: { action: 'unpublish', result: 'unpublished' },
		},
		{
			policy: 'all-published' as const,
			status: 'created' as const,
			sourceActive: false,
			priorWasPublished: false,
			currentlyPublished: false,
			expected: { action: 'publish', result: 'published' },
		},
		{
			policy: 'all-unpublished' as const,
			status: 'updated' as const,
			sourceActive: true,
			priorWasPublished: true,
			currentlyPublished: true,
			expected: { action: 'unpublish', result: 'unpublished' },
		},
	])('$policy + $status → $expected.result', (testCase) => {
		expect(
			resolvePublishing({
				policy: testCase.policy,
				status: testCase.status,
				sourceActive: testCase.sourceActive,
				priorWasPublished: testCase.priorWasPublished,
				currentlyPublished: testCase.currentlyPublished,
				isArchived: false,
			}),
		).toEqual(testCase.expected);
	});

	it('returns unchanged for skipped imports regardless of policy', () => {
		expect(
			resolvePublishing({
				policy: 'all-published',
				status: 'skipped',
				sourceActive: true,
				priorWasPublished: true,
				currentlyPublished: true,
				isArchived: false,
			}),
		).toEqual({ action: 'noop', result: 'unchanged' });
	});

	it('forces unpublish for archived workflows that were published', () => {
		expect(
			resolvePublishing({
				policy: 'all-published',
				status: 'updated',
				sourceActive: true,
				priorWasPublished: true,
				currentlyPublished: true,
				isArchived: true,
			}),
		).toEqual({ action: 'unpublish', result: 'forced-unpublished-archived' });
	});
});

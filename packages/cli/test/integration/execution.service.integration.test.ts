import {
	createTeamProject,
	createWorkflow,
	linkUserToProject,
	testDb,
} from '@n8n/backend-test-utils';
import { GlobalConfig } from '@n8n/config';
import type { ExecutionSummaries, User } from '@n8n/db';
import { ExecutionMetadataRepository, ExecutionRepository, WorkflowRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { mock } from 'jest-mock-extended';
import { performance } from 'node:perf_hooks';

import { ExecutionService } from '@/executions/execution.service';

import { annotateExecution, createAnnotationTags, createExecution } from './shared/db/executions';
import { createMember, createOwner } from './shared/db/users';

describe('ExecutionService', () => {
	let executionService: ExecutionService;
	let executionRepository: ExecutionRepository;
	let member: User;
	let owner: User;
	const globalConfig = Container.get(GlobalConfig);

	beforeAll(async () => {
		await testDb.init();

		executionRepository = Container.get(ExecutionRepository);

		executionService = new ExecutionService(
			globalConfig,
			mock(),
			mock(),
			mock(),
			mock(),
			executionRepository,
			mock(),
			mock(),
			Container.get(WorkflowRepository),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
			mock(),
		);

		owner = await createOwner();
		member = await createMember();
	});

	beforeEach(() => {
		globalConfig.executions.concurrency.productionLimit = -1;
		globalConfig.executions.mode = 'regular';
	});

	afterEach(async () => {
		await testDb.truncate(['ExecutionEntity']);
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	describe('findRangeWithCount', () => {
		test('should return execution summaries', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			const summaryShape = {
				id: expect.any(String),
				workflowId: expect.any(String),
				mode: expect.any(String),
				retryOf: null,
				status: expect.any(String),
				createdAt: expect.any(String),
				startedAt: expect.any(String),
				stoppedAt: expect.any(String),
				waitTill: null,
				retrySuccessId: null,
				workflowName: expect.any(String),
				annotation: {
					tags: expect.arrayContaining([]),
					vote: null,
				},
			};

			expect(output.count).toBe(2);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([summaryShape, summaryShape]);
		});

		test('should limit executions', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 2 },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(3);
			expect(output.estimated).toBe(false);
			expect(output.results).toHaveLength(2);
		});

		test('should retrieve executions before `lastId`, excluding it', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const [firstId, secondId] = await executionRepository.getAllIds();

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20, lastId: secondId },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(4);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: firstId })]),
			);
		});

		test('should retrieve executions after `firstId`, excluding it', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const [firstId, secondId, thirdId, fourthId] = await executionRepository.getAllIds();

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20, firstId },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(4);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: fourthId }),
					expect.objectContaining({ id: thirdId }),
					expect.objectContaining({ id: secondId }),
				]),
			);
		});

		test('should filter executions by `status`', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'waiting' }, workflow),
				createExecution({ status: 'waiting' }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(2);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				expect.objectContaining({ status: 'success' }),
				expect.objectContaining({ status: 'success' }),
			]);
		});

		test('should filter executions by `workflowId`', async () => {
			const firstWorkflow = await createWorkflow({}, owner);
			const secondWorkflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, firstWorkflow),
				createExecution({ status: 'success' }, secondWorkflow),
				createExecution({ status: 'success' }, secondWorkflow),
				createExecution({ status: 'success' }, secondWorkflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				workflowId: firstWorkflow.id,
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual(
				expect.arrayContaining([expect.objectContaining({ workflowId: firstWorkflow.id })]),
			);
		});

		test('should filter executions by `startedBefore`', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ startedAt: new Date('2020-06-01') }, workflow),
				createExecution({ startedAt: new Date('2020-12-31') }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				startedBefore: '2020-07-01',
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				expect.objectContaining({ startedAt: '2020-06-01T00:00:00.000Z' }),
			]);
		});

		test('should filter executions by `startedAfter`', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ startedAt: new Date('2020-06-01') }, workflow),
				createExecution({ startedAt: new Date('2020-12-31') }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				startedAfter: '2020-07-01',
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				expect.objectContaining({ startedAt: '2020-12-31T00:00:00.000Z' }),
			]);
		});

		test('should filter executions by `metadata` with an exact match by default', async () => {
			const workflow = await createWorkflow({}, owner);

			const key = 'myKey';
			const value = 'myValue';

			await Promise.all([
				createExecution({ status: 'success', metadata: [{ key, value }] }, workflow),
				createExecution({ status: 'error', metadata: [{ key, value: `${value}2` }] }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
				metadata: [{ key, value, exactMatch: true }],
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output).toEqual({
				count: 1,
				estimated: false,
				results: [expect.objectContaining({ status: 'success' })],
			});
		});

		test('should filter executions by `metadata` with a partial match', async () => {
			const workflow = await createWorkflow({}, owner);

			const key = 'myKey';

			await Promise.all([
				createExecution({ status: 'success', metadata: [{ key, value: 'myValue' }] }, workflow),
				createExecution({ status: 'error', metadata: [{ key, value: 'var' }] }, workflow),
				createExecution({ status: 'success', metadata: [{ key, value: 'evaluation' }] }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
				metadata: [{ key, value: 'val', exactMatch: false }],
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output).toEqual({
				count: 2,
				estimated: false,
				results: [
					expect.objectContaining({ status: 'success' }),
					expect.objectContaining({ status: 'success' }),
				],
			});
		});

		test('should filter executions by `projectId`', async () => {
			const firstProject = await createTeamProject();
			const secondProject = await createTeamProject();

			const firstWorkflow = await createWorkflow(undefined, firstProject);
			const secondWorkflow = await createWorkflow(undefined, secondProject);

			await createExecution({ status: 'success' }, firstWorkflow);
			await createExecution({ status: 'success' }, firstWorkflow);
			await createExecution({ status: 'success' }, secondWorkflow); // to filter out

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
				projectId: firstProject.id,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output).toEqual({
				count: 2,
				estimated: false,
				results: expect.arrayContaining([
					expect.objectContaining({ workflowId: firstWorkflow.id }),
					expect.objectContaining({ workflowId: firstWorkflow.id }),
					// execution for workflow in second project was filtered out
				]),
			});
		});

		test('should filter executions by `projectId` and expected `status`', async () => {
			const firstProject = await createTeamProject();
			const secondProject = await createTeamProject();

			const firstWorkflow = await createWorkflow(undefined, firstProject);
			const secondWorkflow = await createWorkflow(undefined, secondProject);

			await createExecution({ status: 'success' }, firstWorkflow);
			await createExecution({ status: 'error' }, firstWorkflow);
			await createExecution({ status: 'success' }, secondWorkflow);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
				projectId: firstProject.id,
				status: ['error'],
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output).toEqual({
				count: 1,
				estimated: false,
				results: expect.arrayContaining([
					expect.objectContaining({ workflowId: firstWorkflow.id, status: 'error' }),
				]),
			});
		});

		test.each([
			{
				name: 'waitTill',
				filter: { waitTill: true },
				matchingParams: { waitTill: new Date() },
				nonMatchingParams: { waitTill: undefined },
			},
			{
				name: 'metadata',
				filter: { metadata: [{ key: 'testKey', value: 'testValue' }] },
				matchingParams: { metadata: [{ key: 'testKey', value: 'testValue' }] },
				nonMatchingParams: { metadata: [{ key: 'otherKey', value: 'otherValue' }] },
			},
			{
				name: 'startedAfter',
				filter: { startedAfter: '2023-01-01' },
				matchingParams: { startedAt: new Date('2023-06-01') },
				nonMatchingParams: { startedAt: new Date('2022-01-01') },
			},
			{
				name: 'startedBefore',
				filter: { startedBefore: '2023-12-31' },
				matchingParams: { startedAt: new Date('2023-06-01') },
				nonMatchingParams: { startedAt: new Date('2024-01-01') },
			},
		])(
			'should filter executions by `projectId` and expected `$name`',
			async ({ filter, matchingParams, nonMatchingParams }) => {
				const firstProject = await createTeamProject();
				const secondProject = await createTeamProject();

				const firstWorkflow = await createWorkflow(undefined, firstProject);
				const secondWorkflow = await createWorkflow(undefined, secondProject);

				await Promise.all([
					createExecution(matchingParams, firstWorkflow),
					createExecution(nonMatchingParams, secondWorkflow),
				]);

				const query: ExecutionSummaries.RangeQuery = {
					kind: 'range',
					range: { limit: 20 },
					user: owner,
					projectId: firstProject.id,
					...filter,
				};

				const output = await executionService.findRangeWithCount(query);

				expect(output).toEqual({
					count: 1,
					estimated: false,
					results: expect.arrayContaining([
						expect.objectContaining({ workflowId: firstWorkflow.id }),
					]),
				});
			},
		);

		test('should exclude executions by inaccessible `workflowId`', async () => {
			const accessibleWorkflow = await createWorkflow({}, member);
			const inaccessibleWorkflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, accessibleWorkflow),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				workflowId: inaccessibleWorkflow.id,
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner'],
					projectRoles: ['project:personalOwner'],
				},
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(0);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([]);
		});

		test('should support advanced filters', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([createExecution({}, workflow), createExecution({}, workflow)]);

			const [firstId, secondId] = await executionRepository.getAllIds();

			const executionMetadataRepository = Container.get(ExecutionMetadataRepository);

			await executionMetadataRepository.save({
				key: 'key1',
				value: 'value1',
				execution: { id: firstId },
			});

			await executionMetadataRepository.save({
				key: 'key2',
				value: 'value2',
				execution: { id: secondId },
			});

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				metadata: [{ key: 'key1', value: 'value1' }],
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([expect.objectContaining({ id: firstId })]);
		});
	});

	describe('findRangeWithCount — subquery approach', () => {
		test('should scope results to user accessible workflows', async () => {
			const workflow1 = await createWorkflow({}, member);
			const workflow2 = await createWorkflow({}, member);
			const inaccessibleWorkflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, workflow1),
				createExecution({ status: 'success' }, workflow1),
				createExecution({ status: 'error' }, workflow2),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner'],
					projectRoles: ['project:personalOwner'],
				},
			};

			const result = await executionService.findRangeWithCount(query);

			// member owns workflow1 and workflow2 → sees 3 executions, not the inaccessible one
			expect(result.count).toBe(3);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(workflow1.id);
			expect(workflowIds).toContain(workflow2.id);
			expect(workflowIds).not.toContain(inaccessibleWorkflow.id);
		});

		test('should filter by status correctly', async () => {
			const workflow = await createWorkflow({}, member);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'error' }, workflow),
			]);

			const arrayQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				status: ['success'],
				user: owner,
			};

			const subqueryQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				status: ['success'],
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner'],
					projectRoles: ['project:personalOwner'],
				},
			};

			const [arrayResult, subqueryResult] = await Promise.all([
				executionService.findRangeWithCount(arrayQuery),
				executionService.findRangeWithCount(subqueryQuery),
			]);

			expect(arrayResult.count).toBe(2);
			expect(subqueryResult.count).toBe(2);
			expect(subqueryResult.results.map((r) => r.id)).toEqual(arrayResult.results.map((r) => r.id));
		});

		test('should filter by workflowId correctly', async () => {
			const workflow1 = await createWorkflow({}, member);
			const workflow2 = await createWorkflow({}, member);

			await Promise.all([
				createExecution({ status: 'success' }, workflow1),
				createExecution({ status: 'success' }, workflow2),
				createExecution({ status: 'success' }, workflow2),
			]);

			const arrayQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				workflowId: workflow1.id,
				user: owner,
			};

			const subqueryQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				workflowId: workflow1.id,
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner'],
					projectRoles: ['project:personalOwner'],
				},
			};

			const [arrayResult, subqueryResult] = await Promise.all([
				executionService.findRangeWithCount(arrayQuery),
				executionService.findRangeWithCount(subqueryQuery),
			]);

			expect(arrayResult.count).toBe(1);
			expect(subqueryResult.count).toBe(1);
			expect(subqueryResult.results[0].workflowId).toBe(workflow1.id);
		});

		test('should work with team project', async () => {
			const teamProject = await createTeamProject();
			const personalWorkflow = await createWorkflow({}, owner);
			const teamWorkflow = await createWorkflow({}, teamProject);

			await Promise.all([
				createExecution({ status: 'success' }, personalWorkflow),
				createExecution({ status: 'success' }, teamWorkflow),
			]);

			const arrayQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const arrayResult = await executionService.findRangeWithCount(arrayQuery);
			expect(arrayResult.count).toBe(2);
		});

		test('should work with sharing-enabled roles (team project admin)', async () => {
			// Simulates the isSharingEnabled() === true path in the controller
			const teamProject = await createTeamProject(undefined, member);
			const personalWorkflow = await createWorkflow({}, member);
			const teamWorkflow = await createWorkflow({}, teamProject);
			const inaccessibleWorkflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, personalWorkflow),
				createExecution({ status: 'success' }, teamWorkflow),
				createExecution({ status: 'error' }, teamWorkflow),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
			]);

			// Sharing-enabled roles: member can see workflows they own OR are admin/editor of
			const sharingEnabledQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner', 'workflow:editor'],
					projectRoles: ['project:personalOwner', 'project:admin', 'project:editor'],
				},
			};

			const result = await executionService.findRangeWithCount(sharingEnabledQuery);

			// member owns personalWorkflow and is admin of teamProject → sees 3 executions
			expect(result.count).toBe(3);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(personalWorkflow.id);
			expect(workflowIds).toContain(teamWorkflow.id);
			expect(workflowIds).not.toContain(inaccessibleWorkflow.id);
		});

		test('should work with sharing-enabled roles (team project editor)', async () => {
			// member is linked as project:editor to a team project they didn't create
			const teamProject = await createTeamProject();
			await linkUserToProject(member, teamProject, 'project:editor');
			const teamWorkflow = await createWorkflow({}, teamProject);
			const personalWorkflow = await createWorkflow({}, member);
			const inaccessibleWorkflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, teamWorkflow),
				createExecution({ status: 'success' }, personalWorkflow),
				createExecution({ status: 'success' }, inaccessibleWorkflow),
			]);

			const sharingEnabledQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner', 'workflow:editor'],
					projectRoles: ['project:personalOwner', 'project:admin', 'project:editor'],
				},
			};

			const result = await executionService.findRangeWithCount(sharingEnabledQuery);

			// member owns personalWorkflow and is editor in teamProject → sees 2 executions
			expect(result.count).toBe(2);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(teamWorkflow.id);
			expect(workflowIds).toContain(personalWorkflow.id);
			expect(workflowIds).not.toContain(inaccessibleWorkflow.id);
		});
	});

	describe('findLatestCurrentAndCompleted — subquery approach', () => {
		test('should return same results as array approach', async () => {
			const workflow = await createWorkflow({}, member);

			await Promise.all([
				createExecution({ status: 'running', stoppedAt: undefined }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'error' }, workflow),
			]);

			const arrayQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const subqueryQuery: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner'],
					projectRoles: ['project:personalOwner'],
				},
			};

			const [arrayResult, subqueryResult] = await Promise.all([
				executionService.findLatestCurrentAndCompleted(arrayQuery),
				executionService.findLatestCurrentAndCompleted(subqueryQuery),
			]);

			expect(arrayResult.count).toBe(subqueryResult.count);
			expect(arrayResult.results).toHaveLength(subqueryResult.results.length);

			const arrayIds = arrayResult.results.map((r) => r.id).sort();
			const subqueryIds = subqueryResult.results.map((r) => r.id).sort();
			expect(subqueryIds).toEqual(arrayIds);
		});
	});

	describe('getConcurrentExecutionsCount', () => {
		test('should return concurrentExecutionsCount when concurrency is enabled', async () => {
			globalConfig.executions.concurrency.productionLimit = 4;

			const workflow = await createWorkflow({}, owner);
			const concurrentExecutionsData = await Promise.all([
				createExecution({ status: 'running', mode: 'webhook' }, workflow),
				createExecution({ status: 'running', mode: 'trigger' }, workflow),
			]);

			await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'crashed' }, workflow),
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'running', mode: 'manual' }, workflow),
			]);

			const output = await executionService.getConcurrentExecutionsCount();
			expect(output).toEqual(concurrentExecutionsData.length);
		});

		test('should set concurrentExecutionsCount to -1 when concurrency is disabled', async () => {
			globalConfig.executions.concurrency.productionLimit = -1;

			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'running', mode: 'webhook' }, workflow),
				createExecution({ status: 'running', mode: 'trigger' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'crashed' }, workflow),
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'running', mode: 'manual' }, workflow),
			]);

			const output = await executionService.getConcurrentExecutionsCount();

			expect(output).toEqual(-1);
		});

		test('should set concurrentExecutionsCount to -1 in queue mode', async () => {
			globalConfig.executions.mode = 'queue';
			globalConfig.executions.concurrency.productionLimit = 4;

			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'running', mode: 'webhook' }, workflow),
				createExecution({ status: 'running', mode: 'trigger' }, workflow),
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'crashed' }, workflow),
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'running', mode: 'manual' }, workflow),
			]);

			const output = await executionService.getConcurrentExecutionsCount();

			expect(output).toEqual(-1);
		});
	});

	describe('findLatestCurrentAndCompleted', () => {
		test('should return latest current and completed executions', async () => {
			const workflow = await createWorkflow({}, owner);

			const totalCompleted = 21;

			await Promise.all([
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'running' }, workflow),
				...new Array(totalCompleted)
					.fill(null)
					.map(async () => await createExecution({ status: 'success' }, workflow)),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findLatestCurrentAndCompleted(query);

			expect(output.results).toHaveLength(23); // 3 current + 20 completed (excludes 21st)
			expect(output.count).toBe(totalCompleted); // 21 finished, excludes current
			expect(output.estimated).toBe(false);
		});

		test('should handle zero current executions', async () => {
			const workflow = await createWorkflow({}, owner);

			const totalFinished = 5;

			await Promise.all(
				new Array(totalFinished)
					.fill(null)
					.map(async () => await createExecution({ status: 'success' }, workflow)),
			);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findLatestCurrentAndCompleted(query);

			expect(output.results).toHaveLength(totalFinished); // 5 finished
			expect(output.count).toBe(totalFinished); // 5 finished, excludes active
			expect(output.estimated).toBe(false);
		});

		test('should handle zero completed executions', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'running' }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findLatestCurrentAndCompleted(query);

			expect(output.results).toHaveLength(3); // 3 finished
			expect(output.count).toBe(0); // 0 finished, excludes active
			expect(output.estimated).toBe(false);
		});

		test('should handle zero executions', async () => {
			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findLatestCurrentAndCompleted(query);

			expect(output.results).toHaveLength(0);
			expect(output.count).toBe(0);
			expect(output.estimated).toBe(false);
		});

		test('should prioritize `running` over `new` executions', async () => {
			const workflow = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'running' }, workflow),
				createExecution({ status: 'new' }, workflow),
				createExecution({ status: 'new' }, workflow),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 2 },
				user: owner,
			};

			const { results } = await executionService.findLatestCurrentAndCompleted(query);

			expect(results).toHaveLength(2);
			expect(results[0].status).toBe('running');
			expect(results[1].status).toBe('running');
		});
	});

	describe('annotation', () => {
		const summaryShape = {
			id: expect.any(String),
			workflowId: expect.any(String),
			mode: expect.any(String),
			retryOf: null,
			status: expect.any(String),
			createdAt: expect.any(String),
			startedAt: expect.any(String),
			stoppedAt: expect.any(String),
			waitTill: null,
			retrySuccessId: null,
			workflowName: expect.any(String),
		};

		afterEach(async () => {
			await testDb.truncate(['AnnotationTagEntity', 'ExecutionAnnotation']);
		});

		test('should add and retrieve annotation', async () => {
			const workflow = await createWorkflow({}, owner);

			const execution1 = await createExecution({ status: 'success' }, workflow);
			const execution2 = await createExecution({ status: 'success' }, workflow);

			const annotationTags = await createAnnotationTags(['tag1', 'tag2', 'tag3']);

			await annotateExecution(
				execution1.id,
				{ vote: 'up', tags: [annotationTags[0].id, annotationTags[1].id] },
				[workflow.id],
			);
			await annotateExecution(execution2.id, { vote: 'down', tags: [annotationTags[2].id] }, [
				workflow.id,
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(2);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual(
				expect.arrayContaining([
					{
						...summaryShape,
						annotation: {
							tags: [expect.objectContaining({ name: 'tag3' })],
							vote: 'down',
						},
					},
					{
						...summaryShape,
						annotation: {
							tags: expect.arrayContaining([
								expect.objectContaining({ name: 'tag1' }),
								expect.objectContaining({ name: 'tag2' }),
							]),
							vote: 'up',
						},
					},
				]),
			);
		});

		test('should update annotation', async () => {
			const workflow = await createWorkflow({}, owner);

			const execution = await createExecution({ status: 'success' }, workflow);

			const annotationTags = await createAnnotationTags(['tag1', 'tag2', 'tag3']);

			await annotateExecution(execution.id, { vote: 'up', tags: [annotationTags[0].id] }, [
				workflow.id,
			]);

			await annotateExecution(execution.id, { vote: 'down', tags: [annotationTags[1].id] }, [
				workflow.id,
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				{
					...summaryShape,
					annotation: {
						tags: [expect.objectContaining({ name: 'tag2' })],
						vote: 'down',
					},
				},
			]);
		});

		test('should filter by annotation tags', async () => {
			const workflow = await createWorkflow({}, owner);

			const executions = await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const annotationTags = await createAnnotationTags(['tag1', 'tag2', 'tag3']);

			await annotateExecution(
				executions[0].id,
				{ vote: 'up', tags: [annotationTags[0].id, annotationTags[1].id] },
				[workflow.id],
			);
			await annotateExecution(executions[1].id, { vote: 'down', tags: [annotationTags[2].id] }, [
				workflow.id,
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
				annotationTags: [annotationTags[0].id],
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				{
					...summaryShape,
					annotation: {
						tags: expect.arrayContaining([
							expect.objectContaining({ name: 'tag1' }),
							expect.objectContaining({ name: 'tag2' }),
						]),
						vote: 'up',
					},
				},
			]);
		});

		test('should filter by annotation vote', async () => {
			const workflow = await createWorkflow({}, owner);

			const executions = await Promise.all([
				createExecution({ status: 'success' }, workflow),
				createExecution({ status: 'success' }, workflow),
			]);

			const annotationTags = await createAnnotationTags(['tag1', 'tag2', 'tag3']);

			await annotateExecution(
				executions[0].id,
				{ vote: 'up', tags: [annotationTags[0].id, annotationTags[1].id] },
				[workflow.id],
			);
			await annotateExecution(executions[1].id, { vote: 'down', tags: [annotationTags[2].id] }, [
				workflow.id,
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				status: ['success'],
				range: { limit: 20 },
				user: owner,
				vote: 'up',
			};

			const output = await executionService.findRangeWithCount(query);

			expect(output.count).toBe(1);
			expect(output.estimated).toBe(false);
			expect(output.results).toEqual([
				{
					...summaryShape,
					annotation: {
						tags: expect.arrayContaining([
							expect.objectContaining({ name: 'tag1' }),
							expect.objectContaining({ name: 'tag2' }),
						]),
						vote: 'up',
					},
				},
			]);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// IAM-680 regression: IN subquery (non-correlated) access-control filter
	//
	// Background: IAM-371 replaced the `IN (:...ids)` approach with an EXISTS
	// correlated subquery to fix Postgres crashing with 382+ bind parameters.
	// IAM-680 discovered that the correlated subquery re-evaluates once per row
	// (1M evaluations at CrowdStrike scale), causing 2-3 s query times and high
	// CPU. The fix converts EXISTS back to an IN *non-correlated* subquery —
	// Postgres evaluates it once and uses a hash semi-join instead.
	//
	// These tests verify correctness of every access-control scenario so the
	// fix cannot silently regress either the IAM-371 or IAM-680 behaviour.
	// ─────────────────────────────────────────────────────────────────────────
	describe('findRangeWithCount — IAM-680: IN subquery regression tests', () => {
		// Sharing-enabled roles mirror the controller's isSharingEnabled() === true path.
		const sharingEnabled = {
			workflowRoles: ['workflow:owner', 'workflow:editor'],
			projectRoles: ['project:personalOwner', 'project:admin', 'project:editor'],
		};

		// Personal-only roles (no sharing license).
		const personalOnly = {
			workflowRoles: ['workflow:owner'],
			projectRoles: ['project:personalOwner'],
		};

		afterEach(async () => {
			// Clean up executions, then shared_workflow (FK → workflow), then workflows.
			// We deliberately do NOT truncate Project/ProjectRelation here to preserve
			// the personal projects of `member` and `owner` that were seeded in beforeAll.
			// Team projects accumulate across tests but are harmless — their workflows are
			// deleted, so they contribute zero executions to subsequent tests.
			await testDb.truncate(['ExecutionEntity']);
			await testDb.truncate(['SharedWorkflow']);
			await testDb.truncate(['WorkflowEntity']);
		});

		test('project:admin can see executions of all workflows in a team project', async () => {
			// Replicates the CrowdStrike scenario: a user is project:admin of a team
			// project and queries the executions list. With the EXISTS correlated
			// subquery this produced 2-3 s latency at 1M executions; with IN it uses
			// a hash semi-join and is O(1) relative to execution count.
			const teamProject = await createTeamProject(undefined, member);
			const wf1 = await createWorkflow({}, teamProject);
			const wf2 = await createWorkflow({}, teamProject);
			const otherProject = await createTeamProject();
			const otherWf = await createWorkflow({}, otherProject);

			await Promise.all([
				createExecution({ status: 'success' }, wf1),
				createExecution({ status: 'error' }, wf1),
				createExecution({ status: 'success' }, wf2),
				createExecution({ status: 'success' }, otherWf), // must NOT appear
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(3);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(wf1.id);
			expect(workflowIds).toContain(wf2.id);
			expect(workflowIds).not.toContain(otherWf.id);
		});

		test('project:editor can see executions of workflows in team project', async () => {
			const teamProject = await createTeamProject();
			await linkUserToProject(member, teamProject, 'project:editor');
			const teamWf = await createWorkflow({}, teamProject);
			const otherWf = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, teamWf),
				createExecution({ status: 'success' }, teamWf),
				createExecution({ status: 'success' }, otherWf), // must NOT appear
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			// member is editor of teamProject only; personalOwner has no workflows → 2
			expect(result.count).toBe(2);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(teamWf.id);
			expect(workflowIds).not.toContain(otherWf.id);
		});

		test('user sees executions across personal project AND team project', async () => {
			const teamProject = await createTeamProject(undefined, member);
			const personalWf = await createWorkflow({}, member);
			const teamWf = await createWorkflow({}, teamProject);
			const inaccessibleWf = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, personalWf),
				createExecution({ status: 'success' }, teamWf),
				createExecution({ status: 'error' }, teamWf),
				createExecution({ status: 'success' }, inaccessibleWf), // must NOT appear
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(3);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(personalWf.id);
			expect(workflowIds).toContain(teamWf.id);
			expect(workflowIds).not.toContain(inaccessibleWf.id);
		});

		test('status filter works correctly with IN subquery access control', async () => {
			const teamProject = await createTeamProject(undefined, member);
			const wf = await createWorkflow({}, teamProject);

			await Promise.all([
				createExecution({ status: 'success' }, wf),
				createExecution({ status: 'success' }, wf),
				createExecution({ status: 'error' }, wf),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				status: ['success'],
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(2);
			expect(result.results.every((r) => r.status === 'success')).toBe(true);
		});

		test('workflowId filter works correctly with IN subquery access control', async () => {
			const teamProject = await createTeamProject(undefined, member);
			const wf1 = await createWorkflow({}, teamProject);
			const wf2 = await createWorkflow({}, teamProject);

			await Promise.all([
				createExecution({ status: 'success' }, wf1),
				createExecution({ status: 'success' }, wf1),
				createExecution({ status: 'success' }, wf2),
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				workflowId: wf1.id,
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(2);
			expect(result.results.every((r) => r.workflowId === wf1.id)).toBe(true);
		});

		test('user with no accessible workflows sees empty result (no data leak)', async () => {
			// member has no personal workflows and is not in any team project.
			// The IN subquery must return an empty set — not all executions.
			const ownerWf = await createWorkflow({}, owner);
			await createExecution({ status: 'success' }, ownerWf);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: personalOnly,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(0);
			expect(result.results).toHaveLength(0);
		});

		test('member in multiple team projects sees executions from all of them', async () => {
			const project1 = await createTeamProject(undefined, member);
			const project2 = await createTeamProject();
			await linkUserToProject(member, project2, 'project:editor');

			const wf1 = await createWorkflow({}, project1);
			const wf2 = await createWorkflow({}, project2);
			const otherWf = await createWorkflow({}, owner);

			await Promise.all([
				createExecution({ status: 'success' }, wf1),
				createExecution({ status: 'success' }, wf2),
				createExecution({ status: 'success' }, wf2),
				createExecution({ status: 'success' }, otherWf), // must NOT appear
			]);

			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: sharingEnabled,
			};

			const result = await executionService.findRangeWithCount(query);

			expect(result.count).toBe(3);
			const workflowIds = result.results.map((r) => r.workflowId);
			expect(workflowIds).toContain(wf1.id);
			expect(workflowIds).toContain(wf2.id);
			expect(workflowIds).not.toContain(otherWf.id);
		});

		/**
		 * Performance smoke-test — IAM-680 regression guard.
		 *
		 * Seeds N_WORKFLOWS workflows (all owned by the same team project) and
		 * N_EXECUTIONS executions spread across them, then runs findRangeWithCount
		 * with project:admin sharingOptions QUERY_RUNS times.  The median must stay
		 * below THRESHOLD_MS.
		 *
		 * This exercises exactly the code-path that caused the CrowdStrike CPU spike:
		 * the IN subquery path for a non-global-admin user.  If someone accidentally
		 * reverts the fix back to a correlated EXISTS, even this moderate dataset will
		 * show noticeably higher latency, and the assertion will catch it on Postgres.
		 *
		 * On SQLite the dataset is smaller and the threshold is relaxed; SQLite is
		 * single-threaded and doesn't experience the same Seq Scan amplification.
		 */
		test('query time is acceptable at moderate scale (IAM-680 performance guard)', async () => {
			const isPostgres = process.env.DB_TYPE === 'postgresdb';

			// Dataset sizes: keep total seeding time < 30 s on CI.
			const N_WORKFLOWS = isPostgres ? 200 : 20;
			const N_EXECUTIONS_PER_WF = isPostgres ? 50 : 10; // 10 k / 200 total
			const QUERY_RUNS = 5;
			const THRESHOLD_MS = isPostgres ? 500 : 2000;

			// ── Seed ──────────────────────────────────────────────────────────
			const teamProject = await createTeamProject(undefined, member);

			// Create all workflows in parallel batches to keep seed time manageable.
			const BATCH = 20;
			const workflows = [];
			for (let i = 0; i < N_WORKFLOWS; i += BATCH) {
				const batchSize = Math.min(BATCH, N_WORKFLOWS - i);
				const batch = await Promise.all(
					Array.from({ length: batchSize }, async () => await createWorkflow({}, teamProject)),
				);
				workflows.push(...batch);
			}

			// Seed executions directly via the repository to avoid per-row overhead of
			// createExecution() (which also writes execution_data and metadata rows).
			const executionRepository = Container.get(ExecutionRepository);
			const execRecords = workflows.flatMap((wf) =>
				Array.from({ length: N_EXECUTIONS_PER_WF }, () => ({
					workflowId: wf.id,
					finished: true,
					mode: 'manual' as const,
					status: 'success' as const,
					createdAt: new Date(),
					startedAt: new Date(),
					stoppedAt: new Date(),
					waitTill: null,
				})),
			);

			// Insert in chunks to avoid hitting SQLite's SQLITE_MAX_VARIABLE_NUMBER.
			const INSERT_CHUNK = 500;
			for (let i = 0; i < execRecords.length; i += INSERT_CHUNK) {
				await executionRepository
					.createQueryBuilder()
					.insert()
					.into('execution_entity')
					.values(execRecords.slice(i, i + INSERT_CHUNK))
					.execute();
			}

			// ── Measure ───────────────────────────────────────────────────────
			const query: ExecutionSummaries.RangeQuery = {
				kind: 'range',
				range: { limit: 20 },
				user: member,
				sharingOptions: {
					workflowRoles: ['workflow:owner', 'workflow:editor'],
					projectRoles: ['project:personalOwner', 'project:admin', 'project:editor'],
				},
			};

			const latencies: number[] = [];
			for (let i = 0; i < QUERY_RUNS; i++) {
				const t0 = performance.now();
				await executionService.findRangeWithCount(query);
				latencies.push(performance.now() - t0);
			}

			const sorted = [...latencies].sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)]!;

			console.log(
				`[IAM-680 perf] ${N_WORKFLOWS} workflows × ${N_EXECUTIONS_PER_WF} execs each` +
					` | median ${median.toFixed(1)} ms | threshold ${THRESHOLD_MS} ms` +
					` | runs: [${latencies.map((v) => v.toFixed(1)).join(', ')}]`,
			);

			expect(median).toBeLessThan(THRESHOLD_MS);
		}, 120_000); // allow up to 2 min for seeding + queries on CI
	});
});

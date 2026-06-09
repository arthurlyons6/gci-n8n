import type { AddDatasetRowDto } from '@n8n/api-types';
import type { EvaluationConfig, IExecutionResponse } from '@n8n/db';
import type { EvaluationConfigRepository, ExecutionRepository } from '@n8n/db';
import { mock } from 'jest-mock-extended';
import type { IConnections, IRunData } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { DataTableColumn } from '@/modules/data-table/data-table-column.entity';
import type { DataTableService } from '@/modules/data-table/data-table.service';

import { EvaluationDatasetService } from '../evaluation-dataset.service';

describe('EvaluationDatasetService', () => {
	let configRepository: jest.Mocked<EvaluationConfigRepository>;
	let executionRepository: jest.Mocked<ExecutionRepository>;
	let dataTableService: jest.Mocked<DataTableService>;
	let service: EvaluationDatasetService;

	const WORKFLOW_ID = 'wf-1';
	const CONFIG_ID = 'cfg-1';
	const EXECUTION_ID = 'exec-1';
	const DATA_TABLE_ID = 'dt-1';
	const PROJECT_ID = 'proj-1';

	// Trigger -> Start -> End
	const connections: IConnections = {
		Trigger: { main: [[{ node: 'Start', type: 'main', index: 0 }]] },
		Start: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
	};

	function makeConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
		return {
			id: CONFIG_ID,
			workflowId: WORKFLOW_ID,
			datasetSource: 'data_table',
			datasetRef: { dataTableId: DATA_TABLE_ID },
			startNodeName: 'Start',
			endNodeName: 'End',
			...overrides,
		} as EvaluationConfig;
	}

	function makeColumns(): DataTableColumn[] {
		return [
			{ name: 'question', type: 'string' },
			{ name: 'answer', type: 'string' },
			{ name: 'unmatched', type: 'string' },
		] as DataTableColumn[];
	}

	function nodeOutput(json: Record<string, unknown>) {
		return [{ data: { main: [[{ json }]] } }];
	}

	function makeExecution(options: {
		status?: string;
		runData?: IRunData;
		connections?: IConnections;
	}): IExecutionResponse {
		const runData =
			options.runData ??
			({
				// `Trigger` is the parent of the start node — its output is the slice input.
				Trigger: nodeOutput({ question: 'Q1', extra: 'x' }),
				End: nodeOutput({ answer: 'A1' }),
			} as unknown as IRunData);

		return {
			status: options.status ?? 'success',
			workflowData: { nodes: [], connections: options.connections ?? connections },
			data: { resultData: { runData } },
		} as unknown as IExecutionResponse;
	}

	beforeEach(() => {
		jest.resetAllMocks();
		configRepository = mock<EvaluationConfigRepository>();
		executionRepository = mock<ExecutionRepository>();
		dataTableService = mock<DataTableService>();
		service = new EvaluationDatasetService(configRepository, executionRepository, dataTableService);

		configRepository.findByIdAndWorkflowId.mockResolvedValue(makeConfig());
		executionRepository.findSingleExecution.mockResolvedValue(makeExecution({}));
		dataTableService.getProjectIdForDataTable.mockResolvedValue(PROJECT_ID);
		dataTableService.getColumns.mockResolvedValue(makeColumns());
	});

	describe('getCandidate', () => {
		it('returns columns, input/output fields and a name-matched suggested mapping', async () => {
			const result = await service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID);

			expect(result.dataTableId).toBe(DATA_TABLE_ID);
			expect(result.columns).toEqual([
				{ name: 'question', type: 'string' },
				{ name: 'answer', type: 'string' },
				{ name: 'unmatched', type: 'string' },
			]);
			// Inputs come from the start node's parent (Trigger) output.
			expect(result.fields.inputs).toEqual([
				{ key: 'question', sample: 'Q1' },
				{ key: 'extra', sample: 'x' },
			]);
			expect(result.fields.outputs).toEqual([{ key: 'answer', sample: 'A1' }]);
			expect(result.suggestedMapping).toEqual({
				question: { source: 'input', field: 'question' },
				answer: { source: 'output', field: 'answer' },
				unmatched: null,
			});
		});

		it('matches column names case-insensitively and prefers inputs over outputs', async () => {
			dataTableService.getColumns.mockResolvedValue([
				{ name: 'Question', type: 'string' },
			] as DataTableColumn[]);
			executionRepository.findSingleExecution.mockResolvedValue(
				makeExecution({
					runData: {
						Trigger: nodeOutput({ question: 'Q1' }),
						End: nodeOutput({ question: 'fromOutput' }),
					} as unknown as IRunData,
				}),
			);

			const result = await service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID);

			expect(result.suggestedMapping).toEqual({
				Question: { source: 'input', field: 'question' },
			});
		});

		it('falls back to the start node output when it has no parent', async () => {
			executionRepository.findSingleExecution.mockResolvedValue(
				makeExecution({
					connections: {}, // no edges -> Start has no parent
					runData: {
						Start: nodeOutput({ question: 'fromStart' }),
						End: nodeOutput({ answer: 'A1' }),
					} as unknown as IRunData,
				}),
			);

			const result = await service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID);

			expect(result.fields.inputs).toEqual([{ key: 'question', sample: 'fromStart' }]);
		});

		it('throws NotFoundError when the config does not exist', async () => {
			configRepository.findByIdAndWorkflowId.mockResolvedValue(null);
			await expect(service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID)).rejects.toThrow(
				NotFoundError,
			);
		});

		it('throws BadRequestError when the config is not backed by a data table', async () => {
			configRepository.findByIdAndWorkflowId.mockResolvedValue(
				makeConfig({ datasetSource: 'google_sheets' }),
			);
			await expect(service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID)).rejects.toThrow(
				BadRequestError,
			);
		});

		it('throws NotFoundError when the execution does not exist', async () => {
			executionRepository.findSingleExecution.mockResolvedValue(undefined);
			await expect(service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID)).rejects.toThrow(
				NotFoundError,
			);
		});

		it('throws BadRequestError when the execution is not successful', async () => {
			executionRepository.findSingleExecution.mockResolvedValue(makeExecution({ status: 'error' }));
			await expect(service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID)).rejects.toThrow(
				BadRequestError,
			);
		});

		it('scopes the execution lookup to the workflow', async () => {
			await service.getCandidate(WORKFLOW_ID, CONFIG_ID, EXECUTION_ID);
			expect(executionRepository.findSingleExecution).toHaveBeenCalledWith(EXECUTION_ID, {
				includeData: true,
				unflattenData: true,
				where: { workflowId: WORKFLOW_ID },
			});
		});
	});

	describe('addRow', () => {
		it('inserts a single row built from the mapping and returns the inserted id', async () => {
			dataTableService.insertRows.mockResolvedValue([{ id: 7 }]);

			const dto: AddDatasetRowDto = {
				executionId: EXECUTION_ID,
				mapping: {
					question: { source: 'input', field: 'question' },
					answer: { source: 'output', field: 'answer' },
					unmatched: null,
				},
			};

			const result = await service.addRow(WORKFLOW_ID, CONFIG_ID, dto);

			expect(dataTableService.insertRows).toHaveBeenCalledWith(
				DATA_TABLE_ID,
				PROJECT_ID,
				[{ question: 'Q1', answer: 'A1' }],
				'id',
			);
			expect(result).toEqual([{ id: 7 }]);
		});

		it('skips columns whose mapped field is no longer present on the execution', async () => {
			const dto: AddDatasetRowDto = {
				executionId: EXECUTION_ID,
				mapping: {
					question: { source: 'input', field: 'question' },
					answer: { source: 'output', field: 'gone' },
				},
			};

			await service.addRow(WORKFLOW_ID, CONFIG_ID, dto);

			expect(dataTableService.insertRows).toHaveBeenCalledWith(
				DATA_TABLE_ID,
				PROJECT_ID,
				[{ question: 'Q1' }],
				'id',
			);
		});

		it('JSON-stringifies non-primitive values', async () => {
			executionRepository.findSingleExecution.mockResolvedValue(
				makeExecution({
					runData: {
						Trigger: nodeOutput({ payload: { nested: true } }),
						End: nodeOutput({ answer: 'A1' }),
					} as unknown as IRunData,
				}),
			);
			dataTableService.getColumns.mockResolvedValue([
				{ name: 'payload', type: 'string' },
			] as DataTableColumn[]);

			const dto: AddDatasetRowDto = {
				executionId: EXECUTION_ID,
				mapping: { payload: { source: 'input', field: 'payload' } },
			};

			await service.addRow(WORKFLOW_ID, CONFIG_ID, dto);

			expect(dataTableService.insertRows).toHaveBeenCalledWith(
				DATA_TABLE_ID,
				PROJECT_ID,
				[{ payload: '{"nested":true}' }],
				'id',
			);
		});
	});
});

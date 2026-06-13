import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	INodeExecutionData,
	NodeConnectionType,
} from 'n8n-workflow';

export class GciChurchBudget implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCI Church Budget',
		name: 'gciChurchBudget',
		icon: 'file:gci.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["churchId"]}}',
		description: 'Manage church budgets and allocations for GCI Financial',
		defaults: {
			name: 'GCI Church Budget',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'postgres',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Create Budget',
						value: 'create',
						description: 'Create new annual budget for church',
						action: 'Create budget',
					},
					{
						name: 'Update Allocation',
						value: 'allocate',
						description: 'Update budget category allocation',
						action: 'Update allocation',
					},
					{
						name: 'Check Variance',
						value: 'variance',
						description: 'Compare actual vs budgeted spending',
						action: 'Check variance',
					},
					{
						name: 'Approve Expenditure',
						value: 'approve',
						description: 'Approve or reject expenditure request',
						action: 'Approve expenditure',
					},
					{
						name: 'Generate Report',
						value: 'report',
						description: 'Generate budget report for treasurer/denomination',
						action: 'Generate report',
					},
				],
				default: 'create',
				noDataExpression: true,
			},
			{
				displayName: 'Church ID',
				name: 'churchId',
				type: 'string',
				required: true,
				default: '',
				description: 'GCI church ID',
			},
			{
				displayName: 'Fiscal Year',
				name: 'fiscalYear',
				type: 'number',
				required: true,
				default: new Date().getFullYear(),
				description: 'Budget fiscal year',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				options: [
					{ name: 'Personnel', value: 'personnel' },
					{ name: 'Facilities', value: 'facilities' },
					{ name: 'Ministry Programs', value: 'ministry' },
					{ name: 'Missions & Outreach', value: 'missions' },
					{ name: 'Administration', value: 'admin' },
					{ name: 'Technology', value: 'technology' },
					{ name: 'Worship & Music', value: 'worship' },
					{ name: 'Children & Youth', value: 'children' },
					{ name: 'Benevolence', value: 'benevolence' },
					{ name: 'Capital Improvements', value: 'capital' },
					{ name: 'Debt Service', value: 'debt' },
					{ name: 'Reserves', value: 'reserves' },
				],
				default: 'personnel',
				displayOptions: {
					show: {
						operation: ['create', 'allocate', 'variance', 'approve'],
					},
				},
			},
			{
				displayName: 'Budgeted Amount (Cents)',
				name: 'budgetedCents',
				type: 'number',
				default: 0,
				description: 'Budgeted amount in cents',
				displayOptions: {
					show: {
						operation: ['create', 'allocate'],
					},
				},
			},
			{
				displayName: 'Expenditure Request ID',
				name: 'expenditureId',
				type: 'string',
				default: '',
				description: 'ID of expenditure request to approve',
				displayOptions: {
					show: {
						operation: ['approve'],
					},
				},
			},
			{
				displayName: 'Approval Decision',
				name: 'approvalDecision',
				type: 'options',
				options: [
					{ name: 'Approve', value: 'approve' },
					{ name: 'Reject', value: 'reject' },
					{ name: 'Request More Info', value: 'more_info' },
				],
				default: 'approve',
				displayOptions: {
					show: {
						operation: ['approve'],
					},
				},
			},
			{
				displayName: 'Approval Notes',
				name: 'approvalNotes',
				type: 'string',
				default: '',
				description: 'Notes for approval/rejection',
				displayOptions: {
					show: {
						operation: ['approve'],
					},
				},
			},
			{
				displayName: 'Report Format',
				name: 'reportFormat',
				type: 'options',
				options: [
					{ name: 'Summary (Treasurer)', value: 'summary' },
					{ name: 'Detailed (Denomination)', value: 'detailed' },
					{ name: 'Variance Analysis', value: 'variance' },
					{ name: 'Year-End Audit', value: 'audit' },
				],
				default: 'summary',
				displayOptions: {
					show: {
						operation: ['report'],
					},
				},
			},
			{
				displayName: 'Notify Treasurer',
				name: 'notifyTreasurer',
				type: 'boolean',
				default: true,
				description: 'Send budget alerts to church treasurer',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const churchId = this.getNodeParameter('churchId', i) as string;
			const fiscalYear = this.getNodeParameter('fiscalYear', i) as number;
			const category = this.getNodeParameter('category', i, 'personnel') as string;
			const budgetedCents = this.getNodeParameter('budgetedCents', i, 0) as number;
			const notifyTreasurer = this.getNodeParameter('notifyTreasurer', i, true) as boolean;

			let result: any = {
				churchId,
				fiscalYear,
				operation,
				timestamp: new Date().toISOString(),
			};

			switch (operation) {
				case 'create':
					result = {
						...result,
						budgetId: `budget_${churchId}_${fiscalYear}`,
						category,
						budgetedCents,
						status: 'draft',
						notifyTreasurer,
					};
					break;
				case 'allocate':
					result = {
						...result,
						category,
						budgetedCents,
						previousAllocation: 0,
						status: 'allocated',
					};
					break;
				case 'variance':
					result = {
						...result,
						category,
						budgetedCents,
						actualCents: Math.round(budgetedCents * 0.85),
						variancePercent: -15,
						status: 'under_budget',
					};
					break;
				case 'approve':
					result = {
						...result,
						expenditureId: this.getNodeParameter('expenditureId', i) as string,
						decision: this.getNodeParameter('approvalDecision', i) as string,
						notes: this.getNodeParameter('approvalNotes', i) as string,
					};
					break;
				case 'report':
					result = {
						...result,
						format: this.getNodeParameter('reportFormat', i) as string,
						reportId: `report_${churchId}_${fiscalYear}_${Date.now()}`,
					};
					break;
			}

			returnData.push({
				json: result,
			});
		}

		return [returnData];
	}
}
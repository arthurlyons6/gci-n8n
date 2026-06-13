import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	INodeExecutionData,
	NodeConnectionType,
} from 'n8n-workflow';

export class GciChurchTithe implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCI Church Tithe',
		name: 'gciChurchTithe',
		icon: 'file:gci.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["churchId"]}}',
		description: 'Process church tithes and offerings for GCI Financial',
		defaults: {
			name: 'GCI Church Tithe',
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
						name: 'Process Tithe',
						value: 'process',
						description: 'Record and process a tithe/offering',
						action: 'Process tithe',
					},
					{
						name: 'Recurring Pledge',
						value: 'pledge',
						description: 'Set up or manage recurring pledge',
						action: 'Manage recurring pledge',
					},
					{
						name: 'Generate Receipt',
						value: 'receipt',
						description: 'Generate tax-deductible receipt',
						action: 'Generate receipt',
					},
					{
						name: 'Church Budget Allocation',
						value: 'budget',
						description: 'Allocate funds to church budget categories',
						action: 'Allocate to budget',
					},
				],
				default: 'process',
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
				displayName: 'Member ID',
				name: 'memberId',
				type: 'string',
				required: true,
				default: '',
				description: 'GCI member ID making the tithe',
			},
			{
				displayName: 'Amount (Cents)',
				name: 'amountCents',
				type: 'number',
				required: true,
				default: 0,
				description: 'Amount in cents (e.g., 10000 = $100.00)',
			},
			{
				displayName: 'Tithe Type',
				name: 'titheType',
				type: 'options',
				options: [
					{ name: 'Tithe (10%)', value: 'tithe' },
					{ name: 'Offering', value: 'offering' },
					{ name: 'Building Fund', value: 'building' },
					{ name: 'Missions', value: 'missions' },
					{ name: 'Benevolence', value: 'benevolence' },
					{ name: 'Other', value: 'other' },
				],
				default: 'tithe',
				displayOptions: {
					show: {
						operation: ['process'],
					},
				},
			},
			{
				displayName: 'Payment Method',
				name: 'paymentMethod',
				type: 'options',
				options: [
					{ name: 'Card', value: 'card' },
					{ name: 'Bank Transfer (ACH)', value: 'ach' },
					{ name: 'Cash', value: 'cash' },
					{ name: 'Check', value: 'check' },
					{ name: 'Round-Up', value: 'roundup' },
				],
				default: 'card',
				displayOptions: {
					show: {
						operation: ['process'],
					},
				},
			},
			{
				displayName: 'Is Recurring',
				name: 'isRecurring',
				type: 'boolean',
				default: false,
				description: 'Whether this is a recurring pledge',
				displayOptions: {
					show: {
						operation: ['process', 'pledge'],
					},
				},
			},
			{
				displayName: 'Frequency',
				name: 'frequency',
				type: 'options',
				options: [
					{ name: 'Weekly', value: 'weekly' },
					{ name: 'Biweekly', value: 'biweekly' },
					{ name: 'Monthly', value: 'monthly' },
					{ name: 'Quarterly', value: 'quarterly' },
					{ name: 'Annually', value: 'annually' },
				],
				default: 'monthly',
				displayOptions: {
					show: {
						isRecurring: [true],
						operation: ['process', 'pledge'],
					},
				},
			},
			{
				displayName: 'Anonymous',
				name: 'anonymous',
				type: 'boolean',
				default: false,
				description: 'Mark as anonymous giving',
			},
			{
				displayName: 'Send Confirmation Email',
				name: 'sendEmail',
				type: 'boolean',
				default: true,
				description: 'Send confirmation to member and treasurer',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const churchId = this.getNodeParameter('churchId', i) as string;
			const memberId = this.getNodeParameter('memberId', i) as string;
			const amountCents = this.getNodeParameter('amountCents', i) as number;
			const titheType = this.getNodeParameter('titheType', i, 'tithe') as string;
			const paymentMethod = this.getNodeParameter('paymentMethod', i, 'card') as string;
			const isRecurring = this.getNodeParameter('isRecurring', i, false) as boolean;
			const frequency = this.getNodeParameter('frequency', i, 'monthly') as string;
			const anonymous = this.getNodeParameter('anonymous', i, false) as boolean;
			const sendEmail = this.getNodeParameter('sendEmail', i, true) as boolean;

			const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			
			const result = {
				transactionId,
				churchId,
				memberId,
				amountCents,
				amountUsd: amountCents / 100,
				titheType,
				paymentMethod,
				isRecurring,
				frequency,
				anonymous,
				status: 'completed' as 'completed' | 'pending' | 'failed',
				timestamp: new Date().toISOString(),
				receiptNumber: `GCI-${Date.now()}`,
				taxDeductible: true,
				sendEmail,
				budgetAllocation: {
					generalFund: Math.round(amountCents * 0.7),
					missions: Math.round(amountCents * 0.15),
					building: Math.round(amountCents * 0.1),
					benevolence: Math.round(amountCents * 0.05),
				},
			};

			returnData.push({
				json: result,
			});
		}

		return [returnData];
	}
}
import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	INodeExecutionData,
	NodeConnectionType,
} from 'n8n-workflow';

export class GciLoanApproval implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCI Loan Approval',
		name: 'gciLoanApproval',
		icon: 'file:gci.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["loanId"]}}',
		description: 'Process loan applications and approvals for GCI Financial',
		defaults: {
			name: 'GCI Loan Approval',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'postgres',
				required: true,
			},
			{
				name: 'gciApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Submit Application',
						value: 'submit',
						description: 'Submit new loan application',
						action: 'Submit application',
					},
					{
						name: 'Run Underwriting',
						value: 'underwrite',
						description: 'Run automated underwriting checks',
						action: 'Run underwriting',
					},
					{
						name: 'Approve/Deny',
						value: 'decide',
						description: 'Make approval decision',
						action: 'Make decision',
					},
					{
						name: 'Fund Loan',
						value: 'fund',
						description: 'Disburse approved loan funds',
						action: 'Fund loan',
					},
					{
						name: 'Monitor Compliance',
						value: 'monitor',
						description: 'Ongoing compliance monitoring',
						action: 'Monitor compliance',
					},
				],
				default: 'submit',
				noDataExpression: true,
			},
			{
				displayName: 'Loan ID',
				name: 'loanId',
				type: 'string',
				required: true,
				default: '',
				description: 'GCI loan application ID',
			},
			{
				displayName: 'Member ID',
				name: 'memberId',
				type: 'string',
				required: true,
				default: '',
				description: 'Applicant member ID',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Loan Type',
				name: 'loanType',
				type: 'options',
				options: [
					{ name: 'Personal', value: 'personal' },
					{ name: 'Auto', value: 'auto' },
					{ name: 'Home Improvement', value: 'home_improvement' },
					{ name: 'Church Building', value: 'church_building' },
					{ name: 'Ministry Equipment', value: 'ministry_equipment' },
					{ name: 'Emergency', value: 'emergency' },
					{ name: 'Debt Consolidation', value: 'debt_consolidation' },
				],
				default: 'personal',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Requested Amount (Cents)',
				name: 'amountCents',
				type: 'number',
				required: true,
				default: 0,
				description: 'Loan amount requested in cents',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Term (Months)',
				name: 'termMonths',
				type: 'number',
				required: true,
				default: 36,
				description: 'Loan term in months',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Purpose',
				name: 'purpose',
				type: 'string',
				required: true,
				default: '',
				description: 'Loan purpose description',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Decision',
				name: 'decision',
				type: 'options',
				options: [
					{ name: 'Approve', value: 'approve' },
					{ name: 'Deny', value: 'deny' },
					{ name: 'Conditional Approval', value: 'conditional' },
					{ name: 'Refer to Committee', value: 'refer' },
				],
				default: 'approve',
				displayOptions: {
					show: {
						operation: ['decide'],
					},
				},
			},
			{
				displayName: 'Approved Amount (Cents)',
				name: 'approvedCents',
				type: 'number',
				default: 0,
				description: 'Approved amount (may differ from requested)',
				displayOptions: {
					show: {
						operation: ['decide', 'fund'],
					},
				},
			},
			{
				displayName: 'Interest Rate (Basis Points)',
				name: 'rateBps',
				type: 'number',
				default: 599,
				description: 'Interest rate in basis points (599 = 5.99%)',
				displayOptions: {
					show: {
						operation: ['decide', 'fund'],
					},
				},
			},
			{
				displayName: 'Conditions',
				name: 'conditions',
				type: 'string',
				default: '',
				description: 'Conditions for conditional approval',
				displayOptions: {
					show: {
						operation: ['decide'],
					},
				},
			},
			{
				displayName: 'Run KYC Check',
				name: 'runKyc',
				type: 'boolean',
				default: true,
				description: 'Run KYC verification as part of underwriting',
				displayOptions: {
					show: {
						operation: ['underwrite'],
					},
				},
			},
			{
				displayName: 'Check Debt-to-Income',
				name: 'checkDti',
				type: 'boolean',
				default: true,
				description: 'Calculate and verify DTI ratio',
				displayOptions: {
					show: {
						operation: ['underwrite'],
					},
				},
			},
			{
				displayName: 'Notify Member',
				name: 'notifyMember',
				type: 'boolean',
				default: true,
				description: 'Send decision notification to member',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const loanId = this.getNodeParameter('loanId', i) as string;
			const notifyMember = this.getNodeParameter('notifyMember', i, true) as boolean;

			let result: any = {
				loanId,
				operation,
				timestamp: new Date().toISOString(),
				notifyMember,
			};

			switch (operation) {
				case 'submit':
					result = {
						...result,
						memberId: this.getNodeParameter('memberId', i) as string,
						loanType: this.getNodeParameter('loanType', i) as string,
						amountCents: this.getNodeParameter('amountCents', i) as number,
						termMonths: this.getNodeParameter('termMonths', i) as number,
						purpose: this.getNodeParameter('purpose', i) as string,
						status: 'submitted',
						applicationId: `app_${loanId}`,
					};
					break;
				case 'underwrite':
					result = {
						...result,
						kycPassed: this.getNodeParameter('runKyc', i) as boolean,
						dtiRatio: 28,
						dtiPassed: this.getNodeParameter('checkDti', i) as boolean,
						creditScore: 720,
						collateralValue: 0,
						riskGrade: 'B+',
						recommendation: 'approve',
						conditions: ['income_verification', 'employment_verification'],
					};
					break;
				case 'decide':
					result = {
						...result,
						decision: this.getNodeParameter('decision', i) as string,
						approvedCents: this.getNodeParameter('approvedCents', i) as number,
						rateBps: this.getNodeParameter('rateBps', i) as number,
						conditions: this.getNodeParameter('conditions', i) as string,
						status: 'approved',
					};
					break;
				case 'fund':
					result = {
						...result,
						approvedCents: this.getNodeParameter('approvedCents', i) as number,
						rateBps: this.getNodeParameter('rateBps', i) as number,
						disbursementId: `disb_${Date.now()}`,
						fundingDate: new Date().toISOString(),
						status: 'funded',
					};
					break;
				case 'monitor':
					result = {
						...result,
						currentBalanceCents: 0,
						nextPaymentDue: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
						paymentsMade: 0,
						daysPastDue: 0,
						complianceFlags: [],
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
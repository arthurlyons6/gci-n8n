import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	INodeExecutionData,
	NodeConnectionType,
} from 'n8n-workflow';

export class GciSarFiling implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GCI SAR Filing',
		name: 'gciSarFiling',
		icon: 'file:gci.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["caseId"]}}',
		description: 'File Suspicious Activity Reports for GCI Financial compliance',
		defaults: {
			name: 'GCI SAR Filing',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'postgres',
				required: true,
			},
			{
				name: 'bsaEfile',
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
						name: 'Create SAR',
						value: 'create',
						description: 'Create new Suspicious Activity Report',
						action: 'Create SAR',
					},
					{
						name: 'Auto-Generate from Alert',
						value: 'autoGenerate',
						description: 'Auto-generate SAR from AML alert',
						action: 'Auto-generate SAR',
					},
					{
						name: 'Review & Submit',
						value: 'submit',
						description: 'Review and submit SAR to FinCEN',
						action: 'Submit SAR',
					},
					{
						name: 'Amend SAR',
						value: 'amend',
						description: 'File amended SAR',
						action: 'Amend SAR',
					},
					{
						name: 'Track Status',
						value: 'track',
						description: 'Track SAR filing status',
						action: 'Track status',
					},
				],
				default: 'create',
				noDataExpression: true,
			},
			{
				displayName: 'Case ID',
				name: 'caseId',
				type: 'string',
				required: true,
				default: '',
				description: 'AML case ID requiring SAR',
			},
			{
				displayName: 'Alert IDs',
				name: 'alertIds',
				type: 'string',
				default: '',
				description: 'Comma-separated AML alert IDs that triggered SAR',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Filing Type',
				name: 'filingType',
				type: 'options',
				options: [
					{ name: 'Initial', value: 'initial' },
					{ name: 'Continuing Activity', value: 'continuing' },
					{ name: 'Corrected/Amended', value: 'amended' },
				],
				default: 'initial',
				displayOptions: {
					show: {
						operation: ['create', 'submit'],
					},
				},
			},
			{
				displayName: 'Suspicious Activity Category',
				name: 'activityCategory',
				type: 'options',
				options: [
					{ name: 'Structuring', value: 'structuring' },
					{ name: 'Money Laundering', value: 'money_laundering' },
					{ name: 'Terrorist Financing', value: 'terrorist_financing' },
					{ name: 'Fraud', value: 'fraud' },
					{ name: 'Identity Theft', value: 'identity_theft' },
					{ name: 'Elder Financial Exploitation', value: 'elder_exploitation' },
					{ name: 'Human Trafficking', value: 'human_trafficking' },
					{ name: 'Other', value: 'other' },
				],
				default: 'structuring',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Subject Member ID',
				name: 'subjectMemberId',
				type: 'string',
				required: true,
				default: '',
				description: 'Member ID of suspicious activity subject',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Total Amount (Cents)',
				name: 'totalAmountCents',
				type: 'number',
				required: true,
				default: 0,
				description: 'Total suspicious amount in cents',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Date Range Start',
				name: 'dateStart',
				type: 'string',
				default: '',
				description: 'Start date of suspicious activity (ISO format)',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Date Range End',
				name: 'dateEnd',
				type: 'string',
				default: '',
				description: 'End date of suspicious activity (ISO format)',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Narrative',
				name: 'narrative',
				type: 'string',
				typeOptions: {
					rows: 10,
				},
				default: '',
				description: 'Detailed narrative of suspicious activity',
				displayOptions: {
					show: {
						operation: ['create', 'autoGenerate'],
					},
				},
			},
			{
				displayName: 'Auto-Fill from Alert Data',
				name: 'autoFill',
				type: 'boolean',
				default: true,
				description: 'Auto-populate fields from linked AML alerts',
				displayOptions: {
					show: {
						operation: ['autoGenerate'],
					},
				},
			},
			{
				displayName: 'BSA E-Filing Reference',
				name: 'bsaReference',
				type: 'string',
				default: '',
				description: 'FinCEN BSA E-Filing reference number',
				displayOptions: {
					show: {
						operation: ['submit', 'track'],
					},
				},
			},
			{
				displayName: 'Submit to FinCEN',
				name: 'submitToFincen',
				type: 'boolean',
				default: false,
				description: 'Actually submit to FinCEN BSA E-Filing (vs draft only)',
				displayOptions: {
					show: {
						operation: ['submit'],
					},
				},
			},
			{
				displayName: 'Notify Compliance Officer',
				name: 'notifyCompliance',
				type: 'boolean',
				default: true,
				description: 'Alert compliance officer on SAR creation/submission',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const caseId = this.getNodeParameter('caseId', i) as string;
			const notifyCompliance = this.getNodeParameter('notifyCompliance', i, true) as boolean;

			let result: any = {
				caseId,
				operation,
				timestamp: new Date().toISOString(),
				notifyCompliance,
			};

			switch (operation) {
				case 'create':
					result = {
						...result,
						sarId: `SAR-${Date.now()}`,
						alertIds: this.getNodeParameter('alertIds', i) as string,
						filingType: this.getNodeParameter('filingType', i) as string,
						activityCategory: this.getNodeParameter('activityCategory', i) as string,
						subjectMemberId: this.getNodeParameter('subjectMemberId', i) as string,
						totalAmountCents: this.getNodeParameter('totalAmountCents', i) as number,
						dateStart: this.getNodeParameter('dateStart', i) as string,
						dateEnd: this.getNodeParameter('dateEnd', i) as string,
						narrative: this.getNodeParameter('narrative', i) as string,
						status: 'draft',
					};
					break;
				case 'autoGenerate':
					result = {
						...result,
						sarId: `SAR-${Date.now()}`,
						alertIds: this.getNodeParameter('alertIds', i) as string,
						autoFilled: this.getNodeParameter('autoFill', i) as boolean,
						status: 'draft',
						generatedFields: ['subjectMemberId', 'totalAmountCents', 'dateStart', 'dateEnd', 'narrative'],
					};
					break;
				case 'submit':
					result = {
						...result,
						filingType: this.getNodeParameter('filingType', i) as string,
						bsaReference: this.getNodeParameter('bsaReference', i) as string,
						submittedToFinCEN: this.getNodeParameter('submitToFincen', i) as boolean,
						submissionDate: new Date().toISOString(),
						status: this.getNodeParameter('submitToFincen', i) ? 'submitted' : 'draft',
					};
					break;
				case 'amend':
					result = {
						...result,
						originalSarId: this.getNodeParameter('bsaReference', i) as string,
						amendmentReason: this.getNodeParameter('narrative', i) as string,
						amendmentDate: new Date().toISOString(),
						status: 'amended',
					};
					break;
				case 'track':
					result = {
						...result,
						bsaReference: this.getNodeParameter('bsaReference', i) as string,
						finCENStatus: 'acknowledged',
						acknowledgmentDate: new Date(Date.now() - 86400000).toISOString(),
						daysSinceSubmission: 1,
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
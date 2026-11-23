import type {
	IDataObject,
	IDisplayOptions,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	clean,
	conduytApiRequest,
	conduytApiRequestAllItems,
	confirmedSendOutcome,
	deliveryUnconfirmedMessage,
	EMAIL_CONFIRMED_SEND_TTL_MS,
	isIdempotentReplay,
	isPendingEmailOutcome,
	sendEnvelope,
	splitTags,
	storeConfirmedSendOutcome,
	storeUnconfirmedSendOutcome,
	unconfirmedSendOutcome,
	withInFlightWait,
	writeIdempotencyKey,
} from './GenericFunctions';

const RESOURCES = [
	{ name: 'Automation', value: 'automation' },
	{ name: 'Company', value: 'company' },
	{ name: 'Contact', value: 'contact' },
	{ name: 'Deal', value: 'deal' },
	{ name: 'Message', value: 'message' },
	{ name: 'Note', value: 'note' },
	{ name: 'Tag', value: 'tag' },
	{ name: 'Task', value: 'task' },
];

const RESOURCE_PATH: Record<string, string> = {
	company: '/companies',
	contact: '/contacts',
	deal: '/deals',
	message: '/messages',
	note: '/notes',
	tag: '/tags',
	task: '/tasks',
};

function show(resource: string, operation?: string | string[]): IDisplayOptions {
	const displayOptions: Record<string, string[]> = { resource: [resource] };
	if (operation) displayOptions.operation = Array.isArray(operation) ? operation : [operation];
	return { show: displayOptions };
}

const getAllFields = (resource: string): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean' as const,
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show(resource, 'getAll'),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number' as const,
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: [resource], operation: ['getAll'], returnAll: [false] } },
	},
];

/** Idempotency Key + in-flight wait, shared by the keyed write operations. */
const keyedWriteFields = (resource: string, operation: string): INodeProperties[] => [
	{
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '',
		description:
			'A key that names this one request, e.g. built from the upstream record or event ID (at most 255 characters, no leading or trailing whitespace). Conduyt runs a keyed request once: sending the same key with the same data again returns the stored result and the output says replayed = true; the same key with different data is rejected. Conduyt keeps the key for 24 hours.',
		displayOptions: show(resource, operation),
	},
	{
		displayName: 'Wait for In-Flight Copy (Seconds)',
		name: 'inFlightWaitSeconds',
		type: 'number',
		typeOptions: { minValue: 0, maxValue: 600 },
		default: 60,
		description:
			'Only with an Idempotency Key. When another copy of the same keyed request is still being processed (409), or Conduyt rolled the request back and asks for a retry (503), send the same keyed request again every 3 seconds for up to this long. It then returns the stored result (replayed = true). 0 = do not wait.',
		displayOptions: show(resource, operation),
	},
];

const idField = (resource: string, label: string, ops: string[]): INodeProperties => ({
	displayName: `${label} ID`,
	name: 'id',
	type: 'string' as const,
	default: '',
	required: true,
	displayOptions: show(resource, ops),
});

/** A JSON-object parameter (string or object); empty / '{}' gives undefined. */
function parseJsonObject(
	ctx: IExecuteFunctions,
	raw: unknown,
	label: string,
	itemIndex: number,
): IDataObject | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON`, { itemIndex });
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`, { itemIndex });
	}
	return Object.keys(value as IDataObject).length ? (value as IDataObject) : undefined;
}

/**
 * One POST, keyed when `key` is set; with a key, an in-flight answer is waited out under the
 * same key (see `withInFlightWait`). Returns the unwrapped body and whether Conduyt replayed
 * a stored result.
 */
async function keyedPost(
	ctx: IExecuteFunctions,
	endpoint: string,
	body: IDataObject,
	key: string | undefined,
	itemIndex: number,
	authenticated: boolean,
): Promise<{ result: unknown; replayed: boolean }> {
	let replayed = false;
	const waitSeconds = Number(ctx.getNodeParameter('inFlightWaitSeconds', itemIndex, 60));
	const budgetMs = key && Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1000 : 0;
	const result = await withInFlightWait(
		() =>
			conduytApiRequest.call(
				ctx,
				'POST',
				endpoint,
				body,
				{},
				key ? { 'Idempotency-Key': key } : {},
				(_status, rawBody, headers) => {
					replayed = isIdempotentReplay(rawBody, headers);
				},
				authenticated,
			),
		budgetMs,
	);
	return { result, replayed };
}

export class Conduyt implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Conduyt',
		name: 'conduyt',
		icon: { light: 'file:conduyt.svg', dark: 'file:conduyt.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Create and manage contacts, companies, deals, tasks, notes and messages in Conduyt CRM',
		defaults: { name: 'Conduyt' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'conduytApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: RESOURCES,
				default: 'contact',
			},

			// ---------- Automation ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('automation'),
				options: [
					{
						name: 'Trigger Webhook',
						value: 'triggerWebhook',
						description: 'Start a Conduyt automation that has a webhook trigger',
						action: 'Trigger an automation webhook',
					},
				],
				default: 'triggerWebhook',
			},
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				default: '',
				required: true,
				description:
					"The ID at the end of the automation's webhook URL (…/api/v1/webhooks/automation/&lt;ID&gt;). The automation runs before Conduyt answers.",
				displayOptions: show('automation', 'triggerWebhook'),
			},
			{
				displayName: 'Payload (JSON)',
				name: 'payload',
				type: 'json',
				default: '{}',
				description: "The JSON object the automation's trigger receives",
				displayOptions: show('automation', 'triggerWebhook'),
			},
			{
				displayName: 'Fail If Nothing Ran',
				name: 'failIfNothingRan',
				type: 'boolean',
				default: true,
				description:
					'Whether to fail the item when Conduyt ran no automation for this webhook (none matches it, or it is switched off). A repeat Conduyt recognised (deduplicated) is never a failure.',
				displayOptions: show('automation', 'triggerWebhook'),
			},
			...keyedWriteFields('automation', 'triggerWebhook'),

			// ---------- Contact ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('contact'),
				options: [
					{ name: 'Add Tags', value: 'addTags', description: 'Add tags to a contact', action: 'Add tags to a contact' },
					{ name: 'Create', value: 'create', description: 'Create a contact', action: 'Create a contact' },
					{ name: 'Get', value: 'get', description: 'Get a contact', action: 'Get a contact' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many contacts', action: 'Get many contacts' },
					{ name: 'Search', value: 'search', description: 'Find contacts by email or free text', action: 'Search contacts' },
					{ name: 'Update', value: 'update', description: 'Update a contact', action: 'Update a contact' },
				],
				default: 'create',
			},
			idField('contact', 'Contact', ['get', 'update', 'addTags']),
			{
				displayName: 'First Name',
				name: 'firstName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('contact', 'create'),
			},
			{
				displayName: 'Last Name',
				name: 'lastName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('contact', 'create'),
			},
			{
				displayName: 'Search By',
				name: 'searchBy',
				type: 'options',
				options: [
					{ name: 'Email', value: 'email' },
					{ name: 'Text', value: 'search' },
				],
				default: 'email',
				displayOptions: show('contact', 'search'),
			},
			{
				displayName: 'Search Value',
				name: 'searchValue',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('contact', 'search'),
			},
			{
				displayName: 'Tag Names or IDs',
				name: 'tagIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTags' },
				default: [],
				required: true,
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: show('contact', 'addTags'),
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('contact', ['create', 'update']),
				options: [
					{ displayName: 'Company', name: 'company', type: 'string', default: '' },
					{
						displayName: 'Custom Fields (JSON)',
						name: 'customFields',
						type: 'json',
						default: '{}',
						description: 'Object of custom field key to value',
					},
					{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '' },
					{ displayName: 'First Name', name: 'firstName', type: 'string', default: '' },
					{ displayName: 'Last Name', name: 'lastName', type: 'string', default: '' },
					{
						displayName: 'Phone',
						name: 'phone',
						type: 'string',
						default: '',
						description: 'E.164 format, e.g. +12065551234',
					},
					{ displayName: 'Source', name: 'source', type: 'string', default: '' },
					{
						displayName: 'Tags',
						name: 'tags',
						type: 'string',
						default: '',
						description: 'Comma-separated tag names',
					},
				],
			},

			// ---------- Company ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('company'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a company', action: 'Create a company' },
					{ name: 'Get', value: 'get', description: 'Get a company', action: 'Get a company' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many companies', action: 'Get many companies' },
					{ name: 'Update', value: 'update', description: 'Update a company', action: 'Update a company' },
				],
				default: 'create',
			},
			idField('company', 'Company', ['get', 'update']),
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('company', 'create'),
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('company', ['create', 'update']),
				options: [
					{ displayName: 'Address', name: 'address', type: 'string', default: '' },
					{ displayName: 'Domain', name: 'domain', type: 'string', default: '' },
					{ displayName: 'Industry', name: 'industry', type: 'string', default: '' },
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Phone', name: 'phone', type: 'string', default: '' },
					{ displayName: 'Size', name: 'size', type: 'string', default: '' },
				],
			},

			// ---------- Deal ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('deal'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a deal', action: 'Create a deal' },
					{
						name: 'Create for Contact',
						value: 'createForContact',
						description:
							'Find the contact by phone or email (or create it) and create a deal on it, in one step',
						action: 'Create a deal for a contact found or created by phone or email',
					},
					{ name: 'Get', value: 'get', description: 'Get a deal', action: 'Get a deal' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many deals', action: 'Get many deals' },
					{ name: 'Update', value: 'update', description: 'Update a deal', action: 'Update a deal' },
				],
				default: 'create',
			},
			idField('deal', 'Deal', ['get', 'update']),
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('deal', ['create', 'createForContact']),
			},
			{
				displayName: 'Contact Phone',
				name: 'contactPhone',
				type: 'string',
				default: '',
				description:
					"Used to find the contact (with Contact Email); normalized to E.164 with the account's default country. A phone or an email is required.",
				displayOptions: show('deal', 'createForContact'),
			},
			{
				displayName: 'Contact Email',
				name: 'contactEmail',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				displayOptions: show('deal', 'createForContact'),
			},
			{
				displayName: 'Contact First Name',
				name: 'contactFirstName',
				type: 'string',
				default: '',
				description:
					"Confirms a match (Conduyt's duplicate rules: the name never finds a contact, it confirms one) and names a new contact",
				displayOptions: show('deal', 'createForContact'),
			},
			{
				displayName: 'Contact Last Name',
				name: 'contactLastName',
				type: 'string',
				default: '',
				displayOptions: show('deal', 'createForContact'),
			},
			{
				displayName: 'Contact Company',
				name: 'contactCompany',
				type: 'string',
				default: '',
				description: 'Linked as the contact\'s company (also on an existing contact)',
				displayOptions: show('deal', 'createForContact'),
			},
			{
				displayName: 'Pipeline Name or ID',
				name: 'pipelineId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getPipelines' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: show('deal', ['create', 'createForContact']),
			},
			{
				displayName: 'Stage Name or ID',
				name: 'stageId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getStages', loadOptionsDependsOn: ['pipelineId'] },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: show('deal', ['create', 'createForContact']),
			},
			{
				displayName: 'Additional Fields',
				name: 'forContactFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('deal', 'createForContact'),
				options: [
					{
						displayName: 'Custom Fields (JSON)',
						name: 'customFields',
						type: 'json',
						default: '{}',
						description: 'Object of deal custom field key to value',
					},
					{ displayName: 'Expected Close Date', name: 'expectedCloseDate', type: 'dateTime', default: '' },
					{
						displayName: 'Source',
						name: 'source',
						type: 'string',
						default: '',
						description: 'The lead source on the deal, and on the contact when one is created',
					},
					{ displayName: 'Value', name: 'value', type: 'number', default: 0 },
				],
			},
			...keyedWriteFields('deal', 'createForContact'),
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('deal', ['create', 'update']),
				options: [
					{ displayName: 'Assigned To (User ID)', name: 'assignedTo', type: 'string', default: '' },
					{ displayName: 'Company ID', name: 'companyId', type: 'string', default: '' },
					{ displayName: 'Contact ID', name: 'contactId', type: 'string', default: '' },
					{
						displayName: 'Custom Fields (JSON)',
						name: 'customFields',
						type: 'json',
						default: '{}',
						description: 'Object of deal custom field key to value',
					},
					{ displayName: 'Expected Close Date', name: 'expectedCloseDate', type: 'dateTime', default: '' },
					{ displayName: 'Pipeline ID', name: 'pipelineId', type: 'string', default: '' },
					{ displayName: 'Source', name: 'source', type: 'string', default: '' },
					{ displayName: 'Stage ID', name: 'stageId', type: 'string', default: '' },
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'Open', value: 'open' },
							{ name: 'Won', value: 'won' },
							{ name: 'Lost', value: 'lost' },
						],
						default: 'open',
					},
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'number', default: 0 },
				],
			},

			// ---------- Task ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('task'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a task', action: 'Create a task' },
					{ name: 'Get', value: 'get', description: 'Get a task', action: 'Get a task' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many tasks', action: 'Get many tasks' },
					{ name: 'Update', value: 'update', description: 'Update a task', action: 'Update a task' },
				],
				default: 'create',
			},
			idField('task', 'Task', ['get', 'update']),
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('task', 'create'),
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('task', ['create', 'update']),
				options: [
					{ displayName: 'Assigned To (User ID)', name: 'assignedTo', type: 'string', default: '' },
					{ displayName: 'Contact ID', name: 'contactId', type: 'string', default: '' },
					{ displayName: 'Deal ID', name: 'dealId', type: 'string', default: '' },
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Due Date', name: 'dueDate', type: 'dateTime', default: '' },
					{
						displayName: 'Priority',
						name: 'priority',
						type: 'options',
						options: [
							{ name: 'Low', value: 'low' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'High', value: 'high' },
						],
						default: 'medium',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'To Do', value: 'todo' },
							{ name: 'Done', value: 'done' },
						],
						default: 'todo',
					},
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				],
			},

			// ---------- Note ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('note'),
				options: [
					{ name: 'Create', value: 'create', description: 'Add a note to a contact or deal', action: 'Create a note' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many notes', action: 'Get many notes' },
				],
				default: 'create',
			},
			{
				displayName: 'Content',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: show('note', 'create'),
			},
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				default: '',
				description: 'Attach the note to this contact (this or Deal ID is required)',
				displayOptions: show('note', 'create'),
			},
			{
				displayName: 'Deal ID',
				name: 'dealId',
				type: 'string',
				default: '',
				displayOptions: show('note', 'create'),
			},

			// ---------- Message ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('message'),
				options: [
					{ name: 'Send', value: 'send', description: 'Send an SMS or email to a contact', action: 'Send a message' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many messages', action: 'Get many messages' },
				],
				default: 'send',
			},
			{
				displayName:
					'Each item is sent with its own idempotency key, so Retry On Fail and a manual Retry of a failed execution do not resend a request Conduyt already confirmed. An SMS whose delivery Conduyt could not confirm is reported on the item instead, flagged deliveryUnconfirmed, and is never retried by this node within the same saved run; you decide whether to send it again. That protection lives in the run n8n saves after the report: a worker crash before n8n saves it loses the record, and Conduyt still allows another dispatch under the same key, so a retry after such a crash can resend it; check the conversation before retrying when you cannot rule that out. For email Conduyt keeps the key for 24 hours: a retry within 24 hours never sends twice, a retry after 24 hours sends the email again. Set Idempotency Key below to supply your own key from the upstream item instead: the key itself survives a worker crash between Conduyt accepting the request and n8n saving the run, but the saved request snapshot does not, so give the same key the same item data every time. Each key must belong to one item, with no leading or trailing whitespace; reusing it for a different item or node is rejected.',
				name: 'sendRetryNotice',
				type: 'notice',
				default: '',
				displayOptions: show('message', 'send'),
			},
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('message', 'send'),
			},
			{
				displayName: 'Channel',
				name: 'channel',
				type: 'options',
				options: [
					{ name: 'SMS', value: 'sms' },
					{ name: 'Email', value: 'email' },
				],
				default: 'sms',
				displayOptions: show('message', 'send'),
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['message'], operation: ['send'], channel: ['email'] } },
			},
			{
				displayName: 'From Number',
				name: 'fromNumber',
				type: 'string',
				placeholder: '+15555550123',
				default: '',
				description:
					"The number to send from: the account's number or an assigned agent line (DID). Leave empty to use the sending user's assigned line when they have one, otherwise the account number.",
				displayOptions: { show: { resource: ['message'], operation: ['send'], channel: ['sms'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: show('message', 'send'),
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'Map a unique ID from the upstream item, such as the record or event ID, sent exactly as given (SMS: 8 to 200 characters; email: up to 255). The key stays stable across any retry, including one after a worker crash, but the saved snapshot of the request does not survive that crash, only the key does, so the same key must always come with the same item data. A stable key does not cover an SMS reported deliveryUnconfirmed: Conduyt still allows another dispatch under the same key, so a worker crash before n8n saves the run can resend it on retry regardless of whether the key is generated or supplied here. Reusing a key for a different item or node is rejected, and so is one with leading or trailing whitespace. Left empty, the node generates a key that holds, snapshot included, for retries of the same execution, but a worker crash between Conduyt accepting the request and n8n saving the run can send it again.',
				displayOptions: show('message', 'send'),
			},

			// ---------- Tag ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('tag'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a tag', action: 'Create a tag' },
					{ name: 'Get Many', value: 'getAll', description: 'Get many tags', action: 'Get many tags' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: show('tag', 'create'),
			},

			// ---------- shared ----------
			...getAllFields('contact'),
			...getAllFields('company'),
			...getAllFields('deal'),
			...getAllFields('task'),
			...getAllFields('note'),
			...getAllFields('message'),
			...getAllFields('tag'),
		],
	};

	methods = {
		loadOptions: {
			async getPipelines(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const pipelines = (await conduytApiRequest.call(this, 'GET', '/pipelines')) as IDataObject[];
				return (pipelines || []).map((p) => ({ name: String(p.name), value: String(p.id) }));
			},
			async getStages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const pipelineId = this.getCurrentNodeParameter('pipelineId') as string;
				if (!pipelineId) return [];
				const stages = (await conduytApiRequest.call(
					this,
					'GET',
					`/pipelines/${pipelineId}/stages`,
				)) as IDataObject[];
				return (stages || []).map((s) => ({ name: String(s.name), value: String(s.id) }));
			},
			async getTags(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const tags = await conduytApiRequestAllItems.call(this, '/tags');
				return tags.map((t) => ({ name: String(t.name), value: String(t.id) }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const basePath = RESOURCE_PATH[resource];

		for (let i = 0; i < items.length; i++) {
			try {
				let result: unknown;

				if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
					result = await conduytApiRequestAllItems.call(this, basePath, {}, limit);
				} else if (operation === 'get') {
					const id = this.getNodeParameter('id', i) as string;
					result = await conduytApiRequest.call(this, 'GET', `${basePath}/${id}`);
				} else if (resource === 'contact' && operation === 'search') {
					const by = this.getNodeParameter('searchBy', i) as string;
					const value = (this.getNodeParameter('searchValue', i) as string).trim();
					const found = (await conduytApiRequest.call(this, 'GET', basePath, {}, {
						search: value,
						per_page: 25,
					})) as IDataObject[];
					result =
						by === 'email'
							? (found || []).filter(
									(c) => String(c.email ?? '').toLowerCase() === value.toLowerCase(),
								)
							: found;
				} else if (resource === 'contact' && operation === 'addTags') {
					const id = this.getNodeParameter('id', i) as string;
					const tagIds = this.getNodeParameter('tagIds', i) as string[];
					result = await conduytApiRequest.call(this, 'POST', `${basePath}/${id}/tags`, { tagIds });
				} else if (resource === 'note' && operation === 'create') {
					const body = clean({
						body: this.getNodeParameter('body', i) as string,
						contactId: this.getNodeParameter('contactId', i) as string,
						dealId: this.getNodeParameter('dealId', i) as string,
					});
					if (!body.contactId && !body.dealId) {
						throw new NodeOperationError(this.getNode(), 'A note needs a Contact ID or a Deal ID', {
							itemIndex: i,
						});
					}
					result = await conduytApiRequest.call(this, 'POST', basePath, body);
				} else if (resource === 'message' && operation === 'send') {
					// Both paths carry a per-item idempotency key so a retry never double-sends. The
					// key and the evaluated request travel together: a retry reuses the snapshot
					// instead of re-evaluating expressions next to a reused key.
					const envelope = sendEnvelope.call(
						this,
						i,
						this.getNodeParameter('idempotencyKey', i, ''),
						() => ({
							channel: this.getNodeParameter('channel', i) as string,
							contactId: this.getNodeParameter('contactId', i) as string,
							body: this.getNodeParameter('body', i) as string,
							subject: this.getNodeParameter('subject', i, '') as string,
							fromNumber: this.getNodeParameter('fromNumber', i, '') as string,
						}),
					);
					// Captured once per item so a lookup and a store in the same attempt agree on
					// "now"; see `confirmedSendOutcome` for why SMS and email expire differently.
					const now = Date.now();
					if (envelope.channel === 'sms') {
						// 0.1.6: outbound SMS goes through the delivery endpoint (provider delivery and
						// compliance checks run there); POST /messages refuses outbound SMS.
						const cachedUnconfirmed = unconfirmedSendOutcome.call(this, i);
						const cachedConfirmed = confirmedSendOutcome.call(this, i, now);
						if (cachedUnconfirmed) {
							// A LATER item threw on a previous attempt, so n8n reran every item in this
							// node, including this one, which already got a terminal-but-ambiguous result.
							// Conduyt itself would dispatch a deliveryUnconfirmed row again under the same
							// key, so replay the stored outcome instead of calling the endpoint again.
							result = cachedUnconfirmed;
						} else if (cachedConfirmed) {
							// Same situation, the common case: this item already sent and got back a
							// confirmed result, but a LATER item failed, so a retry reruns this one too.
							// Conduyt's SMS route counts a request against its per-user rate limiter
							// BEFORE it checks the idempotency key, so resending an already-confirmed
							// item would spend a fresh rate-limit window on a message that already went
							// out instead of ever reaching the item that still needs to send. Replay the
							// stored outcome instead of calling the endpoint again.
							result = cachedConfirmed;
						} else {
							try {
								result = await conduytApiRequest.call(
									this,
									'POST',
									'/messages/sms/send',
									clean({
										contactId: envelope.contactId,
										body: envelope.body,
										fromNumber: envelope.fromNumber,
										idempotencyKey: envelope.idempotencyKey,
									}),
								);
								// SMS has no pending/terminal split and no expiry: Conduyt's own operation
								// key for this route is permanent server-side, so the cache never expires.
								storeConfirmedSendOutcome.call(this, i, result as IDataObject, now, null);
							} catch (error) {
								const unconfirmed = deliveryUnconfirmedMessage(error);
								if (!unconfirmed) throw error;
								// Conduyt treats a same-key deliveryUnconfirmed row as free to dispatch again,
								// and n8n retries any thrown node error when Retry On Fail is on, so throwing
								// here risks the exact double-send this node exists to prevent. Report it on
								// the item instead, success or not: the node never retries an unconfirmed send
								// on its own, the user decides whether to send it again. Cached by slot so a
								// later item's failure can't cause this one to be sent again on retry.
								result = {
									...unconfirmed,
									deliveryUnconfirmed: true,
									warning:
										'Conduyt could not confirm this SMS reached the recipient; the provider may already have delivered it. This node does not retry an unconfirmed send automatically, check delivery before sending again.',
								};
								storeUnconfirmedSendOutcome.call(this, i, result as IDataObject);
							}
						}
					} else {
						// Email stays on POST /messages (as in 0.1.5): the API resolves the recipient
						// from the contact and renders merge fields.
						const cachedConfirmed = confirmedSendOutcome.call(this, i, now);
						if (cachedConfirmed) {
							// Same mechanism as the SMS branch above: a later item's failure in the same
							// batch must not resend an email that already went out on a retry, as long as
							// Conduyt's own 24-hour key window for this send has not yet closed (checked
							// inside confirmedSendOutcome); past it, this is a cache miss and falls
							// through to a genuine resend below, same as Conduyt's own key handling.
							result = cachedConfirmed;
						} else {
							let statusCode: number | undefined;
							result = await conduytApiRequest.call(
								this,
								'POST',
								basePath,
								clean({
									contactId: envelope.contactId,
									channel: envelope.channel,
									direction: 'outbound',
									subject: envelope.subject,
									body: envelope.body,
								}),
								{},
								{ 'Idempotency-Key': envelope.idempotencyKey },
								(code) => {
									statusCode = code;
								},
							);
							// A pending response (HTTP 202, a real POST /messages ambiguous-outcome
							// acceptance) has not reached a terminal state yet; caching it as confirmed
							// could skip the email being sent for real. Only cache a terminal result,
							// and only for 24 hours, matching Conduyt's own email key window.
							if (!isPendingEmailOutcome(result, statusCode)) {
								storeConfirmedSendOutcome.call(
									this,
									i,
									result as IDataObject,
									now,
									EMAIL_CONFIRMED_SEND_TTL_MS,
								);
							}
						}
					}
				} else if (resource === 'deal' && operation === 'createForContact') {
					// POST /webhooks/inbound/deals: Conduyt finds the contact by phone / email under
					// its duplicate rules (or creates it) and creates the deal, in ONE transaction
					// together with the Idempotency-Key claim, so a keyed repeat can never make a
					// second contact or deal.
					const key = writeIdempotencyKey(this.getNode(), this.getNodeParameter('idempotencyKey', i, ''), i);
					const contact = clean({
						phone: String(this.getNodeParameter('contactPhone', i, '') ?? '').trim(),
						email: String(this.getNodeParameter('contactEmail', i, '') ?? '').trim(),
						firstName: String(this.getNodeParameter('contactFirstName', i, '') ?? '').trim(),
						lastName: String(this.getNodeParameter('contactLastName', i, '') ?? '').trim(),
						company: String(this.getNodeParameter('contactCompany', i, '') ?? '').trim(),
					});
					if (!contact.phone && !contact.email) {
						throw new NodeOperationError(this.getNode(), 'A Contact Phone or Contact Email is required', {
							itemIndex: i,
						});
					}
					const extra = this.getNodeParameter('forContactFields', i, {}) as IDataObject;
					const body = clean({
						title: this.getNodeParameter('title', i) as string,
						pipelineId: this.getNodeParameter('pipelineId', i, '') as string,
						stageId: this.getNodeParameter('stageId', i, '') as string,
						source: extra.source,
						value: extra.value,
						expectedCloseDate: extra.expectedCloseDate,
						customFields: parseJsonObject(this, extra.customFields, 'Custom Fields', i),
						contact,
					});
					const keyed = await keyedPost(this, '/webhooks/inbound/deals', body, key, i, true);
					result = { ...(keyed.result as IDataObject), replayed: keyed.replayed };
				} else if (resource === 'automation' && operation === 'triggerWebhook') {
					// POST /webhooks/automation/{id}: public, takes no API key, runs the automation
					// before it answers { ok, triggered } (or { ok, triggered: 0, deduplicated: true }
					// for a repeat it recognised by the key, else by the body's hash).
					const webhookId = String(this.getNodeParameter('webhookId', i) ?? '').trim();
					if (!webhookId) {
						throw new NodeOperationError(this.getNode(), 'Webhook ID is required', { itemIndex: i });
					}
					const key = writeIdempotencyKey(this.getNode(), this.getNodeParameter('idempotencyKey', i, ''), i);
					const payload = parseJsonObject(this, this.getNodeParameter('payload', i, '{}'), 'Payload', i) ?? {};
					const keyed = await keyedPost(
						this,
						`/webhooks/automation/${encodeURIComponent(webhookId)}`,
						payload,
						key,
						i,
						false,
					);
					const answer = (keyed.result ?? {}) as IDataObject;
					const triggered = Number(answer.triggered ?? 0);
					const deduplicated = answer.deduplicated === true;
					if (this.getNodeParameter('failIfNothingRan', i, true) && !deduplicated && !(triggered > 0)) {
						throw new NodeOperationError(
							this.getNode(),
							`No automation ran for webhook ${webhookId}: none matches it, or it is switched off`,
							{ itemIndex: i },
						);
					}
					result = { ok: answer.ok === true, triggered, deduplicated, replayed: deduplicated };
				} else if (resource === 'tag' && operation === 'create') {
					result = await conduytApiRequest.call(this, 'POST', basePath, {
						name: this.getNodeParameter('name', i) as string,
					});
				} else if (operation === 'create' || operation === 'update') {
					const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					const body: IDataObject = { ...additional };

					if (operation === 'create') {
						if (resource === 'contact') {
							body.firstName = this.getNodeParameter('firstName', i);
							body.lastName = this.getNodeParameter('lastName', i);
						}
						if (resource === 'company') body.name = this.getNodeParameter('name', i);
						if (resource === 'task') body.title = this.getNodeParameter('title', i);
						if (resource === 'deal') {
							body.title = this.getNodeParameter('title', i);
							body.pipelineId = this.getNodeParameter('pipelineId', i, '');
							body.stageId = this.getNodeParameter('stageId', i, '');
						}
					}
					if (typeof body.tags === 'string') body.tags = splitTags(body.tags);
					if (typeof body.customFields === 'string') {
						try {
							body.customFields = JSON.parse(body.customFields as string);
						} catch {
							throw new NodeOperationError(this.getNode(), 'Custom Fields must be valid JSON', {
								itemIndex: i,
							});
						}
					}

					const cleaned = clean(body);
					if (operation === 'create') {
						result = await conduytApiRequest.call(this, 'POST', basePath, cleaned);
					} else {
						const id = this.getNodeParameter('id', i) as string;
						result = await conduytApiRequest.call(this, 'PATCH', `${basePath}/${id}`, cleaned);
					}
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for ${resource}`,
						{ itemIndex: i },
					);
				}

				const out = this.helpers.returnJsonArray(
					(Array.isArray(result) ? result : [result]) as IDataObject[],
				);
				returnData.push(...this.helpers.constructExecutionMetaData(out, { itemData: { item: i } }));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Both constructors return the original instance when it is already of that class,
				// so errors raised by conduytApiRequest keep their HTTP context.
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

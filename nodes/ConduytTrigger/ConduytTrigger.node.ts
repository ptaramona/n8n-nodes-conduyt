import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { conduytApiRequest, conduytApiRequestAllItems } from '../Conduyt/GenericFunctions';

const EVENTS: Array<{ name: string; value: string }> = [
	{ name: 'Appointment Booked', value: 'appointment.booked' },
	{ name: 'Appointment Cancelled', value: 'appointment.cancelled' },
	{ name: 'Appointment Created', value: 'appointment.created' },
	{ name: 'Appointment Updated', value: 'appointment.updated' },
	{ name: 'Call Completed', value: 'call.completed' },
	{ name: 'Call Dispositioned', value: 'call.dispositioned' },
	{ name: 'Call Missed', value: 'call.missed' },
	{ name: 'Campaign Completed', value: 'campaign.completed' },
	{ name: 'Company Created', value: 'company.created' },
	{ name: 'Company Stage Changed', value: 'company.stage_changed' },
	{ name: 'Company Updated', value: 'company.updated' },
	{ name: 'Contact Assigned', value: 'contact.assigned' },
	{ name: 'Contact Created', value: 'contact.created' },
	{ name: 'Contact Deleted', value: 'contact.deleted' },
	{ name: 'Contact Tag Added', value: 'contact.tag_added' },
	{ name: 'Contact Tag Removed', value: 'contact.tag_removed' },
	{ name: 'Contact Updated', value: 'contact.updated' },
	{ name: 'Deal Created', value: 'deal.created' },
	{ name: 'Deal Deleted', value: 'deal.deleted' },
	{ name: 'Deal Lost', value: 'deal.lost' },
	{ name: 'Deal Stage Changed', value: 'deal.stage_changed' },
	{ name: 'Deal Stalled', value: 'deal.stalled' },
	{ name: 'Deal Updated', value: 'deal.updated' },
	{ name: 'Deal Won', value: 'deal.won' },
	{ name: 'Document Sent', value: 'document.sent' },
	{ name: 'Document Viewed', value: 'document.viewed' },
	{ name: 'Form Submitted', value: 'form.submitted' },
	{ name: 'Invoice Paid', value: 'invoice.paid' },
	{ name: 'Message Received', value: 'message.received' },
	{ name: 'Message Sent', value: 'message.sent' },
	{ name: 'Note Created', value: 'note.created' },
	{ name: 'Task Completed', value: 'task.completed' },
	{ name: 'Task Created', value: 'task.created' },
];

export class ConduytTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Conduyt Trigger',
		name: 'conduytTrigger',
		icon: 'file:../Conduyt/conduyt.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when something happens in Conduyt CRM',
		defaults: { name: 'Conduyt Trigger' },
		inputs: [],
		outputs: ['main'],
		credentials: [{ name: 'conduytApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: EVENTS,
				default: ['contact.created'],
				required: true,
				description: 'The Conduyt events that start this workflow',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const staticData = this.getWorkflowStaticData('node');

				if (staticData.webhookId) {
					try {
						await conduytApiRequest.call(this, 'GET', `/webhooks/manage/${staticData.webhookId}`);
						return true;
					} catch {
						delete staticData.webhookId;
						delete staticData.webhookSecret;
					}
				}

				// Adopt an existing subscription pointing at this URL (e.g. after an import).
				const existing = await conduytApiRequestAllItems.call(this, '/webhooks');
				const match = existing.find((w) => w.url === webhookUrl);
				if (match) {
					staticData.webhookId = match.id;
					return true;
				}
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				const staticData = this.getWorkflowStaticData('node');

				const response = (await conduytApiRequest.call(this, 'POST', '/webhooks', {
					url: webhookUrl,
					events,
					description: `n8n: ${this.getWorkflow().name ?? 'workflow'}`,
				})) as IDataObject;

				if (!response || !response.id) return false;
				staticData.webhookId = response.id;
				// The signing secret is only returned once, on create.
				if (typeof response.secret === 'string') staticData.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.webhookId) {
					try {
						await conduytApiRequest.call(this, 'DELETE', `/webhooks/manage/${staticData.webhookId}`);
					} catch {
						return false;
					}
					delete staticData.webhookId;
					delete staticData.webhookSecret;
				}
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const staticData = this.getWorkflowStaticData('node');
		const secret = staticData.webhookSecret as string | undefined;

		// Verify X-Conduyt-Signature (sha256=<hex HMAC of the raw body>) when we hold the secret.
		if (secret) {
			const header = String(req.headers['x-conduyt-signature'] ?? '');
			const provided = header.startsWith('sha256=') ? header.slice(7) : header;
			const raw =
				typeof req.rawBody === 'object' && req.rawBody
					? Buffer.from(req.rawBody as Buffer).toString('utf8')
					: JSON.stringify(req.body);
			const expected = createHmac('sha256', secret).update(raw).digest('hex');
			const ok =
				provided.length === expected.length &&
				timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
			if (!ok) {
				res.status(401).send('Invalid signature');
				return { noWebhookResponse: true };
			}
		}

		const body = req.body as IDataObject;
		const events = this.getNodeParameter('events') as string[];
		if (body?.event && events.length && !events.includes(String(body.event))) {
			// Subscribed elsewhere for other events on the same URL; acknowledge and skip.
			return { workflowData: [[]] };
		}

		return {
			workflowData: [this.helpers.returnJsonArray(body)],
		};
	}
}

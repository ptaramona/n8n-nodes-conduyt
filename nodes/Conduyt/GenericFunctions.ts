import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IHttpRequestOptions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { createHash } from 'crypto';

type ConduytContext = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

/**
 * Conduyt wraps responses as { data: <payload> }. List endpoints nest once more:
 * { data: { data: [...], meta: {...} } }. Unwrap both shapes.
 */
export function unwrap(body: unknown): unknown {
	if (body && typeof body === 'object' && 'data' in (body as IDataObject)) {
		const inner = (body as IDataObject).data;
		if (
			inner &&
			typeof inner === 'object' &&
			!Array.isArray(inner) &&
			Array.isArray((inner as IDataObject).data)
		) {
			return (inner as IDataObject).data;
		}
		return inner;
	}
	return body;
}

export async function conduytApiRequest(
	this: ConduytContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	headers: Record<string, string> = {},
): Promise<unknown> {
	const credentials = await this.getCredentials('conduytApi');
	const baseUrl = ((credentials.baseUrl as string) || 'https://conduyt.app/api/v1').replace(
		/\/+$/,
		'',
	);

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${endpoint}`,
		qs,
		body,
		json: true,
		headers: {
			Accept: 'application/json',
			'User-Agent': 'n8n-nodes-conduyt',
			...headers,
		},
	};
	if (Object.keys(body).length === 0) delete options.body;
	if (Object.keys(qs).length === 0) delete options.qs;

	try {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'conduytApi',
			options,
		);
		return unwrap(response);
	} catch (error) {
		const err = error as JsonObject & { message?: string; description?: string };
		const responseBody = ((err.response as JsonObject | undefined)?.body ??
			(err.error as JsonObject | undefined) ??
			{}) as JsonObject;
		const apiMessage =
			(typeof responseBody.error === 'string' && responseBody.error) ||
			(typeof responseBody.message === 'string' && responseBody.message) ||
			undefined;
		throw new NodeApiError(this.getNode(), err, {
			message: apiMessage ? `Conduyt API: ${apiMessage}` : undefined,
			description: apiMessage ?? err.message,
		});
	}
}

/**
 * Follow Conduyt's page / per_page pagination until exhausted or `limit` reached.
 */
export async function conduytApiRequestAllItems(
	this: ConduytContext,
	endpoint: string,
	qs: IDataObject = {},
	limit = 0,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let page = 1;
	const perPage = limit > 0 && limit < 100 ? limit : 100;

	while (true) {
		const pageItems = (await conduytApiRequest.call(this, 'GET', endpoint, {}, {
			...qs,
			page,
			per_page: perPage,
		})) as IDataObject[];
		if (!Array.isArray(pageItems) || pageItems.length === 0) break;
		results.push(...pageItems);
		if (limit > 0 && results.length >= limit) return results.slice(0, limit);
		if (pageItems.length < perPage) break;
		page += 1;
	}
	return results;
}

/** Flow-context key that pins the first execution id of a retry family (see below). */
const ROOT_EXECUTION_ID_KEY = 'conduytRootExecutionId';

/**
 * Stable per-item key for a send, so a retry is deduplicated by the API instead of sent
 * twice: Retry On Fail, a network timeout after Conduyt already handed the message to
 * the provider, and a manual "Retry execution" of a failed run.
 *
 * A manual retry gets a NEW execution id (the original survives only as `retryOf`, which
 * nodes cannot read), but n8n resumes it from the saved run data of the failed execution,
 * and the flow context is part of that data. So the first send in an execution pins the
 * execution id in the flow context and every retry in the family reads it back; a fresh
 * execution starts with an empty context and gets a fresh key.
 *
 * The node run index is in the hash too: a node inside a loop restarts its item indexes
 * at 0 on every run, so item index alone would reuse the previous iteration's keys.
 * Hashed so the key stays within the API's length caps whatever the node name is.
 */
export function sendIdempotencyKey(this: IExecuteFunctions, itemIndex: number): string {
	const flow = this.getContext('flow');
	if (typeof flow[ROOT_EXECUTION_ID_KEY] !== 'string') {
		flow[ROOT_EXECUTION_ID_KEY] = this.getExecutionId();
	}
	const parts = [
		this.getWorkflow().id ?? '',
		flow[ROOT_EXECUTION_ID_KEY] as string,
		this.getNode().name,
		String(this.getWorkflowDataProxy(itemIndex).$thisRunIndex),
		String(itemIndex),
	];
	return `n8n-${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

/** Flow-context key under which evaluated send envelopes are kept, by stable send slot. */
const SEND_ENVELOPES_KEY = 'conduytSendEnvelopes';

/** Flow-context key recording which stable send slot currently owns a caller-supplied key. */
const SEND_KEY_OWNERS_KEY = 'conduytSendKeyOwners';

/** Everything a Message > Send request is built from, frozen at first evaluation. */
export interface SendEnvelope {
	idempotencyKey: string;
	channel: string;
	contactId: string;
	body: string;
	subject: string;
	fromNumber: string;
}

function isSendEnvelope(value: unknown): value is SendEnvelope {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return ['idempotencyKey', 'channel', 'contactId', 'body', 'subject', 'fromNumber'].every(
		(field) => typeof v[field] === 'string',
	);
}

/**
 * Identifies one item's send independent of any execution id: this node, this loop run,
 * this item, every time this exact send is attempted. Snapshots are cached by slot rather
 * than by the wire key so that a caller-supplied key reused by a different item or node is
 * a detectable collision instead of one send silently returning another's cached envelope.
 */
function sendSlot(this: IExecuteFunctions, itemIndex: number): string {
	const parts = [
		this.getNode().name,
		String(this.getWorkflowDataProxy(itemIndex).$thisRunIndex),
		String(itemIndex),
	];
	return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Conduyt's own key-length bounds, checked here so a bad key fails before the request goes out. */
function assertCallerKeyLength(node: INode, channel: string, key: string, itemIndex: number): void {
	if (channel === 'sms') {
		if (key.length < 8 || key.length > 200) {
			throw new NodeOperationError(
				node,
				`Idempotency Key must be 8 to 200 characters for SMS, got ${key.length}`,
				{ itemIndex },
			);
		}
	} else if (key.length > 255) {
		throw new NodeOperationError(
			node,
			`Idempotency Key must be at most 255 characters for email, got ${key.length}`,
			{ itemIndex },
		);
	}
}

/**
 * The envelope that goes with an item's idempotency key. Both Conduyt endpoints bind a key
 * to the request content, and n8n re-evaluates expressions ($now, $execution.id, ...) on a
 * manual retry, so re-reading the parameters next to a reused key would turn a retry into
 * a conflict (same channel, different payload) or into a request on the other endpoint
 * (channel changed). The first evaluation is kept in the flow context, under the item's
 * stable send slot, which rides the saved run data into every retry of the family, and
 * every later attempt against that same slot reuses it.
 *
 * `callerKey`, when non-empty (trimming is used only to test for emptiness; the key is
 * cached and sent exactly as given), is used as the idempotency key instead of the
 * generated one, and skips `sendIdempotencyKey` (and its `conduytRootExecutionId` flow
 * write) entirely: the key then comes straight from the item's own data on every attempt,
 * so it is already identical on a retry even if the flow context never reached a saved
 * execution (a crash between Conduyt accepting the request and n8n persisting the run).
 * Only the KEY is guaranteed stable through that: if the flow context carrying the
 * snapshot is lost in the same crash, the payload is re-evaluated from scratch, so the
 * same caller key must always come with the same item data (channel, contact, body) or a
 * crash-triggered retry can send a different payload under the matching key. A caller key
 * already owned by a different send slot is rejected rather than reused.
 */
export function sendEnvelope(
	this: IExecuteFunctions,
	itemIndex: number,
	callerKey: string,
	evaluate: () => Omit<SendEnvelope, 'idempotencyKey'>,
): SendEnvelope {
	const slot = sendSlot.call(this, itemIndex);
	const flow = this.getContext('flow');
	if (!flow[SEND_ENVELOPES_KEY] || typeof flow[SEND_ENVELOPES_KEY] !== 'object') {
		flow[SEND_ENVELOPES_KEY] = {};
	}
	const envelopes = flow[SEND_ENVELOPES_KEY] as Record<string, unknown>;
	const stored = envelopes[slot];
	if (isSendEnvelope(stored)) return stored;

	const hasCallerKey = callerKey.trim() !== '';
	const fields = evaluate();
	const idempotencyKey = hasCallerKey ? callerKey : sendIdempotencyKey.call(this, itemIndex);

	if (hasCallerKey) {
		assertCallerKeyLength(this.getNode(), fields.channel, idempotencyKey, itemIndex);

		if (!flow[SEND_KEY_OWNERS_KEY] || typeof flow[SEND_KEY_OWNERS_KEY] !== 'object') {
			flow[SEND_KEY_OWNERS_KEY] = {};
		}
		const owners = flow[SEND_KEY_OWNERS_KEY] as Record<string, string>;
		const owner = owners[callerKey];
		if (owner !== undefined && owner !== slot) {
			throw new NodeOperationError(
				this.getNode(),
				`Idempotency Key "${callerKey}" is already in use by another item or node; give each message its own key`,
				{ itemIndex },
			);
		}
		owners[callerKey] = slot;
	}

	const envelope: SendEnvelope = { idempotencyKey, ...fields };
	envelopes[slot] = envelope;
	return envelope;
}

/** Drop undefined / empty-string keys so PATCH bodies only carry real changes. */
export function clean(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === '') continue;
		out[k] = v;
	}
	return out;
}

export function splitTags(value: unknown): string[] | undefined {
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	return value
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}

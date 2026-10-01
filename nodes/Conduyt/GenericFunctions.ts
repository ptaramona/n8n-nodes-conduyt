import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
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

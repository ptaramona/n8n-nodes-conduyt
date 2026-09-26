import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

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
): Promise<unknown> {
	const credentials = await this.getCredentials('conduytApi');
	const baseUrl = ((credentials.baseUrl as string) || 'https://conduyt.app/api/v1').replace(
		/\/+$/,
		'',
	);

	const options: IRequestOptions = {
		method,
		uri: `${baseUrl}${endpoint}`,
		qs,
		body,
		json: true,
		headers: {
			Accept: 'application/json',
			'User-Agent': 'n8n-nodes-conduyt/0.1.0',
		},
	};
	if (Object.keys(body).length === 0) delete options.body;
	if (Object.keys(qs).length === 0) delete options.qs;

	try {
		const response = await this.helpers.requestWithAuthentication.call(
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

// 0.1.7: Deal > Create for Contact, Automation > Trigger Webhook, the in-flight wait, the
// replay flag, and deal Source / Custom Fields. Runs against the compiled output: `npm test`
// builds first (pretest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { Conduyt } = require('../dist/nodes/Conduyt/Conduyt.node');
const G = require('../dist/nodes/Conduyt/GenericFunctions');

G.inFlightTiming.stepMs = 1; // the real step is 3 s

const DEAL = { id: '11111111-1111-4111-8111-111111111111', contactId: '22222222-2222-4222-8222-222222222222', title: 'ZZ TEST Co' };

/** A failed request exactly as n8n's HTTP helper throws it (a NodeApiError from an Axios-shaped error). */
function httpError(status, data) {
	const axiosError = Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data },
	});
	return new NodeApiError({ name: 'Conduyt' }, axiosError);
}

/**
 * Minimal IExecuteFunctions for one item. `answers` is consumed one per HTTP call: a function
 * (called with the request options) or a { statusCode, body, headers } response.
 */
function ctx(resource, operation, params, answers) {
	const calls = [];
	const next = async (kind, options) => {
		calls.push({ kind, options });
		const a = answers[Math.min(calls.length - 1, answers.length - 1)];
		const r = typeof a === 'function' ? a(options) : a;
		return { headers: {}, ...r };
	};
	return {
		calls,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => {
			if (name === 'resource') return resource;
			if (name === 'operation') return operation;
			return name in params ? params[name] : fallback;
		},
		getCredentials: async () => ({ baseUrl: 'https://conduyt.test/api/v1/', apiKey: 'cdy_test' }),
		helpers: {
			httpRequestWithAuthentication: async (_cred, options) => next('auth', options),
			httpRequest: async (options) => next('plain', options),
			returnJsonArray: (data) => data.map((json) => ({ json })),
			constructExecutionMetaData: (data, { itemData }) => data.map((e) => ({ ...e, pairedItem: itemData })),
		},
		continueOnFail: () => false,
		getNode: () => ({ name: 'Conduyt', type: 'n8n-nodes-conduyt.conduyt', typeVersion: 1, position: [0, 0], parameters: {} }),
	};
}

const run = (c) => new Conduyt().execute.call(c);
const forContact = (extra) =>
	Object.assign(
		{
			title: 'ZZ TEST Co',
			pipelineId: 'p-1',
			stageId: 's-1',
			contactPhone: ' +12025550144 ',
			contactEmail: '',
			contactFirstName: 'ZZ TEST',
			contactLastName: 'Kloudi',
			contactCompany: 'ZZ TEST Co',
			forContactFields: { source: 'Kloudi Direct Send', customFields: '{"kloudi_list":"ZZ TEST LIST"}' },
			idempotencyKey: 'kdsn-abc-2026-11-23',
			inFlightWaitSeconds: 60,
		},
		extra || {},
	);

test('Create for Contact: one keyed POST to the inbound deals route; a fresh 201 is replayed = false', async () => {
	const c = ctx('deal', 'createForContact', forContact(), [{ statusCode: 201, body: { data: DEAL } }]);
	const [[out]] = await run(c);
	assert.equal(c.calls.length, 1);
	const { kind, options } = c.calls[0];
	assert.equal(kind, 'auth');
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://conduyt.test/api/v1/webhooks/inbound/deals');
	assert.equal(options.headers['Idempotency-Key'], 'kdsn-abc-2026-11-23');
	assert.deepEqual(options.body, {
		title: 'ZZ TEST Co',
		pipelineId: 'p-1',
		stageId: 's-1',
		source: 'Kloudi Direct Send',
		customFields: { kloudi_list: 'ZZ TEST LIST' },
		contact: { phone: '+12025550144', firstName: 'ZZ TEST', lastName: 'Kloudi', company: 'ZZ TEST Co' },
	});
	assert.equal(out.json.id, DEAL.id);
	assert.equal(out.json.contactId, DEAL.contactId);
	assert.equal(out.json.replayed, false);
});

test('Create for Contact: the stored answer (200, idempotentReplay: true) is replayed = true', async () => {
	const c = ctx('deal', 'createForContact', forContact(), [{ statusCode: 200, body: { data: DEAL, idempotentReplay: true } }]);
	const [[out]] = await run(c);
	assert.equal(out.json.id, DEAL.id);
	assert.equal(out.json.replayed, true);
});

test('Create for Contact: a copy in flight (409) is waited out under the SAME key and body, then replays', async () => {
	const c = ctx('deal', 'createForContact', forContact(), [
		() => {
			throw httpError(409, { error: 'A request with this Idempotency-Key is still being processed' });
		},
		() => {
			throw httpError(503, { error: 'The matched contact changed while the deal was being created. Retry.' });
		},
		{ statusCode: 200, body: { data: DEAL, idempotentReplay: true } },
	]);
	const [[out]] = await run(c);
	assert.equal(c.calls.length, 3);
	assert.ok(c.calls.every((x) => x.options.headers['Idempotency-Key'] === 'kdsn-abc-2026-11-23'));
	assert.ok(c.calls.every((x) => JSON.stringify(x.options.body) === JSON.stringify(c.calls[0].options.body)));
	assert.equal(out.json.replayed, true);
});

test('Create for Contact: without a key a 409 is NOT repeated (a repeat could create a second deal)', async () => {
	const c = ctx('deal', 'createForContact', forContact({ idempotencyKey: '' }), [
		() => {
			throw httpError(409, { error: 'conflict' });
		},
	]);
	await assert.rejects(() => run(c));
	assert.equal(c.calls.length, 1);
	assert.equal(c.calls[0].options.headers['Idempotency-Key'], undefined);
});

test('Create for Contact: the wait is bounded by Wait for In-Flight Copy (Seconds)', async () => {
	G.inFlightTiming.stepMs = 1000; // budget 3 s = 3 waits = 4 attempts; sleep is real here, so keep it short
	try {
		const c = ctx('deal', 'createForContact', forContact({ inFlightWaitSeconds: 3 }), [
			() => {
				throw httpError(409, { error: 'still being processed' });
			},
		]);
		await assert.rejects(() => run(c), (e) => G.errorStatusCode(e) === 409);
		assert.equal(c.calls.length, 4);
	} finally {
		G.inFlightTiming.stepMs = 1;
	}
});

test('Create for Contact: 0 seconds = one attempt', async () => {
	const c = ctx('deal', 'createForContact', forContact({ inFlightWaitSeconds: 0 }), [
		() => {
			throw httpError(409, { error: 'still being processed' });
		},
	]);
	await assert.rejects(() => run(c));
	assert.equal(c.calls.length, 1);
});

test('Create for Contact: a real conflict is never repeated (409 oes_number_taken, 422 different body, 500)', async () => {
	for (const [status, data] of [
		[409, { error: 'taken', code: 'oes_number_taken' }],
		[422, { error: 'Idempotency-Key was already used with a different request' }],
		[500, { error: 'Internal server error' }],
		[403, { error: 'Insufficient permissions' }],
	]) {
		const c = ctx('deal', 'createForContact', forContact(), [
			() => {
				throw httpError(status, data);
			},
		]);
		await assert.rejects(() => run(c));
		assert.equal(c.calls.length, 1, `status ${status} was repeated`);
	}
});

test('Create for Contact: refuses a request with neither phone nor email, a padded key, a key over 255', async () => {
	for (const [extra, re] of [
		[{ contactPhone: ' ', contactEmail: '' }, /Contact Phone or Contact Email/],
		[{ idempotencyKey: ' kdsn-x ' }, /whitespace/],
		[{ idempotencyKey: 'k'.repeat(256) }, /at most 255/],
	]) {
		const c = ctx('deal', 'createForContact', forContact(extra), [{ statusCode: 201, body: { data: DEAL } }]);
		await assert.rejects(() => run(c), re);
		assert.equal(c.calls.length, 0);
	}
});

test('Create for Contact: Custom Fields must be a JSON object', async () => {
	const c = ctx('deal', 'createForContact', forContact({ forContactFields: { customFields: '[1]' } }), [{ statusCode: 201, body: { data: DEAL } }]);
	await assert.rejects(() => run(c), /JSON object/);
});

test('Trigger Webhook: posts WITHOUT the API key to the webhook URL, keyed, and reports what ran', async () => {
	const c = ctx(
		'automation',
		'triggerWebhook',
		{ webhookId: ' 36647402-020b-4f03-8da5-aa36cd0619e5 ', payload: '{"gpt_evaluation":"positive","deal_id":"d-1"}', idempotencyKey: 'kds-h-d-1', failIfNothingRan: true, inFlightWaitSeconds: 60 },
		[{ statusCode: 200, body: { data: { ok: true, triggered: 1 } } }],
	);
	const [[out]] = await run(c);
	assert.equal(c.calls.length, 1);
	assert.equal(c.calls[0].kind, 'plain', 'the public receiver must not get the API key');
	assert.equal(c.calls[0].options.url, 'https://conduyt.test/api/v1/webhooks/automation/36647402-020b-4f03-8da5-aa36cd0619e5');
	assert.equal(c.calls[0].options.headers['Idempotency-Key'], 'kds-h-d-1');
	assert.equal(c.calls[0].options.headers.Authorization, undefined);
	assert.deepEqual(c.calls[0].options.body, { gpt_evaluation: 'positive', deal_id: 'd-1' });
	assert.deepEqual(out.json, { ok: true, triggered: 1, deduplicated: false, replayed: false });
});

test('Trigger Webhook: nothing ran (triggered 0) fails the item; a recognised repeat does not', async () => {
	const base = { webhookId: 'w-1', payload: '{}', idempotencyKey: 'kds-h-d-1', failIfNothingRan: true, inFlightWaitSeconds: 60 };
	const none = ctx('automation', 'triggerWebhook', base, [{ statusCode: 200, body: { data: { ok: true, triggered: 0 } } }]);
	await assert.rejects(() => run(none), /No automation ran for webhook w-1/);
	const dup = ctx('automation', 'triggerWebhook', base, [{ statusCode: 200, body: { data: { ok: true, triggered: 0, deduplicated: true } } }]);
	const [[out]] = await run(dup);
	assert.deepEqual(out.json, { ok: true, triggered: 0, deduplicated: true, replayed: true });
	const off = ctx('automation', 'triggerWebhook', { ...base, failIfNothingRan: false }, [{ statusCode: 200, body: { data: { ok: true, triggered: 0 } } }]);
	const [[o2]] = await run(off);
	assert.equal(o2.json.triggered, 0);
});

test('Trigger Webhook: a 503 (another copy holds the run) is waited out under the key; a 500 is not repeated', async () => {
	const base = { webhookId: 'w-1', payload: '{}', idempotencyKey: 'kds-h-d-1', failIfNothingRan: true, inFlightWaitSeconds: 60 };
	const busy = ctx('automation', 'triggerWebhook', base, [
		() => {
			throw httpError(503, { ok: false, retry: true });
		},
		{ statusCode: 200, body: { data: { ok: true, triggered: 0, deduplicated: true } } },
	]);
	const [[out]] = await run(busy);
	assert.equal(busy.calls.length, 2);
	assert.equal(out.json.replayed, true);
	const failed = ctx('automation', 'triggerWebhook', base, [
		() => {
			throw httpError(500, { error: 'Automation execution failed; please retry' });
		},
	]);
	await assert.rejects(() => run(failed));
	assert.equal(failed.calls.length, 1, 'a 500 may have run steps: never repeated automatically');
});

test('Deal Update: Source and Custom Fields (JSON) reach the PATCH body', async () => {
	const c = ctx(
		'deal',
		'update',
		{ id: DEAL.id, additionalFields: { source: 'Kloudi Direct Send', customFields: '{"velocify_lead_id":"123","velocify_campaign":"1585"}' } },
		[{ statusCode: 200, body: { data: DEAL } }],
	);
	await run(c);
	assert.equal(c.calls[0].options.method, 'PATCH');
	assert.equal(c.calls[0].options.url, `https://conduyt.test/api/v1/deals/${DEAL.id}`);
	assert.deepEqual(c.calls[0].options.body, { source: 'Kloudi Direct Send', customFields: { velocify_lead_id: '123', velocify_campaign: '1585' } });
});

test('isIdempotentReplay: the body flag or the Idempotent-Replay header (any case); nothing else', () => {
	assert.equal(G.isIdempotentReplay({ data: {}, idempotentReplay: true }, {}), true);
	assert.equal(G.isIdempotentReplay({ data: {} }, { 'idempotent-replay': 'true' }), true);
	assert.equal(G.isIdempotentReplay({ data: {} }, { 'Idempotent-Replay': 'TRUE' }), true);
	assert.equal(G.isIdempotentReplay({ data: { idempotentReplay: true } }, {}), false);
	assert.equal(G.isIdempotentReplay({ data: {}, idempotentReplay: 'true' }, { 'idempotent-replay': 'false' }), false);
	assert.equal(G.isIdempotentReplay(undefined, undefined), false);
});

test('errorStatusCode reads the status n8n puts on its error', () => {
	assert.equal(G.errorStatusCode(httpError(409, {})), 409);
	assert.equal(G.errorStatusCode(new Error('x')), undefined);
});

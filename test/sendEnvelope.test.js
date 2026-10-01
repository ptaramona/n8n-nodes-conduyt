// Runs against the compiled output: `npm test` builds first (pretest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Conduyt } = require('../dist/nodes/Conduyt/Conduyt.node');

/**
 * Minimal IExecuteFunctions stand-in for Message > Send. `flow` is the object n8n hands
 * back from getContext('flow'); it lives in the saved run data, so a manual retry of a
 * failed execution sees the same object under a new execution id. `params(name, i)`
 * plays the expression evaluator: a manual retry re-evaluates $now, $execution.id and
 * the like, so the retry gets a different `params`.
 */
function execution({ executionId, flow, items = 2, params, send, nodeName = 'Send', continueOnFail = false }) {
	const requests = [];
	return {
		requests,
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getNodeParameter: (name, i, fallback) => {
			if (name === 'resource') return 'message';
			if (name === 'operation') return 'send';
			const value = params(name, i);
			return value === undefined ? fallback : value;
		},
		getCredentials: async () => ({ baseUrl: 'https://conduyt.test/api/v1' }),
		helpers: {
			httpRequestWithAuthentication: async (_credential, options) => {
				requests.push(options);
				return send(options, requests.length - 1);
			},
			returnJsonArray: (data) => data.map((json) => ({ json })),
			constructExecutionMetaData: (data, { itemData }) =>
				data.map((entry) => ({ ...entry, pairedItem: itemData })),
		},
		continueOnFail: () => continueOnFail,
		getNode: () => ({ name: nodeName, type: 'n8n-nodes-conduyt.conduyt', typeVersion: 1, position: [0, 0], parameters: {} }),
		getWorkflow: () => ({ id: 'wf-1' }),
		getExecutionId: () => executionId,
		getWorkflowDataProxy: () => ({ $thisRunIndex: 0 }),
		getContext: (type) => {
			assert.equal(type, 'flow');
			return flow;
		},
	};
}

const ok = () => ({ data: { id: 'msg_1', status: 'queued' } });
const providerDown = () => {
	const error = new Error('502 Bad Gateway');
	error.response = { body: { error: 'provider unavailable' } };
	throw error;
};
const deliveryUnconfirmed = () => {
	const error = new Error('422 Unprocessable Entity');
	error.response = {
		body: {
			error: 'Delivery could not be confirmed',
			data: { id: 'msg_1', status: 'sent', metadata: { deliveryUnconfirmed: true } },
		},
	};
	throw error;
};
const rateLimited = () => {
	const error = new Error('429 Too Many Requests');
	error.response = { body: { error: 'rate limit exceeded' } };
	throw error;
};

test('manual retry replays an already-confirmed item from cache and resends the first evaluation under the same key for the one that actually failed, even when expressions changed', async () => {
	const node = new Conduyt();
	const flow = {};

	// First run: item 0 (SMS) succeeds, item 1 (email) fails at the provider.
	const first = execution({
		executionId: 'e1',
		flow,
		params: (name, i) =>
			({
				channel: ['sms', 'email'][i],
				contactId: `con_${i}`,
				body: `Hello from run 1 item ${i}`,
				subject: i === 1 ? 'Run 1 subject' : undefined,
				fromNumber: i === 0 ? '+15550001111' : undefined,
			})[name],
		send: (_options, n) => (n === 0 ? ok() : providerDown()),
	});
	await assert.rejects(() => node.execute.call(first), /provider unavailable/);
	assert.equal(first.requests.length, 2);

	const [sentSms, failedEmail] = first.requests;
	assert.equal(sentSms.url, 'https://conduyt.test/api/v1/messages/sms/send');
	assert.match(sentSms.body.idempotencyKey, /^n8n-[0-9a-f]{64}$/);
	assert.equal(failedEmail.url, 'https://conduyt.test/api/v1/messages');
	assert.match(failedEmail.headers['Idempotency-Key'], /^n8n-[0-9a-f]{64}$/);

	// Manual Retry: new execution id, same saved run data, every expression re-evaluated.
	// Item 0 now resolves to EMAIL with a new body; item 1 keeps its channel with a new body.
	const retry = execution({
		executionId: 'e2',
		flow,
		params: (name, i) =>
			({
				channel: 'email',
				contactId: `con_${i}`,
				body: `Hello from run 2 item ${i}`,
				subject: `Run 2 subject ${i}`,
				fromNumber: undefined,
			})[name],
		send: ok,
	});
	const out = await node.execute.call(retry);
	assert.equal(out[0].length, 2);
	// Item 0 already sent and was confirmed, so the retry replays the cached result and
	// never calls the endpoint for it again; only the item that actually failed (item 1)
	// makes a new request.
	assert.equal(retry.requests.length, 1);
	assert.equal(out[0][0].json.id, 'msg_1');
	assert.equal(out[0][0].json.status, 'queued');

	// The failed item is retried as first evaluated, under its original key.
	assert.deepEqual(retry.requests[0], failedEmail);
	assert.equal(retry.requests[0].body.body, 'Hello from run 1 item 1');
	assert.equal(retry.requests[0].body.subject, 'Run 1 subject');
	assert.equal(retry.requests[0].headers['Idempotency-Key'], failedEmail.headers['Idempotency-Key']);
});

test('a fresh execution evaluates anew: the changed channel really switches endpoints', async () => {
	const node = new Conduyt();
	const run = (channel) =>
		execution({
			executionId: `fresh-${channel}`,
			flow: {},
			items: 1,
			params: (name) => ({ channel, contactId: 'con_1', body: 'Hi', subject: 'S' })[name],
			send: ok,
		});
	const sms = run('sms');
	await node.execute.call(sms);
	const email = run('email');
	await node.execute.call(email);
	assert.equal(sms.requests[0].url, 'https://conduyt.test/api/v1/messages/sms/send');
	assert.equal(email.requests[0].url, 'https://conduyt.test/api/v1/messages');
	assert.notEqual(sms.requests[0].body.idempotencyKey, email.requests[0].headers['Idempotency-Key']);
});

test('a caller-supplied idempotency key is sent verbatim for SMS and email', async () => {
	const node = new Conduyt();
	const run = (channel, idempotencyKey) =>
		execution({
			executionId: `caller-${channel}`,
			flow: {},
			items: 1,
			params: (name) =>
				({
					channel,
					contactId: 'con_1',
					body: 'Hi',
					subject: 'S',
					fromNumber: channel === 'sms' ? '+15550001111' : undefined,
					idempotencyKey,
				})[name],
			send: ok,
		});

	const sms = run('sms', 'order-42');
	await node.execute.call(sms);
	assert.equal(sms.requests[0].body.idempotencyKey, 'order-42');

	const email = run('email', 'order-43');
	await node.execute.call(email);
	assert.equal(email.requests[0].headers['Idempotency-Key'], 'order-43');
});

test('ordinary retry (flow context carried over): an already-confirmed caller-key item replays from cache instead of resending, even though the envelope would also reuse the same request', async () => {
	const node = new Conduyt();
	const flow = {};

	const first = execution({
		executionId: 'e1',
		flow,
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello from run 1',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0001',
			})[name],
		send: ok,
	});
	await node.execute.call(first);
	assert.equal(first.requests.length, 1);
	assert.equal(first.requests[0].body.idempotencyKey, 'order-0001');

	// Retry On Fail / manual Retry with the SAME saved flow object, expressions re-evaluated
	// to a different body. The slot (node + run index + item index) is unchanged and this item
	// already reached a confirmed outcome, so the retry replays the cached result and makes no
	// request at all, with no network call to reuse the (also unchanged) cached envelope on.
	const retry = execution({
		executionId: 'e2',
		flow,
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello from run 2 (changed)',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0001',
			})[name],
		send: ok,
	});
	const out = await node.execute.call(retry);

	assert.equal(retry.requests.length, 0);
	assert.equal(out[0][0].json.id, 'msg_1');
	assert.equal(out[0][0].json.status, 'queued');
});

test('crash recovery (fresh flow state): the caller key stays stable on its own, but the snapshot does not survive, only the key does', async () => {
	const node = new Conduyt();

	// First attempt: Conduyt would accept the request, but the worker dies before n8n
	// persists the completed node, so the saved execution carries NO flow context forward
	// at all (a brand-new, empty flow object below, not the same reference) — the true
	// crash case, unlike an ordinary retry where flow context survives.
	const first = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello, stable item data',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0002',
			})[name],
		send: ok,
	});
	await node.execute.call(first);

	// Retry under a fresh execution id AND fresh flow context (nothing carried over). The
	// caller key does not depend on flow context, so it alone is still identical. With the
	// SAME, deterministic item data (as upstream data should be), the freshly re-evaluated
	// payload also happens to match — but that is because the inputs match, not because any
	// snapshot was reused; there is no snapshot available here to reuse.
	const retry = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello, stable item data',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0002',
			})[name],
		send: ok,
	});
	await node.execute.call(retry);

	assert.equal(retry.requests[0].body.idempotencyKey, first.requests[0].body.idempotencyKey);
	assert.equal(retry.requests[0].body.body, first.requests[0].body.body);
});

test('documents the caveat: a caller key does not protect a non-deterministic payload across a crash', async () => {
	const node = new Conduyt();

	// Same crash shape as above (fresh flow both times), but the upstream item data is NOT
	// deterministic between attempts (for example a body built from $now). The key is still
	// identical, because it never depended on flow context, but the resent payload differs:
	// the snapshot genuinely did not survive, only the key did, exactly as documented in the
	// node notice, the field description, and the README.
	const first = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello from run 1',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0003',
			})[name],
		send: ok,
	});
	await node.execute.call(first);

	const retry = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hello from run 2 (changed)',
				fromNumber: '+15550001111',
				idempotencyKey: 'order-0003',
			})[name],
		send: ok,
	});
	await node.execute.call(retry);

	assert.equal(retry.requests[0].body.idempotencyKey, first.requests[0].body.idempotencyKey);
	assert.notEqual(retry.requests[0].body.body, first.requests[0].body.body);
});

test('a caller key reused by a different item in the same execution is rejected, not silently replayed', async () => {
	const node = new Conduyt();
	const ctx = execution({
		executionId: 'e1',
		flow: {},
		items: 2,
		params: (name, i) =>
			({
				channel: 'sms',
				contactId: `con_${i}`,
				body: `Body for item ${i}`,
				fromNumber: '+15550001111',
				idempotencyKey: 'shared-key-01',
			})[name],
		send: ok,
	});

	await assert.rejects(() => node.execute.call(ctx), /already in use/);
	// The first item's request went out before the second item's collision was caught; the
	// second item's request never fires with the first item's (wrong) envelope.
	assert.equal(ctx.requests.length, 1);
	assert.equal(ctx.requests[0].body.contactId, 'con_0');
});

test('a caller key reused by a different node is rejected, not silently replayed', async () => {
	const node = new Conduyt();
	const flow = {};

	const nodeA = execution({
		executionId: 'e1',
		flow,
		nodeName: 'Send SMS A',
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_a',
				body: 'From node A',
				fromNumber: '+15550001111',
				idempotencyKey: 'shared-key-02',
			})[name],
		send: ok,
	});
	await node.execute.call(nodeA);
	assert.equal(nodeA.requests.length, 1);

	const nodeB = execution({
		executionId: 'e1',
		flow,
		nodeName: 'Send SMS B',
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_b',
				body: 'From node B',
				fromNumber: '+15550001111',
				idempotencyKey: 'shared-key-02',
			})[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(nodeB), /already in use/);
	assert.equal(nodeB.requests.length, 0);
});

test('a caller key equal to an inherited Object.prototype member name is accepted, not falsely rejected as already in use', async () => {
	const node = new Conduyt();
	// A plain-object ownership map read by bracket access on the raw key would resolve these
	// to an inherited function instead of a real entry, and wrongly throw on the very first
	// use of the key.
	for (const key of ['constructor', 'toString', '__proto__']) {
		const ctx = execution({
			executionId: `e-${key}`,
			flow: {},
			items: 1,
			params: (name) =>
				({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: key })[
					name
				],
			send: ok,
		});
		await node.execute.call(ctx);
		assert.equal(ctx.requests.length, 1);
		assert.equal(ctx.requests[0].body.idempotencyKey, key);
	}
});

test('ownership tracking for a key equal to an Object.prototype member name survives a JSON round trip of the flow context', async () => {
	const node = new Conduyt();
	for (const key of ['constructor', 'toString', '__proto__']) {
		const flow = {};
		const first = execution({
			executionId: 'e1',
			flow,
			items: 1,
			params: (name) =>
				({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: key })[
					name
				],
			send: ok,
		});
		await node.execute.call(first);
		assert.equal(first.requests.length, 1);

		// n8n persists the execution data as JSON between the failure/retry and the next attempt.
		const restored = JSON.parse(JSON.stringify(flow));

		// Retry of the SAME item/slot with the SAME key: recognized as its own owner (and
		// replayed from the confirmed-outcome cache), not "already in use".
		const retry = execution({
			executionId: 'e2',
			flow: restored,
			items: 1,
			params: (name) =>
				({ channel: 'sms', contactId: 'con_1', body: 'Changed', fromNumber: '+15550001111', idempotencyKey: key })[
					name
				],
			send: ok,
		});
		await node.execute.call(retry);
		assert.equal(retry.requests.length, 0);

		// A DIFFERENT node reusing the same key after the round trip is still correctly rejected.
		const other = execution({
			executionId: 'e3',
			flow: restored,
			nodeName: 'Send SMS B',
			items: 1,
			params: (name) =>
				({
					channel: 'sms',
					contactId: 'con_2',
					body: 'From another node',
					fromNumber: '+15550001111',
					idempotencyKey: key,
				})[name],
			send: ok,
		});
		await assert.rejects(() => node.execute.call(other), /already in use/);
	}
});

test('a caller key outside the server length bounds is rejected before sending', async () => {
	const node = new Conduyt();
	const shortSms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: 'short' })[
				name
			],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(shortSms), /8 to 200 characters/);
	assert.equal(shortSms.requests.length, 0);

	const longEmail = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'email',
				contactId: 'con_1',
				body: 'Hi',
				subject: 'S',
				idempotencyKey: 'x'.repeat(256),
			})[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(longEmail), /at most 255 characters/);
	assert.equal(longEmail.requests.length, 0);
});

test('the snapshot survives a JSON round trip of the saved run data', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name) => ({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111' })[name];
	const first = execution({ executionId: 'e1', flow, items: 1, params, send: providerDown });
	await assert.rejects(() => node.execute.call(first));

	// n8n persists the execution data as JSON between the failure and the retry.
	const restored = JSON.parse(JSON.stringify(flow));
	const retry = execution({
		executionId: 'e2',
		flow: restored,
		items: 1,
		params: (name) => ({ channel: 'email', contactId: 'con_1', body: 'Changed', subject: 'S' })[name],
		send: ok,
	});
	await node.execute.call(retry);
	assert.deepEqual(retry.requests[0], first.requests[0]);
});

test('an unconfirmed SMS delivery is reported on the item, not thrown, so Retry On Fail never fires a second request', async () => {
	const node = new Conduyt();
	const ctx = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111' })[name],
		send: deliveryUnconfirmed,
	});

	// A single call to execute() is the node's one and only attempt. Because it resolves
	// instead of rejecting, n8n's Retry On Fail (which only fires on a thrown error) has
	// nothing to retry: this assertion on requests.length is the two-attempt contract,
	// there is no second attempt to make a second request from.
	const out = await node.execute.call(ctx);
	assert.equal(ctx.requests.length, 1);
	assert.equal(out[0][0].json.deliveryUnconfirmed, true);
	assert.match(out[0][0].json.warning, /may already have delivered/);
	assert.equal(out[0][0].json.id, 'msg_1');
});

test('an unconfirmed SMS delivery is reported the same way whether continueOnFail is on or off', async () => {
	const node = new Conduyt();
	const withContinueOnFail = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		continueOnFail: true,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111' })[name],
		send: deliveryUnconfirmed,
	});
	const out = await node.execute.call(withContinueOnFail);
	assert.equal(withContinueOnFail.requests.length, 1);
	// Not the continueOnFail error-item shape ({ json: { error } }): a real, successful item.
	assert.equal(out[0][0].json.error, undefined);
	assert.equal(out[0][0].json.deliveryUnconfirmed, true);
});

test('whitespace-equivalent caller keys for email are rejected, not silently collided on the server', async () => {
	const node = new Conduyt();
	const ctx = execution({
		executionId: 'e1',
		flow: {},
		items: 2,
		params: (name, i) =>
			({
				channel: 'email',
				contactId: `con_${i}`,
				body: `Body for item ${i}`,
				subject: 'S',
				// The email endpoint trims the header server-side, so these two are the same
				// wire key even though they differ in this function's own raw comparison.
				idempotencyKey: i === 0 ? 'order-42' : ' order-42',
			})[name],
		send: ok,
	});

	await assert.rejects(() => node.execute.call(ctx), /leading or trailing whitespace/);
	assert.equal(ctx.requests.length, 1);
	assert.equal(ctx.requests[0].headers['Idempotency-Key'], 'order-42');
});

test('a later item failing does not cause an earlier unconfirmed SMS to be sent again on retry', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name, i) =>
		({ channel: 'sms', contactId: `con_${i}`, body: `Body ${i}`, fromNumber: '+15550001111' })[name];

	// First attempt: item 0's SMS comes back deliveryUnconfirmed (reported, not thrown), item
	// 1's provider call fails outright, which fails the whole node.
	const first = execution({
		executionId: 'e1',
		flow,
		items: 2,
		params,
		send: (_options, n) => (n === 0 ? deliveryUnconfirmed() : providerDown()),
	});
	await assert.rejects(() => node.execute.call(first), /provider unavailable/);
	assert.equal(first.requests.length, 2);

	// Manual Retry of the whole failed execution: n8n reruns every item in this node,
	// including item 0, which already produced a terminal (if ambiguous) result. Conduyt
	// would dispatch a deliveryUnconfirmed row again under the same key, so the node must
	// not call the endpoint for item 0 a second time.
	const retry = execution({
		executionId: 'e2',
		flow,
		items: 2,
		params,
		send: ok,
	});
	const out = await node.execute.call(retry);
	assert.equal(out[0].length, 2);
	// Only item 1 (the one that actually failed) makes a new request.
	assert.equal(retry.requests.length, 1);
	assert.equal(out[0][0].json.deliveryUnconfirmed, true);
	assert.equal(out[0][0].json.id, 'msg_1');
	assert.equal(out[0][1].json.deliveryUnconfirmed, undefined);
});

test('documents the limit: a worker crash before n8n saves the run loses the unconfirmed-SMS replay protection', async () => {
	const node = new Conduyt();

	// The protection above relies entirely on flow context (conduytSendUnconfirmed) that
	// n8n only carries forward once it has saved the run. A true crash, exactly like the
	// one the generated/caller-key notes already document for the envelope snapshot, loses
	// that context: the retry below gets a brand-new, empty flow object, not the same
	// reference, so there is nothing to replay and the endpoint is called again. This test
	// pins that gap rather than hiding it; the fix lives outside this repo (a server-backed
	// replay lookup in Conduyt itself), so the node notice, field description, and README
	// disclose it instead of claiming a guarantee this client alone cannot make.
	const first = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: 'order-0004' })[
				name
			],
		send: deliveryUnconfirmed,
	});
	const out1 = await node.execute.call(first);
	assert.equal(first.requests.length, 1);
	assert.equal(out1[0][0].json.deliveryUnconfirmed, true);

	const retry = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: 'order-0004' })[
				name
			],
		send: ok,
	});
	const out2 = await node.execute.call(retry);
	// A second request really does go out: there is no cached outcome to replay it from.
	assert.equal(retry.requests.length, 1);
	assert.equal(retry.requests[0].body.idempotencyKey, 'order-0004');
	assert.equal(out2[0][0].json.deliveryUnconfirmed, undefined);
});

test('a later item hitting the rate limit does not cause already-confirmed SMS sends to be replayed on retry (limit-plus-one livelock)', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name, i) =>
		({ channel: 'sms', contactId: `con_${i}`, body: `Body ${i}`, fromNumber: '+15550001111' })[name];

	// First attempt: items 0 and 1 are confirmed sends; item 2 hits Conduyt's per-user
	// rate limiter (429) before the endpoint even reaches the idempotency check, which
	// fails the whole node.
	const first = execution({
		executionId: 'e1',
		flow,
		items: 3,
		params,
		send: (_options, n) => (n < 2 ? ok() : rateLimited()),
	});
	await assert.rejects(() => node.execute.call(first), /rate limit/);
	assert.equal(first.requests.length, 3);

	// Manual Retry of the whole failed execution: n8n reruns every item in this node. If
	// items 0 and 1 (already confirmed) were resent, each would spend a fresh rate-limit
	// window on a message that already went out, and item 2 would never get a turn: a
	// livelock. The confirmed prefix must be replayed from cache, not resent.
	const retry = execution({
		executionId: 'e2',
		flow,
		items: 3,
		params,
		send: ok,
	});
	const out = await node.execute.call(retry);
	assert.equal(out[0].length, 3);
	// Only item 2 (the one that never got a confirmed result) makes a new request.
	assert.equal(retry.requests.length, 1);
	assert.equal(retry.requests[0].body.contactId, 'con_2');
});

test('a later item failing does not cause an already-confirmed email send to be replayed on retry', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name, i) =>
		({ channel: 'email', contactId: `con_${i}`, body: `Body ${i}`, subject: 'S' })[name];

	const first = execution({
		executionId: 'e1',
		flow,
		items: 2,
		params,
		send: (_options, n) => (n === 0 ? ok() : providerDown()),
	});
	await assert.rejects(() => node.execute.call(first), /provider unavailable/);
	assert.equal(first.requests.length, 2);

	const retry = execution({
		executionId: 'e2',
		flow,
		items: 2,
		params,
		send: ok,
	});
	const out = await node.execute.call(retry);
	assert.equal(out[0].length, 2);
	// Only item 1 (the one that actually failed) makes a new request.
	assert.equal(retry.requests.length, 1);
	assert.equal(retry.requests[0].body.contactId, 'con_1');
});

/**
 * Runs `fn` with `Date.now` stubbed to `nowMs`, always restoring the real `Date.now`
 * afterwards even if `fn` throws or its promise rejects. `confirmedSendOutcome` and
 * `storeConfirmedSendOutcome` are given `Date.now()` by the node itself (never a value
 * these tests pass in directly), so stubbing the global is the only way to fake the clock
 * they see.
 */
async function withFakeNow(nowMs, fn) {
	const realNow = Date.now;
	Date.now = () => nowMs;
	try {
		return await fn();
	} finally {
		Date.now = realNow;
	}
}

test('a confirmed email outcome is replayed within Conduyt\'s 24-hour key window, but genuinely re-sent once that window has passed', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name) => ({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S' })[name];

	await withFakeNow(0, async () => {
		const first = execution({ executionId: 'e1', flow, items: 1, params, send: ok });
		await node.execute.call(first);
		assert.equal(first.requests.length, 1);
	});

	// 23 hours later, inside Conduyt's documented 24-hour email key window: replayed from
	// cache, no request at all.
	await withFakeNow(23 * 60 * 60 * 1000, async () => {
		const withinWindow = execution({ executionId: 'e2', flow, items: 1, params, send: ok });
		const out = await node.execute.call(withinWindow);
		assert.equal(withinWindow.requests.length, 0);
		assert.equal(out[0][0].json.id, 'msg_1');
	});

	// 25 hours after the ORIGINAL send, past the window: the cached record has expired, so
	// this is a cache miss and the node genuinely resends it, matching what Conduyt's own
	// server-side key handling would also now allow.
	await withFakeNow(25 * 60 * 60 * 1000, async () => {
		const afterWindow = execution({ executionId: 'e3', flow, items: 1, params, send: ok });
		await node.execute.call(afterWindow);
		assert.equal(afterWindow.requests.length, 1);
		assert.equal(afterWindow.requests[0].body.contactId, 'con_1');
	});
});

test('a pending email response is never cached, so a retry always re-requests it, even well inside what would be the 24-hour window for a terminal result', async () => {
	const node = new Conduyt();
	const flow = {};
	const params = (name) => ({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S' })[name];
	const pending = () => ({ data: { id: 'msg_1', status: 'pending' } });

	await withFakeNow(0, async () => {
		const first = execution({ executionId: 'e1', flow, items: 1, params, send: pending });
		const out = await node.execute.call(first);
		assert.equal(first.requests.length, 1);
		assert.equal(out[0][0].json.status, 'pending');
	});

	// Only a minute later: a terminal result would still be well within the 24-hour window,
	// but a pending one was never cached at all, so Conduyt is asked again and its own
	// Idempotency-Key handling resolves the retry.
	await withFakeNow(60 * 1000, async () => {
		const retry = execution({ executionId: 'e2', flow, items: 1, params, send: ok });
		const out = await node.execute.call(retry);
		assert.equal(retry.requests.length, 1);
		assert.equal(out[0][0].json.status, 'queued');
	});
});

test('a whitespace-only caller key is rejected for SMS and email, not silently treated as unset', async () => {
	const node = new Conduyt();
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hi',
				fromNumber: '+15550001111',
				idempotencyKey: '   ',
			})[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(sms), /leading or trailing whitespace/);
	assert.equal(sms.requests.length, 0);

	const email = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S', idempotencyKey: '\t\t' })[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(email), /leading or trailing whitespace/);
	assert.equal(email.requests.length, 0);
});

test('a numeric caller key (an upstream ID that stayed a number) is coerced to its decimal string, for SMS and email', async () => {
	const node = new Conduyt();
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hi',
				fromNumber: '+15550001111',
				idempotencyKey: 20260101123,
			})[name],
		send: ok,
	});
	await node.execute.call(sms);
	assert.equal(sms.requests[0].body.idempotencyKey, '20260101123');

	const email = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) => ({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S', idempotencyKey: 42 })[name],
		send: ok,
	});
	await node.execute.call(email);
	assert.equal(email.requests[0].headers['Idempotency-Key'], '42');
});

test('an unsafe integer caller key (precision already lost) is rejected rather than silently collapsed with a neighboring ID', async () => {
	const node = new Conduyt();
	// 9007199254740992 and 9007199254740993 are both unsafe and round to the SAME Number,
	// so accepting either as a key would make two distinct upstream IDs collide.
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hi',
				fromNumber: '+15550001111',
				idempotencyKey: 9007199254740993,
			})[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(sms), /safe integer/);
	assert.equal(sms.requests.length, 0);

	const email = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S', idempotencyKey: 9007199254740992 })[
				name
			],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(email), /safe integer/);
	assert.equal(email.requests.length, 0);
});

test('NaN and +/-Infinity caller keys are rejected, not turned into reusable literal keys', async () => {
	const node = new Conduyt();
	for (const bad of [NaN, Infinity, -Infinity]) {
		const sms = execution({
			executionId: `e-${bad}`,
			flow: {},
			items: 1,
			params: (name) =>
				({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: bad })[
					name
				],
			send: ok,
		});
		await assert.rejects(() => node.execute.call(sms), /safe integer/);
		assert.equal(sms.requests.length, 0);
	}
});

test('a negative-zero caller key is rejected, not treated as the same key as a literal 0', async () => {
	const node = new Conduyt();
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: -0 })[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(sms), /safe integer, got -0/);
	assert.equal(sms.requests.length, 0);
});

test('a null caller key (an upstream expression that resolved to no value) is treated as unset, for SMS and email', async () => {
	const node = new Conduyt();
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'sms', contactId: 'con_1', body: 'Hi', fromNumber: '+15550001111', idempotencyKey: null })[name],
		send: ok,
	});
	await node.execute.call(sms);
	assert.match(sms.requests[0].body.idempotencyKey, /^n8n-[0-9a-f]{64}$/);

	const email = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) => ({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S', idempotencyKey: null })[name],
		send: ok,
	});
	await node.execute.call(email);
	assert.match(email.requests[0].headers['Idempotency-Key'], /^n8n-[0-9a-f]{64}$/);
});

test('a non-string, non-number caller key (an object or array) is rejected with a clear error, for SMS and email', async () => {
	const node = new Conduyt();
	const sms = execution({
		executionId: 'e1',
		flow: {},
		items: 1,
		params: (name) =>
			({
				channel: 'sms',
				contactId: 'con_1',
				body: 'Hi',
				fromNumber: '+15550001111',
				idempotencyKey: { oops: true },
			})[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(sms), /Idempotency Key must be a string or number/);
	assert.equal(sms.requests.length, 0);

	const email = execution({
		executionId: 'e2',
		flow: {},
		items: 1,
		params: (name) =>
			({ channel: 'email', contactId: 'con_1', body: 'Hi', subject: 'S', idempotencyKey: ['a', 'b'] })[name],
		send: ok,
	});
	await assert.rejects(() => node.execute.call(email), /Idempotency Key must be a string or number/);
	assert.equal(email.requests.length, 0);
});

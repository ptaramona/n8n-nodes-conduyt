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
function execution({ executionId, flow, items = 2, params, send }) {
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
		continueOnFail: () => false,
		getNode: () => ({ name: 'Send', type: 'n8n-nodes-conduyt.conduyt', typeVersion: 1, position: [0, 0], parameters: {} }),
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

test('manual retry resends the first evaluation under the same key, even when expressions changed', async () => {
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
	assert.equal(retry.requests.length, 2);

	// The already-sent item goes back to the SAME endpoint with the SAME request and key,
	// so Conduyt answers it from the first send instead of sending again or conflicting.
	assert.deepEqual(retry.requests[0], sentSms);
	assert.equal(retry.requests[0].url, 'https://conduyt.test/api/v1/messages/sms/send');
	assert.equal(retry.requests[0].body.body, 'Hello from run 1 item 0');

	// The failed item is retried as first evaluated, under its original key.
	assert.deepEqual(retry.requests[1], failedEmail);
	assert.equal(retry.requests[1].body.body, 'Hello from run 1 item 1');
	assert.equal(retry.requests[1].body.subject, 'Run 1 subject');
	assert.equal(retry.requests[1].headers['Idempotency-Key'], failedEmail.headers['Idempotency-Key']);
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

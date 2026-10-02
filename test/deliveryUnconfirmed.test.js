// Runs against the compiled output: `npm test` builds first (pretest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { conduytApiRequest, deliveryUnconfirmedMessage } = require('../dist/nodes/Conduyt/GenericFunctions');

/**
 * Minimal ConduytContext stand-in: just enough for conduytApiRequest's own body (getCredentials,
 * getNode, a single HTTP call through helpers.httpRequestWithAuthentication).
 */
function context(send) {
	return {
		getCredentials: async () => ({ baseUrl: 'https://conduyt.test/api/v1' }),
		getNode: () => ({ name: 'Send', type: 'n8n-nodes-conduyt.conduyt', typeVersion: 1, position: [0, 0], parameters: {} }),
		helpers: {
			httpRequestWithAuthentication: async () => send(),
		},
	};
}

test("a real NodeApiError, the shape n8n's own HTTP helper actually throws, is recognized as an unconfirmed delivery", async () => {
	// n8n's authenticated HTTP helper (and n8n's own wrapping of a raw Axios failure in
	// general) throws a NodeApiError, not a plain Error with `.response.body`. That
	// constructor parses the Axios-shaped `response.data` into its own `context.data`
	// before conduytApiRequest ever sees the error; `response.body` does not exist on it.
	const axiosError = Object.assign(new Error('Request failed with status code 422'), {
		response: {
			status: 422,
			data: { data: { id: 'msg_1', status: 'sent', metadata: { deliveryUnconfirmed: true } } },
		},
	});
	const thrown = new NodeApiError({ name: 'Send' }, axiosError);
	assert.ok(thrown.context.data, 'sanity check: NodeApiError really does parse onto context.data');

	const ctx = context(() => {
		throw thrown;
	});

	let caught;
	await assert.rejects(
		() => conduytApiRequest.call(ctx, 'POST', '/messages/sms/send', {}),
		(error) => {
			caught = error;
			return true;
		},
	);

	const unconfirmed = deliveryUnconfirmedMessage(caught);
	assert.ok(unconfirmed, 'deliveryUnconfirmedMessage should recognize a real NodeApiError');
	assert.equal(unconfirmed.id, 'msg_1');
	assert.equal(unconfirmed.metadata.deliveryUnconfirmed, true);
});

test('a real NodeApiError for an ordinary (confirmed) failure is not mistaken for an unconfirmed delivery', async () => {
	const axiosError = Object.assign(new Error('Request failed with status code 400'), {
		response: { status: 400, data: { error: 'Invalid contact' } },
	});
	const thrown = new NodeApiError({ name: 'Send' }, axiosError);
	const ctx = context(() => {
		throw thrown;
	});

	let caught;
	await assert.rejects(
		() => conduytApiRequest.call(ctx, 'POST', '/messages/sms/send', {}),
		(error) => {
			caught = error;
			return true;
		},
	);
	assert.equal(deliveryUnconfirmedMessage(caught), undefined);
});

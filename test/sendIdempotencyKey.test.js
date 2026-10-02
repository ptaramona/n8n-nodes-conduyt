// Runs against the compiled output: `npm test` builds first (pretest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendIdempotencyKey } = require('../dist/nodes/Conduyt/GenericFunctions');

/**
 * Minimal IExecuteFunctions stand-in. `flow` is the object n8n hands back from
 * getContext('flow'); it lives in the execution's run data, so a manual retry of a
 * failed execution sees the same object under a new execution id.
 */
function stub({ executionId, runIndex = 0, flow = {}, nodeName = 'Send SMS', workflowId = 'wf-1' }) {
	return {
		getWorkflow: () => ({ id: workflowId }),
		getExecutionId: () => executionId,
		getNode: () => ({ name: nodeName }),
		getWorkflowDataProxy: () => ({ $thisRunIndex: runIndex }),
		getContext: (type) => {
			assert.equal(type, 'flow');
			return flow;
		},
	};
}

test('key shape: prefixed sha256 hex', () => {
	const key = sendIdempotencyKey.call(stub({ executionId: 'e1' }), 0);
	assert.match(key, /^n8n-[0-9a-f]{64}$/);
});

test('different items in one run get different keys', () => {
	const ctx = stub({ executionId: 'e1' });
	assert.notEqual(sendIdempotencyKey.call(ctx, 0), sendIdempotencyKey.call(ctx, 1));
});

test('loop: the same item index on a later node run gets a different key', () => {
	const flow = {};
	const run0 = stub({ executionId: 'e1', runIndex: 0, flow });
	const run1 = stub({ executionId: 'e1', runIndex: 1, flow });
	assert.notEqual(sendIdempotencyKey.call(run0, 0), sendIdempotencyKey.call(run1, 0));
});

test('Retry On Fail: repeated attempts of one run reuse the key', () => {
	const ctx = stub({ executionId: 'e1', runIndex: 2 });
	assert.equal(sendIdempotencyKey.call(ctx, 3), sendIdempotencyKey.call(ctx, 3));
});

test('manual Retry execution: new execution id, carried run data, same key', () => {
	const flow = {};
	const original = stub({ executionId: 'e1', runIndex: 1, flow });
	const first = sendIdempotencyKey.call(original, 2);
	assert.equal(flow.conduytRootExecutionId, 'e1');

	const retry = stub({ executionId: 'e2', runIndex: 1, flow });
	assert.equal(sendIdempotencyKey.call(retry, 2), first);
	assert.equal(flow.conduytRootExecutionId, 'e1', 'root id stays pinned to the first execution');

	// A retry of the retry still resolves to the root of the family.
	const retryOfRetry = stub({ executionId: 'e3', runIndex: 1, flow });
	assert.equal(sendIdempotencyKey.call(retryOfRetry, 2), first);
});

test('fresh execution (empty context) gets a fresh key', () => {
	const a = sendIdempotencyKey.call(stub({ executionId: 'e1' }), 0);
	const b = sendIdempotencyKey.call(stub({ executionId: 'e2' }), 0);
	assert.notEqual(a, b);
});

test('different nodes in one execution get different keys', () => {
	const flow = {};
	const sms = stub({ executionId: 'e1', flow, nodeName: 'Send SMS' });
	const email = stub({ executionId: 'e1', flow, nodeName: 'Send Email' });
	assert.notEqual(sendIdempotencyKey.call(sms, 0), sendIdempotencyKey.call(email, 0));
});

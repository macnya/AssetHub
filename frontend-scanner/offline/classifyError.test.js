// Run with:  npm test        (from frontend-scanner/)
// Uses Node's built-in test runner — no test framework to install.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, RETRY, REAUTH, REJECT } = require('./classifyError');

const withStatus = (status) => ({ response: { status } });

test('a network failure with no response is retryable', () => {
  assert.equal(classifyError(new Error('Network Error')), RETRY);
  assert.equal(classifyError({}), RETRY);
  assert.equal(classifyError(undefined), RETRY);
});

test('an expired session asks for re-auth and does NOT discard the queue', () => {
  // This is the regression. A 401 carries a response, and the original code
  // treated any response as a permanent failure — which silently destroyed a
  // day of offline verifications whenever a token expired overnight.
  assert.equal(classifyError(withStatus(401)), REAUTH);
  assert.notEqual(classifyError(withStatus(401)), REJECT);

  assert.equal(classifyError(withStatus(403)), REAUTH);
  assert.notEqual(classifyError(withStatus(403)), REJECT);
});

test('server errors are retryable, not the officer\'s fault', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyError(withStatus(status)), RETRY, `status ${status}`);
  }
});

test('timeouts and rate limiting are retryable', () => {
  assert.equal(classifyError(withStatus(408)), RETRY);
  assert.equal(classifyError(withStatus(429)), RETRY);
});

test('a genuine rejection is parked, not retried forever', () => {
  for (const status of [400, 404, 409, 422]) {
    assert.equal(classifyError(withStatus(status)), REJECT, `status ${status}`);
  }
});

test('every outcome is one of the three known values', () => {
  const statuses = [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503];
  for (const status of statuses) {
    const outcome = classifyError(withStatus(status));
    assert.ok([RETRY, REAUTH, REJECT].includes(outcome), `status ${status} gave "${outcome}"`);
  }
});
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../server/ratelimit');

// Minimal Express-style req/res doubles.
function reqFrom(ip) {
  return { ip, socket: { remoteAddress: ip } };
}
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.set = (k, v) => {
    res.headers[k] = v;
    return res;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

// Run the middleware once; return { blocked, res } where blocked means next() was
// NOT called (i.e. the request was rejected).
function hit(limiter, ip) {
  const res = fakeRes();
  let passed = false;
  limiter(reqFrom(ip), res, () => {
    passed = true;
  });
  return { blocked: !passed, res };
}

test('allows up to the max, then blocks with 429 + Retry-After', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  assert.equal(hit(limiter, '1.1.1.1').blocked, false);
  assert.equal(hit(limiter, '1.1.1.1').blocked, false);
  assert.equal(hit(limiter, '1.1.1.1').blocked, false);

  const fourth = hit(limiter, '1.1.1.1');
  assert.equal(fourth.blocked, true);
  assert.equal(fourth.res.statusCode, 429);
  assert.ok(fourth.res.headers['Retry-After']);
  assert.match(fourth.res.body.error, /Too many scans/);
});

test('limits are tracked per IP independently', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
  assert.equal(hit(limiter, 'a').blocked, false);
  assert.equal(hit(limiter, 'a').blocked, true); // a is now over
  assert.equal(hit(limiter, 'b').blocked, false); // b is unaffected
});

test('the window resets after it elapses', async () => {
  const limiter = createRateLimiter({ windowMs: 20, max: 1 });
  assert.equal(hit(limiter, 'x').blocked, false);
  assert.equal(hit(limiter, 'x').blocked, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hit(limiter, 'x').blocked, false); // fresh window
});

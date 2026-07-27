const test = require("node:test");
const assert = require("node:assert/strict");
const { createSecurityState } = require("../backend/security-state");

function request(ip = "127.0.0.1") {
  return { headers: {}, socket: { remoteAddress: ip } };
}

test("memory captcha is single-use", async () => {
  const state = createSecurityState({ redisUrl: "", trustProxy: false });
  await state.init();
  await state.saveCaptcha("one", "42", 1000);
  assert.equal(await state.consumeCaptcha("one", "42"), true);
  assert.equal(await state.consumeCaptcha("one", "42"), false);
});

test("memory rate limiter isolates buckets", async () => {
  const state = createSecurityState({ redisUrl: "", trustProxy: false });
  assert.equal(await state.rateLimit(request(), "login", 2, 10000), true);
  assert.equal(await state.rateLimit(request(), "login", 2, 10000), true);
  assert.equal(await state.rateLimit(request(), "login", 2, 10000), false);
  assert.equal(await state.rateLimit(request(), "captcha", 2, 10000), true);
});

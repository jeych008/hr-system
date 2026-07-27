const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createPasswordService, isBcryptAvailable } = require("../backend/passwords");

test("BCrypt hashes verify and do not expose the password", { skip: !isBcryptAvailable() }, () => {
  const passwords = createPasswordService(10);
  const encoded = passwords.hash("correct-horse-battery-staple");
  assert.match(encoded, /^\$2[aby]\$/);
  assert.equal(passwords.verify("correct-horse-battery-staple", encoded), true);
  assert.equal(passwords.verify("wrong", encoded), false);
  assert.equal(passwords.needsUpgrade(encoded), false);
});

test("production password service rejects a missing BCrypt dependency", { skip: isBcryptAvailable() }, () => {
  assert.throws(() => createPasswordService(10, { requireBcrypt: true }), /bcryptjs is required/);
});

test("legacy scrypt hashes remain valid and are marked for upgrade", () => {
  const passwords = createPasswordService(10);
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = `scrypt:${salt}:${crypto.scryptSync("legacy-password", salt, 32).toString("hex")}`;
  assert.equal(passwords.verify("legacy-password", legacy), true);
  assert.equal(passwords.verify("wrong", legacy), false);
  assert.equal(passwords.needsUpgrade(legacy), isBcryptAvailable());
});

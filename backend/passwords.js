const crypto = require("crypto");
let bcrypt = null;
try {
  bcrypt = require("bcryptjs");
} catch {}

function legacyHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${crypto.scryptSync(String(password), salt, 32).toString("hex")}`;
}

function createPasswordService(rounds, { requireBcrypt = false } = {}) {
  if (requireBcrypt && !bcrypt) throw new Error("bcryptjs is required in production; run npm ci before startup");

  function hash(password) {
    return bcrypt ? bcrypt.hashSync(String(password), rounds) : legacyHash(password);
  }

  function verify(password, stored) {
    const encoded = String(stored || "");
    if (encoded.startsWith("$2a$") || encoded.startsWith("$2b$") || encoded.startsWith("$2y$")) {
      try {
        return bcrypt.compareSync(String(password), encoded);
      } catch {
        return false;
      }
    }
    if (!encoded.startsWith("scrypt:")) return false;
    const [, salt, expectedHex] = encoded.split(":");
    if (!salt || !/^[a-f0-9]{64}$/i.test(expectedHex || "")) return false;
    const actual = crypto.scryptSync(String(password), salt, 32);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function needsUpgrade(stored) {
    if (!bcrypt) return false;
    if (!String(stored || "").startsWith("$2")) return true;
    return bcrypt.getRounds(stored) < rounds;
  }

  return { hash, verify, needsUpgrade };
}

module.exports = { createPasswordService, isBcryptAvailable: () => Boolean(bcrypt) };

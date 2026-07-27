const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../backend/runtime-config");

const managed = ["NODE_ENV", "STORAGE_DRIVER", "MYSQL_URL", "REDIS_URL", "JWT_SECRET", "PUBLIC_BASE_URL"];

function withEnv(values, fn) {
  const before = Object.fromEntries(managed.map(key => [key, process.env[key]]));
  for (const key of managed) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const key of managed) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("production rejects missing infrastructure and weak secrets", () => {
  withEnv({ NODE_ENV: "production", STORAGE_DRIVER: "json", JWT_SECRET: "short" }, () => {
    assert.throws(() => loadConfig(), /Production configuration rejected/);
  });
});

test("production accepts MySQL, Redis, HTTPS and a strong JWT secret", () => {
  withEnv({
    NODE_ENV: "production",
    STORAGE_DRIVER: "mysql",
    MYSQL_URL: "mysql://hr_app:StrongDatabasePassword123@mysql:3306/hr_resume",
    REDIS_URL: "redis://redis:6379/0",
    JWT_SECRET: "a".repeat(64),
    PUBLIC_BASE_URL: "https://recruit.company.test"
  }, () => {
    const config = loadConfig();
    assert.equal(config.storageDriver, "mysql");
    assert.equal(config.production, true);
  });
});

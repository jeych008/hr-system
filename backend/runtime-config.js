const crypto = require("crypto");

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function loadConfig() {
  const environment = process.env.NODE_ENV || "development";
  const production = environment === "production";
  const mysqlUrl = String(process.env.MYSQL_URL || "").trim();
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  const storageDriver = String(process.env.STORAGE_DRIVER || (mysqlUrl ? "mysql" : "json")).toLowerCase();
  let jwtSecret = String(process.env.JWT_SECRET || "");

  if (!jwtSecret && !production) {
    jwtSecret = crypto.randomBytes(32).toString("hex");
    console.warn("JWT_SECRET is not configured; development tokens will be invalid after restart.");
  }

  const config = {
    environment,
    production,
    port: int("PORT", 5177, 1, 65535),
    storageDriver,
    mysqlUrl,
    mysqlSsl: bool("MYSQL_SSL", false),
    mysqlAutoMigrate: bool("MYSQL_AUTO_MIGRATE", !production),
    mysqlPoolSize: int("MYSQL_POOL_SIZE", 10, 1, 50),
    redisUrl,
    jwtSecret,
    jwtTtlSeconds: int("JWT_TTL_SECONDS", production ? 7200 : 86400, 300, 86400),
    jwtIssuer: process.env.JWT_ISSUER || "hr-resume-system",
    jwtAudience: process.env.JWT_AUDIENCE || "hr-resume-admin",
    bcryptRounds: int("BCRYPT_ROUNDS", 12, 10, 14),
    passwordMinLength: int("PASSWORD_MIN_LENGTH", 10, 8, 64),
    bodyLimitBytes: int("BODY_LIMIT_BYTES", 1024 * 1024, 16 * 1024, 4 * 1024 * 1024),
    trustProxy: bool("TRUST_PROXY", false),
    runBackgroundJobs: bool("RUN_BACKGROUND_JOBS", true),
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
  };

  if (!['json', 'mysql'].includes(storageDriver)) {
    throw new Error("STORAGE_DRIVER must be json or mysql");
  }
  if (storageDriver === "mysql" && !mysqlUrl) {
    throw new Error("MYSQL_URL is required when STORAGE_DRIVER=mysql");
  }
  if (production) {
    const errors = [];
    if (storageDriver !== "mysql") errors.push("production requires STORAGE_DRIVER=mysql");
    if (!redisUrl) errors.push("production requires REDIS_URL");
    if (Buffer.byteLength(jwtSecret) < 32 || /replace|example|changeme/i.test(jwtSecret)) errors.push("JWT_SECRET must contain at least 32 random bytes");
    if (!/^https:\/\//i.test(config.publicBaseUrl)) errors.push("PUBLIC_BASE_URL must use https://");
    if (/\.example\.(com|org|net)(\/|$)/i.test(config.publicBaseUrl)) errors.push("PUBLIC_BASE_URL must not use an example domain");
    try {
      const databaseUrl = new URL(mysqlUrl);
      if (databaseUrl.protocol !== "mysql:" || !databaseUrl.username || databaseUrl.pathname === "/" || databaseUrl.password.length < 12 || /replace|changeme/i.test(databaseUrl.password)) {
        errors.push("MYSQL_URL must contain a dedicated user and a strong password");
      }
    } catch {
      errors.push("MYSQL_URL is invalid");
    }
    if (errors.length) throw new Error(`Production configuration rejected: ${errors.join("; ")}`);
  }
  return Object.freeze(config);
}

module.exports = { loadConfig };

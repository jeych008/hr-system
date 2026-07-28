#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../backend/runtime-config");
const { createMysqlStore } = require("../backend/mysql-store");

function sourceCounts(db) {
  return {
    users: (db.users || []).length,
    projects: (db.projects || []).length,
    monthly_configs: (db.monthlyConfigs || []).length,
    candidates: (db.candidates || []).length,
    daily_reports: (db.dailyReports || []).length,
    audit_logs: (db.auditLogs || []).length,
    violation_logs: (db.violationLogs || []).length,
    system_messages: (db.systemMessages || []).length,
    system_settings: db.systemSettings ? 1 : 0
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const credentialsRotated = args.includes("--confirm-credentials-rotated");
  const sourceArg = args.find(value => !value.startsWith("--"));
  const sourceFile = path.resolve(sourceArg || path.join(__dirname, "..", "data", "db.json"));
  if (!fs.existsSync(sourceFile)) throw new Error(`Source file does not exist: ${sourceFile}`);

  const db = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  for (const key of ["users", "projects", "monthlyConfigs", "candidates", "dailyReports", "auditLogs", "violationLogs", "systemMessages"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  for (const user of db.users) if (!Number.isInteger(user.authVersion)) user.authVersion = 0;
  if (!db.systemSettings) {
    db.systemSettings = {
      id: "report_delivery",
      sendTime: "19:00",
      deliveryEnabled: false,
      webhookUrl: "",
      lastGeneratedDate: "",
      lastSentDate: "",
      lastSendAttemptAt: "",
      lastSendError: "",
      updatedAt: ""
    };
  }
  const expected = sourceCounts(db);
  console.log("Source validated:", expected);
  if (dryRun) return;
  if (!credentialsRotated) {
    throw new Error("Refusing to migrate accounts until all development credentials are rotated. Re-run with --confirm-credentials-rotated after verification.");
  }

  const config = loadConfig();
  if (!config.mysqlUrl) throw new Error("MYSQL_URL is required");
  const store = createMysqlStore(config);
  try {
    await store.init({ migrate: true });
    const before = await store.counts();
    if (Object.values(before).some(Number) && !force) {
      throw new Error("Target MySQL database is not empty. Use --force only after taking a verified backup.");
    }
    if (force) await store.clear();
    const target = await store.read();
    Object.defineProperty(db, "__storageVersion", { value: target.__storageVersion, writable: true, enumerable: false });
    await store.write(db);
    const actual = await store.counts();
    const mismatches = Object.keys(expected).filter(key => expected[key] !== actual[key]);
    console.log("MySQL import completed:", actual);
    if (mismatches.length) throw new Error(`Count verification failed for: ${mismatches.join(", ")}`);
    console.log("Count verification passed.");
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});

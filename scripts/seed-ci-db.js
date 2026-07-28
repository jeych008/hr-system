#!/usr/bin/env node
const { loadConfig } = require("../backend/runtime-config");
const { createMysqlStore } = require("../backend/mysql-store");
const { createPasswordService } = require("../backend/passwords");

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const password = String(process.env.CI_ADMIN_PASSWORD || "");
  if (password.length < 10) throw new Error("CI_ADMIN_PASSWORD must contain at least 10 characters");
  const config = loadConfig();
  const store = createMysqlStore(config);
  try {
    let initialized = false;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await store.init({ migrate: true });
        initialized = true;
        break;
      } catch (error) {
        if (attempt === 30) throw error;
        await wait(2000);
      }
    }
    if (!initialized) throw new Error("MySQL did not become ready");
    const db = await store.read();
    db.users = [{
      id: "u_ci_admin",
      username: "admin",
      displayName: "CI 管理员",
      role: "ADMIN",
      enabled: true,
      passwordHash: createPasswordService(10).hash(password),
      authVersion: 0,
      projectIds: []
    }];
    db.projects = [];
    db.monthlyConfigs = [];
    db.candidates = [];
    db.dailyReports = [];
    db.auditLogs = [];
    db.violationLogs = [];
    db.systemMessages = [];
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
    await store.write(db);
    console.log("CI database initialized");
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`CI database initialization failed: ${error.message}`);
  process.exit(1);
});

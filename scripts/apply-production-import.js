#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../backend/runtime-config");
const { createMysqlStore } = require("../backend/mysql-store");

function unique(items, key, label) {
  const values = items.map(item => item[key]);
  if (values.some(value => !value) || new Set(values).size !== values.length) throw new Error(`${label}存在空值或重复值`);
}

function validIdCard(value) {
  const text = String(value || "").toUpperCase();
  if (!/^\d{17}[\dX]$/.test(text)) return false;
  const birth = `${text.slice(6, 10)}-${text.slice(10, 12)}-${text.slice(12, 14)}`;
  const parsed = new Date(`${birth}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birth) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const sum = weights.reduce((total, weight, index) => total + Number(text[index]) * weight, 0);
  return checks[sum % 11] === text[17];
}

function validateBundle(bundle) {
  if (bundle?.manifest?.formatVersion !== 1) throw new Error("不支持的导入包版本");
  for (const key of ["projects", "users", "candidates", "auditLogs"]) {
    if (!Array.isArray(bundle[key])) throw new Error(`导入包缺少 ${key}`);
  }
  if (bundle.projects.length !== 13 || bundle.users.length !== 10) throw new Error("项目或HR账号数量不符合已确认配置");
  if (bundle.candidates.length !== Number(bundle.manifest.acceptedRows)) throw new Error("候选人数量与清单不一致");
  unique(bundle.projects, "id", "项目ID");
  unique(bundle.projects, "shortCode", "项目链接");
  unique(bundle.users, "username", "HR用户名");
  unique(bundle.candidates, "id", "人员ID");
  const projectIds = new Set(bundle.projects.map(item => item.id));
  const phones = new Set();
  for (const user of bundle.users) {
    if (user.role !== "HR" || !user.username.startsWith("hr_") || !user.passwordHash?.startsWith("scrypt:")) throw new Error(`HR账号不符合规则: ${user.username}`);
    if (!user.projectIds?.length || user.projectIds.some(projectId => !projectIds.has(projectId))) throw new Error(`HR项目分配无效: ${user.username}`);
  }
  for (const candidate of bundle.candidates) {
    if (!projectIds.has(candidate.projectId)) throw new Error(`人员项目无效: ${candidate.id}`);
    if (!/^1[3-9]\d{9}$/.test(candidate.phone) || !validIdCard(candidate.idCard)) throw new Error(`人员证件或手机号格式无效: ${candidate.id}`);
    const key = `${candidate.projectId}:${candidate.phone}`;
    if (phones.has(key)) throw new Error(`同项目手机号重复: ${key}`);
    phones.add(key);
    if (!new Set(["CANDIDATE", "TRAINING", "LEFT"]).has(candidate.employmentStatus)) throw new Error(`人员状态无效: ${candidate.id}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirm-replace-business-data");
  const dryRun = args.includes("--dry-run");
  const sourceArg = args.find(value => !value.startsWith("--"));
  if (!sourceArg || (!confirmed && !dryRun)) throw new Error("用法: node scripts/apply-production-import.js <production-import.json> --dry-run|--confirm-replace-business-data");
  const source = path.resolve(sourceArg);
  const bundle = JSON.parse(fs.readFileSync(source, "utf8"));
  validateBundle(bundle);
  if (dryRun) {
    console.log(JSON.stringify({ message: "导入包校验通过，未修改数据库", ...bundle.manifest }, null, 2));
    return;
  }
  const config = loadConfig();
  if (config.storageDriver !== "mysql") throw new Error("生产导入仅支持MySQL");
  const store = createMysqlStore(config);
  try {
    await store.init();
    const current = await store.read();
    const admins = current.users.filter(user => user.role === "ADMIN" && user.username === "admin" && user.enabled !== false);
    if (admins.length !== 1) throw new Error("必须存在且仅存在一个启用的 admin 管理员账号");
    const importedAt = new Date().toISOString();
    const target = {
      users: [admins[0], ...bundle.users],
      projects: bundle.projects,
      monthlyConfigs: bundle.monthlyConfigs || [],
      candidates: bundle.candidates,
      dailyReports: [],
      auditLogs: [{
        id: `log_import_${Date.now()}`, actorId: admins[0].id, action: "REPLACE_TEST_DATA_WITH_PRODUCTION_IMPORT",
        entityType: "SYSTEM", entityId: "production-import", before: null, after: bundle.manifest, createdAt: importedAt
      }, ...bundle.auditLogs],
      violationLogs: [],
      systemMessages: [],
      systemSettings: current.systemSettings ? {
        ...current.systemSettings,
        lastGeneratedDate: "",
        lastSentDate: "",
        lastSendAttemptAt: "",
        lastSendError: "",
        updatedAt: importedAt
      } : null,
      captchas: []
    };
    Object.defineProperty(target, "__storageVersion", { value: current.__storageVersion, writable: true, enumerable: false });
    const expected = {
      users: target.users.length,
      projects: target.projects.length,
      monthly_configs: target.monthlyConfigs.length,
      candidates: target.candidates.length,
      daily_reports: target.dailyReports.length,
      audit_logs: target.auditLogs.length,
      violation_logs: target.violationLogs.length,
      system_messages: target.systemMessages.length,
      system_settings: target.systemSettings ? 1 : 0
    };
    await store.write(target, { replaceHistory: true, expectedCounts: expected });
    const actual = await store.counts();
    console.log(JSON.stringify({ message: "生产数据导入成功", ...actual }, null, 2));
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`生产数据导入失败: ${error.message}`);
  process.exit(1);
});

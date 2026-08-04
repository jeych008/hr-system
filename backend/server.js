const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawnSync } = require("child_process");
const { URL } = require("url");
const { loadConfig } = require("./runtime-config");
const { createPasswordService } = require("./passwords");
const { createSecurityState } = require("./security-state");
const { createStorage } = require("./storage");
const {
  formatShanghaiDateTime,
  localClockParts,
  publicReportSettings,
  reportIsDue,
  reportSettings,
  sendIsDue,
  sendWechatFile,
  updateReportSettings
} = require("./report-delivery");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.resolve(process.env.DATA_FILE || path.join(DATA_DIR, "db.json"));
const FRONTEND_DIR = path.join(ROOT, "frontend");
const VENDOR_FILES = new Map([
  ["/vendor/flatpickr/flatpickr.min.css", path.join(ROOT, "node_modules/flatpickr/dist/flatpickr.min.css")],
  ["/vendor/flatpickr/month-select.css", path.join(ROOT, "node_modules/flatpickr/dist/plugins/monthSelect/style.css")],
  ["/vendor/flatpickr/flatpickr.min.js", path.join(ROOT, "node_modules/flatpickr/dist/flatpickr.min.js")],
  ["/vendor/flatpickr/zh.js", path.join(ROOT, "node_modules/flatpickr/dist/l10n/zh.js")],
  ["/vendor/flatpickr/month-select.js", path.join(ROOT, "node_modules/flatpickr/dist/plugins/monthSelect/index.js")]
]);
const PDF_GENERATOR = path.join(__dirname, "pdf_generator.py");
const REPORT_PDF_GENERATOR = path.join(__dirname, "report_pdf_generator.py");
const REPORTS_DIR = path.resolve(process.env.REPORTS_DIR || path.join(DATA_DIR, "reports"));
const ALL_PROJECTS_REPORT_ID = "__all__";
const config = loadConfig();
const PORT = config.port;
const passwordService = createPasswordService(config.bcryptRounds, { requireBcrypt: config.production });
const securityState = createSecurityState(config);

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  ...(config.production ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {})
};

function nowIso() {
  return new Date().toISOString();
}

function localDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function localMonth(date = localDate()) {
  return date.slice(0, 7);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function shortCode(db) {
  let code = "";
  do {
    code = `job-${crypto.randomBytes(4).toString("hex")}`;
  } while (db.projects.some(p => p.shortCode === code));
  return code;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload,
    iss: config.jwtIssuer,
    aud: config.jwtAudience,
    iat: now,
    exp: now + config.jwtTtlSeconds,
    jti: crypto.randomBytes(12).toString("hex")
  }));
  const sig = crypto.createHmac("sha256", config.jwtSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (decodedHeader.alg !== "HS256" || decodedHeader.typ !== "JWT") return null;
    const expected = crypto.createHmac("sha256", config.jwtSecret).update(`${header}.${body}`).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.iss !== config.jwtIssuer || payload.aud !== config.jwtAudience) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.iat > now + 60 || payload.exp <= now || payload.exp - payload.iat > config.jwtTtlSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) return;
  const username = String(process.env.INITIAL_ADMIN_USERNAME || "").trim();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || "");
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username) || password.length < config.passwordMinLength) {
    throw new Error(`New JSON databases require INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD (at least ${config.passwordMinLength} characters)`);
  }
  const adminId = id("u");
  const seed = {
    users: [
      {
        id: adminId,
        username,
        displayName: String(process.env.INITIAL_ADMIN_NAME || "系统管理员").trim(),
        role: "ADMIN",
        enabled: true,
        passwordHash: passwordService.hash(password),
        authVersion: 0,
        projectIds: []
      }
    ],
    projects: [],
    monthlyConfigs: [],
    candidates: [],
    dailyReports: [],
    auditLogs: [],
    violationLogs: [],
    systemMessages: [],
    systemSettings: {
      id: "report_delivery",
      sendTime: "19:00",
      deliveryEnabled: false,
      webhookUrl: "",
      lastGeneratedDate: "",
      lastSentDate: "",
      lastSendAttemptAt: "",
      lastSendError: "",
      updatedAt: ""
    },
    captchas: []
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
}

function readJsonDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  let changed = false;
  if (!Array.isArray(db.systemMessages)) {
    db.systemMessages = [];
    changed = true;
  }
  if (!db.systemSettings || typeof db.systemSettings !== "object") {
    reportSettings(db);
    changed = true;
  }
  for (const user of db.users || []) {
    if (!Number.isInteger(user.authVersion)) {
      user.authVersion = 0;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(db, "operationData")) {
    delete db.operationData;
    changed = true;
  }
  for (const config of db.monthlyConfigs || []) {
    if (Object.prototype.hasOwnProperty.call(config, "openingHeadcount")) {
      delete config.openingHeadcount;
      changed = true;
    }
  }
  for (const project of db.projects || []) {
    if (!project.shortCode) {
      project.shortCode = shortCode(db);
      changed = true;
    }
  }
  if (changed) writeJsonDb(db);
  for (const candidate of db.candidates || []) {
    if (!candidate.employmentStatus) {
      candidate.employmentStatus = "CANDIDATE";
      changed = true;
    }
    for (const field of [
      "plannedJoinDate",
      "plannedJoinSetAt",
      "plannedJoinSetBy",
      "failedAt",
      "failedBy",
      "failedReason",
      "joinedAt",
      "joinedBy",
      "trainingStartedAt",
      "trainingStartedBy",
      "trainingEndedAt",
      "trainingEndedBy",
      "activeAt",
      "activeBy",
      "leftAt",
      "leftBy",
      "leftReason",
      "leftFromStatus",
      "abandonAt",
      "abandonBy",
      "abandonReason",
      "lastReminderDate"
    ]) {
      if (!Object.prototype.hasOwnProperty.call(candidate, field)) {
        candidate[field] = null;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "attachment")) {
      delete candidate.attachment;
      changed = true;
    }
  }
  if (changed) writeJsonDb(db);
  return db;
}

function writeJsonDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const storage = createStorage(config, {
  async init() { ensureDb(); },
  async read() { return readJsonDb(); },
  async write(db) { writeJsonDb(db); }
});

async function readDb() {
  return storage.read();
}

async function writeDb(db) {
  return storage.write(db);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...jsonHeaders, ...headers });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType) {
  const isFrontendCode = contentType.startsWith("text/html") || contentType.startsWith("text/javascript") || contentType.startsWith("text/css");
  res.writeHead(status, {
    ...jsonHeaders,
    "content-type": contentType,
    "cache-control": isFrontendCode ? "no-cache" : "public, max-age=300"
  });
  res.end(body);
}

function bad(res, message, status = 400, extra = {}) {
  send(res, status, { error: message, ...extra });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > config.bodyLimitBytes) {
        tooLarge = true;
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("请求内容过大"), { statusCode: 413 }));
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error("请求内容不是有效JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function getUser(req, db) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const payload = verifyJwt(match?.[1]);
  if (!payload) return null;
  const user = db.users.find(u => u.id === payload.sub && u.enabled);
  if (!user || Number(payload.ver || 0) !== Number(user.authVersion || 0)) return null;
  return user;
}

function canAccessAllRecruitmentData(user) {
  return ["ADMIN", "OPS"].includes(user.role);
}

function canWriteRecruitmentData(user) {
  return ["ADMIN", "HR"].includes(user.role);
}

function projectAllowed(user, projectId) {
  return canAccessAllRecruitmentData(user) || user.projectIds.includes(projectId);
}

function findPublicProject(db, identifier) {
  return db.projects.find(p => p.enabled && (p.id === identifier || p.shortCode === identifier));
}

function requireAuth(req, res, db) {
  const user = getUser(req, db);
  if (!user) {
    bad(res, "未登录或登录已过期", 401);
    return null;
  }
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    projectIds: user.projectIds
  };
}

function validateProjectIds(db, projectIds) {
  if (!Array.isArray(projectIds)) return "项目必须为多选列表";
  const validIds = new Set(db.projects.map(p => p.id));
  if (projectIds.some(projectId => !validIds.has(projectId))) return "包含不存在的项目";
  return "";
}

function validateUserCreate(db, body) {
  const username = String(body.username || "").trim();
  const displayName = String(body.displayName || "").trim();
  const password = String(body.password || "");
  const role = body.role || "HR";
  const projectIds = body.projectIds || [];
  if (!username) return "用户名为必填";
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return "用户名需为3-32位字母、数字或下划线";
  if (!displayName) return "姓名为必填";
  if (!password) return "密码为必填";
  if (password.length < config.passwordMinLength) return `密码至少${config.passwordMinLength}位`;
  if (!["ADMIN", "HR", "OPS"].includes(role)) return "角色不正确";
  const projectError = validateProjectIds(db, projectIds);
  if (projectError) return projectError;
  if (role === "HR" && projectIds.length === 0) return "创建HR账号至少分配一个项目";
  if (db.users.some(u => u.username === username)) return "用户名已存在";
  return "";
}

function validateUserUpdate(db, body) {
  if (body.displayName !== undefined && !String(body.displayName || "").trim()) return "姓名不能为空";
  if (body.password !== undefined && String(body.password || "").length < config.passwordMinLength) return `密码至少${config.passwordMinLength}位`;
  if (body.role !== undefined && !["ADMIN", "HR", "OPS"].includes(body.role)) return "角色不正确";
  if (body.projectIds !== undefined) return validateProjectIds(db, body.projectIds);
  return "";
}

function maskPhone(phone = "") {
  return phone.replace(/^(\d{3})\d{4}(\d+)/, "$1****$2");
}

function maskEmail(email = "") {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  return `${name.slice(0, 2)}***@${domain}`;
}

function maskIdCard(idCard = "") {
  return idCard.replace(/^(.{6}).+(.{4})$/, "$1********$2");
}

function candidateListView(c) {
  return {
    ...c,
    phone: maskPhone(c.phone),
    email: maskEmail(c.email),
    idCard: maskIdCard(c.idCard),
    statusCode: candidateStatus(c),
    statusLabel: candidateStatusLabel(c),
    group: candidateGroupOf(c),
    plannedJoinDate: c.plannedJoinDate || "",
    failedReason: c.failedReason || "",
    joinedAt: c.joinedAt || "",
    trainingStartedAt: c.trainingStartedAt || "",
    trainingEndedAt: c.trainingEndedAt || "",
    activeAt: c.activeAt || "",
    leftAt: c.leftAt || "",
    leftReason: c.leftReason || "",
    abandonReason: c.abandonReason || ""
  };
}

function isDateOnly(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(`${text}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day;
}

function normalizeHalfWidth(value) {
  return String(value ?? "").replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, " ");
}

function ageOf(birthDate, at = new Date()) {
  if (!birthDate) return null;
  const birth = new Date(`${birthDate}T00:00:00`);
  let age = at.getFullYear() - birth.getFullYear();
  const m = at.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < birth.getDate())) age--;
  return age;
}

function ageBucket(birthDate) {
  const age = ageOf(birthDate);
  if (age == null || Number.isNaN(age)) return "未知";
  if (age <= 25) return "18-25";
  if (age <= 30) return "26-30";
  if (age <= 35) return "31-35";
  if (age <= 40) return "36-40";
  return "40+";
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const k = keyFn(item) || "未知";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function dateInRange(value, from, to) {
  const d = localDatePart(value);
  return (!from || d >= from) && (!to || d <= to);
}

function sameDay(iso, date) {
  return iso && localDatePart(iso) === date;
}

function localDatePart(value) {
  if (!value) return "";
  const text = String(value);
  if (isDateOnly(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : localDate(parsed);
}

function addDaysLocal(date, days) {
  const d = new Date(`${date}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

const statusLabels = {
  PENDING: "待处理",
  ARRIVED: "已到面",
  PASSED: "已通过",
  FAILED: "未通过",
  PENDING_ONBOARD_CONFIRM: "待入职确认",
  TRAINING: "培训中",
  ACTIVE: "在职",
  LEFT: "已离职",
  ABANDONED: "放弃入职"
};

function candidateStatus(c, date = localDate()) {
  if (["ONBOARD", "ACTIVE"].includes(c.employmentStatus)) return "ACTIVE";
  if (c.employmentStatus === "TRAINING") return "TRAINING";
  if (c.employmentStatus === "LEFT") return "LEFT";
  if (c.employmentStatus === "ABANDONED") return "ABANDONED";
  if (c.failedAt) return "FAILED";
  if (c.passed && c.plannedJoinDate === date) return "PENDING_ONBOARD_CONFIRM";
  if (c.passed) return "PASSED";
  if (c.arrived) return "ARRIVED";
  return "PENDING";
}

function candidateLeftDate(c) {
  return c.leftAt || "";
}

function countLeftCandidates(db, projectIds, from, to) {
  const allowed = new Set(projectIds);
  return db.candidates.filter(c => {
    if (!allowed.has(c.projectId) || candidateStatus(c) !== "LEFT") return false;
    if (!from && !to) return true;
    return Boolean(candidateLeftDate(c)) && dateInRange(candidateLeftDate(c), from, to);
  }).length;
}

function candidateStatusLabel(c) {
  return statusLabels[candidateStatus(c)] || "待处理";
}

function candidateGroupOf(c) {
  const status = candidateStatus(c);
  if (status === "TRAINING") return "training";
  if (status === "ACTIVE") return "onboard";
  if (status === "LEFT") return "left";
  if (status === "ABANDONED") return "abandoned";
  return "candidates";
}

function validateReason(value, label) {
  const text = String(value || "").trim();
  if (!text) return `${label}为必填`;
  if (text.length > 200) return `${label}最多200字`;
  return "";
}

function candidateWorkflowDefaults() {
  return {
    plannedJoinDate: null,
    plannedJoinSetAt: null,
    plannedJoinSetBy: null,
    failedAt: null,
    failedBy: null,
    failedReason: null,
    joinedAt: null,
    joinedBy: null,
    trainingStartedAt: null,
    trainingStartedBy: null,
    trainingEndedAt: null,
    trainingEndedBy: null,
    activeAt: null,
    activeBy: null,
    leftAt: null,
    leftBy: null,
    leftReason: null,
    leftFromStatus: null,
    abandonAt: null,
    abandonBy: null,
    abandonReason: null,
    lastReminderDate: null
  };
}

function latestMonthlyConfig(db, projectId, month) {
  return db.monthlyConfigs.find(c => c.projectId === projectId && c.month === month) ||
    { projectId, month, targetHc: 0 };
}

function headcount(db, projectId, date = localDate()) {
  const month = localMonth(date);
  const cfg = latestMonthlyConfig(db, projectId, month);
  const onboard = db.candidates.filter(c => c.projectId === projectId && candidateStatus(c) === "ACTIVE").length;
  const training = db.candidates.filter(c => c.projectId === projectId && candidateStatus(c) === "TRAINING").length;
  return { onboard, training, gap: cfg.targetHc - onboard, targetHc: cfg.targetHc };
}

function candidateStats(candidates) {
  return {
    education: countBy(candidates, c => c.education),
    gender: countBy(candidates, c => c.gender),
    experience: countBy(candidates, c => (c.phoneCustomerServiceExperience ?? c.hasCustomerServiceExperience) ? "有电话客服经验" : "无电话客服经验"),
    age: countBy(candidates, c => ageBucket(c.birthDate))
  };
}

function autoCounts(db, projectId, date) {
  const created = db.candidates.filter(c => c.projectId === projectId && sameDay(c.createdAt, date));
  const arrived = db.candidates.filter(c => c.projectId === projectId && sameDay(c.arrivedAt, date));
  const passed = db.candidates.filter(c => c.projectId === projectId && sameDay(c.passedAt, date));
  const joined = db.candidates.filter(c => c.projectId === projectId && sameDay(c.joinedAt, date));
  const left = db.candidates.filter(c => c.projectId === projectId && candidateStatus(c) === "LEFT" && sameDay(c.leftAt, date));
  const training = db.candidates.filter(c => c.projectId === projectId && candidateStatus(c) === "TRAINING");
  return { newCandidateCount: created.length, arrivedCount: arrived.length, passedCount: passed.length, joinedCount: joined.length, leftCount: left.length, trainingCount: training.length };
}

function todayProjectStats(db, projectIds, date = localDate()) {
  return projectIds.map(projectId => {
    const project = db.projects.find(p => p.id === projectId);
    const counts = autoCounts(db, projectId, date);
    return {
      projectId,
      projectName: project?.name || projectId,
      date,
      ...counts,
      onboardCount: headcount(db, projectId, date).onboard
    };
  });
}

function countJoinedCandidates(db, projectIds, from, to) {
  const allowed = new Set(projectIds);
  return db.candidates.filter(c => {
    if (!allowed.has(c.projectId)) return false;
    if (!from && !to) return Boolean(c.joinedAt) || ["TRAINING", "ACTIVE", "LEFT"].includes(candidateStatus(c));
    return Boolean(c.joinedAt) && dateInRange(c.joinedAt, from, to);
  }).length;
}

function dailyJoinTrend(db, projectIds, month) {
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const allowed = new Set(projectIds);
  const counts = new Map();
  for (const candidate of db.candidates) {
    if (!allowed.has(candidate.projectId) || !candidate.joinedAt) continue;
    const date = localDatePart(candidate.joinedAt);
    if (!date.startsWith(`${month}-`)) continue;
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    return { date, count: counts.get(date) || 0 };
  });
}

function generateEntryReminders(db) {
  const today = localDate();
  const tomorrow = addDaysLocal(today, 1);
  let changed = false;
  for (const candidate of db.candidates || []) {
    if (!candidate.plannedJoinDate || candidate.plannedJoinDate !== tomorrow) continue;
    if (["TRAINING", "ACTIVE", "LEFT", "ABANDONED"].includes(candidateStatus(candidate))) continue;
    const recipients = (db.users || []).filter(user => user.role === "HR" && projectAllowed(user, candidate.projectId));
    for (const hr of recipients) {
      const exists = (db.systemMessages || []).some(msg => msg.type === "JOIN_TOMORROW" && msg.candidateId === candidate.id && msg.userId === hr.id && msg.messageDate === tomorrow);
      if (exists) continue;
      db.systemMessages.unshift({
        id: id("msg"),
        type: "JOIN_TOMORROW",
        projectId: candidate.projectId,
        candidateId: candidate.id,
        userId: hr.id,
        messageDate: tomorrow,
        message: `候选人 ${candidate.name} 的计划入职时间为明天，请及时确认。`,
        readAt: null,
        createdAt: nowIso()
      });
      changed = true;
    }
  }
  return changed;
}

function appendAudit(db, actorId, action, entityId, before, after) {
  db.auditLogs.unshift({ id: id("log"), actorId, action, entityType: "CANDIDATE", entityId, before, after, createdAt: nowIso() });
}

function validateIdCard(idCard) {
  const value = String(idCard || "").trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(value)) return false;
  const birth = value.slice(6, 14);
  const year = Number(birth.slice(0, 4));
  const month = Number(birth.slice(4, 6));
  const day = Number(birth.slice(6, 8));
  const date = new Date(`${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17];
}

function birthDateFromIdCard(idCard) {
  const value = String(idCard || "").trim().toUpperCase();
  if (!validateIdCard(value)) return "";
  const birth = value.slice(6, 14);
  return `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}`;
}

function validateCandidate(data) {
  const required = [
    "name",
    "gender",
    "education",
    "phone",
    "idCard",
    "email",
    "recruitmentChannel",
    "appliedPosition",
    "availableDate",
    "graduationSchool",
    "major",
    "mandarinLevel",
    "graduationTime",
    "currentResidenceProvince",
    "currentResidenceCity",
    "maritalStatus",
    "childrenStatus",
    "expectedProvince",
    "expectedCity",
    "lastLeaveReason"
  ];
  for (const field of required) {
    if (!String(data[field] || "").trim()) return `${field} 为必填`;
  }
  if (data.phoneCustomerServiceExperience !== true && data.phoneCustomerServiceExperience !== false) return "电话客服类行业经验为必填";
  if (!/^1[3-9]\d{9}$/.test(String(data.phone).trim())) return "手机号格式不正确";
  if (!validateIdCard(data.idCard)) return "身份证号码格式不正确";
  const birthDate = birthDateFromIdCard(data.idCard);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email).trim())) return "邮箱格式不正确";
  for (const field of ["availableDate", "graduationTime"]) {
    if (!isDateOnly(data[field])) return `${field} 日期格式应为 yyyy-MM-dd`;
  }
  if (String(data.graduationTime) < birthDate) return "毕业时间不能早于出生日期";
  if (!["初中及以下", "高中", "中专或技校", "大专", "本科", "研究生", "博士"].includes(data.education)) return "学历选项不正确";
  if (!["未评级", "一甲", "一乙", "二甲", "二乙", "三甲", "三乙"].includes(data.mandarinLevel)) return "普通话水平选项不正确";
  const channel = String(data.recruitmentChannel || "").trim();
  const channelOk = ["BOSS直聘", "58同城", "本地招聘网", "现场招聘会", "人力资源公司", "社区推荐"].includes(channel) ||
    (channel.startsWith("亲友介绍：") && channel.slice(5).trim()) ||
    (channel.startsWith("其他：") && channel.slice(3).trim());
  if (!channelOk) return "获知招聘信息渠道选项不正确";
  if (data.maritalStatus && !["已婚", "未婚"].includes(data.maritalStatus)) return "婚姻状况只能为已婚或未婚";
  if (data.childrenStatus && !["有", "无"].includes(data.childrenStatus)) return "子女情况只能为有或无";
  if (String(data.lastLeaveReason || "").length > 500) return "上一份工作离职原因最多500字";
  if (!Array.isArray(data.workExperiences) || data.workExperiences.length === 0) return "工作经历为必填";
  for (const work of data.workExperiences) {
    for (const field of ["companyName", "position", "startDate", "endDate", "description"]) {
      if (!String(work[field] || "").trim()) return "工作经历每一项均为必填";
    }
    if (!isDateOnly(work.startDate) || !isDateOnly(work.endDate)) return "工作经历日期格式应为 yyyy-MM-dd";
    if (String(work.endDate) < String(work.startDate)) return "工作经历的结束时间不能早于开始时间";
  }
  return null;
}

function normalizeCandidate(data) {
  return {
    name: String(data.name || "").trim(),
    gender: data.gender,
    birthDate: birthDateFromIdCard(data.idCard),
    education: data.education,
    phone: String(data.phone || "").trim(),
    idCard: String(data.idCard || "").trim().toUpperCase(),
    email: String(data.email || "").trim(),
    recruitmentChannel: String(data.recruitmentChannel || "").trim(),
    appliedPosition: String(data.appliedPosition || "").trim(),
    availableDate: String(data.availableDate || "").trim(),
    graduationSchool: String(data.graduationSchool || "").trim(),
    major: String(data.major || "").trim(),
    mandarinLevel: String(data.mandarinLevel || "").trim(),
    graduationTime: String(data.graduationTime || "").trim(),
    hasCustomerServiceExperience: Boolean(data.phoneCustomerServiceExperience),
    phoneCustomerServiceExperience: Boolean(data.phoneCustomerServiceExperience),
    currentResidenceProvince: String(data.currentResidenceProvince || "").trim(),
    currentResidenceCity: String(data.currentResidenceCity || "").trim(),
    currentResidence: data.currentResidenceProvince || data.currentResidenceCity
      ? [data.currentResidenceProvince, data.currentResidenceCity].filter(Boolean).join(" ")
      : String(data.currentResidence || "").trim(),
    maritalStatus: String(data.maritalStatus || "").trim(),
    childrenStatus: String(data.childrenStatus || "").trim(),
    expectedProvince: String(data.expectedProvince || "").trim(),
    expectedCity: String(data.expectedCity || "").trim(),
    expectedLocation: data.expectedProvince || data.expectedCity
      ? [data.expectedProvince, data.expectedCity].filter(Boolean).join(" ")
      : String(data.expectedLocation || "").trim(),
    lastLeaveReason: String(data.lastLeaveReason || "").trim(),
    workExperiences: Array.isArray(data.workExperiences) ? data.workExperiences.map(w => ({
      companyName: String(w.companyName || "").trim(),
      position: String(w.position || "").trim(),
      startDate: String(w.startDate || "").trim(),
      endDate: String(w.endDate || "").trim(),
      description: String(w.description || "").trim()
    })).filter(w => w.companyName || w.position || w.description) : []
  };
}

function buildDailySnapshot(db, projectId, date) {
  const projectIds = projectId === ALL_PROJECTS_REPORT_ID ? db.projects.map(project => project.id) : [projectId];
  const selectedProjectId = projectId === ALL_PROJECTS_REPORT_ID ? "" : projectId;
  const reportMonth = localMonth(date);
  const cumulative = cumulativeReport(db, selectedProjectId, "", date, projectIds, true, reportMonth);
  const currentDay = cumulativeReport(db, selectedProjectId, date, date, projectIds, false, reportMonth);
  cumulative.todayByProject = todayProjectStats(db, projectIds, date);
  return {
    id: id("daily"),
    projectId,
    projectName: projectId === ALL_PROJECTS_REPORT_ID
      ? "全部项目"
      : db.projects.find(project => project.id === projectId)?.name || projectId,
    date,
    locked: true,
    generatedAt: nowIso(),
    reportMonth,
    currentDayMetrics: currentDay.metrics,
    metrics: cumulative.metrics,
    distributions: cumulative.distributions,
    dailyJoinTrend: cumulative.dailyJoinTrend,
    byProject: cumulative.byProject,
    todayByProject: cumulative.todayByProject
  };
}

function ensureDailyReports(db, date, onlyProjectId = null) {
  const projectIds = onlyProjectId
    ? [onlyProjectId]
    : [ALL_PROJECTS_REPORT_ID, ...db.projects.map(project => project.id)];
  const created = [];
  for (const projectId of projectIds) {
    if (db.dailyReports.some(report => report.projectId === projectId && report.date === date)) continue;
    const report = buildDailySnapshot(db, projectId, date);
    db.dailyReports.push(report);
    created.push(report);
  }
  return created;
}

function routeParams(pathname, pattern) {
  const p = pathname.split("/").filter(Boolean);
  const pat = pattern.split("/").filter(Boolean);
  if (p.length !== pat.length) return null;
  const params = {};
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(":")) params[pat[i].slice(1)] = decodeURIComponent(p[i]);
    else if (pat[i] !== p[i]) return null;
  }
  return params;
}

function escapeXml(s = "") {
  return String(s).replace(/[<>&'"]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[ch]));
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function xlsx(rows) {
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const col = String.fromCharCode(65 + c);
    return `<c r="${col}${r + 1}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return zipStore([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="报表" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` }
  ]);
}

function simplePdf(candidates) {
  const pageStreams = [];
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 44;
  const contentWidth = pageWidth - margin * 2;
  const bottom = 62;
  let ops = [];
  let y = 790;
  let currentName = "";

  const hexText = value => {
    const text = normalizeHalfWidth(value ?? "-");
    const buf = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) buf.writeUInt16BE(text.charCodeAt(i), i * 2);
    return `<${buf.toString("hex")}>`;
  };
  const safe = value => normalizeHalfWidth(value ?? "").trim() || "-";
  const wrap = (value, width, size = 9) => {
    const source = safe(value).replace(/\r\n?/g, "\n");
    const lines = [];
    for (const paragraph of source.split("\n")) {
      let lineText = "";
      let lineWidth = 0;
      for (const ch of Array.from(paragraph || " ")) {
        const charWidth = /[\x00-\xff]/.test(ch) ? size * 0.55 : size;
        if (lineText && lineWidth + charWidth > width) {
          lines.push(lineText);
          lineText = ch;
          lineWidth = charWidth;
        } else {
          lineText += ch;
          lineWidth += charWidth;
        }
      }
      if (lineText) lines.push(lineText);
    }
    return lines.length ? lines : ["-"];
  };
  const color = (r, g, b, stroke = false) => `${r} ${g} ${b} ${stroke ? "RG" : "rg"}`;
  const text = (x, yy, value, size = 10, font = "F2") => {
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${yy} Tm ${hexText(value)} Tj ET`);
  };
  const rect = (x, yy, w, h, r, g, b) => {
    ops.push(`q ${color(r, g, b)} ${x} ${yy} ${w} ${h} re f Q`);
  };
  const strokeRect = (x, yy, w, h, r = 0.82, g = 0.85, b = 0.9) => {
    ops.push(`q ${color(r, g, b, true)} ${x} ${yy} ${w} ${h} re S Q`);
  };
  const line = (x1, y1, x2, y2, r = 0.82, g = 0.85, b = 0.9) => {
    ops.push(`q ${color(r, g, b, true)} ${x1} ${y1} m ${x2} ${y2} l S Q`);
  };
  const circle = (cx, cy, radius, r, g, b) => {
    const k = radius * 0.5522847498;
    ops.push(`q ${color(r, g, b)} ${cx + radius} ${cy} m ${cx + radius} ${cy + k} ${cx + k} ${cy + radius} ${cx} ${cy + radius} c ${cx - k} ${cy + radius} ${cx - radius} ${cy + k} ${cx - radius} ${cy} c ${cx - radius} ${cy - k} ${cx - k} ${cy - radius} ${cx} ${cy - radius} c ${cx + k} ${cy - radius} ${cx + radius} ${cy - k} ${cx + radius} ${cy} c f Q`);
  };
  const finishPage = () => {
    if (!ops.length) return;
    rect(205, 26, 185, 18, 0.96, 0.96, 0.96);
    text(248, 31, "内部保密资料", 10);
    pageStreams.push(ops.join("\n"));
    ops = [];
  };
  const continuationPage = () => {
    finishPage();
    y = 790;
    text(margin, 808, `${currentName} - 简历续页`, 14);
    line(margin, 797, pageWidth - margin, 797);
  };
  const ensureSpace = height => {
    if (y - height < bottom) continuationPage();
  };
  const section = title => {
    ensureSpace(40);
    y -= 24;
    rect(margin, y - 2, 4, 18, 0.08, 0.34, 0.94);
    text(margin + 12, y + 2, title, 14);
    line(margin, y - 11, pageWidth - margin, y - 11);
    y -= 23;
  };
  const grid = fields => {
    const cellWidth = contentWidth / 2;
    for (let index = 0; index < fields.length; index += 2) {
      const row = [fields[index], fields[index + 1]].filter(Boolean);
      const lines = row.map(item => wrap(item[1], cellWidth - 84, 9));
      const rowHeight = Math.max(28, 12 + Math.max(...lines.map(items => items.length)) * 12);
      ensureSpace(rowHeight + 8);
      const top = y + 7;
      const rowBottom = y - rowHeight + 5;
      rect(margin, rowBottom, contentWidth, rowHeight, 0.99, 0.995, 1);
      strokeRect(margin, rowBottom, contentWidth, rowHeight);
      line(margin + cellWidth, rowBottom, margin + cellWidth, top);
      row.forEach((item, cellIndex) => {
        const x = margin + cellIndex * cellWidth + 10;
        text(x, y, `${item[0]}：`, 8.5);
        lines[cellIndex].forEach((part, lineIndex) => text(x + 72, y - lineIndex * 12, part, 9));
      });
      y = rowBottom - 8;
    }
  };
  const note = (label, value) => {
    const lines = wrap(value, contentWidth - 24, 9);
    const rowHeight = 30 + Math.max(0, lines.length - 1) * 13;
    ensureSpace(rowHeight + 8);
    const top = y + 7;
    const rowBottom = y - rowHeight + 5;
    strokeRect(margin, rowBottom, contentWidth, rowHeight);
    text(margin + 12, y, label, 9);
    lines.forEach((part, index) => text(margin + 12, y - 15 - index * 13, part, 9));
    y = rowBottom - 8;
  };
  const workBlock = work => {
    const description = wrap(work.description, contentWidth - 46, 9);
    let offset = 0;
    let first = true;
    while (first || offset < description.length) {
      ensureSpace(first ? 96 : 48);
      const headerHeight = first ? 58 : 26;
      const availableLines = Math.max(1, Math.floor((y - bottom - headerHeight - 15) / 13));
      const part = description.slice(offset, offset + availableLines);
      const cardHeight = headerHeight + Math.max(0, part.length - 1) * 13 + 24;
      ensureSpace(cardHeight + 8);
      const top = y + 7;
      const cardBottom = y - cardHeight + 5;
      rect(margin + 8, cardBottom, contentWidth - 16, cardHeight, 0.985, 0.985, 0.985);
      strokeRect(margin + 8, cardBottom, contentWidth - 16, cardHeight);
      if (first) {
        text(margin + 20, y, `公司名称：${safe(work.companyName)}`, 9.5);
        text(margin + 270, y, `职位：${safe(work.position)}`, 9.5);
        text(margin + 20, y - 17, `起止时间：${safe(work.startDate)} 至 ${safe(work.endDate)}`, 9);
        text(margin + 20, y - 34, "工作描述：", 9);
        part.forEach((lineText, index) => text(margin + 36, y - 49 - index * 13, lineText, 9));
      } else {
        text(margin + 20, y, "工作描述（续）：", 9);
        part.forEach((lineText, index) => text(margin + 36, y - 16 - index * 13, lineText, 9));
      }
      y = cardBottom - 10;
      offset += part.length;
      first = false;
      if (offset < description.length) continuationPage();
    }
  };

  for (const c of candidates) {
    finishPage();
    currentName = c.name || "候选人";
    y = 790;
    rect(margin, 738, contentWidth, 70, 0.92, 0.95, 1);
    strokeRect(margin, 738, contentWidth, 70, 0.75, 0.8, 0.9);
    circle(margin + 34, 772, 25, 0.82, 0.85, 0.9);
    text(margin + 26, 765, Array.from(safe(c.name))[0], 18);
    text(margin + 76, 784, safe(c.name), 22);
    text(margin + 76, 762, `应聘简历 | ${safe(c.education)} | ${safe(c.expectedLocation || [c.expectedProvince, c.expectedCity].filter(Boolean).join(" "))}`, 10);
    text(433, 787, `生成时间：${localDate()}`, 9);
    y = 716;

    section("基础信息");
    grid([["姓名", c.name], ["性别", c.gender], ["出生日期", c.birthDate], ["学历", c.education], ["手机号", c.phone], ["邮箱", c.email], ["身份证号", c.idCard], ["电话客服经验", (c.phoneCustomerServiceExperience ?? c.hasCustomerServiceExperience) ? "是" : "否"], ["婚姻状况", c.maritalStatus], ["子女情况", c.childrenStatus], ["毕业院校", c.graduationSchool], ["所学专业", c.major], ["普通话等级", c.mandarinLevel], ["毕业时间", c.graduationTime]]);

    section("地点与求职信息");
    grid([["当前居住地", c.currentResidence], ["期望工作地点", c.expectedLocation || [c.expectedProvince, c.expectedCity].filter(Boolean).join(" ")], ["招聘渠道", c.recruitmentChannel], ["应聘岗位", c.appliedPosition], ["可到岗时间", c.availableDate], ["资料来源", c.source === "SELF" ? "候选人自助" : "HR录入"]]);
    note("上一份工作离职原因", c.lastLeaveReason);

    section("工作经历");
    const works = [...(c.workExperiences || [])].sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)));
    works.forEach(workBlock);
  }
  finishPage();

  const pageCount = Math.max(pageStreams.length, 1);
  if (!pageStreams.length) pageStreams.push("");
  const fontF1Id = 3 + pageCount * 2;
  const fontF2Id = fontF1Id + 1;
  const cidFontId = fontF2Id + 1;
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i);
  const contentIds = Array.from({ length: pageCount }, (_, i) => 3 + pageCount + i);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map(pid => `${pid} 0 R`).join(" ")}] /Count ${pageCount} >>`
  ];
  pageStreams.forEach((stream, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontF1Id} 0 R /F2 ${fontF2Id} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`);
  });
  pageStreams.forEach(stream => {
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFontId} 0 R] >>`,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>"
  );
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(o => { pdf += `${String(o).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

let pdfPythonChecked = false;
let pdfPython = null;

function resolvePdfPython() {
  if (pdfPythonChecked) return pdfPython;
  pdfPythonChecked = true;
  const candidates = [
    process.env.PDF_PYTHON,
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "bin", "python3"),
    "python3"
  ].filter(Boolean);
  for (const executable of [...new Set(candidates)]) {
    const probe = spawnSync(executable, ["-c", "import reportlab"], { timeout: 5000, stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      pdfPython = executable;
      break;
    }
  }
  return pdfPython;
}

function candidatePdf(candidates) {
  const python = resolvePdfPython();
  if (!python) {
    throw new Error("简历 PDF 组件未安装，请安装 requirements-pdf.txt 中的依赖");
  }
  const generated = spawnSync(python, [PDF_GENERATOR], {
    input: JSON.stringify({ candidates, generatedDate: localDate() }),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000
  });
  if (generated.error || generated.status !== 0 || generated.stdout?.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error(`简历 PDF 生成失败：${generated.error?.message || generated.stderr?.toString().trim() || `exit ${generated.status}`}`);
  }
  return generated.stdout;
}

function reportPdf(report) {
  const python = resolvePdfPython();
  if (!python) throw new Error("日报 PDF 组件未安装，请安装 requirements-pdf.txt 中的依赖");
  const generated = spawnSync(python, [REPORT_PDF_GENERATOR], {
    input: JSON.stringify({ report }),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000
  });
  if (generated.error || generated.status !== 0 || generated.stdout?.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error(`日报 PDF 生成失败：${generated.error?.message || generated.stderr?.toString().trim() || `exit ${generated.status}`}`);
  }
  return generated.stdout;
}

function reportPdfPath(projectId, date) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(projectId || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    throw new Error("日报文件参数不正确");
  }
  const directory = path.resolve(REPORTS_DIR, date);
  const file = path.resolve(directory, `${projectId}.pdf`);
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error("日报文件路径不正确");
  return file;
}

function ensureReportPdf(report) {
  const file = reportPdfPath(report.projectId, report.date);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, reportPdf(report), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function cumulativeReport(db, projectId, from, to, allowedProjectIds = null, includeByProject = true, trendMonth = localMonth()) {
  const projectIds = projectId ? [projectId] : (allowedProjectIds || db.projects.map(p => p.id));
  const allowed = new Set(projectIds);
  const inProject = item => allowed.has(item.projectId);
  const candidates = db.candidates.filter(c => inProject(c) && dateInRange(c.createdAt, from, to));
  const arrived = db.candidates.filter(c => inProject(c) && (
    !from && !to ? Boolean(c.arrived || c.arrivedAt) : Boolean(c.arrivedAt) && dateInRange(c.arrivedAt, from, to)
  ));
  const passed = db.candidates.filter(c => inProject(c) && (
    !from && !to ? Boolean(c.passed || c.passedAt) : Boolean(c.passedAt) && dateInRange(c.passedAt, from, to)
  ));
  const currentHc = projectIds.reduce((sum, pid) => {
    const hc = headcount(db, pid, to || localDate());
    sum.onboard += hc.onboard;
    sum.training += hc.training;
    sum.gap += hc.gap;
    sum.targetHc += hc.targetHc;
    return sum;
  }, { onboard: 0, training: 0, gap: 0, targetHc: 0 });
  const metrics = {
    candidateCount: candidates.length,
    arrivedCount: arrived.length,
    passedCount: passed.length,
    joinedCount: countJoinedCandidates(db, projectIds, from, to),
    leftCount: countLeftCandidates(db, projectIds, from, to),
    trainingCount: currentHc.training,
    onboardCount: currentHc.onboard,
    remainingGap: currentHc.gap,
    passRate: arrived.length ? Number((passed.length / arrived.length * 100).toFixed(2)) : 0,
    hcCompletionRate: currentHc.targetHc ? Number((passed.length / currentHc.targetHc * 100).toFixed(2)) : 0
  };
  const byProject = includeByProject ? projectIds.map(pid => {
    const project = db.projects.find(p => p.id === pid);
    const report = cumulativeReport(db, pid, from, to, [pid], false);
    return { projectId: pid, projectName: project?.name || pid, ...report.metrics };
  }) : [];
  const todayByProject = includeByProject ? todayProjectStats(db, projectIds) : [];
  return {
    metrics,
    distributions: includeByProject ? candidateStats(candidates) : {},
    dailyJoinTrend: includeByProject ? dailyJoinTrend(db, projectIds, trendMonth) : [],
    byProject,
    todayByProject
  };
}

const metricLabels = {
  candidateCount: "累计候选人",
  newCandidateCount: "今日新增候选人",
  arrivedCount: "到面人数",
  passedCount: "通过人数",
  joinedCount: "入职人数",
  leftCount: "离职人数",
  trainingCount: "当前培训中人数",
  onboardCount: "当前在岗人数",
  remainingGap: "当前剩余缺口",
  passRate: "总通过率",
  hcCompletionRate: "目标完成率"
};

const distributionLabels = {
  education: "学历分布",
  gender: "性别分布",
  experience: "电话客服经验分布",
  age: "年龄段分布"
};

function reportRows(report) {
  const rows = [];
  if (report.date) rows.push(["日报日期", report.date], ["生成时间", formatShanghaiDateTime(report.generatedAt)], []);
  if (report.currentDayMetrics) {
    const todayLabels = {
      candidateCount: "今日新增候选人",
      arrivedCount: "今日到面人数",
      passedCount: "今日通过人数",
      joinedCount: "今日入职人数",
      leftCount: "今日离职人数"
    };
    rows.push(["当日指标", "数值"]);
    for (const key of ["candidateCount", "arrivedCount", "passedCount", "joinedCount", "leftCount"]) {
      rows.push([todayLabels[key], report.currentDayMetrics[key] || 0]);
    }
    rows.push([]);
  }
  rows.push(["累计指标", "数值"]);
  for (const [key, value] of Object.entries(report.metrics || {})) {
    const formatted = ["passRate", "hcCompletionRate"].includes(key) ? `${value}%` : value;
    rows.push([metricLabels[key] || key, formatted]);
  }
  rows.push([], ["分布", "类别", "数量", "占比"]);
  for (const [group, data] of Object.entries(report.distributions || {})) {
    const total = Object.values(data).reduce((sum, value) => sum + Number(value || 0), 0);
    for (const [key, value] of Object.entries(data)) {
      const percent = total ? `${(Number(value || 0) / total * 100).toFixed(1)}%` : "0.0%";
      rows.push([distributionLabels[group] || group, key, value, percent]);
    }
  }
  if (report.dailyJoinTrend?.length) {
    rows.push([], ["当月每日入职人数"], ["日期", "入职人数"]);
    for (const item of report.dailyJoinTrend) rows.push([item.date, item.count]);
  }
  if (report.byProject?.length) {
    rows.push([], ["按项目统计"], ["项目", "累计候选人", "到面人数", "通过人数", "入职人数", "离职人数", "培训中人数", "当前在岗人数", "当前剩余缺口", "总通过率", "目标完成率"]);
    for (const item of report.byProject) {
      rows.push([
        item.projectName,
        item.candidateCount,
        item.arrivedCount,
        item.passedCount,
        item.joinedCount,
        item.leftCount,
        item.trainingCount,
        item.onboardCount,
        item.remainingGap,
        `${item.passRate}%`,
        `${item.hcCompletionRate}%`
      ]);
    }
  }
  if (report.todayByProject?.length) {
    rows.push([], ["今日各项目招聘数据"], ["项目", "日期", "今日新增候选人", "今日到面人数", "今日通过人数", "今日入职人数", "今日离职人数", "培训中人数", "当前在职人数"]);
    for (const item of report.todayByProject) {
      rows.push([
        item.projectName,
        item.date,
        item.newCandidateCount,
        item.arrivedCount,
        item.passedCount,
        item.joinedCount,
        item.leftCount,
        item.trainingCount,
        item.onboardCount
      ]);
    }
  }
  return rows;
}

function downloadFileName(name) {
  const fallback = String(name || "resume").replace(/[^\w.-]+/g, "_") || "resume";
  return `filename="${fallback}.pdf"; filename*=UTF-8''${encodeURIComponent(`${name || "简历"}.pdf`)}`;
}

async function api(req, res, pathname, searchParams) {
  const db = await readDb();
  const method = req.method;

  if (method === "POST" && pathname === "/api/auth/captcha") {
    if (!await securityState.rateLimit(req, "captcha", 60, 60 * 1000)) return bad(res, "请求过于频繁，请稍后再试", 429);
    const a = 10 + Math.floor(Math.random() * 40);
    const b = 1 + Math.floor(Math.random() * 20);
    const answer = a + b;
    const captcha = { id: id("cap") };
    await securityState.saveCaptcha(captcha.id, answer, 5 * 60 * 1000);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="42"><rect width="120" height="42" fill="#f1f5f9"/><path d="M5 34 C40 6 70 48 115 12" stroke="#94a3b8" fill="none"/><text x="18" y="28" font-size="20" font-family="Arial" fill="#0f172a">${a} + ${b} = ?</text></svg>`;
    return send(res, 200, { captchaId: captcha.id, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    if (!await securityState.rateLimit(req, "login", 10, 60 * 1000)) return bad(res, "登录尝试过于频繁，请稍后再试", 429);
    const body = await parseBody(req);
    if (!await securityState.consumeCaptcha(body.captchaId, body.captcha)) return bad(res, "验证码错误或已过期");
    const user = db.users.find(u => u.username === body.username && u.enabled);
    if (!user || !passwordService.verify(body.password || "", user.passwordHash)) return bad(res, "用户名或密码错误", 401);
    if (passwordService.needsUpgrade(user.passwordHash)) {
      user.passwordHash = passwordService.hash(body.password || "");
      user.authVersion = Number(user.authVersion || 0) + 1;
      await writeDb(db);
    }
    return send(res, 200, { token: signJwt({ sub: user.id, role: user.role, ver: Number(user.authVersion || 0) }), user: publicUser(user) });
  }

  const publicProject = routeParams(pathname, "/api/public/projects/:projectId");
  if (method === "GET" && publicProject) {
    const project = findPublicProject(db, publicProject.projectId);
    if (!project) return bad(res, "项目不存在", 404);
    return send(res, 200, { id: project.id, name: project.name, shortCode: project.shortCode });
  }

  const publicCandidate = routeParams(pathname, "/api/public/projects/:projectId/candidates");
  if (method === "POST" && publicCandidate) {
    if (!await securityState.rateLimit(req, "public-candidate", 20, 60 * 1000)) return bad(res, "提交过于频繁，请稍后再试", 429);
    const body = await parseBody(req);
    if (!await securityState.consumeCaptcha(body.captchaId, body.captcha)) return bad(res, "验证码错误或已过期");
    const project = findPublicProject(db, publicCandidate.projectId);
    if (!project) return bad(res, "项目不存在", 404);
    const validation = validateCandidate(body);
    if (validation) return bad(res, validation);
    if (db.candidates.some(c => c.projectId === project.id && c.phone === body.phone)) return bad(res, "该手机号已存在", 409);
    const candidate = {
      id: id("cand"),
      projectId: project.id,
      source: "SELF",
      createdBy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...normalizeCandidate(body),
      arrived: false,
      arrivedAt: null,
      arrivedBy: null,
      passed: false,
      passedAt: null,
      passedBy: null,
      employmentStatus: "CANDIDATE",
      ...candidateWorkflowDefaults()
    };
    db.candidates.push(candidate);
    appendAudit(db, null, "CREATE_SELF", candidate.id, null, candidate);
    await writeDb(db);
    return send(res, 201, { id: candidate.id, message: "提交成功" });
  }

  const user = requireAuth(req, res, db);
  if (!user) return;

  if (method === "GET" && pathname === "/api/me") {
    return send(res, 200, { user: publicUser(user) });
  }

  if (method === "GET" && pathname === "/api/projects") {
    const projects = canAccessAllRecruitmentData(user) ? db.projects : db.projects.filter(p => user.projectIds.includes(p.id));
    return send(res, 200, { items: projects });
  }

  if (method === "POST" && pathname === "/api/projects") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const body = await parseBody(req);
    if (!String(body.name || "").trim()) return bad(res, "项目名称必填");
    const project = { id: id("p"), name: String(body.name).trim(), shortCode: shortCode(db), enabled: body.enabled !== false, createdAt: nowIso() };
    db.projects.push(project);
    await writeDb(db);
    return send(res, 201, project);
  }

  const projectDetail = routeParams(pathname, "/api/projects/:projectId");
  if (projectDetail && method === "PUT") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const project = db.projects.find(p => p.id === projectDetail.projectId);
    if (!project) return bad(res, "项目不存在", 404);
    const body = await parseBody(req);
    if (body.name !== undefined) {
      if (!String(body.name || "").trim()) return bad(res, "项目名称必填");
      project.name = String(body.name).trim();
    }
    if (body.enabled !== undefined) project.enabled = Boolean(body.enabled);
    project.updatedAt = nowIso();
    await writeDb(db);
    return send(res, 200, project);
  }
  if (projectDetail && method === "DELETE") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const project = db.projects.find(p => p.id === projectDetail.projectId);
    if (!project) return bad(res, "项目不存在", 404);
    project.enabled = false;
    project.updatedAt = nowIso();
    await writeDb(db);
    return send(res, 200, { message: "项目已停用", project });
  }

  const projectMonth = routeParams(pathname, "/api/projects/:projectId/month-config");
  if (projectMonth && method === "GET") {
    if (!projectAllowed(user, projectMonth.projectId)) return bad(res, "无权限", 403);
    return send(res, 200, latestMonthlyConfig(db, projectMonth.projectId, searchParams.get("month") || localMonth()));
  }
  if (projectMonth && method === "POST") {
    if (!projectAllowed(user, projectMonth.projectId)) return bad(res, "无权限", 403);
    if (!canWriteRecruitmentData(user)) return bad(res, "运营账号仅可查看数据，不能修改项目配置", 403);
    const body = await parseBody(req);
    const month = body.month || localMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(res, "配置月份格式应为 yyyy-MM");
    const targetHc = Number(body.targetHc);
    if (!Number.isInteger(targetHc) || targetHc < 0) return bad(res, "目标总人数必须为非负整数");
    let cfg = db.monthlyConfigs.find(c => c.projectId === projectMonth.projectId && c.month === month);
    if (!cfg) {
      cfg = { id: id("mc"), projectId: projectMonth.projectId, month };
      db.monthlyConfigs.push(cfg);
    }
    cfg.targetHc = targetHc;
    cfg.updatedBy = user.id;
    cfg.updatedAt = nowIso();
    await writeDb(db);
    return send(res, 200, cfg);
  }

  if (method === "GET" && pathname === "/api/users") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    return send(res, 200, { items: db.users.map(publicUser) });
  }

  if (method === "POST" && pathname === "/api/users") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const body = await parseBody(req);
    const validation = validateUserCreate(db, body);
    if (validation) return bad(res, validation, validation === "用户名已存在" ? 409 : 400);
    const created = {
      id: id("u"),
      username: String(body.username || "").trim(),
      displayName: String(body.displayName || "").trim(),
      role: body.role || "HR",
      enabled: body.enabled !== false,
      passwordHash: passwordService.hash(String(body.password || "")),
      authVersion: 0,
      projectIds: body.projectIds || []
    };
    db.users.push(created);
    await writeDb(db);
    return send(res, 201, publicUser(created));
  }

  const userDetail = routeParams(pathname, "/api/users/:id");
  if (userDetail && method === "PUT") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const target = db.users.find(u => u.id === userDetail.id);
    if (!target) return bad(res, "用户不存在", 404);
    const body = await parseBody(req);
    const validation = validateUserUpdate(db, body);
    if (validation) return bad(res, validation);
    Object.assign(target, {
      displayName: body.displayName !== undefined ? String(body.displayName).trim() : target.displayName,
      role: body.role ?? target.role,
      enabled: body.enabled ?? target.enabled,
      projectIds: body.projectIds ?? target.projectIds
    });
    if (body.password) {
      target.passwordHash = passwordService.hash(body.password);
      target.authVersion = Number(target.authVersion || 0) + 1;
    }
    await writeDb(db);
    return send(res, 200, publicUser(target));
  }
  if (userDetail && method === "DELETE") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const target = db.users.find(u => u.id === userDetail.id);
    if (!target) return bad(res, "用户不存在", 404);
    if (target.id === user.id) return bad(res, "不能删除当前登录账号");
    if (target.role === "ADMIN" && db.users.filter(u => u.role === "ADMIN").length <= 1) return bad(res, "至少保留一个管理员账号");
    db.users = db.users.filter(u => u.id !== target.id);
    await writeDb(db);
    return send(res, 200, { message: "账号已删除" });
  }

  if (method === "GET" && pathname === "/api/candidate-metrics") {
    const projectId = searchParams.get("projectId");
    const today = localDate();
    let visible = db.candidates
      .filter(c => !projectId || c.projectId === projectId)
      .filter(c => projectAllowed(user, c.projectId));
    const messages = (db.systemMessages || [])
      .filter(msg => (!msg.userId || msg.userId === user.id) && (!projectId || msg.projectId === projectId) && projectAllowed(user, msg.projectId))
      .slice(0, 5);
    return send(res, 200, {
      metrics: {
        resumeTotal: visible.length,
        todayNew: visible.filter(c => sameDay(c.createdAt, today)).length,
        arrivedCount: visible.filter(c => c.arrived).length,
        passedCount: visible.filter(c => c.passed).length,
        joinedCount: visible.filter(c => Boolean(c.joinedAt) || ["TRAINING", "ACTIVE", "LEFT"].includes(candidateStatus(c))).length,
        trainingCount: visible.filter(c => candidateStatus(c) === "TRAINING").length,
        onboardCount: visible.filter(c => candidateStatus(c) === "ACTIVE").length,
        leftCount: visible.filter(c => candidateStatus(c) === "LEFT").length
      },
      messages
    });
  }

  if (method === "GET" && pathname === "/api/candidates") {
    const projectId = searchParams.get("projectId");
    const keyword = (searchParams.get("keyword") || "").trim();
    const group = searchParams.get("group") || "candidates";
    const status = searchParams.get("status") || "";
    let items = db.candidates
      .filter(c => !projectId || c.projectId === projectId)
      .filter(c => projectAllowed(user, c.projectId));
    if (group === "training") items = items.filter(c => candidateStatus(c) === "TRAINING");
    else if (group === "onboard") items = items.filter(c => candidateStatus(c) === "ACTIVE");
    else if (group === "left") items = items.filter(c => candidateStatus(c) === "LEFT");
    else if (group === "abandoned") items = items.filter(c => candidateStatus(c) === "ABANDONED");
    else items = items.filter(c => candidateGroupOf(c) === "candidates");
    if (status) items = items.filter(c => candidateStatus(c) === status);
    if (keyword) items = items.filter(c => [c.name, c.phone, c.idCard, c.email, c.appliedPosition].some(v => String(v || "").includes(keyword)));
    const sortValue = c => group === "training" ? c.trainingStartedAt : group === "onboard" ? (c.activeAt || c.joinedAt) : group === "left" ? c.leftAt : group === "abandoned" ? c.abandonAt : c.createdAt;
    return send(res, 200, { items: items.sort((a, b) => String(sortValue(b) || b.createdAt || "").localeCompare(String(sortValue(a) || a.createdAt || ""))).map(candidateListView) });
  }

  if (method === "POST" && pathname === "/api/candidates") {
    const body = await parseBody(req);
    if (!projectAllowed(user, body.projectId)) return bad(res, "无权限", 403);
    if (!canWriteRecruitmentData(user)) return bad(res, "运营账号仅可查看数据，不能新增候选人", 403);
    const validation = validateCandidate(body);
    if (validation) return bad(res, validation);
    if (db.candidates.some(c => c.projectId === body.projectId && c.phone === body.phone)) return bad(res, "该手机号已存在", 409);
    const candidate = {
      id: id("cand"),
      projectId: body.projectId,
      source: "HR",
      createdBy: user.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...normalizeCandidate(body),
      arrived: false,
      arrivedAt: null,
      arrivedBy: null,
      passed: false,
      passedAt: null,
      passedBy: null,
      employmentStatus: "CANDIDATE",
      ...candidateWorkflowDefaults()
    };
    db.candidates.push(candidate);
    appendAudit(db, user.id, "CREATE", candidate.id, null, candidate);
    await writeDb(db);
    return send(res, 201, candidate);
  }

  const candDetail = routeParams(pathname, "/api/candidates/:id");
  if (candDetail && method === "GET") {
    const c = db.candidates.find(x => x.id === candDetail.id);
    if (!c) return bad(res, "候选人不存在", 404);
    if (!projectAllowed(user, c.projectId)) return bad(res, "无权限", 403);
    return send(res, 200, c);
  }
  if (candDetail && method === "PUT") {
    const c = db.candidates.find(x => x.id === candDetail.id);
    if (!c) return bad(res, "候选人不存在", 404);
    if (!projectAllowed(user, c.projectId)) return bad(res, "无权限", 403);
    if (!canWriteRecruitmentData(user)) return bad(res, "运营账号仅可查看数据，不能编辑候选人", 403);
    const body = await parseBody(req);
    const validation = validateCandidate(body);
    if (validation) return bad(res, validation);
    if (db.candidates.some(x => x.projectId === c.projectId && x.phone === body.phone && x.id !== c.id)) return bad(res, "该手机号已存在", 409);
    const before = JSON.parse(JSON.stringify(c));
    Object.assign(c, normalizeCandidate(body), { updatedAt: nowIso() });
    appendAudit(db, user.id, "EDIT", c.id, before, c);
    await writeDb(db);
    return send(res, 200, c);
  }

  const candStatus = routeParams(pathname, "/api/candidates/:id/status");
  if (candStatus && method === "POST") {
    const c = db.candidates.find(x => x.id === candStatus.id);
    if (!c) return bad(res, "候选人不存在", 404);
    if (!projectAllowed(user, c.projectId)) return bad(res, "无权限", 403);
    if (!canWriteRecruitmentData(user)) return bad(res, "运营账号仅可查看数据，不能标记候选人状态", 403);
    const body = await parseBody(req);
    const type = String(body.type || "");
    const current = candidateStatus(c);
    if (type === "passed" && !c.arrived && !body.force) {
      return bad(res, "该候选人尚未标记到面，确认通过吗？", 409, { confirmRequired: true });
    }
    if (["LEFT", "ABANDONED"].includes(current)) return bad(res, "离职或放弃入职人员不可继续变更状态");
    const before = JSON.parse(JSON.stringify(c));
    if (type === "arrived") {
      if (!["PENDING", "ARRIVED", "PASSED", "PENDING_ONBOARD_CONFIRM"].includes(current)) return bad(res, "当前状态不可标记到面");
      c.arrived = true; c.arrivedAt = c.arrivedAt || nowIso(); c.arrivedBy = c.arrivedBy || user.id;
    } else if (type === "passed") {
      if (!isDateOnly(body.plannedJoinDate)) return bad(res, "入职时间为必填，格式应为 yyyy-MM-dd");
      if (!["PENDING", "ARRIVED", "PASSED", "FAILED", "PENDING_ONBOARD_CONFIRM"].includes(current)) return bad(res, "当前状态不可标记通过");
      c.passed = true;
      c.passedAt = c.passedAt || nowIso();
      c.passedBy = c.passedBy || user.id;
      c.failedAt = null;
      c.failedBy = null;
      c.failedReason = null;
      c.plannedJoinDate = body.plannedJoinDate;
      c.plannedJoinSetAt = nowIso();
      c.plannedJoinSetBy = user.id;
      c.employmentStatus = "CANDIDATE";
    } else if (type === "failed") {
      const reasonError = validateReason(body.reason, "未通过原因");
      if (reasonError) return bad(res, reasonError);
      if (!["PENDING", "ARRIVED", "PASSED", "FAILED", "PENDING_ONBOARD_CONFIRM"].includes(current)) return bad(res, "当前状态不可标记不通过");
      c.passed = false;
      c.passedAt = null;
      c.passedBy = null;
      c.plannedJoinDate = null;
      c.failedAt = nowIso();
      c.failedBy = user.id;
      c.failedReason = String(body.reason).trim();
      c.employmentStatus = "CANDIDATE";
    } else if (type === "onboard") {
      if (!["PASSED", "PENDING_ONBOARD_CONFIRM"].includes(current) || !c.passed || !c.plannedJoinDate) {
        return bad(res, "仅已通过且设置入职时间的候选人可确认入职");
      }
      c.employmentStatus = "TRAINING";
      c.joinedAt = nowIso();
      c.joinedBy = user.id;
      c.trainingStartedAt = c.joinedAt;
      c.trainingStartedBy = user.id;
      c.trainingEndedAt = null;
      c.trainingEndedBy = null;
      c.activeAt = null;
      c.activeBy = null;
      c.leftAt = null;
      c.leftBy = null;
      c.leftReason = null;
      c.leftFromStatus = null;
      c.abandonAt = null;
      c.abandonBy = null;
      c.abandonReason = null;
    } else if (type === "activate") {
      if (current !== "TRAINING") return bad(res, "仅培训中人员可转为在职");
      if (!isDateOnly(body.trainingEndDate)) return bad(res, "培训结束日期为必填，格式应为 yyyy-MM-dd");
      if (body.trainingEndDate > localDate()) return bad(res, "培训结束日期不能晚于今天");
      if (body.trainingEndDate < localDatePart(c.trainingStartedAt || c.joinedAt)) return bad(res, "培训结束日期不能早于培训开始日期");
      c.employmentStatus = "ACTIVE";
      c.trainingEndedAt = body.trainingEndDate;
      c.trainingEndedBy = user.id;
      c.activeAt = body.trainingEndDate;
      c.activeBy = user.id;
    } else if (type === "left") {
      const reasonError = validateReason(body.reason, "离职原因");
      if (reasonError) return bad(res, reasonError);
      if (!isDateOnly(body.leftDate)) return bad(res, "离职日期为必填，格式应为 yyyy-MM-dd");
      if (body.leftDate > localDate()) return bad(res, "离职日期不能晚于今天");
      if (!["TRAINING", "ACTIVE"].includes(current)) return bad(res, "仅培训中或在职人员可办理离职");
      if (c.joinedAt && body.leftDate < localDatePart(c.joinedAt)) return bad(res, "离职日期不能早于实际入职日期");
      c.employmentStatus = "LEFT";
      c.leftAt = body.leftDate;
      c.leftBy = user.id;
      c.leftReason = String(body.reason).trim();
      c.leftFromStatus = current;
    } else if (type === "abandon") {
      const reasonError = validateReason(body.reason, "放弃原因");
      if (reasonError) return bad(res, reasonError);
      if (!c.passed || !c.plannedJoinDate) return bad(res, "仅已通过且设置入职时间的候选人可放弃入职");
      c.employmentStatus = "ABANDONED";
      c.abandonAt = nowIso();
      c.abandonBy = user.id;
      c.abandonReason = String(body.reason).trim();
    } else if (type === "reschedule") {
      if (!isDateOnly(body.plannedJoinDate)) return bad(res, "入职时间为必填，格式应为 yyyy-MM-dd");
      if (!c.passed) return bad(res, "仅已通过候选人可更改入职时间");
      c.employmentStatus = "CANDIDATE";
      c.plannedJoinDate = body.plannedJoinDate;
      c.plannedJoinSetAt = nowIso();
      c.plannedJoinSetBy = user.id;
      c.failedAt = null;
      c.failedBy = null;
      c.failedReason = null;
    } else {
      return bad(res, "状态类型错误");
    }
    c.updatedAt = nowIso();
    appendAudit(db, user.id, `MARK_${type.toUpperCase()}`, c.id, before, c);
    await writeDb(db);
    return send(res, 200, c);
  }

  if (method === "GET" && pathname === "/api/settings/report-delivery") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    return send(res, 200, publicReportSettings(reportSettings(db)));
  }

  if (method === "PUT" && pathname === "/api/settings/report-delivery") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const body = await parseBody(req);
    try {
      updateReportSettings(reportSettings(db), body, nowIso());
    } catch (error) {
      return bad(res, error.message);
    }
    await writeDb(db);
    return send(res, 200, publicReportSettings(db.systemSettings));
  }

  if (method === "POST" && pathname === "/api/reports/daily/generate") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    const body = await parseBody(req);
    const date = String(body.date || localDate());
    if (!isDateOnly(date) || date > localDate()) return bad(res, "日报日期必须是今天或过去的有效日期");
    const requestedProjectId = String(body.projectId || "");
    if (requestedProjectId && !db.projects.some(project => project.id === requestedProjectId)) return bad(res, "项目不存在", 404);
    const created = ensureDailyReports(db, date, requestedProjectId || null);
    if (!created.length) return bad(res, "该日期的日报已存在，历史快照不可覆盖", 409);
    for (const report of created) ensureReportPdf(report);
    if (!requestedProjectId && date === localDate()) reportSettings(db).lastGeneratedDate = date;
    db.auditLogs.unshift({
      id: id("log"), actorId: user.id, action: "GENERATE_DAILY_REPORT", entityType: "DAILY_REPORT",
      entityId: date, before: null, after: { date, projectId: requestedProjectId || ALL_PROJECTS_REPORT_ID, createdCount: created.length }, createdAt: nowIso()
    });
    await writeDb(db);
    return send(res, 201, { message: `已生成 ${created.length} 份日报快照`, date, createdCount: created.length });
  }

  if (method === "GET" && pathname === "/api/reports/daily/dates") {
    const requestedProjectId = searchParams.get("projectId") || "";
    const projectId = requestedProjectId || ALL_PROJECTS_REPORT_ID;
    const month = searchParams.get("month") || localMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(res, "月份格式应为 yyyy-MM");
    if (projectId === ALL_PROJECTS_REPORT_ID && !canAccessAllRecruitmentData(user)) return bad(res, "无权限", 403);
    if (projectId !== ALL_PROJECTS_REPORT_ID && !projectAllowed(user, projectId)) return bad(res, "无权限", 403);
    const dates = db.dailyReports
      .filter(report => report.projectId === projectId && report.date.startsWith(`${month}-`))
      .map(report => report.date)
      .sort();
    return send(res, 200, { projectId: requestedProjectId, month, dates });
  }

  if (method === "GET" && pathname === "/api/reports/daily") {
    const requestedProjectId = searchParams.get("projectId") || "";
    const projectId = requestedProjectId || ALL_PROJECTS_REPORT_ID;
    const date = searchParams.get("date");
    if (projectId === ALL_PROJECTS_REPORT_ID && !canAccessAllRecruitmentData(user)) return bad(res, "无权限", 403);
    if (projectId !== ALL_PROJECTS_REPORT_ID && !projectAllowed(user, projectId)) return bad(res, "无权限", 403);
    const report = db.dailyReports.find(r => r.projectId === projectId && r.date === date);
    if (!report) return bad(res, "暂无日报", 404);
    return send(res, 200, report);
  }

  if (method === "GET" && pathname === "/api/reports/daily.pdf") {
    const requestedProjectId = searchParams.get("projectId") || "";
    const projectId = requestedProjectId || ALL_PROJECTS_REPORT_ID;
    const date = searchParams.get("date");
    if (projectId === ALL_PROJECTS_REPORT_ID && !canAccessAllRecruitmentData(user)) return bad(res, "无权限", 403);
    if (projectId !== ALL_PROJECTS_REPORT_ID && !projectAllowed(user, projectId)) return bad(res, "无权限", 403);
    const report = db.dailyReports.find(item => item.projectId === projectId && item.date === date);
    if (!report) return bad(res, "暂无日报", 404);
    const file = ensureReportPdf(report);
    const baseName = `${report.projectName || "招聘"}-${date}-日报`;
    res.writeHead(200, { ...jsonHeaders, "content-type": "application/pdf", "content-disposition": `attachment; ${downloadFileName(baseName)}` });
    return fs.createReadStream(file).pipe(res);
  }

  if (method === "GET" && pathname === "/api/reports/cumulative") {
    const projectId = searchParams.get("projectId");
    if (projectId && !projectAllowed(user, projectId)) return bad(res, "无权限", 403);
    const allowedProjectIds = canAccessAllRecruitmentData(user) ? db.projects.map(p => p.id) : user.projectIds;
    const trendMonth = /^\d{4}-\d{2}$/.test(searchParams.get("month") || "") ? searchParams.get("month") : localMonth();
    const includeDetails = searchParams.get("summaryOnly") !== "true";
    return send(res, 200, cumulativeReport(db, projectId, searchParams.get("from"), searchParams.get("to"), allowedProjectIds, includeDetails, trendMonth));
  }

  if (method === "GET" && pathname === "/api/logs") {
    if (user.role !== "ADMIN") return bad(res, "无权限", 403);
    return send(res, 200, { auditLogs: db.auditLogs.slice(0, 200), violationLogs: db.violationLogs.slice(0, 200) });
  }

  if (method === "GET" && pathname === "/api/export/candidates.pdf") {
    const ids = (searchParams.get("ids") || "").split(",").filter(Boolean);
    const candidates = db.candidates.filter(c => ids.includes(c.id) && projectAllowed(user, c.projectId));
    const buf = candidatePdf(candidates);
    const baseName = candidates.length === 1
      ? candidates[0].name
      : candidates.length > 1
        ? `简历批量-${candidates[0].name}等${candidates.length}人`
        : "简历";
    res.writeHead(200, { ...jsonHeaders, "content-type": "application/pdf", "content-disposition": `attachment; ${downloadFileName(baseName)}` });
    return res.end(buf);
  }

  if (method === "GET" && pathname === "/api/export/report.xlsx") {
    const kind = searchParams.get("kind") || "cumulative";
    const projectId = searchParams.get("projectId");
    if (projectId && !projectAllowed(user, projectId)) return bad(res, "无权限", 403);
    let rows = [];
    if (kind === "daily") {
      const dailyProjectId = projectId || ALL_PROJECTS_REPORT_ID;
      if (dailyProjectId === ALL_PROJECTS_REPORT_ID && !canAccessAllRecruitmentData(user)) return bad(res, "无权限", 403);
      const report = db.dailyReports.find(r => r.projectId === dailyProjectId && r.date === searchParams.get("date"));
      if (!report) return bad(res, "日报快照不存在", 404);
      rows = reportRows(report);
    } else {
      const allowedProjectIds = canAccessAllRecruitmentData(user) ? db.projects.map(p => p.id) : user.projectIds;
      const report = cumulativeReport(db, projectId, searchParams.get("from"), searchParams.get("to"), allowedProjectIds);
      rows = reportRows(report);
    }
    const buf = xlsx(rows);
    res.writeHead(200, { ...jsonHeaders, "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename=${kind}-report.xlsx` });
    return res.end(buf);
  }

  bad(res, "接口不存在", 404);
}

function serveStatic(req, res, pathname) {
  const vendorFile = VENDOR_FILES.get(pathname);
  if (vendorFile) {
    if (!fs.existsSync(vendorFile)) return text(res, 404, "Not found", "text/plain");
    const contentType = path.extname(vendorFile) === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
    return text(res, 200, fs.readFileSync(vendorFile), contentType);
  }
  const routeFile = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(FRONTEND_DIR, routeFile);
  if (file !== FRONTEND_DIR && !file.startsWith(`${FRONTEND_DIR}${path.sep}`)) return text(res, 403, "Forbidden", "text/plain");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return text(res, 404, "Not found", "text/plain");
  const ext = path.extname(file);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  text(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
}

let backgroundJobRunning = false;

async function persistReportDeliveryState(update) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await readDb();
    update(reportSettings(latest));
    try {
      await writeDb(latest);
      return;
    } catch (error) {
      if (error.code !== "STORE_CONFLICT" || attempt === 2) throw error;
    }
  }
}

async function runBackgroundJobs() {
  if (backgroundJobRunning) return;
  backgroundJobRunning = true;
  try {
    const db = await readDb();
    const hadSettings = Boolean(db.systemSettings);
    const settings = reportSettings(db);
    let changed = !hadSettings;
    const now = new Date();

    if (reportIsDue(settings, now)) {
      const date = localClockParts(now).date;
      ensureDailyReports(db, date);
      const reports = db.dailyReports.filter(report => report.date === date);
      for (const report of reports) ensureReportPdf(report);
      settings.lastGeneratedDate = date;
      settings.lastSendError = "";
      changed = true;
    }
    if (generateEntryReminders(db)) changed = true;
    if (changed) await writeDb(db);

    if (sendIsDue(settings, now)) {
      const date = localClockParts(now).date;
      const report = db.dailyReports.find(item => item.projectId === ALL_PROJECTS_REPORT_ID && item.date === date);
      if (!report) return;
      const attemptAt = nowIso();
      await persistReportDeliveryState(current => {
        current.lastSendAttemptAt = attemptAt;
        current.lastSendError = "";
      });
      let sendError = "";
      try {
        const file = ensureReportPdf(report);
        await sendWechatFile(settings.webhookUrl, file, `招聘日报-${date}.pdf`);
      } catch (error) {
        sendError = String(error.message || error).slice(0, 500);
        console.error("Daily report delivery failed:", sendError);
      }
      await persistReportDeliveryState(current => {
        current.lastSendAttemptAt = attemptAt;
        current.lastSendError = sendError;
        if (!sendError) current.lastSentDate = date;
      });
    }
  } finally {
    backgroundJobRunning = false;
  }
}

let ready = false;
let backgroundTimer = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health/live") return send(res, 200, { status: "ok" });
    if (url.pathname === "/health/ready") return send(res, ready ? 200 : 503, { status: ready ? "ready" : "starting" });
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname, url.searchParams);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    const conflict = err.code === "STORE_CONFLICT" || err.code === "ER_DUP_ENTRY";
    const status = err.statusCode || (conflict ? 409 : 500);
    const message = err.code === "ER_DUP_ENTRY"
      ? "数据已存在，请刷新后重试"
      : status < 500 || !config.production ? (err.message || "服务器错误") : "服务器内部错误";
    if (!res.headersSent) bad(res, message, status);
    else res.end();
  }
});

async function start() {
  await storage.init();
  await securityState.init();
  if (config.runBackgroundJobs) {
    await runBackgroundJobs();
    backgroundTimer = setInterval(() => runBackgroundJobs().catch(err => console.error("Background job failed:", err)), 60 * 1000);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, () => {
      server.off("error", reject);
      ready = true;
      console.log(`HR resume system running on port ${PORT} (${config.environment}, ${config.storageDriver})`);
      resolve();
    });
  });
}

async function shutdown(signal) {
  ready = false;
  if (backgroundTimer) clearInterval(backgroundTimer);
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await Promise.allSettled([storage.close(), securityState.close()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch(err => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});

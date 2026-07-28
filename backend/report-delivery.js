const fs = require("fs");

const DEFAULT_REPORT_SETTINGS = Object.freeze({
  id: "report_delivery",
  sendTime: "19:00",
  deliveryEnabled: false,
  webhookUrl: "",
  lastGeneratedDate: "",
  lastSentDate: "",
  lastSendAttemptAt: "",
  lastSendError: "",
  updatedAt: ""
});

function reportSettings(db) {
  const current = db.systemSettings && typeof db.systemSettings === "object"
    ? db.systemSettings
    : {};
  db.systemSettings = { ...DEFAULT_REPORT_SETTINGS, ...current, id: "report_delivery" };
  return db.systemSettings;
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function normalizeWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("企业微信机器人 Webhook 地址格式不正确");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "qyapi.weixin.qq.com" || parsed.pathname !== "/cgi-bin/webhook/send") {
    throw new Error("仅支持企业微信官方机器人 Webhook 地址");
  }
  const key = parsed.searchParams.get("key") || "";
  if (!/^[A-Za-z0-9-]{20,80}$/.test(key)) throw new Error("企业微信机器人 Webhook 缺少有效 key");
  return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
}

function publicReportSettings(settings) {
  const safe = { ...DEFAULT_REPORT_SETTINGS, ...(settings || {}) };
  return {
    sendTime: safe.sendTime,
    deliveryEnabled: Boolean(safe.deliveryEnabled),
    webhookConfigured: Boolean(safe.webhookUrl),
    webhookHint: safe.webhookUrl ? `已配置（key 尾号 ${new URL(safe.webhookUrl).searchParams.get("key").slice(-4)}）` : "未配置",
    lastGeneratedDate: safe.lastGeneratedDate || "",
    lastSentDate: safe.lastSentDate || "",
    lastSendAttemptAt: safe.lastSendAttemptAt || "",
    lastSendError: safe.lastSendError || "",
    updatedAt: safe.updatedAt || ""
  };
}

function updateReportSettings(settings, body, nowIso) {
  const sendTime = body.sendTime === undefined ? settings.sendTime : String(body.sendTime || "");
  if (!isTime(sendTime)) throw new Error("发送时间格式应为 HH:mm");
  let webhookUrl = settings.webhookUrl || "";
  if (body.clearWebhook === true) webhookUrl = "";
  else if (body.webhookUrl !== undefined && String(body.webhookUrl || "").trim()) webhookUrl = normalizeWebhookUrl(body.webhookUrl);
  const deliveryEnabled = body.deliveryEnabled === undefined ? Boolean(settings.deliveryEnabled) : Boolean(body.deliveryEnabled);
  if (deliveryEnabled && !webhookUrl) throw new Error("启用自动发送前必须配置企业微信机器人 Webhook");
  Object.assign(settings, { sendTime, webhookUrl, deliveryEnabled, updatedAt: nowIso });
  return settings;
}

function localClockParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function reportIsDue(settings, now = new Date()) {
  const local = localClockParts(now);
  return isTime(settings.sendTime) && local.time >= settings.sendTime && settings.lastGeneratedDate !== local.date;
}

function sendIsDue(settings, now = new Date()) {
  if (!settings.deliveryEnabled || !settings.webhookUrl) return false;
  const local = localClockParts(now);
  if (local.time < settings.sendTime || settings.lastGeneratedDate !== local.date || settings.lastSentDate === local.date) return false;
  if (!settings.lastSendAttemptAt) return true;
  const elapsed = now.getTime() - new Date(settings.lastSendAttemptAt).getTime();
  return Number.isNaN(elapsed) || elapsed >= 5 * 60 * 1000;
}

async function wechatJson(response, action) {
  if (!response.ok) throw new Error(`${action}失败：HTTP ${response.status}`);
  const body = await response.json();
  if (Number(body.errcode || 0) !== 0) throw new Error(`${action}失败：${body.errmsg || body.errcode}`);
  return body;
}

async function sendWechatFile(webhookUrl, filePath, fileName, fetchImpl = fetch) {
  const normalized = normalizeWebhookUrl(webhookUrl);
  const parsed = new URL(normalized);
  const key = parsed.searchParams.get("key");
  const file = fs.readFileSync(filePath);
  if (file.length > 20 * 1024 * 1024) throw new Error("日报 PDF 超过企业微信机器人 20MB 文件限制");
  const form = new FormData();
  form.append("media", new Blob([file], { type: "application/pdf" }), fileName);
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${encodeURIComponent(key)}&type=file`;
  const upload = await fetchImpl(uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  const uploaded = await wechatJson(upload, "企业微信文件上传");
  if (!uploaded.media_id) throw new Error("企业微信文件上传未返回 media_id");
  const sent = await fetchImpl(normalized, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "file", file: { media_id: uploaded.media_id } }),
    signal: AbortSignal.timeout(15000)
  });
  await wechatJson(sent, "企业微信文件发送");
}

module.exports = {
  DEFAULT_REPORT_SETTINGS,
  isTime,
  localClockParts,
  normalizeWebhookUrl,
  publicReportSettings,
  reportIsDue,
  reportSettings,
  sendIsDue,
  sendWechatFile,
  updateReportSettings
};

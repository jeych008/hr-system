const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatShanghaiDateTime,
  isTime,
  normalizeWebhookUrl,
  publicReportSettings,
  reportIsDue,
  sendIsDue,
  updateReportSettings
} = require("../backend/report-delivery");

test("UTC snapshot timestamps are displayed in Shanghai time", () => {
  assert.equal(formatShanghaiDateTime("2026-07-30T10:00:00.000Z"), "2026-07-30 18:00:00");
  assert.equal(formatShanghaiDateTime(""), "");
});

test("report time accepts only HH:mm", () => {
  assert.equal(isTime("00:00"), true);
  assert.equal(isTime("19:00"), true);
  assert.equal(isTime("24:00"), false);
  assert.equal(isTime("9:00"), false);
});

test("webhook accepts only the official enterprise WeChat robot endpoint", () => {
  const key = "12345678-1234-1234-1234-123456789012";
  assert.equal(normalizeWebhookUrl(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`), `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`);
  assert.throws(() => normalizeWebhookUrl(`https://example.com/cgi-bin/webhook/send?key=${key}`), /仅支持企业微信/);
  assert.throws(() => normalizeWebhookUrl("http://127.0.0.1/internal"), /仅支持企业微信/);
});

test("settings require a webhook before delivery can be enabled", () => {
  const settings = { sendTime: "19:00", deliveryEnabled: false, webhookUrl: "" };
  assert.throws(() => updateReportSettings(settings, { deliveryEnabled: true }, new Date().toISOString()), /必须配置/);
});

test("daily report becomes due after configured Shanghai time", () => {
  const settings = { sendTime: "18:30", lastGeneratedDate: "" };
  assert.equal(reportIsDue(settings, new Date("2026-07-28T10:29:00.000Z")), false);
  assert.equal(reportIsDue(settings, new Date("2026-07-28T10:30:00.000Z")), true);
  settings.lastGeneratedDate = "2026-07-28";
  assert.equal(reportIsDue(settings, new Date("2026-07-28T12:00:00.000Z")), false);
});

test("failed delivery retries no more than once every five minutes", () => {
  const settings = {
    sendTime: "19:00",
    deliveryEnabled: true,
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-1234-1234-1234-123456789012",
    lastGeneratedDate: "2026-07-28",
    lastSentDate: "",
    lastSendAttemptAt: "2026-07-28T11:00:00.000Z"
  };
  assert.equal(sendIsDue(settings, new Date("2026-07-28T11:04:59.000Z")), false);
  assert.equal(sendIsDue(settings, new Date("2026-07-28T11:05:00.000Z")), true);
  settings.lastSentDate = "2026-07-28";
  assert.equal(sendIsDue(settings, new Date("2026-07-28T12:00:00.000Z")), false);
});

test("public settings never expose the full webhook", () => {
  const result = publicReportSettings({
    sendTime: "19:00",
    deliveryEnabled: true,
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-1234-1234-1234-123456789012"
  });
  assert.equal(Object.hasOwn(result, "webhookUrl"), false);
  assert.match(result.webhookHint, /9012/);
});

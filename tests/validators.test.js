const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = { window: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "frontend", "validators.js"), "utf8"),
  context
);

test("manual dates are normalized and calendar-valid", () => {
  assert.equal(context.window.formatManualDate("20260726"), "2026-07-26");
  assert.equal(context.window.formatManualDate("2026-07-26"), "2026-07-26");
  assert.equal(context.window.isValidDateOnly("2024-02-29"), true);
  assert.equal(context.window.isValidDateOnly("2026-02-29"), false);
});

test("birth date is extracted from a valid 18-digit ID card", () => {
  const idCard = "11010519491231002X";
  assert.equal(context.window.validateIdCardNumber(idCard), true);
  assert.equal(context.window.extractBirthDateFromIdCard(idCard), "1949-12-31");
  assert.equal(context.window.extractBirthDateFromIdCard("11010519491331002X"), "");
});

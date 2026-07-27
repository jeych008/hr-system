window.validatePhoneNumber = function validatePhoneNumber(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || "").trim());
};

window.isValidDateOnly = function isValidDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(`${text}T00:00:00`);
  return !Number.isNaN(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() + 1 === month &&
    date.getDate() === day;
};

window.formatManualDate = function formatManualDate(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
};

window.bindManualDateInputs = function bindManualDateInputs(root = document) {
  root.querySelectorAll("[data-manual-date]").forEach(input => {
    if (input.dataset.manualDateBound === "true") return;
    input.dataset.manualDateBound = "true";
    input.addEventListener("input", () => {
      input.value = window.formatManualDate(input.value);
    });
  });
};

window.extractBirthDateFromIdCard = function extractBirthDateFromIdCard(idCard) {
  const value = String(idCard || "").trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(value)) return "";
  const birth = value.slice(6, 14);
  const date = `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}`;
  return window.isValidDateOnly(date) ? date : "";
};

window.validateIdCardNumber = function validateIdCardNumber(idCard) {
  const value = String(idCard || "").trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(value)) return false;
  if (!window.extractBirthDateFromIdCard(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17];
};

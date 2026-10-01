import { formatBusinessTime, formatBusinessDateTime, formatScheduledDateTime } from './businessDate.js';
// Date / quantity / text formatters shared by the Order Notes board card and modal.
// Extracted verbatim from OrderNotes.vue — behavior unchanged.

export function formatTimeOnly(dateVal) {
  return formatBusinessTime(dateVal);
}

export function formatDateTime(dateVal) {
  return formatBusinessDateTime(dateVal);
}

export function formatScheduledTime(dateVal) {
  return formatScheduledDateTime(dateVal);
}

export function getQtyFormatted(qty) {
  const num = Number(qty);
  if (isNaN(num)) return qty;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

export function isArabic(text) {
  if (!text) return false;
  const arabicPattern = /[؀-ۿ]/;
  return arabicPattern.test(String(text));
}

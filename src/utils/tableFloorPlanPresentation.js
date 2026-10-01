import { parseBackendTimestamp } from './businessDate.js';

const STATUS_PRESENTATION = Object.freeze({
  available: Object.freeze({ cssClass: 'table-card--available', translationKey: 'Available' }),
  occupied: Object.freeze({ cssClass: 'table-card--occupied', translationKey: 'Occupied' }),
  printed: Object.freeze({ cssClass: 'table-card--printed', translationKey: 'Bill Printed' })
});

const UNKNOWN_STATUS = Object.freeze({
  cssClass: 'table-card--unknown',
  translationKey: 'Unknown'
});

const latinInteger = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
  useGrouping: false
});

function statusPresentation(status) {
  return STATUS_PRESENTATION[String(status || '').toLowerCase()] || UNKNOWN_STATUS;
}

export function getTableStatusClass(status) {
  return statusPresentation(status).cssClass;
}

export function getTableStatusKey(status) {
  return statusPresentation(status).translationKey;
}

export function formatTableElapsedTime(createdAt, nowMs = Date.now(), translate = (key) => key) {
  if (!createdAt) return '';

  const createdMs = parseBackendTimestamp(createdAt).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return '';

  const totalMinutes = Math.max(0, Math.floor((nowMs - createdMs) / 60000));
  if (totalMinutes < 60) {
    return `${latinInteger.format(totalMinutes)} ${translate('min')}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${latinInteger.format(hours)} ${translate('hr')}`;
  }

  return `${latinInteger.format(hours)} ${translate('hr')} ${latinInteger.format(minutes)} ${translate('min')}`;
}

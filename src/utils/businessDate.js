import { fetchReadJsonResponse } from '@/shared/http.js';
let offsetMinutes = 180;
let sqlOffset = '+03:00';
let dayStartHour = 6;

const pad2 = (value) => String(value).padStart(2, '0');

function parseBusinessSqlOffset(offset) {
    const raw = String(offset || '+03:00');
    if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(raw)) {
        throw new Error('Invalid business_sql_offset.');
    }
    const sign = raw[0] === '-' ? -1 : 1;
    const [hours, minutes] = raw.slice(1).split(':').map(Number);
    return sign * ((hours * 60) + minutes);
}

export function initBusinessConfig(config = {}) {
    if (config.business_sql_offset) {
        offsetMinutes = parseBusinessSqlOffset(config.business_sql_offset);
        sqlOffset = config.business_sql_offset;
    }
    if (Number.isInteger(config.business_day_start_hour) &&
        config.business_day_start_hour >= 0 &&
        config.business_day_start_hour <= 23) {
        dayStartHour = config.business_day_start_hour;
    }
}

let businessConfigFailed = false;
let businessConfigPending = null;

// Bounded so a stalled read can never hold the POS boot; a failure keeps the
// defaults and is re-read by retryFailedBusinessConfig on the socket heartbeat.
export function loadBusinessConfig() {
    businessConfigPending ||= fetchReadJsonResponse('api/config/business', {}, 3000)
        .then(({ data }) => {
            if (!data?.success) throw new Error('Business config read failed.');
            initBusinessConfig(data);
            businessConfigFailed = false;
            return data;
        })
        .catch(error => {
            businessConfigFailed = true;
            throw error;
        })
        .finally(() => { businessConfigPending = null; });
    return businessConfigPending;
}

export function retryFailedBusinessConfig() {
    if (businessConfigFailed && !businessConfigPending) loadBusinessConfig().catch(() => {});
}

export function parseBackendTimestamp(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    if (value == null || value === '') return new Date(NaN);
    const raw = String(value).trim();
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
    return new Date(hasZone ? raw : `${raw.replace(' ', 'T')}Z`);
}

export function parseScheduledTimestamp(value) {
    if (value == null || value === '' || String(value).startsWith('0000-00-00')) return new Date(NaN);
    if (value instanceof Date) return value;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
        return new Date(parseBackendTimestamp(raw).getTime() - offsetMinutes * 60000);
    }
    return parseBackendTimestamp(raw);
}

export function scheduledDateTimeInput(value) {
    const instant = parseScheduledTimestamp(value);
    if (Number.isNaN(instant.getTime())) return '';
    const wall = wallClockAtBusinessOffset(instant);
    return `${formatBusinessDate(instant)}T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
}

export function formatScheduledDateTime(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const instant = parseScheduledTimestamp(value);
    return Number.isNaN(instant.getTime()) ? value || '' : formatBusinessDateTimeShort(instant);
}

export function wallClockAtBusinessOffset(value) {
    const date = parseBackendTimestamp(value);
    return new Date(date.getTime() + offsetMinutes * 60000);
}

export function toBusinessDate(value) {
    const date = parseBackendTimestamp(value);
    const business = new Date(date.getTime() + offsetMinutes * 60000 - dayStartHour * 3600000);
    return `${business.getUTCFullYear()}-${pad2(business.getUTCMonth() + 1)}-${pad2(business.getUTCDate())}`;
}

export function currentBusinessDate() {
    return toBusinessDate(new Date());
}

export function addBusinessDateDays(dateString, days) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatBusinessDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const wall = wallClockAtBusinessOffset(value);
    if (isNaN(wall.getTime())) return value || '';
    return `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

export function formatBusinessDateTime(value) {
    const wall = wallClockAtBusinessOffset(value);
    if (isNaN(wall.getTime())) return value || '';
    const hours24 = wall.getUTCHours();
    const hours12 = hours24 % 12 || 12;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    return `${formatBusinessDate(value)} ${pad2(hours12)}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())} ${ampm}`;
}

export function formatBusinessDateTimeShort(value) {
    if (value == null || value === '') return '';
    if (Number.isNaN(parseBackendTimestamp(value).getTime())) return value;
    const date = formatBusinessDate(value);
    const time = formatBusinessTimeShort(value);
    return date && time ? `${date} ${time}` : value || '';
}

export function formatBusinessTime(value) {
    const formatted = formatBusinessDateTime(value);
    if (!formatted) return '';
    const parts = formatted.split(' ');
    return `${parts[1]} ${parts[2]}`;
}

export function formatBusinessTimeShort(value) {
    const wall = wallClockAtBusinessOffset(value);
    if (isNaN(wall.getTime())) return value || '';
    const hours24 = wall.getUTCHours();
    const hours12 = hours24 % 12 || 12;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    return `${pad2(hours12)}:${pad2(wall.getUTCMinutes())} ${ampm}`;
}

export function getBusinessDayStartHour() {
    return dayStartHour;
}

export function getBusinessConfig() {
    return {
        business_sql_offset: sqlOffset,
        business_day_start_hour: dayStartHour,
    };
}

export function businessDayWindowLabel(startDate, endDate) {
    const startHourStr = pad2(dayStartHour);
    const endHourStr = pad2((dayStartHour + 23) % 24);
    const nextDate = addBusinessDateDays(endDate, 1);
    return `${startDate} ${startHourStr}:00 → ${nextDate} ${endHourStr}:59`;
}


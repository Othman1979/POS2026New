const {
    addBusinessDays,
    getBusinessDate,
    getBusinessDateRange,
    getBusinessDayStartHour,
} = require('../utils/businessDate');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIOD_DAYS = 366;

function isValidDateOnly(value) {
    if (!DATE_ONLY.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
}

function daysBetween(startDate, endDate) {
    return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

function invalidPeriod(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function parseDailyReportPeriod({ startDate, endDate, defaultDate = getBusinessDate() } = {}) {
    const start = String(startDate || defaultDate);
    const end = String(endDate || start);
    if (!isValidDateOnly(start) || !isValidDateOnly(end)) throw invalidPeriod('Invalid report date.');
    const span = daysBetween(start, end);
    if (span < 0) throw invalidPeriod('End date must not be before start date.');
    if (span >= MAX_PERIOD_DAYS) throw invalidPeriod('Report range cannot exceed 366 days.');
    const range = getBusinessDateRange(start, end);
    const startHour = getBusinessDayStartHour();
    return {
        start_date: start,
        end_date: end,
        is_single_day: start === end,
        business_start_at: range.start,
        business_end_at: range.end,
        business_day_start_hour: startHour,
        business_day_end_hour: (startHour + 23) % 24,
        comparison_start_date: addBusinessDays(start, -7),
        comparison_end_date: addBusinessDays(end, -7),
    };
}

module.exports = { MAX_PERIOD_DAYS, daysBetween, isValidDateOnly, parseDailyReportPeriod };

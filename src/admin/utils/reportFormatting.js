import { currentLanguage, t } from '@/shared/i18n.js';
import { formatBusinessTimeShort } from '../../utils/businessDate.js';

const numberFormatters = new Map();
const dateFormatters = new Map();

function reportLocale() {
    return currentLanguage.value === 'ar' ? 'ar-JO' : 'en-JO';
}

function numberFormatter(options = {}) {
    const locale = reportLocale();
    const formatterOptions = { ...options, numberingSystem: 'latn' };
    const key = `${locale}:${JSON.stringify(formatterOptions)}`;
    if (!numberFormatters.has(key)) {
        numberFormatters.set(key, new Intl.NumberFormat(locale, formatterOptions));
    }
    return numberFormatters.get(key);
}

function dateFormatter(options) {
    const locale = reportLocale();
    const formatterOptions = { ...options, numberingSystem: 'latn', timeZone: 'UTC' };
    const key = `${locale}:${JSON.stringify(formatterOptions)}`;
    if (!dateFormatters.has(key)) {
        dateFormatters.set(key, new Intl.DateTimeFormat(locale, formatterOptions));
    }
    return dateFormatters.get(key);
}

function businessDateAsUtcNoon(value) {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
}

export function formatReportNumber(value, options = {}) {
    const numericValue = Number(value);
    return numberFormatter(options).format(Number.isFinite(numericValue) ? numericValue : 0);
}

export function formatReportMoney(value) {
    return `${formatReportNumber(value, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} ${t('JD')}`;
}

export function formatReportPercent(value) {
    return `${formatReportNumber(value, { maximumFractionDigits: 2 })}%`;
}

export function formatReportBusinessDate(value) {
    return dateFormatter({ year: 'numeric', month: 'short', day: 'numeric' })
        .format(businessDateAsUtcNoon(value));
}

export function formatReportWeekday(value) {
    return dateFormatter({ weekday: 'long' }).format(businessDateAsUtcNoon(value));
}

export function formatReportBusinessTime(value) {
    const [clock, period = ''] = formatBusinessTimeShort(value).split(' ');
    return `${clock} ${t(period)}`.trim();
}

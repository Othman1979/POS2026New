const DEFAULT_BUSINESS_TIME_ZONE = process.env.POS_BUSINESS_TIME_ZONE || 'Asia/Amman';
const DEFAULT_BUSINESS_SQL_OFFSET = process.env.POS_BUSINESS_SQL_OFFSET || '+03:00';
const DEFAULT_BUSINESS_DAY_START_HOUR = process.env.POS_BUSINESS_DAY_START_HOUR || '6';

const pad2 = (value) => String(value).padStart(2, '0');

const parseBackendTimestamp = (value) => {
    if (value instanceof Date) return value;
    if (value == null || value === '') return new Date(NaN);
    const raw = String(value).trim();
    return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
};

// A schedule is entered in the venue's clock and stored unchanged in DATETIME.
// Never let Node's local timezone interpret this input.
const normalizeScheduledDateTime = (value, publicCode = 'DELIVERY_DATE_INVALID') => {
    if (value == null || String(value).trim() === '') return null;
    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    const invalid = () => Object.assign(new Error('Enter a valid scheduled date and time.'), { statusCode: 400, publicCode });
    if (!match) throw invalid();
    const [, year, month, day, hour, minute, second = '00'] = match;
    const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    if (+year < 1000 || date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month ||
        date.getUTCDate() !== +day || date.getUTCHours() !== +hour ||
        date.getUTCMinutes() !== +minute || date.getUTCSeconds() !== +second) throw invalid();
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const getBusinessSqlOffset = () => {
    if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(DEFAULT_BUSINESS_SQL_OFFSET)) {
        throw new Error('Invalid POS_BUSINESS_SQL_OFFSET.');
    }
    return DEFAULT_BUSINESS_SQL_OFFSET;
};

const parseBusinessSqlOffset = () => {
    const offset = getBusinessSqlOffset();
    const sign = offset[0] === '-' ? -1 : 1;
    const [hours, minutes] = offset.slice(1).split(':').map(Number);
    return sign * ((hours * 60) + minutes);
};

const getBusinessDayStartHour = () => {
    const raw = String(DEFAULT_BUSINESS_DAY_START_HOUR);
    if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(raw)) {
        throw new Error('Invalid POS_BUSINESS_DAY_START_HOUR (expected integer 0..23).');
    }
    return Number(raw);
};

const businessLocalTimestampSql = (columnExpression) =>
    `CONVERT_TZ(${columnExpression}, '+00:00', '${getBusinessSqlOffset()}')`;

const businessLocalDateSql = (columnExpression) =>
    `DATE_FORMAT(${businessLocalTimestampSql(columnExpression)} - INTERVAL ${getBusinessDayStartHour()} HOUR, '%Y-%m-%d')`;

const businessLocalHourSql = (columnExpression) =>
    `HOUR(${businessLocalTimestampSql(columnExpression)})`;

const businessLocalHourSortSql = (columnExpression) =>
    `((HOUR(${businessLocalTimestampSql(columnExpression)}) - ${getBusinessDayStartHour()} + 24) % 24)`;

const businessLocalElapsedMinuteSql = (columnExpression) => {
    const localTimestamp = businessLocalTimestampSql(columnExpression);
    const startMinutes = getBusinessDayStartHour() * 60;
    return `MOD((HOUR(${localTimestamp}) * 60 + MINUTE(${localTimestamp}) - ${startMinutes} + 1440), 1440)`;
};

const datePartsAtBusinessOffset = (date) => {
    const shifted = new Date(date.getTime() + parseBusinessSqlOffset() * 60000);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        second: shifted.getUTCSeconds(),
    };
};

// Calendar issue date, deliberately without the operational business-day cutoff.
const getBusinessCalendarDate = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = parseBackendTimestamp(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp.');
    const parts = datePartsAtBusinessOffset(date);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
};

const zonedLocalTimeToDate = (dateString) => {
    const [year, month, day] = String(dateString).split('-').map(Number);
    if (!year || !month || !day) throw new Error('Invalid business date.');
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - parseBusinessSqlOffset() * 60000);
};

const formatDbTimestamp = (date) => (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
);

const getBusinessDate = (date = new Date()) => {
    const businessMs = date.getTime()
        + parseBusinessSqlOffset() * 60000
        - getBusinessDayStartHour() * 3600000;
    const d = new Date(businessMs);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

const addBusinessDays = (dateString, days) => {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

const getBusinessDayRange = (dateString = getBusinessDate()) => {
    const businessDate = dateString || getBusinessDate();
    const nextDate = addBusinessDays(businessDate, 1);
    const [year, month, day] = businessDate.split('-').map(Number);
    const [nextYear, nextMonth, nextDay] = nextDate.split('-').map(Number);
    const startHour = getBusinessDayStartHour();
    const offsetMinutes = parseBusinessSqlOffset();
    const start = new Date(Date.UTC(year, month - 1, day, startHour, 0, 0) - offsetMinutes * 60000);
    const end = new Date(Date.UTC(nextYear, nextMonth - 1, nextDay, startHour, 0, 0) - offsetMinutes * 60000);
    return {
        date: businessDate,
        nextDate,
        start: formatDbTimestamp(start),
        end: formatDbTimestamp(end),
    };
};

const getBusinessDateRange = (startDate, endDate = startDate) => {
    const start = getBusinessDayRange(startDate);
    const endExclusive = getBusinessDayRange(addBusinessDays(endDate, 1));
    return {
        start: start.start,
        end: endExclusive.start,
        startDate,
        endDate,
    };
};

module.exports = {
    parseBackendTimestamp,
    normalizeScheduledDateTime,
    getBusinessCalendarDate,
    DEFAULT_BUSINESS_TIME_ZONE,
    DEFAULT_BUSINESS_SQL_OFFSET,
    getBusinessSqlOffset,
    parseBusinessSqlOffset,
    getBusinessDayStartHour,
    businessLocalTimestampSql,
    businessLocalDateSql,
    businessLocalHourSql,
    businessLocalHourSortSql,
    businessLocalElapsedMinuteSql,
    datePartsAtBusinessOffset,
    getBusinessDate,
    addBusinessDays,
    getBusinessDayRange,
    getBusinessDateRange,
    zonedLocalTimeToDate,
    formatDbTimestamp,
};

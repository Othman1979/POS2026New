'use strict';

// DECIMAL(16,6) quantities. Keep strings at SQL/JSON boundaries; BigInt in sums.
const SCALE = 1000000n;
const MAX = 9999999999999999n;
function parse(value) {
    if (!['string', 'number'].includes(typeof value)) throw new TypeError('Invalid stock quantity.');
    const text = String(value);
    if (!/^-?\d{1,10}(\.\d{1,6})?$/.test(text)) throw new TypeError('Stock quantity requires at most six decimal places.');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
    return negative ? -units : units;
}
function format(units) {
    if (typeof units !== 'bigint' || units > MAX || units < -MAX) throw new RangeError('Stock quantity exceeds the supported range.');
    const absolute = units < 0n ? -units : units;
    return `${units < 0n ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(6, '0')}`;
}
module.exports = { parse, format };

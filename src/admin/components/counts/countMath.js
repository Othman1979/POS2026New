// Pure helpers for the stock count sheet. Quantities and money are decimal strings (3 dp) that
// come from and go back to the server; every calculation here uses scaled BigInt integers, never
// floats, so 0.1 + 0.2 style drift cannot reach the screen.

export const MAX_BATCH = 100;

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

// Exact decimal text -> { units, scale } (units is a BigInt, value = units / 10^scale), or null.
export function parseDecimal(text) {
    const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(text ?? '').trim());
    if (!match) return null;
    const frac = match[3] || '';
    const units = BigInt(match[2] + frac);
    return { units: match[1] ? -units : units, scale: frac.length };
}

const pow10 = (n) => 10n ** BigInt(n);

function roundScale(units, fromScale, toScale) {
    if (fromScale <= toScale) return units * pow10(toScale - fromScale);
    const divisor = pow10(fromScale - toScale);
    const magnitude = units < 0n ? -units : units;
    const rounded = (magnitude + divisor / 2n) / divisor;
    return units < 0n ? -rounded : rounded;
}

// Value as integer thousandths (half-up), or null when it is not a number.
export function toThousandths(text) {
    const parsed = parseDecimal(text);
    return parsed ? roundScale(parsed.units, parsed.scale, 3) : null;
}

export function formatThousandths(units) {
    const negative = units < 0n;
    const digits = String(negative ? -units : units).padStart(4, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

// What a person typed into a quantity box. Blank is "not counted yet"; 0 is a real count.
// Returns { state: 'empty' | 'invalid' | 'ok', value } where value is the canonical 3 dp text.
export function parseQty(raw) {
    const text = String(raw ?? '').trim().replace(/[٠-٩۰-۹]/g, digit => ARABIC_DIGITS[digit]).replace(/[,٫]/g, '.');
    if (text === '') return { state: 'empty', value: null };
    if (!/^\d{1,9}(\.\d{1,3})?$/.test(text)) return { state: 'invalid', value: null };
    return { state: 'ok', value: formatThousandths(toThousandths(text)) };
}

// Canonical 3 dp text for a stored quantity, null for none.
export const canonQty = (stored) => {
    if (stored === null || stored === undefined || stored === '') return null;
    const units = toThousandths(stored);
    return units === null ? null : formatThousandths(units);
};

// Counted quantity x pack size, in the base unit, half-up to 3 dp: "2.500" x "12" = "30.000".
export function toBaseQty(qty, factor) {
    const a = parseDecimal(qty);
    const b = parseDecimal(factor);
    if (!a || !b) return null;
    return formatThousandths(roundScale(a.units * b.units, a.scale + b.scale, 3));
}

const trimZeros = (units, scale) => formatThousandths(roundScale(units, scale, 3)).replace(/\.?0+$/, '');

// Standard unit labels read as their translated name and never show a factor. A pack reads as
// "label (size unit)" with the size in kg / l when the item also has that unit, else in the base
// unit. `names` maps label -> translated name; `options` are all the item's units.
export function unitOptionText(option, baseUnit, names = {}, options = []) {
    if (names[option?.label]) return names[option.label];
    const larger = { g: 'kg', ml: 'l' }[baseUnit];
    const useLarger = larger && options.some(other => other.label === larger);
    const divisor = useLarger ? 1000n : 1n;
    const thousandths = toThousandths(option?.factor);
    if (thousandths === null) return String(option?.label ?? '');
    const size = formatThousandths((thousandths + divisor / 2n) / divisor).replace(/\.?0+$/, '');
    const unitName = names[useLarger ? larger : baseUnit] || (useLarger ? larger : baseUnit);
    return `${option.label} (${size} ${unitName})`;
}

// Fixed groups are translated by key; category names stay as the server sent them. Review lines
// carry no group key, so an ingredient is recognised by its item key.
export function groupName(line, translate) {
    if (line.group_key === 'ingredients' || String(line.item_key || '').startsWith('ingredient:')) return translate('Ingredients');
    if (line.group_key === 'other' || line.group_label === 'Other items') return translate('Other items');
    return line.group_label;
}

export const trimFactor = (factor) => {
    const parsed = parseDecimal(factor);
    return parsed ? trimZeros(parsed.units, parsed.scale) : String(factor);
};

// Pack factors are stored with six decimals, so unit identity compares all six: 1.0001 and
// 1.0004 are different packs even though they are equal at three decimals.
function factorKey(factor) {
    const parsed = parseDecimal(factor);
    return parsed ? String(roundScale(parsed.units, parsed.scale, 6)) : String(factor);
}

export const unitKey = (option) => `${option.label}|${factorKey(option.factor)}`;

// Same unit means same label and the same pack size, however the factor is written.
export function sameUnit(aLabel, aFactor, bLabel, bFactor) {
    return aLabel === bLabel && factorKey(aFactor) === factorKey(bFactor);
}

// Index of the next line to visit from `from` in `step` direction. `uncountedOnly` skips lines that
// already hold a quantity (forward Enter); returns -1 when there is none.
export function nextIndex(lines, from, step, uncountedOnly) {
    for (let index = from + step; index >= 0 && index < lines.length; index += step) {
        if (!uncountedOnly || parseQty(lines[index].qty).state !== 'ok') return index;
    }
    return -1;
}

// Review order: largest absolute money difference first; lines without a value go last.
export function sortByAbsValue(lines) {
    const size = (line) => {
        const units = toThousandths(line.variance_value);
        return units === null ? null : (units < 0n ? -units : units);
    };
    return [...lines].sort((a, b) => {
        const left = size(a);
        const right = size(b);
        if (left === null && right === null) return String(a.name).localeCompare(String(b.name));
        if (left === null) return 1;
        if (right === null) return -1;
        return left === right ? String(a.name).localeCompare(String(b.name)) : (left < right ? 1 : -1);
    });
}

// A count written in several units ("3 packs + 7 pieces"), totalled in the base unit. Each part is
// { qty, factor }; blank parts are skipped and any invalid part makes the whole total invalid.
export function mixedBaseQty(parts) {
    let total = 0n;
    let counted = false;
    for (const part of parts || []) {
        const typed = parseQty(part.qty);
        if (typed.state === 'invalid') return { state: 'invalid', value: null };
        if (typed.state === 'empty') continue;
        const base = toBaseQty(typed.value, part.factor);
        if (base === null) return { state: 'invalid', value: null };
        total += toThousandths(base);
        counted = true;
    }
    return counted ? { state: 'ok', value: formatThousandths(total) } : { state: 'empty', value: null };
}

// Stored quantity for display without trailing zeros: "3.000" -> "3", "2.500" -> "2.5".
export const trimQty = (stored) => {
    const canon = canonQty(stored);
    return canon === null ? '' : canon.replace(/\.?0+$/, '');
};

// Exact sum of decimal money strings; values that are not numbers count as zero.
export function sumValues(values) {
    let total = 0n;
    for (const value of values || []) total += toThousandths(value) ?? 0n;
    return formatThousandths(total);
}

export const isShortage =(value) => (toThousandths(value) ?? 0n) < 0n;
export const isZero = (value) => (toThousandths(value) ?? 0n) === 0n;

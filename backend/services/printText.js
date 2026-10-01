// Strips control bytes (incl. ESC 0x1B / GS 0x1D used for ESC/POS injection) and
// clamps length, so user-sourced fields can't inject printer commands or break layout.
function sanitizePrintString(value, maxLen = 200) {
    if (value === null || value === undefined) return '';
    // eslint-disable-next-line no-control-regex
    const cleaned = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

module.exports = { sanitizePrintString };

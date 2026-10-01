/**
 * Decode a price-embedded scale label: EAN-13 = 7-digit item part + 5-digit
 * total in cents + check digit. Only two leads count, so a manufacturer
 * barcode is never read as a price: 0 (a UPC-A scale label, sent as 12 digits)
 * and 2 (GS1 in-store numbers, never used on manufacturer products).
 */
function decodeScaleBarcode(value) {
    const input = String(value ?? '').trim();
    // A zero-prefixed EAN-13 can be transmitted by a scanner as UPC-A.
    // Restore only that representation; still require the complete checksum.
    const barcode = /^\d{12}$/.test(input) ? `0${input}` : input;
    if (!/^[02]\d{12}$/.test(barcode)) return null;

    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
        const digit = barcode.charCodeAt(index) - 48;
        sum += digit * (index % 2 === 0 ? 1 : 3);
    }
    const expectedCheckDigit = (10 - (sum % 10)) % 10;
    if (expectedCheckDigit !== barcode.charCodeAt(12) - 48) return null;

    const totalCents = Number(barcode.slice(7, 12));
    if (totalCents <= 0) return null;

    const head = barcode.slice(0, 7);
    return {
        // A 0 label keeps its one established form: the 6 digits after the 0.
        // A 2 label may be saved as the 6 digits after the 2, with the 2
        // (e.g. 200001), as the whole item part, or as GS1 20-29 + 5 digits.
        // Order is irrelevant: the lookup accepts only an unambiguous owner.
        itemCodes: head[0] === '0'
            ? [head.slice(1)]
            : [...new Set([head.slice(1), head.slice(0, 6), head, head.slice(2)])],
        totalCents
    };
}

module.exports = { decodeScaleBarcode };

import { describe, expect, it } from 'vitest';
import { decodeScaleBarcode } from '../../services/scaleBarcode.js';

describe('decodeScaleBarcode', () => {
    it.each([
        ['0100000014523', 1452],
        ['100000014523', 1452],
        ['100000040591', 4059],
        ['100000054369', 5436],
        ['0100000040591', 4059],
        ['0100000054369', 5436],
        ['0100000999998', 99999]
    ])('decodes store-1 scale label %s as the six digits after the 0', (barcode, totalCents) => {
        expect(decodeScaleBarcode(barcode)).toEqual({ itemCodes: ['100000'], totalCents });
    });

    it.each(['6251234014521', '5901234123457', '3000000405994'])(
        'never reads a manufacturer barcode %s as a scale price', (barcode) => {
            expect(decodeScaleBarcode(barcode)).toBeNull();
        });

    it('decodes a 2-leading label into every saved item-code form', () => {
        expect(decodeScaleBarcode('2000010040599')).toEqual({
            itemCodes: ['000010', '200001', '2000010', '00010'],
            totalCents: 4059
        });
    });

    it.each([
        '0100000040592',
        '100000040592',
        '1100000040598',
        '2000010040598',
        '2000010000005',
        '010000004059',
        '01000000405911',
        '01000000A0591',
        '0100000000007',
        '',
        null
    ])('rejects non-scale or unsafe label %s', (barcode) => {
        expect(decodeScaleBarcode(barcode)).toBeNull();
    });
});

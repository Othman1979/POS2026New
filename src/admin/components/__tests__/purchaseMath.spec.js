import { describe, expect, it } from 'vitest';
import {
    addOrIncrement, applyItem, bonusReceipt, buildLines, invoiceTotals, lineAmounts, mergeRows, newRow, nextCell, paperTotalState, priceChange, purchaseInsight,
    rowFromLine, sameDraft, sameLines, selectUnit,
} from '../purchases/purchaseMath.js';

const item = (id, extra = {}) => ({ item_key: `product:${id}`, name: `Item ${id}`, base_unit: 'kg', packs: [{ label: 'kg', factor: 1 }, { label: 'box', factor: 12 }], last: null, ...extra });
const filled = (id, qty, price, tax = 0, extra = {}) => Object.assign(applyItem(newRow(), item(id, extra), { qty }), { unit_price: price, tax_rate: tax });

describe('line and invoice totals follow the server rule', () => {
    it('rounds each line to 3 decimals and sums the rounded lines', () => {
        // 7 x 0.1429 = 1.0003 -> 1.000; tax 16% of 1.000 = 0.160
        expect(lineAmounts(filled(1, 7, 0.1429, 16))).toEqual({ subtotal: 1, tax: 0.16, total: 1.16 });
        // Three lines of 0.0004 each round to 0.000; the invoice sums the rounded lines (0), not the raw 0.0012.
        const rows = [filled(1, 1, 0.0004), filled(2, 1, 0.0004), filled(3, 1, 0.0004)];
        expect(invoiceTotals(rows)).toEqual({ subtotal: 0, tax: 0, total: 0 });
        expect(invoiceTotals([filled(1, 1, 0.0005), filled(2, 1, 0.0005)]).subtotal).toBe(0.002);
    });

    it('treats empty, zero and negative quantities or prices as contributing nothing', () => {
        expect(lineAmounts(filled(1, '', 5, 16)).total).toBe(0);
        expect(lineAmounts(filled(1, 0, 5, 16)).total).toBe(0);
        expect(lineAmounts(filled(1, 2, '', 16)).total).toBe(0);
        expect(lineAmounts(filled(1, 2, 0, 16)).total).toBe(0);
        expect(lineAmounts(filled(1, -2, 5, 16)).total).toBe(0);
    });

    it('compares the paper total with a 0.005 tolerance', () => {
        expect(paperTotalState('', 10)).toBe('none');
        expect(paperTotalState(10.004, 10)).toBe('match');
        expect(paperTotalState(10.006, 10)).toBe('mismatch');
        expect(paperTotalState(9.99, 10)).toBe('mismatch');
    });
});

describe('payload building', () => {
    it('drops rows without an item or without a quantity and never sends them', () => {
        const rows = [newRow(), filled(1, 2, 3, 4), applyItem(newRow(), item(2)), filled(3, 0, 5)];
        const { lines, problems } = buildLines(rows);
        expect(problems).toEqual([]);
        expect(lines).toEqual([{ item_key: 'product:1', qty: 2, unit_label: 'box', unit_factor: 12, unit_price: 3, tax_rate: 4 }]);
    });

    it('reports a quantity without a price instead of sending it', () => {
        const row = applyItem(newRow(), item(5), { qty: 2 });
        const { lines, problems } = buildLines([row]);
        expect(lines).toEqual([]);
        expect(problems).toEqual([{ key: row.key, reason: 'price' }]);
    });

    it('keeps a zero price as a real value', () => {
        const { lines } = buildLines([filled(1, 2, 0)]);
        expect(lines[0].unit_price).toBe(0);
    });
});

describe('item prefill and barcode add-or-increment', () => {
    it('prefills unit, price and tax from the last purchase, else the buying pack', () => {
        const last = { unit_label: 'box', unit_factor: 12, unit_price: 24, tax_rate: 16, invoice_date: '2026-09-01' };
        const withLast = applyItem(newRow(), item(1, { last }));
        expect(withLast).toMatchObject({ unit_label: 'box', unit_factor: 12, unit_price: 24, tax_rate: 16, ref_price: 24 });
        const without = applyItem(newRow(), item(2));
        expect(without).toMatchObject({ unit_label: 'box', unit_factor: 12, unit_price: '', tax_rate: 0, ref_price: null });
    });

    it('adds a new item with quantity 1, then increments instead of duplicating it', () => {
        const rows = [newRow()];
        expect(addOrIncrement(rows, item(7), { targetIndex: 0 })).toEqual({ index: 0, added: true });
        expect(rows[0].qty).toBe(1);
        rows.push(newRow());
        expect(addOrIncrement(rows, item(7), { targetIndex: 1 })).toEqual({ index: 0, added: false });
        expect(rows[0].qty).toBe(2);
        expect(rows.filter(row => row.item).length).toBe(1);
        expect(rows[1].item).toBeNull();
    });

    it('treats a product and an ingredient with the same number as different items', () => {
        const rows = [filled(1, 1, 1)];
        const flour = item(1, { item_key: 'ingredient:1' });
        expect(addOrIncrement(rows, flour, { targetIndex: -1 })).toEqual({ index: 1, added: true });
        expect(rows.map(row => row.item.item_key)).toEqual(['product:1', 'ingredient:1']);
        expect(addOrIncrement(rows, flour, { targetIndex: -1 })).toEqual({ index: 1, added: false });
    });

    it('appends a row when the scan target is not blank', () => {
        const rows = [filled(1, 1, 1)];
        expect(addOrIncrement(rows, item(2), { targetIndex: 0 })).toEqual({ index: 1, added: true });
        expect(rows.map(row => row.item.item_key)).toEqual(['product:1', 'product:2']);
    });

    it('re-prices on a unit change only while the price was not typed', () => {
        const last = { unit_label: 'box', unit_factor: 12, unit_price: 24, tax_rate: 0 };
        const row = applyItem(newRow(), item(1, { last }));
        selectUnit(row, 'kg|1');
        expect(row.unit_price).toBe('');
        selectUnit(row, 'box|12');
        expect(row.unit_price).toBe(24);
        row.price_touched = true;
        row.unit_price = 30;
        selectUnit(row, 'kg|1');
        expect(row.unit_price).toBe(30);
    });
});

describe('price-change badge', () => {
    const row = (price, ref = 10, refFactor = 1, factor = 1) => ({ unit_price: price, ref_price: ref, ref_factor: refFactor, unit_factor: factor });
    it('shows only above 10 percent and says which way', () => {
        expect(priceChange(row(11))).toBeNull();
        expect(priceChange(row(9))).toBeNull();
        expect(priceChange(row(11.01))).toMatchObject({ direction: 'up', percent: 10 });
        expect(priceChange(row(8.5))).toMatchObject({ direction: 'down', percent: 15 });
    });
    it('stays quiet without a reference or across different buying units', () => {
        expect(priceChange(row(20, null))).toBeNull();
        expect(priceChange(row('', 10))).toBeNull();
        expect(priceChange(row(20, 10, 12, 1))).toBeNull();
    });
});

describe('keyboard next-cell logic', () => {
    const rows = [filled(1, 1, 1), filled(2, 1, 1)];
    it('walks item, qty, unit, price, tax', () => {
        expect(nextCell(rows, 0, 'item')).toEqual({ row: 0, cell: 'qty', createRow: false });
        expect(nextCell(rows, 0, 'qty')).toEqual({ row: 0, cell: 'unit', createRow: false });
        expect(nextCell(rows, 0, 'unit')).toEqual({ row: 0, cell: 'price', createRow: false });
        expect(nextCell(rows, 0, 'price')).toEqual({ row: 0, cell: 'tax', createRow: false });
    });
    it('moves to the next row item after the last cell, and opens a new row after the final row', () => {
        expect(nextCell(rows, 0, 'tax')).toEqual({ row: 1, cell: 'item', createRow: false });
        expect(nextCell(rows, 1, 'tax')).toEqual({ row: 2, cell: 'item', createRow: true });
    });
    it('keeps focus on the item search while the row has no item', () => {
        expect(nextCell([newRow()], 0, 'item')).toEqual({ row: 0, cell: 'item', createRow: false });
    });
});

describe('repeat last invoice and add category merging', () => {
    it('drops blank rows, skips items already present, keeps one blank row at the end', () => {
        const existing = [filled(1, 5, 2), newRow()];
        const incoming = [filled(1, 9, 9), filled(2, 3, 4)];
        const { rows, skipped } = mergeRows(existing, incoming);
        expect(skipped).toBe(1);
        expect(rows.map(row => row.item?.item_key ?? null)).toEqual(['product:1', 'product:2', null]);
        expect(rows[0].qty).toBe(5);
    });
    it('honors the 100-line cap', () => {
        const many = Array.from({ length: 100 }, (_, index) => filled(index + 1, 1, 1));
        const { rows, skipped } = mergeRows(many, [filled(500, 1, 1)]);
        expect(skipped).toBe(1);
        expect(rows.filter(row => row.item).length).toBe(100);
    });
    it('repeat-last rows keep quantity and price and have no badge', () => {
        const row = rowFromLine({ item_key: 'product:4', name: 'Milk', base_unit: 'ml', qty: '6.000', unit_label: 'box', unit_factor: '12', unit_price: '3.5000', tax_rate: '16.00', last_unit_price_before: '3.5' });
        expect(row).toMatchObject({ qty: 6, unit_label: 'box', unit_factor: 12, unit_price: 3.5, tax_rate: 16 });
        expect(priceChange(row)).toBeNull();
    });
    it('a line keeps the starts-tracking flag of its item, from a search result and from a saved line', () => {
        expect(applyItem(newRow(), item(5, { starts_tracking: true })).item.starts_tracking).toBe(true);
        expect(applyItem(newRow(), item(5)).item.starts_tracking).toBeUndefined();
        const saved = { item_key: 'product:4', name: 'Milk', base_unit: 'ml', qty: '1', unit_label: 'ml', unit_factor: '1', unit_price: '1', tax_rate: '0' };
        expect(rowFromLine({ ...saved, starts_tracking: true }).item.starts_tracking).toBe(true);
        expect(rowFromLine({ ...saved, starts_tracking: false }).item.starts_tracking).toBe(false);
        expect(rowFromLine(saved).item.starts_tracking).toBe(false);
    });
});

describe('recognising a committed save', () => {
    it('matches server lines to the intended lines numerically', () => {
        const intended = [{ item_key: 'product:1', qty: 2, unit_label: 'kg', unit_factor: 1, unit_price: 3.5, tax_rate: 16 }];
        const server = [{ item_key: 'product:1', qty: '2.000', unit_label: 'kg', unit_factor: '1.000000', unit_price: '3.5000', tax_rate: '16.00' }];
        expect(sameLines(server, intended)).toBe(true);
        expect(sameLines([{ ...server[0], qty: '3.000' }], intended)).toBe(false);
        expect(sameLines([], intended)).toBe(false);
    });

    it('defaults a first purchase to the buying pack, and a repeat purchase to the last unit', () => {
        const first = applyItem(newRow(), item(1));
        expect([first.unit_label, first.unit_factor]).toEqual(['box', 12]);
        const repeat = applyItem(newRow(), item(1, { last: { unit_label: 'kg', unit_factor: 1, unit_price: 2, tax_rate: 0 } }));
        expect([repeat.unit_label, repeat.unit_factor]).toEqual(['kg', 1]);
        const baseOnly = applyItem(newRow(), item(1, { packs: [{ label: 'kg', factor: 1 }] }));
        expect(baseOnly.unit_label).toBe('kg');
    });
});

describe('review fixes', () => {
    it('rounds money exactly like the server, not with binary floats', () => {
        // 0.813 x 2.5000 = 2.0325 -> half-up 2.033; binary floats round it to 2.032.
        expect(lineAmounts(filled(1, 0.813, 2.5)).subtotal).toBe(2.033);
        // 1.275 x 1.9800 = 2.5245 -> 2.525 (floats: 2.524); tax 16% of 2.525 = 0.404
        expect(lineAmounts(filled(1, 1.275, 1.98, 16))).toEqual({ subtotal: 2.525, tax: 0.404, total: 2.929 });
        expect(invoiceTotals([filled(1, 0.813, 2.5), filled(2, 0.75, 2.682)]).total).toBe(4.045);
    });

    it('tells apart two packs that share a label', () => {
        const row = applyItem(newRow(), item(1, { packs: [{ label: 'kg', factor: 1 }, { label: 'box', factor: 12 }, { label: 'box', factor: 24 }] }));
        selectUnit(row, 'box|24');
        expect([row.unit_label, row.unit_factor]).toEqual(['box', 24]);
        selectUnit(row, 'box|12');
        expect(row.unit_factor).toBe(12);
    });

    it('compares a previous price only when it was for the same buying unit', () => {
        const line = { item_key: 'product:1', name: 'Cola', base_unit: 'unit', qty: 2, unit_label: 'carton', unit_factor: 24, unit_price: 7, tax_rate: 16 };
        const samePack = rowFromLine({ ...line, last_unit_price_before: 6, last_unit_factor_before: 24 });
        expect(priceChange(samePack)).toMatchObject({ direction: 'up', percent: 17 });
        const otherPack = rowFromLine({ ...line, last_unit_price_before: 0.3, last_unit_factor_before: 1 });
        expect(priceChange(otherPack)).toBeNull();
    });

    it('recognises a lost save only when header and lines both match', () => {
        const lines = [{ item_key: 'product:1', qty: 2, unit_label: 'box', unit_factor: 12, unit_price: 3, tax_rate: 0 }];
        const body = { supplier_id: 5, supplier_invoice_no: 'INV-1', invoice_date: '2026-09-30', payment_status: 'credit', paper_total: null, notes: null, lines };
        const server = { ...body, paper_total: null, notes: '', lines: [{ ...lines[0], qty: '2.000' }] };
        expect(sameDraft(server, body)).toBe(true);
        expect(sameDraft({ ...server, supplier_invoice_no: 'INV-2' }, body)).toBe(false);
        expect(sameDraft({ ...server, payment_status: 'paid' }, body)).toBe(false);
        expect(sameDraft({ ...server, paper_total: 6 }, body)).toBe(false);
    });

    it('treats a repeated price as a suggestion that a unit change clears', () => {
        const line = { item_key: 'product:1', name: 'Cola', base_unit: 'unit', qty: 2, unit_label: 'box', unit_factor: 12, unit_price: 24, tax_rate: 0 };
        const repeated = rowFromLine(line, { repeated: true });
        selectUnit(repeated, 'unit|1');
        expect(repeated.unit_price).toBe('');
        const saved = rowFromLine(line);
        selectUnit(saved, 'unit|1');
        expect(saved.unit_price).toBe(24);
    });
});

describe('purchase history under a line', () => {
    const history = (extra = {}) => ({
        item_key: 'product:1',
        last: { base_price: 0.25, unit_price: 3, unit_factor: 12, unit_label: 'box', invoice_date: '2026-09-30', supplier_id: 2, supplier_name: 'Other', reference: 'A-1' },
        supplier_last: { base_price: 0.2, unit_price: 0.2, unit_factor: 1, unit_label: 'kg', invoice_date: '2026-09-01', supplier_id: 1, supplier_name: 'Mine', reference: 'B-1' },
        average_base_price: 0.225,
        on_hand: 40,
        ...extra,
    });

    it('expresses every price in the line unit and flags any rise above the last price', () => {
        const row = Object.assign(applyItem(newRow(), item(1)), { unit_label: 'box', unit_factor: 12, unit_price: 3.12 });
        const insight = purchaseInsight(row, history());
        expect(insight.last.price).toBe(3);
        expect(insight.supplierLast.price).toBe(2.4);
        expect(insight.average).toBe(2.7);
        expect(insight.onHand).toBe(40);
        expect(insight.increase).toEqual({ amount: 0.12, percent: 4 });
    });

    it('stays quiet for equal or lower prices and when there is no history', () => {
        const row = Object.assign(applyItem(newRow(), item(1)), { unit_label: 'kg', unit_factor: 1, unit_price: 0.25 });
        expect(purchaseInsight(row, history()).increase).toBeNull();
        expect(purchaseInsight({ ...row, unit_price: 0.2 }, history()).increase).toBeNull();
        expect(purchaseInsight(row, history({ last: null, supplier_last: null, average_base_price: null, on_hand: null })))
            .toEqual({ last: null, lastFromSupplier: false, supplierLast: null, average: null, onHand: null, increase: null });
        expect(purchaseInsight(newRow(), history())).toBeNull();
    });

    it('merges the supplier price into the last price when it is the same invoice', () => {
        const row = Object.assign(applyItem(newRow(), item(1)), { unit_price: '' });
        const same = history({ supplier_last: history().last });
        expect(purchaseInsight(row, same)).toMatchObject({ lastFromSupplier: true, supplierLast: null });
    });
});

describe('bonus units', () => {
    it('adds free base units to stock and spreads the paid amount over them', () => {
        const row = selectUnit(filled(1, 10, ''), 'box|12');
        Object.assign(row, { unit_price: 2.4, bonus_qty: 24 });
        expect(bonusReceipt(row)).toEqual({ base: 144, cost: 0.166667 });
        expect(buildLines([row]).lines[0]).toMatchObject({ qty: 10, bonus_qty: 24, unit_label: 'box', unit_factor: 12 });
        row.bonus_qty = '';
        expect(bonusReceipt(row)).toBeNull();
        expect(buildLines([row]).lines[0]).not.toHaveProperty('bonus_qty');
    });

    it('rejects a negative bonus and reloads a saved one', () => {
        const row = filled(1, 1, 5);
        row.bonus_qty = -1;
        expect(buildLines([row]).problems).toEqual([{ key: row.key, reason: 'qty' }]);
        const line = { item_key: 'product:1', name: 'Item 1', base_unit: 'kg', packs: [], qty: 2, bonus_qty: 3, unit_label: 'kg', unit_factor: 1, unit_price: 5, tax_rate: 0 };
        expect(rowFromLine(line).bonus_qty).toBe(3);
        expect(rowFromLine(line, { keepQty: false }).bonus_qty).toBe('');
        expect(sameLines([line], [{ ...line, bonus_qty: 0 }])).toBe(false);
    });
});

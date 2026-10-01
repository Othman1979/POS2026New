import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

vi.mock('vue', async original => ({
    ...await original(),
    useSSRContext: () => ({ modules: new Set() }),
    onMounted: vi.fn(), onBeforeUnmount: vi.fn(), onActivated: vi.fn(), onDeactivated: vi.fn(),
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../counts/countsApi.js', () => ({
    describeError: error => error.message,
    countsApi: { getCount: vi.fn(), saveLines: vi.fn(), addLine: vi.fn(), searchItems: vi.fn(), deleteCount: vi.fn() },
}));
import Sheet from '../counts/StockCountSheet.vue';
import { countsApi } from '../counts/countsApi.js';
import { unitKey } from '../counts/countMath.js';

const serverLine = (id, extra = {}) => ({
    id, line_no: id, item_key: `stock:${id}`, name: `Item ${id}`, group_label: 'Dairy', base_unit: 'g', qty: null,
    unit_label: 'g', unit_factor: '1', unit_options: [{ label: 'g', factor: '1' }, { label: 'box', factor: '500' }],
    counted_at: null, counted_by_name: null, ...extra,
});
const serverCount = (lines, extra = {}) => ({ id: 7, reference: 'Monthly', count_date: '2026-09-30', status: 'draft', line_count: lines.length, counted_count: 0, created_by_name: 'Sam', lines, ...extra });
const lostReply = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const echo = async (id, payload) => ({ lines: payload.map(line => ({ id: line.id, counted_at: '2026-09-30T10:00:00Z', counted_by_name: 'Sam' })), counted_count: payload.length });

let scope, sheet, emitted;
async function open(lines) {
    countsApi.getCount.mockResolvedValue(serverCount(lines));
    scope = effectScope();
    sheet = scope.run(() => Sheet.setup({ countId: 7 }, { expose: () => {}, emit: (name, payload) => emitted.push([name, payload]) }));
    await sheet.load();
    return sheet.lines.value;
}
const type = (line, value) => { line.qty = value; sheet.onQtyInput(line); };

beforeEach(() => {
    vi.useFakeTimers();
    Object.values(countsApi).forEach(fn => fn.mockReset());
    countsApi.saveLines.mockImplementation(echo);
    emitted = [];
});
afterEach(() => { scope?.stop(); vi.useRealTimers(); });

describe('stock count sheet: blind count', () => {
    it('never carries expected quantities onto the sheet, even if the server sent them', async () => {
        const [line] = await open([serverLine(1, { expected_qty: '99.000', variance_qty: '1.000', unit_cost: '0.500' })]);
        expect(Object.keys(line)).not.toContain('expected_qty');
        expect(JSON.stringify(line)).not.toContain('99');
    });
});

describe('stock count sheet: keyboard', () => {
    it('Enter saves the line and moves to the next uncounted line, Shift+Enter goes back', async () => {
        const lines = await open([serverLine(1), serverLine(2, { qty: '3.000' }), serverLine(3)]);
        lines[0].qty = '5';
        sheet.onQtyEnter({ shiftKey: false, isComposing: false }, lines[0]);
        expect(sheet.highlightId.value).toBe(3);
        expect(countsApi.saveLines).toHaveBeenCalledTimes(1);
        expect(countsApi.saveLines.mock.calls[0][1]).toEqual([{ id: 1, qty: '5.000', unit_label: 'g', unit_factor: '1' }]);

        sheet.onQtyEnter({ shiftKey: true, isComposing: false }, lines[2]);
        expect(sheet.highlightId.value).toBe(2);
    });

    it('stays put and says so when nothing is left to count', async () => {
        const lines = await open([serverLine(1), serverLine(2, { qty: '3.000' })]);
        sheet.onQtyEnter({ shiftKey: false, isComposing: false }, lines[0]);
        expect(sheet.highlightId.value).toBeNull();
        expect(sheet.note.value).toBe('No more items left to count.');
    });

    it('treats 0 as a real count, not as uncounted', async () => {
        const lines = await open([serverLine(1), serverLine(2), serverLine(3)]);
        type(lines[1], '0');
        sheet.onQtyEnter({ shiftKey: false, isComposing: false }, lines[0]);
        expect(sheet.highlightId.value).toBe(3);
        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines.mock.calls.at(-1)[1]).toContainEqual({ id: 2, qty: '0.000', unit_label: 'g', unit_factor: '1' });
    });
});

describe('stock count sheet: saving', () => {
    it('saves changed lines in one batch 700 ms after the last edit', async () => {
        const lines = await open([serverLine(1), serverLine(2)]);
        type(lines[0], '4');
        await vi.advanceTimersByTimeAsync(600);
        type(lines[1], '2,5');
        await vi.advanceTimersByTimeAsync(699);
        expect(countsApi.saveLines).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(countsApi.saveLines).toHaveBeenCalledTimes(1);
        expect(countsApi.saveLines.mock.calls[0][1].map(line => line.qty)).toEqual(['4.000', '2.500']);
        expect(sheet.unsaved.value).toBe(false);
    });

    it('never sends more than 100 lines in one PUT', async () => {
        const lines = await open(Array.from({ length: 250 }, (_, index) => serverLine(index + 1)));
        for (const line of lines) line.qty = '1';
        expect(await sheet.saveAll()).toBe(true);
        expect(countsApi.saveLines.mock.calls.map(call => call[1].length)).toEqual([100, 100, 50]);
        expect(sheet.unsaved.value).toBe(false);
    });

    it('does not send an invalid quantity and keeps the sheet unsaved', async () => {
        const lines = await open([serverLine(1)]);
        type(lines[0], '1.2.3');
        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines).not.toHaveBeenCalled();
        expect(sheet.marker(lines[0])).toBe('invalid');
        expect(sheet.unsaved.value).toBe(true);
    });

    it('keeps a line dirty after a lost reply and retries the very same values', async () => {
        const lines = await open([serverLine(1)]);
        countsApi.saveLines.mockRejectedValueOnce(lostReply());
        type(lines[0], '7');
        await vi.advanceTimersByTimeAsync(700);
        expect(sheet.marker(lines[0])).toBe('error');
        expect(sheet.unsaved.value).toBe(true);
        expect(lines[0].qty).toBe('7');

        await sheet.flush();
        expect(countsApi.saveLines).toHaveBeenCalledTimes(2);
        expect(countsApi.saveLines.mock.calls[1][1]).toEqual(countsApi.saveLines.mock.calls[0][1]);
        expect(sheet.unsaved.value).toBe(false);
        expect(sheet.saveError.value).toBe('');
    });

    it('does not mark a line clean with a value the server never received', async () => {
        const lines = await open([serverLine(1)]);
        let release;
        countsApi.saveLines.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ lines: [{ id: 1, counted_at: 't', counted_by_name: 'Sam' }], counted_count: 1 }); }));
        type(lines[0], '5');
        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines).toHaveBeenCalledTimes(1);

        type(lines[0], '6'); // typed while the first save is on the wire
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(lines[0].saved.qty).toBe('5.000');
        expect(sheet.unsaved.value).toBe(true);

        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines).toHaveBeenCalledTimes(2);
        expect(countsApi.saveLines.mock.calls[1][1][0].qty).toBe('6.000');
        expect(lines[0].saved.qty).toBe('6.000');
        expect(sheet.unsaved.value).toBe(false);
    });

    it('sends a flush requested during a save right after it returns', async () => {
        const lines = await open([serverLine(1), serverLine(2)]);
        let release;
        countsApi.saveLines.mockImplementationOnce(async (id, payload) => { await new Promise(resolve => { release = resolve; }); return echo(id, payload); });
        type(lines[0], '1');
        sheet.flush();
        lines[1].qty = '2';
        sheet.flush(); // Enter on the next line while the first save is still out
        expect(countsApi.saveLines).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(countsApi.saveLines).toHaveBeenCalledTimes(2);
        expect(countsApi.saveLines.mock.calls[1][1].map(line => line.id)).toEqual([2]);
    });

    it('saves a unit change on a counted line and ignores one on an uncounted line', async () => {
        const lines = await open([serverLine(1, { qty: '2.000' }), serverLine(2)]);
        sheet.onUnitChange(lines[0], unitKey({ label: 'box', factor: '500' }));
        sheet.onUnitChange(lines[1], unitKey({ label: 'box', factor: '500' }));
        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines.mock.calls[0][1]).toEqual([{ id: 1, qty: '2.000', unit_label: 'box', unit_factor: '500' }]);
    });

    it('flushes everything before review and refuses to review while a save failed', async () => {
        const lines = await open([serverLine(1)]);
        lines[0].qty = '3';
        countsApi.saveLines.mockRejectedValueOnce(lostReply());
        await sheet.goReview();
        expect(emitted.filter(([name]) => name === 'review')).toHaveLength(0);
        expect(sheet.errorText.value).toBe('Some counted quantities are not saved yet. Retry before reviewing.');
        await sheet.goReview();
        expect(emitted.filter(([name]) => name === 'review')).toHaveLength(1);
    });
});

describe('stock count sheet: Not counted filter', () => {
    it('keeps a row in view after its save succeeds, and drops it when the filter changes', async () => {
        const lines = await open([serverLine(1), serverLine(2)]);
        sheet.filter.value = 'uncounted';
        await nextTick();
        expect(sheet.ordered.value.map(line => line.id)).toEqual([1, 2]);

        type(lines[0], '4');
        await vi.advanceTimersByTimeAsync(700);
        expect(lines[0].saved.qty).toBe('4.000');
        expect(sheet.ordered.value.map(line => line.id)).toEqual([1, 2]);

        // Enter still walks to the next uncounted line.
        sheet.onQtyEnter({ shiftKey: false, isComposing: false }, lines[0]);
        expect(sheet.highlightId.value).toBe(2);

        sheet.filter.value = 'all';
        await nextTick();
        sheet.filter.value = 'uncounted';
        await nextTick();
        expect(sheet.ordered.value.map(line => line.id)).toEqual([2]);
    });
});

describe('stock count sheet: identity', () => {
    it('keeps two same-named categories as separate sections', async () => {
        await open([
            serverLine(1, { group_key: 'category:1', group_label: 'Drinks' }),
            serverLine(2, { group_key: 'category:2', group_label: 'Drinks' }),
            serverLine(3, { group_key: 'category:1', group_label: 'Drinks' }),
        ]);
        expect(sheet.sections.value.map(section => [section.id, section.lines.map(line => line.id)])).toEqual([
            ['category:1', [1, 3]],
            ['category:2', [2]],
        ]);
    });

    it('tells packs with the same label apart at six decimals and sends the server factor as written', async () => {
        const options = [{ label: 'g', factor: '1' }, { label: 'pack', factor: '1.000100' }, { label: 'pack', factor: '1.000400' }];
        const lines = await open([serverLine(1, { qty: '2.000', unit_options: options })]);
        expect(new Set(options.map(unitKey)).size).toBe(3);
        sheet.onUnitChange(lines[0], unitKey(options[1]));
        await vi.advanceTimersByTimeAsync(700);
        sheet.onUnitChange(lines[0], unitKey(options[2]));
        expect(sheet.unsaved.value).toBe(true); // 1.0001 -> 1.0004 is a real change
        await vi.advanceTimersByTimeAsync(700);
        expect(countsApi.saveLines.mock.calls.map(call => call[1][0].unit_factor)).toEqual(['1.000100', '1.000400']);
        expect(sheet.unsaved.value).toBe(false);
    });
});

describe('stock count sheet: add item', () => {
    it('jumps to an item already on the sheet without another request', async () => {
        await open([serverLine(1), serverLine(2)]);
        await sheet.addItem({ item_key: 'stock:2', name: 'Item 2' });
        expect(countsApi.addLine).not.toHaveBeenCalled();
        expect(sheet.highlightId.value).toBe(2);
    });

    it('appends a new line from the server reply', async () => {
        await open([serverLine(1)]);
        countsApi.addLine.mockResolvedValue({ line: serverLine(9), existing: false });
        await sheet.addItem({ item_key: 'stock:9', name: 'Item 9' });
        expect(sheet.lines.value.map(line => line.id)).toEqual([1, 9]);
        expect(sheet.highlightId.value).toBe(9);
    });
});

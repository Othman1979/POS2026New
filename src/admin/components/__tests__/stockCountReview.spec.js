import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onBeforeUnmount: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../counts/countsApi.js', () => ({
    describeError: error => error.message,
    countsApi: { getReview: vi.fn(), getCount: vi.fn(), postCount: vi.fn(), listGroups: vi.fn(), createCount: vi.fn() },
}));
import Review from '../counts/StockCountReview.vue';
import StartPanel from '../counts/StockCountNew.vue';
import { countsApi } from '../counts/countsApi.js';

const lostReply = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const reviewLine = (id, extra = {}) => ({ id, item_key: `stock:${id}`, name: `Item ${id}`, group_label: 'Dairy', base_unit: 'g', counted_base_qty: '10.000', expected_qty: '12.000', variance_qty: '-2.000', unit_cost: '0.500', variance_value: '-1.000', ...extra });
const reviewData = () => ({
    lines: [
        reviewLine(1, { variance_value: '-1.000' }),
        reviewLine(2, { variance_value: '4.500', variance_qty: '9.000' }),
        reviewLine(3, { counted_base_qty: null, variance_qty: null, variance_value: null, expected_qty: '5.000' }),
    ],
    totals: { counted_count: 2, uncounted_count: 1, shortage_value: '-1.000', surplus_value: '4.500', net_value: '3.500' },
});
const postedCount = (extra = {}) => ({ id: 7, reference: 'Monthly', count_date: '2026-09-30', status: 'posted', posted_by_name: 'Sam', lines: reviewData().lines, ...extra });

let scope, review, emitted, confirm;
beforeEach(async () => {
    Object.values(countsApi).forEach(fn => fn.mockReset());
    confirm = vi.fn(async () => true);
    vi.stubGlobal('window', { showAdminConfirm: confirm });
    emitted = [];
    countsApi.getReview.mockResolvedValue(reviewData());
    scope = effectScope();
    review = scope.run(() => Review.setup({ countId: 7, meta: { reference: 'Monthly', count_date: '2026-09-30' }, startPosted: false }, { expose: () => {}, emit: (name, payload) => emitted.push([name, payload]) }));
    await review.load();
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('stock count review', () => {
    it('sorts counted lines by absolute value and keeps uncounted lines apart', () => {
        expect(review.counted.value.map(line => line.id)).toEqual([2, 1]);
        expect(review.uncounted.value.map(line => line.id)).toEqual([3]);
    });

    it('asks with the counts in the confirmation and posts with a request key', async () => {
        countsApi.postCount.mockResolvedValue(postedCount());
        await review.post();
        expect(confirm.mock.calls[0][0]).toBe('Post this count? 2 items will be set to the counted quantity. 1 items were not counted and stay as they are.');
        const [id, key] = countsApi.postCount.mock.calls[0];
        expect(id).toBe(7);
        expect(key).toMatch(/^[0-9a-f-]{36}$/);
        expect(review.posted.value).toBe(true);
        expect(emitted.some(([name]) => name === 'posted')).toBe(true);
    });

    it('counts every counted line in the confirmation, even with no known variance', async () => {
        countsApi.getReview.mockResolvedValue({
            lines: [1, 2, 3].map(id => reviewLine(id, { variance_qty: null, variance_value: null, expected_qty: null })),
            totals: { counted_count: 3, uncounted_count: 0, shortage_value: '0.000', surplus_value: '0.000', net_value: '0.000' },
        });
        await review.load();
        confirm.mockResolvedValue(false);
        await review.post();
        expect(confirm.mock.calls[0][0]).toContain('3 items will be set');
    });

    it('posts nothing when the confirmation is declined', async () => {
        confirm.mockResolvedValue(false);
        await review.post();
        expect(countsApi.postCount).not.toHaveBeenCalled();
    });

    it('reloads the count after a lost reply and reports posted when it was', async () => {
        countsApi.postCount.mockRejectedValueOnce(lostReply());
        countsApi.getCount.mockResolvedValue(postedCount());
        await review.post();
        expect(countsApi.getCount).toHaveBeenCalledWith(7);
        expect(review.posted.value).toBe(true);
        expect(review.pendingPost.value).toBe(false);
        expect(emitted.filter(([name]) => name === 'posted')).toHaveLength(1);
    });

    it('stays frozen after a lost reply on a still-draft count and retries with the same key', async () => {
        countsApi.postCount.mockRejectedValueOnce(lostReply());
        countsApi.getCount.mockResolvedValue(postedCount({ status: 'draft' }));
        await review.post();
        expect(review.posted.value).toBe(false);
        expect(review.pendingPost.value).toBe(true);
        confirm.mockClear();
        confirm.mockResolvedValueOnce(false);
        expect(await review.confirmDiscard()).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);

        countsApi.postCount.mockResolvedValue(postedCount());
        await review.post();
        expect(countsApi.postCount).toHaveBeenCalledTimes(2);
        expect(countsApi.postCount.mock.calls[1][1]).toBe(countsApi.postCount.mock.calls[0][1]);
        expect(review.posted.value).toBe(true);
    });

    it('shows a definite failure without freezing and lets the person try again', async () => {
        countsApi.postCount.mockRejectedValueOnce(Object.assign(new Error('Stock is busy'), { code: 'STOCK_COUNT_BUSY' }));
        await review.post();
        expect(review.errorText.value).toBe('Stock is busy');
        expect(review.pendingPost.value).toBe(false);
        expect(review.posted.value).toBe(false);
    });
});

describe('posted count', () => {
    it('computes the totals from the stored lines with exact decimals', async () => {
        countsApi.getCount.mockResolvedValue(postedCount({ lines: [reviewLine(1, { variance_value: '-0.100' }), reviewLine(2, { variance_value: '-0.200' }), reviewLine(3, { variance_value: '0.300' })] }));
        const posted = scope.run(() => Review.setup({ countId: 7, meta: {}, startPosted: true }, { expose: () => {}, emit: () => {} }));
        await posted.load();
        expect(posted.totals.shortage_value).toBe('-0.300');
        expect(posted.totals.surplus_value).toBe('0.300');
        expect(posted.totals.net_value).toBe('0.000');
        expect(countsApi.getReview).toHaveBeenCalledTimes(1); // only the draft review above
    });
});

describe('open work a settings change must not drop', () => {
    it('reports a post in flight and a count being created as unsaved, and a plain form as not', async () => {
        let exposed;
        let release;
        countsApi.postCount.mockReturnValue(new Promise(resolve => { release = resolve; }));
        countsApi.getCount.mockResolvedValue(postedCount());
        const pane = scope.run(() => Review.setup({ countId: 7, meta: {}, startPosted: false }, { expose: value => { exposed = value; }, emit: () => {} }));
        await pane.load();
        expect(exposed.unsaved.value).toBe(false);
        const posting = pane.post();
        await vi.waitFor(() => expect(exposed.unsaved.value).toBe(true));
        release({ id: 7 });
        await posting;
        expect(exposed.unsaved.value).toBe(false);

        let panelExposed;
        let created;
        countsApi.createCount.mockReturnValue(new Promise(resolve => { created = resolve; }));
        const panel = scope.run(() => StartPanel.setup({}, { expose: value => { panelExposed = value; }, emit: () => {} }));
        panel.reference.value = 'Weekly';
        expect(panelExposed.unsaved.value).toBe(false);
        const starting = panel.start();
        await vi.waitFor(() => expect(panelExposed.unsaved.value).toBe(true));
        created({ id: 4 });
        await starting;
        expect(panelExposed.unsaved.value).toBe(false);
    });
});

describe('new count panel', () => {
    it('offers to open the count that is already open', async () => {
        const created = [];
        const panel = scope.run(() => StartPanel.setup({}, { expose: () => {}, emit: (name, payload) => created.push([name, payload]) }));
        countsApi.createCount.mockRejectedValue(Object.assign(new Error('A stock count is already open.'), { code: 'STOCK_COUNT_ALREADY_OPEN', data: { open_id: 9 } }));
        await panel.start();
        expect(panel.errorText.value).toBe('A stock count is already open.');
        expect(panel.openId.value).toBe(9);
        expect(created).toEqual([]);
    });

    it('sends the chosen groups and a request key, and keeps the key on a plain retry', async () => {
        const panel = scope.run(() => StartPanel.setup({}, { expose: () => {}, emit: () => {} }));
        countsApi.createCount.mockRejectedValueOnce(lostReply()).mockResolvedValue({ id: 3 });
        panel.allItems.value = false;
        panel.picked.value = ['category:12'];
        await Promise.resolve();
        await panel.start();
        await panel.start();
        const [first, second] = countsApi.createCount.mock.calls.map(call => call[0]);
        expect(first).not.toHaveProperty('count_date'); // the backend dates a count on the day it is posted
        expect(first.groups).toEqual(['category:12']);
        expect(second.request_key).toBe(first.request_key);
        expect(first.request_key).toMatch(/^[0-9a-f-]{36}$/);
    });
});

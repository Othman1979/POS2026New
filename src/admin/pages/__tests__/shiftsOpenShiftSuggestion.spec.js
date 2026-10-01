import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../../composables/useBrowserReportPrint.js', () => ({ useBrowserReportPrint: () => ({ printReport: vi.fn(), isPrinting: false }) }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
import { fetchJson } from '@/shared/http.js';
import Shifts from '../Shifts.vue';

let scope, page, checks, posts;
const answerCheck = (index, suggested) => checks[index].resolve({ success: true, suggested_starting_cash: suggested });
const selectCashier = userId => {
    page.openShiftForm.value.user_id = userId;
    return page.refreshOpenShiftSuggestion();
};

beforeEach(() => {
    scope = effectScope();
    checks = [];
    posts = [];
    vi.stubGlobal('window', { showAdminAlert: vi.fn(async () => {}) });
    fetchJson.mockReset();
    fetchJson.mockImplementation((url, options) => {
        if (url.startsWith('api/auth/shifts?action=check')) {
            return new Promise(resolve => { checks.push({ url, resolve }); });
        }
        if (options?.method === 'POST') posts.push(JSON.parse(options.body));
        return Promise.resolve({ success: true, cashiers: [], shifts: [], pagination: {} });
    });
    page = scope.run(() => Shifts.setup());
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('Shifts open-shift cash suggestion', () => {
    it('keeps the second cashier suggestion when the first cashier answers late', async () => {
        const first = selectCashier(4);
        const second = selectCashier(9);
        answerCheck(1, 35);
        await second;
        answerCheck(0, 120);
        await first;
        expect(checks.map(check => check.url)).toEqual(['api/auth/shifts?action=check&user_id=4', 'api/auth/shifts?action=check&user_id=9']);
        expect(page.openShiftForm.value.starting_cash).toBe(35);
    });

    it('discards a stale answer for a cashier who was selected again', async () => {
        const firstA = selectCashier(4);
        const b = selectCashier(9);
        const secondA = selectCashier(4);
        answerCheck(2, 60);
        await secondA;
        answerCheck(0, 999);
        answerCheck(1, 35);
        await Promise.all([firstA, b]);
        expect(page.openShiftForm.value.starting_cash).toBe(60);
    });

    it('discards an answer requested before the modal was reopened', async () => {
        const beforeClose = selectCashier(4);
        const reopen = page.triggerOpenShift();
        expect(page.openShiftForm.value).toEqual({ user_id: '', starting_cash: 0 });
        await reopen;
        answerCheck(0, 999);
        await beforeClose;
        expect(page.openShiftForm.value).toEqual({ user_id: '', starting_cash: 0 });
        const afterReopen = selectCashier(4);
        answerCheck(1, 45);
        await afterReopen;
        expect(page.openShiftForm.value.starting_cash).toBe(45);
    });

    it('keeps cash typed while the suggestion is still loading', async () => {
        const loading = selectCashier(4);
        page.openShiftForm.value.starting_cash = 75;
        page.openShiftCashEdited.value = true;
        answerCheck(0, 120);
        await loading;
        expect(page.openShiftForm.value.starting_cash).toBe(75);
    });

    it('does not submit the reset zero while the suggestion is loading', async () => {
        const loading = selectCashier(4);
        await page.submitOpenShift();
        expect(posts).toEqual([]);
        answerCheck(0, 30);
        await loading;
        await page.submitOpenShift();
        expect(posts).toEqual([{ user_id: 4, starting_cash: 30 }]);
    });

    it('keeps blocking submission when the previous cashier answers while the next is loading', async () => {
        const first = selectCashier(4);
        const second = selectCashier(9);
        answerCheck(0, 120);
        await first;
        await page.submitOpenShift();
        expect(posts).toEqual([]);
        answerCheck(1, 35);
        await second;
        await page.submitOpenShift();
        expect(posts).toEqual([{ user_id: 9, starting_cash: 35 }]);
    });
});

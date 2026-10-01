import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const browserPrint = vi.hoisted(() => vi.fn());
vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../../composables/useBrowserReportPrint.js', () => ({ useBrowserReportPrint: () => ({ printReport: browserPrint, isPrinting: false }) }));
import Shifts from '../Shifts.vue';

const __dirname = dirname(fileURLToPath(import.meta.url));
// See shiftsPage.quality.spec.js: the source-scraping regexes anchor on a blank
// line, which never matches a CRLF checkout of an LF blob.
const SRC = readFileSync(resolve(__dirname, '../Shifts.vue'), 'utf8').replace(/\r\n/g, '\n');

let scope, page, requests, respond;
beforeEach(() => {
  scope = effectScope();
  requests = [];
  respond = () => ({ success: true, shifts: [], pagination: {} });
  browserPrint.mockClear();
  vi.stubGlobal('window', { showAdminConfirm: vi.fn(async () => true), showAdminAlert: vi.fn(async () => {}) });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // A thermal shift print reads the spooler settings here and then POSTs, so it shows in the request list.
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ path: url.split('?')[0], query: new URLSearchParams(url.split('?')[1]), method: options?.method || 'GET' });
    const data = await respond(url, options);
    return { json: async () => data };
  }));
  page = scope.run(() => Shifts.setup());
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

const deferred = () => {
  let resolveIt;
  const promise = new Promise(done => { resolveIt = done; });
  return { promise, resolve: resolveIt };
};
// Lets the fire-and-forget refreshes and any queued watchers finish.
const settle = () => new Promise(done => setTimeout(done, 0));
const requested = () => requests.map(({ method, path }) => `${method} ${path}`);

async function renderShiftDrawer() {
  const app = createSSRApp({ ...Shifts, setup: () => page });
  app.config.globalProperties.$t = key => key;
  const context = {};
  await renderToString(app, context);
  return context.teleports?.body || '';
}
const forceCloseButton = html => html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Force Close Shift<\/button>/)?.[0];

describe('Shifts.vue bug-fixes', () => {
  it('M1: Reset from a later page reloads page one of the shifts and the audit status', async () => {
    page.currentPage.value = 3;

    page.clearAllFilters();
    await settle();

    const shiftPages = requests.filter(({ path }) => path === 'api/admin/shifts').map(({ query }) => query.get('page'));
    expect(new Set(shiftPages)).toEqual(new Set(['1']));
    expect(requested()).toContain('GET api/admin/audit-reports/status');
  });

  it.each([
    ['opening a shift', async () => {
      page.openShiftForm.value = { user_id: 4, starting_cash: 0 };
      await page.submitOpenShift();
    }],
    ['correcting closed-shift cash', async () => {
      page.selectedShift.value = { id: 7, is_active: false, starting_cash: 50, actual_cash: 90 };
      page.newStartingCash.value = 50;
      page.newActualCash.value = 80;
      await page.updateShiftCash();
    }],
  ])('M3: %s refreshes the audit status as well as the shifts', async (_name, mutate) => {
    await mutate();
    await settle();

    expect(requested()).toEqual(expect.arrayContaining(['GET api/admin/shifts', 'GET api/admin/audit-reports/status']));
  });

  it('M2: a slower earlier audit-status response never replaces a newer one', async () => {
    const older = deferred();
    const newer = deferred();
    const pending = [older, newer];
    respond = () => pending.shift().promise;

    const first = page.fetchAuditStatus();
    const second = page.fetchAuditStatus();
    newer.resolve({ success: true, business_date: 'newer' });
    await second;
    older.resolve({ success: true, business_date: 'older' });
    await first;

    expect(page.auditStatus.value.business_date).toBe('newer');
  });

  it('H2: a successful force close closes the drawer and refreshes without printing', async () => {
    page.selectedShift.value = { id: 7, is_active: true, live_expected_cash: 80 };
    page.showModal.value = true;
    page.actualCashInput.value = 75;

    await page.adminForceCloseShift();
    await settle();

    expect(page.showModal.value).toBe(false);
    expect(browserPrint).not.toHaveBeenCalled();
    expect(requested()).toEqual(['PUT api/admin/shifts', 'GET api/admin/shifts', 'GET api/admin/audit-reports/status']);
    expect(window.showAdminAlert).not.toHaveBeenCalled();
  });

  it('M4: force-close Counted Cash starts empty and the button stays disabled until a count is entered', async () => {
    respond = () => ({ success: true, print_payload: { expected_cash: 80, starting_cash: 50 } });
    page.actualCashInput.value = 80;
    await page.openShiftModal({ id: 7, is_active: true, starting_cash: 50, live_expected_cash: 80 });

    expect(page.actualCashInput.value).toBe('');
    const emptyCount = forceCloseButton(await renderShiftDrawer());
    expect(emptyCount).toBeDefined();
    expect(emptyCount).toMatch(/ disabled[ >]/);

    page.actualCashInput.value = 0;
    expect(forceCloseButton(await renderShiftDrawer())).not.toMatch(/ disabled[ >]/);
  });

  it('explains every drawer movement in a wide audit layout', () => {
    expect(SRC).toContain('width-class="max-w-5xl"');
    expect(SRC).toContain("$t('Drawer cash calculation')");
    expect(SRC).toContain("$t('Cash expenses paid from drawer')");
    expect(SRC).toContain("$t('Cash received from sales')");
    expect(SRC).toContain("$t('Cash refunds paid from drawer')");
    expect(SRC).toContain('selectedShift?.gross_cash_sales');
    expect(SRC).toContain('selectedShift?.cash_refunds');
    expect(SRC).toContain('selectedShift?.cash_expenses');
    expect(SRC).toContain('selectedShift?.expense_categories');
    expect(SRC).toContain("$t('Other shift totals')");
    expect(SRC).toContain("$t('Net sales before tax')");
    expect(SRC).toContain("$t('Tax collected after refunds')");
    expect(SRC).toContain('selectedShift?.net_sales_pre_tax');
    expect(SRC).toContain('selectedShift?.tax_collected');
    const openModal = SRC.match(/const openShiftModal = async \(shift\) => \{[\s\S]*?\n        \};/);
    expect(openModal).not.toBeNull();
    expect(openModal[0]).toContain('shift-reports/${shift.id}/print-payload');
    expect(openModal[0]).toContain('shiftDetailsSeq');
    expect(SRC).toContain('isLoadingShiftDetails');
    expect(SRC).toContain('shiftDetailsError');
  });
});

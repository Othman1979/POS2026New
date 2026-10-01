import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';

const split = vi.hoisted(() => ({ tables: null }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => split.tables }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => ({ isProcessing: ref(false), taxInclusivePricing: ref(false) }) }));
import SplitCheckModal from '../SplitCheckModal.vue';

// Half a 2.50 + 16% tax item stays on the Remaining Check and half moved to check 1;
// the session preview allocates the odd cent to the Remaining Check.
async function renderHalvedItem() {
  const half = { cartId: 'tea', name: 'Tea', price: 2.5, qty: 0.5, tax_rate: 16 };
  split.tables = {
    showSplitModal: ref(true), splitSeats: ref([{ id: 1, items: [{ ...half, cartId: 'tea-1' }] }]),
    unassignedSplitItems: ref([half]), activeSplitSeat: ref(1), splitEditContext: ref(null),
    getSeatTotal: () => '1.45', getSplitItemTotal: scope => (scope === 'unassigned' ? 1.46 : 1.44),
  };
  const app = createSSRApp(SplitCheckModal);
  app.config.globalProperties.$t = text => text;
  // Opening the modal remembers the focused element to restore on close.
  vi.stubGlobal('document', { activeElement: null });
  try {
    return await renderToString(app);
  } finally {
    vi.unstubAllGlobals();
  }
}

const modal = readFileSync(resolve(__dirname, '../SplitCheckModal.vue'), 'utf8');
const i18n = JSON.parse(readFileSync(resolve(__dirname, '../../../shared/i18n/ar.json'), 'utf8'));

describe('split check modal interaction contract', () => {
  it('uses one explicit destination and tap-first assignment flow', () => {
    expect(modal).toContain('const activeSeat = computed');
    expect(modal).toContain('Move only what should be paid separately. Everything else stays here.');
    expect(modal).toContain('@click="assignItem(item, index)"');
    expect(modal).toContain('@click="returnItem(item, index)"');
    expect(modal).toContain('@drop="dropOnSeat($event, seat.id)"');
    expect(modal).not.toContain('Division Console');
    expect(modal).not.toContain('startCarouselDrag');
  });

  it('keeps dialog, focus, reduced-motion, and action-state safeguards', () => {
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("event.key !== 'Tab'");
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain('!canFinalize || isProcessing');
    expect(modal).toContain('prefers-reduced-motion:reduce');
  });

  it('presents the source as Remaining Check and shares the quantity control', () => {
    expect(modal).toContain("$t('Remaining Check')");
    expect(modal).toContain('ItemQuantityInput');
    expect(modal).toContain('selectedQuantity');
  });

  it('labels group edits as Save Changes instead of a new split', () => {
    expect(modal).toContain("splitEditContext ? 'Save Changes' : 'Finalize Splits'");
  });

  it('offers a compact remove control only for empty extra checks', () => {
    expect(modal).toContain('removeSplitSeat');
    expect(modal).toContain('splitSeats.length > 1 && seat.items.length === 0');
    expect(modal).toContain("$t('Remove Check')");
    expect(i18n['Remove Check']).toBeTruthy();
  });

  it('prices each split row from the session preview allocation', async () => {
    const html = await renderHalvedItem();
    expect(html).toMatch(/0\.5×<\/span><span[^>]*>1\.46 JD</);
    expect(html).toMatch(/0\.5×<\/span><span[^>]*>1\.44 JD</);
  });

  it('shows a fractional share beside the tax-inclusive price of one whole item', async () => {
    expect(await renderHalvedItem()).toContain('Original price 2.90 JD');
  });

  it('keeps fractional presets inside the compact item row', () => {
    expect(modal).toContain('class="split-line-presets"');
    expect(modal).not.toContain("<span>{{ $t('Split item') }}</span>");
  });

  it('shows a fractional item share beside its original tax-inclusive price', () => {
    expect(modal).toContain('isFractionalSplit(item)');
    expect(modal).toContain("$t('Original price')");
    expect(modal.match(/money\(getSplitItemTotal/g)).toHaveLength(2);
    expect(i18n['Original price']).toBe('السعر الأصلي');
  });

  it('shows enough fractional quantity precision to explain thirds and sixths', () => {
    expect(modal).toContain('number.toFixed(6)');
  });
});

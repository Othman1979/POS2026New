import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSSRApp, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';

const splitStore = vi.hoisted(() => ({ rows: [] }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: {} }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ socket: { value: null }, initSocket: () => null }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => ({ isProcessing: ref(false), isHolding: ref(false) }) }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({ storeName: ref('S'), storeAddress: ref(''), storePhone: ref('') }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({
  tableSplitsList: ref(splitStore.rows), tableSplitsError: ref(''), fetchTableSplits: vi.fn(),
  restoreTableSplit: vi.fn(), cancelSplitGroup: vi.fn(), editSplitGroup: vi.fn(),
}) }));
import TableSplits from '../../TableSplits.vue';

const split = (id, paidSplitCount = 0) => ({ id, parent_invoice_id: 101, reference_name: 'Table 5 - Seat 1', total: 10, cart_data: '{}', paid_split_count: paidSplitCount });
async function renderBoard(rows) {
  splitStore.rows = rows;
  const app = createSSRApp(TableSplits);
  app.config.globalProperties.$t = text => text;
  return renderToString(app);
}

const board = readFileSync(resolve(__dirname, '../../TableSplits.vue'), 'utf8');
const cart = readFileSync(resolve(__dirname, '../PosCartWorkspace.vue'), 'utf8');
const catalog = readFileSync(resolve(__dirname, '../PosCatalogWorkspace.vue'), 'utf8');

describe('table splits board contract', () => {
  it('groups siblings by parent invoice and keeps Remaining Check first', () => {
    expect(board).toContain('`invoice:${split.parent_invoice_id}`');
    expect(board).toContain("left.split_role === 'remainder'");
    expect(board).toContain("return t('Remaining Check')");
    expect(board).toContain("t('Bill Check')");
  });

  it('opens the whole unpaid group for editing', () => {
    expect(board).toContain('editSplitGroup(group)');
    expect(board).toContain("$t('Edit unpaid checks')");
  });

  it('offers Cancel Splits only while no check in the group has been paid', async () => {
    expect(await renderBoard([split(1), split(2)])).toContain('Cancel Splits');
    expect(await renderBoard([split(1), split(2, 1)])).not.toContain('Cancel Splits');
  });

  it('maps legacy neutral colors onto the active POS theme', () => {
    expect(board).toContain('var(--color-on-surface)');
    expect(board).toContain('var(--color-surface-container-low)');
    expect(board).toContain('var(--color-outline-variant)');
  });

  it('shows a retryable fetch error before the empty state', () => {
    expect(board).toContain('tableSplitsError && tableSplitsList.length === 0');
    expect(board).toContain("$t('Split checks could not be loaded')");
    expect(board.indexOf('tableSplitsError &&')).toBeLessThan(board.indexOf('groupedTables.length === 0'));
  });

  it('keeps individual split settlement in a payment-only workspace', () => {
    expect(cart).toContain("v-if=\"activeTable?.is_split\"");
    expect(cart).toContain(':disabled="activeTable?.is_split"');
    expect(catalog).toContain("activeTable?.is_split ? 'opacity-60 pointer-events-none'");
  });
});

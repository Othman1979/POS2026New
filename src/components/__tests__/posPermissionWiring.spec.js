import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('POS permission wiring', () => {
  // The drawer is inline in PosTerminal's template with no component seam to render
  // alone, so its grant wiring stays a template check.
  it('hides drawer actions that the current user cannot perform', () => {
    const terminal = read('src/components/PosTerminal.vue');

    expect(terminal).toContain(`tablesEnabled && can('tables.access')`);
    expect(terminal).toContain(`can('shift.close')`);
    expect(terminal).toContain('v-if="canPrintCheck"');
    expect(terminal).toContain('v-if="serviceChargeEnabled && canApplyServiceCharge"');
    expect(terminal).toContain('v-if="canApplyDiscount"');
  });

  it('keeps held-order access independent from paid-order history', () => {
    const terminal = read('src/components/PosTerminal.vue');
    const orderNotes = read('src/components/OrderNotes.vue');
    const router = read('src/router.js');

    expect(terminal).toContain(`can('pos.hold_orders') || can('orders.view')`);
    expect(router).toContain(`has('pos.hold_orders') || has('orders.view')`);
    expect(orderNotes).toContain(`const canViewHeldOrders = computed(() => can('pos.hold_orders'));`);
    expect(orderNotes).toContain('v-if="canViewHeldOrders && canViewHistory"');
    expect(orderNotes).toContain('const showHistory = ref(canViewHistory.value && !canViewHeldOrders.value);');
    // Actual allowed/denied requests (including programmatic tab changes) are
    // covered by orderNotesReads.spec.js, independent of the loader's syntax.
  });
});

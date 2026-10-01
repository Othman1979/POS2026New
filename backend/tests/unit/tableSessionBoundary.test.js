import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

const loadBoundary = () => import('@/pos/stores/orderSession/tableSession.js');

describe('tableSession boundary', () => {
  it('invalidates stale table owners and clears QR residue on leave', async () => {
    const { createTableSessionBoundary } = await loadBoundary();
    const activeTable = ref({ id: 1 });
    const activeQrDraft = ref([{ id: 9 }]);
    const removed = [];
    const boundary = createTableSessionBoundary({ activeTable, activeQrDraft, storage: { removeItem: (key) => removed.push(key) } });
    const owner = boundary.capture();

    boundary.invalidate();
    expect(boundary.isCurrent(owner)).toBe(false);
    expect(activeQrDraft.value).toBeNull();

    boundary.leave();
    expect(activeTable.value).toBeNull();
    expect(removed).toContain('pos_active_table');
  });

  it('normalizes every active-table identity field used by table and checkout flows', async () => {
    const { normalizeActiveTable } = await loadBoundary();

    expect(normalizeActiveTable({ id: 2, table_number: '7', current_order_id: 8, order_id: 9, waiter_id: 5, is_split: true, parent_invoice_id: 1, parent_order_id: 2, split_check_id: 3, ticket_display_no: 'T4' }, { isDynamic: false })).toMatchObject({
      id: 2, table_number: '7', section_name: '', current_order_id: 8, order_id: 9, waiter_id: 5,
      is_split: true, parent_invoice_id: 1, parent_order_id: 2, split_check_id: 3, ticket_display_no: 'T4',
      order_display_no: '9',
    });
  });
});

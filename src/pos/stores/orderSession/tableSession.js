import { ref } from 'vue';
import { writeActiveTable } from './orderSessionPersistence.js';

export const createTableSessionBoundary = ({ activeTable, activeQrDraft, storage = localStorage }) => {
  const tableSessionSeq = ref(0);
  const clearTableScopedResidue = () => { activeQrDraft.value = null; };
  const invalidate = () => {
    tableSessionSeq.value += 1;
    clearTableScopedResidue();
  };
  const capture = () => ({ seq: tableSessionSeq.value, tableId: activeTable.value?.id ?? null });
  const isCurrent = ({ seq, tableId }) => seq === tableSessionSeq.value && String(activeTable.value?.id ?? '') === String(tableId ?? '');
  const leave = () => {
    invalidate();
    activeTable.value = null;
    writeActiveTable(storage, null);
  };
  return { tableSessionSeq, capture, isCurrent, clearTableScopedResidue, invalidate, leave };
};

export const normalizeActiveTable = (table, { isDynamic = false } = {}) => ({
  id: table.id || null,
  table_number: table.table_number,
  section_name: table.section_name || (isDynamic ? 'Dynamic' : ''),
  status: table.status || 'available',
  current_order_id: table.current_order_id || null,
  version: table.version ?? null,
  waiter_id: table.waiter_id ?? null,
  parent_table_id: table.parent_table_id || null,
  seating_parent_id: table.seating_parent_id || null,
  original_table_number: table.original_table_number || null,
  is_split: table.is_split || false,
  parent_invoice_id: table.parent_invoice_id || null,
  parent_order_id: table.parent_order_id || null,
  split_check_id: table.split_check_id || null,
  split_revision: Number(table.split_revision || 1),
  ...(table.is_split ? {
    tax_inclusive_at_sale: table.tax_inclusive_at_sale ?? null,
    receipt_tax_inclusive_at_sale: table.receipt_tax_inclusive_at_sale ?? null,
    tax_exempt_at_sale: table.tax_exempt_at_sale ?? null,
    tax_registration_type_at_sale: table.tax_registration_type_at_sale ?? null,
  } : {}),
  order_id: table.order_id || null,
  order_type_id: table.order_type_id ?? null,
  invoice_number: table.invoice_number ?? null,
  invoice_display_no: table.invoice_display_no ?? null,
  order_display_no: table.order_display_no ?? (table.order_id == null ? null : String(table.order_id)),
  ticket_display_no: table.ticket_display_no ?? null,
  table_display_no: table.table_display_no ?? null,
  order_taken_at: table.order_taken_at ?? table.created_at ?? table.active_order_created_at ?? null,
  active_order_created_at: table.active_order_created_at ?? table.order_taken_at ?? table.created_at ?? null,
});

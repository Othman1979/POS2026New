const VALID_TAX_MODES = new Set(['exclusive', 'inclusive', 'legacy_unknown']);
const VALID_STATUSES = new Set(['original', 'voided', 'partially_refunded', 'fully_refunded']);
const TAX_EXEMPT_LABEL = '(معفي من الضريبة)';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cents = value => Math.round((finite(value) + Number.EPSILON) * 100);
const money = value => cents(value) / 100;
const dateText = value => value instanceof Date && !Number.isNaN(value.getTime())
  ? value.toISOString()
  : String(value || '');
const fail = message => {
  const error = new Error(`Invalid receipt presentation: ${message}`);
  error.code = 'RECEIPT_PRESENTATION_INVALID';
  error.reason = message;
  throw error;
};

function modifierSelections(source = {}) {
  let selections = source.selectedModifiers ?? source.selected_modifiers ?? null;
  if (typeof selections === 'string') {
    try { selections = JSON.parse(selections); }
    catch { selections = null; }
  }
  return Array.isArray(selections)
    ? selections.slice(0, 50).filter(selection => selection && typeof selection === 'object' && !Array.isArray(selection))
    : [];
}

function isNoteProductSelection(selection) {
  if (Number.isSafeInteger(Number(selection.noteProductId)) && Number(selection.noteProductId) > 0) return true;
  if (selection.gid || selection.oid) return false;
  const group = String(selection.group ?? selection.group_name ?? '').trim();
  const option = String(selection.option ?? selection.option_name ?? selection.name ?? '').trim();
  return group && group === option && Number(selection.price) > 0;
}

function modifierDisplayLine(selection) {
  const option = String(selection.option ?? selection.option_name ?? selection.name ?? '').trim();
  if (!option) return '';
  const price = Number(selection.price);
  const priced = Number.isFinite(price) && price > 0;
  if (isNoteProductSelection(selection)) {
    return priced ? `${option} (+${price.toFixed(2)})` : option;
  }
  const group = String(selection.group ?? selection.group_name ?? '').trim();
  const label = group ? `${group}: ${option}` : option;
  return priced ? `${label} (${price.toFixed(2)} JD)` : label;
}

function generatedLineVariants(selection) {
  const canonical = modifierDisplayLine(selection);
  if (!canonical) return [];
  const option = String(selection.option ?? selection.option_name ?? selection.name ?? '').trim();
  const price = Number(selection.price);
  if (isNoteProductSelection(selection) && Number.isFinite(price) && price > 0) {
    return [canonical, `${option} (+${price.toFixed(2)} JD)`];
  }
  return [canonical];
}

function receiptItemNote(source = {}) {
  if (source.note === 'Auto-Gratuity') return '';
  const selections = modifierSelections(source);
  if (selections.length === 0) return String(source.note ?? '');
  const manual = String(source.note ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const selection of [...selections].reverse()) {
    for (const variant of generatedLineVariants(selection)) {
      const index = manual.lastIndexOf(variant);
      if (index >= 0) {
        manual.splice(index, 1);
        break;
      }
    }
  }
  return [...manual, ...selections.map(modifierDisplayLine).filter(Boolean)].join('\n');
}

function normalizeLine(source = {}, index = 0) {
  const kind = source.kind === 'bundle_child' || source.parent_item_id != null
    ? 'bundle_child'
    : 'item';
  const rawQty = source.qty ?? source.quantity;
  const rawUnitPrice = source.unitPrice ?? source.price ?? source.price_at_sale;
  if (!Number.isFinite(Number(rawQty)) || !Number.isFinite(Number(rawUnitPrice))) fail(`non-finite row at index ${index}`);
  const qty = Number(rawQty);
  const unitPrice = Number(rawUnitPrice);
  const discountType = source.discountType ?? source.discount_type ?? null;
  const rawDiscountValue = source.discountValue ?? source.discount_value ?? 0;
  if (!Number.isFinite(Number(rawDiscountValue))) fail(`non-finite discount at index ${index}`);
  const discountValue = Number(rawDiscountValue);
  if (qty <= 0 || unitPrice < 0 || discountValue < 0) fail(`invalid row money at index ${index}`);
  if (discountValue > 0 && !['fixed', 'percent'].includes(discountType)) fail(`invalid discount type at index ${index}`);
  if (discountType === 'percent' && discountValue > 100) fail(`invalid discount percent at index ${index}`);
  const extendedRaw = kind === 'bundle_child' ? 0 : unitPrice * qty;
  let discountRaw = 0;
  if (discountType === 'fixed') discountRaw = discountValue * qty;
  if (discountType === 'percent') discountRaw = extendedRaw * (discountValue / 100);
  const netRaw = Math.max(0, extendedRaw - discountRaw);
  return {
    key: String(source.key ?? source.cartId ?? `row-${index}`),
    kind,
    name: String(source.name ?? source.product_name ?? source.item_name ?? 'Unknown Item'),
    // Auto-Gratuity is the internal service-charge identity marker, not a customer note.
    note: receiptItemNote(source),
    qty,
    unitPrice: money(unitPrice),
    extendedPrice: money(extendedRaw),
    lineDiscountAmount: money(Math.min(extendedRaw, Math.max(0, discountRaw))),
    lineDiscountLabel: discountValue > 0
      ? (discountType === 'percent' ? `${discountValue}%` : `${money(discountValue).toFixed(2)} x ${qty}`)
      : null,
    netRaw,
    netAmount: kind === 'bundle_child' ? 0 : money(netRaw),
    _index: index
  };
}

function apportionRows(rows, subtotal, toleranceCents = 0) {
  const financial = rows.filter(row => row.kind === 'item');
  const rawTotal = financial.reduce((sum, row) => sum + row.netRaw, 0);
  const rawDelta = cents(subtotal) - cents(rawTotal);
  if (Math.abs(rawDelta) > toleranceCents) fail('subtotal does not match receipt rows');
  let delta = cents(subtotal) - financial.reduce((sum, row) => sum + cents(row.netRaw), 0);
  const ordered = [...financial].sort((a, b) => {
    const aFraction = a.netRaw * 100 - Math.floor(a.netRaw * 100);
    const bFraction = b.netRaw * 100 - Math.floor(b.netRaw * 100);
    return delta >= 0
      ? (bFraction - aFraction || a._index - b._index)
      : (aFraction - bFraction || a._index - b._index);
  });
  for (let cursor = 0; delta !== 0; cursor += 1) {
    if (cursor > ordered.length * 2) fail('row-cent residue is not reconcilable');
    const row = ordered[cursor % ordered.length];
    const next = cents(row.netAmount) + Math.sign(delta);
    if (next < 0) continue;
    row.netAmount = next / 100;
    delta -= Math.sign(delta);
  }
  return rows.map(({ netRaw, _index, ...row }) => row);
}

function buildReceiptPresentation(input = {}) {
  const taxMode = input.taxMode || 'legacy_unknown';
  const status = input.status || 'original';
  if (!VALID_TAX_MODES.has(taxMode)) fail('unknown tax mode');
  if (!VALID_STATUSES.has(status)) fail('unknown receipt status');
  if (input.taxExempt !== undefined && typeof input.taxExempt !== 'boolean') fail('tax exemption must be boolean');
  const taxExempt = input.taxExempt === true;
  if (![input.summary?.subtotal, input.summary?.tax, input.summary?.total, input.orderDiscount?.amount]
    .every(value => Number.isFinite(Number(value)))) fail('non-finite summary');
  const orderDiscountType = input.orderDiscount?.type ?? null;
  const orderDiscountValue = Number(input.orderDiscount?.value ?? 0);
  if (!Number.isFinite(orderDiscountValue) || orderDiscountValue < 0 ||
      (orderDiscountValue > 0 && !['fixed', 'percent'].includes(orderDiscountType)) ||
      (orderDiscountType === 'percent' && orderDiscountValue > 100)) fail('invalid order discount');
  const rawSubtotal = Number(input.summary.subtotal);
  const rawTaxAmount = Number(input.summary.tax);
  const rawTotal = Number(input.summary.total);
  const rawOrderDiscountAmount = Number(input.orderDiscount.amount);
  if (rawSubtotal < 0 || rawTaxAmount < 0 || rawTotal < 0 ||
      rawOrderDiscountAmount < 0 || rawOrderDiscountAmount > rawSubtotal) {
    fail('negative or impossible summary money');
  }
  if (taxExempt && rawTaxAmount !== 0) fail('tax-exempt receipt tax must be zero');
  const subtotal = money(rawSubtotal);
  const taxAmount = taxExempt ? 0 : money(rawTaxAmount);
  const total = money(rawTotal);
  const orderDiscountAmount = money(rawOrderDiscountAmount);
  const subtotalAllocationToleranceCents = input.subtotalAllocationToleranceCents ?? 0;
  if (!Number.isSafeInteger(subtotalAllocationToleranceCents) || subtotalAllocationToleranceCents < 0) {
    fail('invalid subtotal allocation tolerance');
  }
  const rows = apportionRows(
    (input.items || []).map(normalizeLine),
    subtotal,
    subtotalAllocationToleranceCents
  );
  const roundingAdjustment = (
    cents(total) - cents(subtotal) + cents(orderDiscountAmount) - cents(taxAmount)
  ) / 100;
  if (Math.abs(cents(roundingAdjustment)) > 2) fail('summary rounding residue is not reconcilable');
  const model = {
    version: 1,
    currency: 'JD',
    decimals: 2,
    taxMode,
    status,
    ...(taxExempt ? { taxExempt: true } : {}),
    rows,
    summary: {
      subtotal,
      orderDiscountAmount,
      orderDiscountLabel: orderDiscountType === 'percent'
        ? `${orderDiscountValue}%`
        : null,
      taxAmount,
      taxLabel: taxExempt ? TAX_EXEMPT_LABEL : (taxMode === 'inclusive' ? 'Included in prices' : null),
      roundingAdjustment: money(roundingAdjustment),
      total
    },
    ...(input.billing ? { billing: {
      terms: input.billing.terms,
      issuedOn: dateText(input.billing.issuedOn),
      dueOn: dateText(input.billing.dueOn),
      invoiceTotal: money(input.billing.invoiceTotal),
      collectedAmount: money(input.billing.collectedAmount),
      outstandingAmount: money(input.billing.outstandingAmount)
    } } : {})
  };
  validateReceiptPresentation(model);
  return model;
}

function validateReceiptPresentation(model) {
  if (!model || model.version !== 1 || !Array.isArray(model.rows) || !model.summary) fail('shape');
  if (model.currency !== 'JD' || model.decimals !== 2 ||
      !VALID_TAX_MODES.has(model.taxMode) || !VALID_STATUSES.has(model.status)) fail('metadata');
  if (model.taxExempt !== undefined && typeof model.taxExempt !== 'boolean') fail('tax exemption');
  const { subtotal, orderDiscountAmount, taxAmount, roundingAdjustment, total } = model.summary;
  // Real number types required: Number.isFinite(Number('10')) would accept numeric
  // strings that every renderer then crashes on (subtotal.toFixed is not a function).
  if (![subtotal, orderDiscountAmount, taxAmount, roundingAdjustment, total]
    .every(value => typeof value === 'number' && Number.isFinite(value))) fail('summary money');
  if (subtotal < 0 || orderDiscountAmount < 0 || orderDiscountAmount > subtotal || taxAmount < 0 || total < 0) fail('summary money');
  if ((model.summary.orderDiscountLabel != null && typeof model.summary.orderDiscountLabel !== 'string') ||
      (model.summary.taxLabel != null && typeof model.summary.taxLabel !== 'string')) fail('summary text');
  if (model.taxExempt === true && (taxAmount !== 0 || model.summary.taxLabel !== TAX_EXEMPT_LABEL)) fail('tax-exempt summary');
  if (Math.abs(cents(roundingAdjustment)) > 2) fail('summary rounding residue');
  const keys = new Set();
  for (const row of model.rows) {
    if (!row || typeof row.key !== 'string' || row.key.length === 0 ||
        !['item', 'bundle_child'].includes(row.kind) || !Number.isFinite(row.netAmount) || row.netAmount < 0 ||
        !Number.isFinite(row.qty) || row.qty <= 0 || !Number.isFinite(row.unitPrice) || row.unitPrice < 0 ||
        !Number.isFinite(row.extendedPrice) || row.extendedPrice < 0 ||
        !Number.isFinite(row.lineDiscountAmount) || row.lineDiscountAmount < 0) fail('row');
    if (typeof row.name !== 'string' ||
        (row.note != null && typeof row.note !== 'string') ||
        (row.lineDiscountLabel != null && typeof row.lineDiscountLabel !== 'string')) fail('row text');
    if (row.lineDiscountAmount > row.extendedPrice) fail('row discount');
    if (row.lineDiscountAmount > 0 && !row.lineDiscountLabel) fail('row discount');
    if (row.kind === 'bundle_child' && (row.lineDiscountAmount !== 0 || row.lineDiscountLabel != null)) fail('bundle child discount');
    if (row.kind === 'bundle_child' && row.netAmount !== 0) fail('bundle child money');
    if (keys.has(row.key)) fail('duplicate row key');
    keys.add(row.key);
  }
  const financialCents = model.rows
    .filter(row => row.kind === 'item')
    .reduce((sum, row) => sum + cents(row.netAmount), 0);
  if (financialCents !== cents(model.summary.subtotal)) fail('row sum');
  const foot = cents(model.summary.subtotal)
    - cents(model.summary.orderDiscountAmount)
    + cents(model.summary.taxAmount)
    + cents(model.summary.roundingAdjustment);
  if (foot !== cents(model.summary.total)) fail('summary footing');
  if (model.billing !== undefined) {
    const billing = model.billing;
    if (!billing || billing.terms !== 'receivable' || typeof billing.issuedOn !== 'string' || !billing.issuedOn ||
        typeof billing.dueOn !== 'string' || !billing.dueOn ||
        ![billing.invoiceTotal, billing.collectedAmount, billing.outstandingAmount]
          .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail('billing');
    if (cents(billing.invoiceTotal) !== cents(model.summary.total) ||
        cents(billing.collectedAmount) > cents(billing.invoiceTotal) ||
        cents(billing.outstandingAmount) !== cents(billing.invoiceTotal) - cents(billing.collectedAmount)) fail('billing money');
  }
  return true;
}

function normalizeStoredTaxMode(value) {
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  return null;
}

function receiptTaxMode({ stored, tax }) {
  const normalized = normalizeStoredTaxMode(stored);
  if (normalized === true) return 'inclusive';
  if (normalized === false) return 'exclusive';
  return Number(tax || 0) > 0 ? 'exclusive' : 'legacy_unknown';
}

module.exports = {
  buildReceiptPresentation,
  validateReceiptPresentation,
  normalizeStoredTaxMode,
  receiptTaxMode
};

const { escapeHtml } = require('./report-html');

const VALID_TAX_MODES = new Set(['exclusive', 'inclusive', 'legacy_unknown']);
const VALID_STATUSES = new Set(['original', 'voided', 'partially_refunded', 'fully_refunded']);
const TAX_EXEMPT_LABEL = '(معفي من الضريبة)';
const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);

const fail = message => {
  const error = new Error(`Invalid receipt presentation: ${message}`);
  error.code = 'RECEIPT_PRESENTATION_INVALID';
  error.reason = message;
  throw error;
};

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
  if (financialCents !== cents(subtotal)) fail('row sum');
  const foot = cents(subtotal)
    - cents(orderDiscountAmount)
    + cents(taxAmount)
    + cents(roundingAdjustment);
  if (foot !== cents(total)) fail('summary footing');
  if (model.billing !== undefined) {
    const billing = model.billing;
    if (!billing || billing.terms !== 'receivable' || typeof billing.issuedOn !== 'string' || !billing.issuedOn ||
        typeof billing.dueOn !== 'string' || !billing.dueOn ||
        ![billing.invoiceTotal, billing.collectedAmount, billing.outstandingAmount]
          .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail('billing');
    if (cents(billing.invoiceTotal) !== cents(total) || cents(billing.collectedAmount) > cents(billing.invoiceTotal) ||
        cents(billing.outstandingAmount) !== cents(billing.invoiceTotal) - cents(billing.collectedAmount)) fail('billing money');
  }
  return true;
}

function renderReceiptItems(model) {
  validateReceiptPresentation(model);
  let html = `<div class="item-header"><div class="col-qty">Qty</div><div class="col-name">Item</div><div class="col-total">Total</div></div><div class="solid-line"></div>`;
  for (const row of model.rows) {
    const qtyText = Number.isInteger(row.qty) ? String(row.qty) : row.qty.toFixed(2);
    const escapedName = escapeHtml(row.name);
    const displayNote = row.note === 'Auto-Gratuity' ? '' : row.note;
    
    if (row.kind === 'bundle_child') {
      html += `<div class="item-row" style="opacity: 0.8;"><div class="col-qty"></div><div class="col-name text-lg" style="padding-left: 16px;">&bull; ${escapedName} x${qtyText}</div><div class="col-total"></div></div>`;
      if (displayNote) {
        const escapedNote = displayNote.split('\n').filter(Boolean).map(line => `- ${escapeHtml(line.trim())}`).join('\n');
        html += `<div class="item-note" style="padding-left: 16px;">${escapedNote}</div>`;
      }
    } else {
      html += `<div class="item-row"><div class="col-qty">${qtyText}x</div><div class="col-name">${escapedName}</div><div class="col-total">${row.netAmount.toFixed(2)} JD</div></div>`;
      if (displayNote) {
        const escapedNote = displayNote.split('\n').filter(Boolean).map(line => `- ${escapeHtml(line.trim())}`).join('\n');
        html += `<div class="item-note">${escapedNote}</div>`;
      }
      if (row.lineDiscountAmount > 0) {
        const discountLabel = row.lineDiscountLabel || 'Discount';
        html += `<div class="item-note">${escapeHtml(discountLabel)} Off (-${row.lineDiscountAmount.toFixed(2)} JD)</div>`;
      }
    }
  }
  html += `<div class="dashed-line"></div>`;
  return html;
}

function renderReceiptSummary(model) {
  validateReceiptPresentation(model);
  const { subtotal, taxAmount, orderDiscountAmount, roundingAdjustment, total } = model.summary;
  let html = '';

  if (model.taxMode !== 'inclusive') {
    html += `<div class="text-lr font-bold"><span class="font-normal">Subtotal</span><span>${subtotal.toFixed(2)} JD</span></div>`;
    if (model.summary.taxLabel) {
      html += `<div class="text-lr font-bold"><span class="font-normal">Tax</span><span>${escapeHtml(model.summary.taxLabel)}</span></div>`;
    } else {
      html += `<div class="text-lr font-bold"><span class="font-normal">Tax</span><span>${taxAmount.toFixed(2)} JD</span></div>`;
    }
  }
  
  if (orderDiscountAmount > 0) {
    const discLabel = model.summary.orderDiscountLabel ? `Discount (${model.summary.orderDiscountLabel})` : 'Discount';
    html += `<div class="text-lr font-bold"><span class="font-normal">${escapeHtml(discLabel)}</span><span>-${orderDiscountAmount.toFixed(2)} JD</span></div>`;
  }
  
  if (roundingAdjustment !== 0) {
    html += `<div class="text-lr font-bold"><span class="font-normal">Rounding</span><span>${roundingAdjustment > 0 ? '+' : ''}${roundingAdjustment.toFixed(2)} JD</span></div>`;
  }
  
  html += `<div class="total-box"><span class="tracking-widest uppercase">Total</span><span>${total.toFixed(2)} JD</span></div>`;
  if (model.billing?.terms === 'receivable') {
    html += `<div class="text-lr font-bold"><span class="font-normal">Payment</span><span>RECEIVABLE</span></div>`;
    html += `<div class="text-lr font-bold"><span class="font-normal">Issued</span><span>${escapeHtml(model.billing.issuedOn)}</span></div>`;
    html += `<div class="text-lr font-bold"><span class="font-normal">Due date</span><span>${escapeHtml(model.billing.dueOn)}</span></div>`;
    html += `<div class="text-lr font-bold"><span class="font-normal">Collected</span><span>${model.billing.collectedAmount.toFixed(2)} JD</span></div>`;
    html += `<div class="text-lr font-bold"><span class="font-normal">Outstanding</span><span>${model.billing.outstandingAmount.toFixed(2)} JD</span></div>`;
  }
  return html;
}

module.exports = {
  validateReceiptPresentation,
  escapeHtml,
  renderReceiptItems,
  renderReceiptSummary
};

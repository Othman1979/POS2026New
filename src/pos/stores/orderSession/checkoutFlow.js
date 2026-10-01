import { buildReceiptPresentation, validateReceiptPresentation } from '@/utils/receiptPresentation.js';
import { exemptUnitPrice } from '@/utils/posTotals.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const moneyCents = value => Math.round(((Number(value) || 0) + Number.EPSILON) * 100);

export const buildCallCenterCommandPolicy = ({ editing = false, kitchenFired = false } = {}) => {
  if (!editing) return ['send_as_held'];
  return kitchenFired
    ? ['save_changes', 'send_follow_up', 'cancel_edits', 'cancel_order']
    : ['save_changes', 'cancel_edits', 'cancel_order'];
};

export const buildCheckoutFingerprintSource = ({
  user, shiftId, cart, table, editingInvoiceId, editingOrderId, orderTypeId, orderTypeDeferred, customer, totals,
  orderDiscount, hashNumber, serviceChargeSnapshot, payment, taxExempt = false,
  heldOrderContext = null,
}) => ({
  actorId: user?.id || null,
  shiftId: shiftId || null,
  cart: cart.map((item) => ({
    id: item.id ?? null,
    product_id: item.product_id ?? null,
    name: item.name ?? item.item_name ?? '',
    qty: Number(item.qty ?? item.quantity ?? 0),
    price: Number(item.price ?? item.price_at_sale ?? 0),
    tax_rate: Number(item.tax_rate ?? 0),
    jofotara_tax_category: item.jofotara_tax_category ?? null,
    discountType: item.discountType ?? item.discount_type ?? null,
    discountValue: Number(item.discountValue ?? item.discount_value ?? 0),
    note: item.note ?? '',
    course_id: item.course_id ?? null,
    bundleItems: Array.isArray(item.bundleItems) ? item.bundleItems.map((sub) => ({
      id: sub.id ?? sub.product_id ?? null,
      name: sub.name ?? sub.item_name ?? '',
      qty: Number(sub.qty ?? sub.quantity ?? 0),
      note: sub.note ?? '',
    })) : [],
  })),
  subtotal: totals.subtotal,
  tax: totals.tax,
  total: totals.total,
  taxExempt: taxExempt === true,
  orderDiscount: { type: orderDiscount?.type || null, value: Number(orderDiscount?.value || 0) },
  orderNote: customer.note || '',
  activeTableId: table?.id || null,
  activeTableOrderId: table?.current_order_id || null,
  splitCheckId: table?.split_check_id || null,
  splitRevision: table?.is_split ? Number(table.split_revision || 1) : null,
  parentInvoiceId: table?.parent_invoice_id || null,
  editingInvoiceId: editingInvoiceId || null,
  editingOrderId: editingOrderId || null,
  orderTypeId: orderTypeId || null,
  orderTypeDeferred: orderTypeDeferred === true,
  customerPhone: customer.phone || '',
  customerName: customer.name || '',
  customerAddress: customer.address || '',
  deliveryDate: customer.deliveryDate || '',
  hashNumber: hashNumber || '',
  serviceChargeSnapshot: serviceChargeSnapshot ? {
    id: serviceChargeSnapshot.id,
    version: serviceChargeSnapshot.version,
    claimToken: serviceChargeSnapshot.claimToken || null,
  } : null,
  payment: {
    method: payment.method || null,
    amountTendered: Number(payment.amountTendered || 0),
    splitCardAmount: Number(payment.splitCardAmount || 0),
    splitCashTendered: Number(payment.splitCashTendered || 0),
  },
  heldOrderContext: heldOrderContext ? {
    id: heldOrderContext.id,
    version: heldOrderContext.version,
    claimToken: heldOrderContext.claimToken || null,
  } : null,
});

export const buildCheckoutRequest = (input) => {
  const cartSnapshot = clone(input.cart);
  const tableSnapshot = input.table ? { ...input.table } : null;
  const discountSnapshot = { ...input.orderDiscount };
  const customer = { ...input.customer };
  const totals = { ...input.totals };
  const splitPayment = input.payment.method === 'split';
  const receivablePayment = input.payment.method === 'receivable';
  const platformPayment = input.payment.method === 'platform';
  const noTenderPayment = receivablePayment || platformPayment;
  const totalCents = moneyCents(totals.total);
  const cardCents = input.payment.method === 'card'
    ? totalCents
    : (splitPayment ? moneyCents(input.payment.splitCardAmount) : 0);
  const cashCents = input.payment.method === 'cash'
    ? totalCents
    : (splitPayment ? totalCents - cardCents : 0);
  const splitCashTenderedCents = splitPayment ? moneyCents(input.payment.splitCashTendered) : 0;
  const cardAmount = cardCents / 100;
  const cashAmount = cashCents / 100;
  const amountTendered = noTenderPayment
    ? 0
    : splitPayment
    ? (cardCents + splitCashTenderedCents) / 100
    : (input.payment.method === 'cash' ? input.payment.amountTendered : totals.total);
  const changeDue = noTenderPayment
    ? 0
    : splitPayment
    ? Math.max(0, splitCashTenderedCents - cashCents) / 100
    : input.payment.changeDue;
  const payload = {
    user_id: input.user.id,
    shift_id: input.shiftId,
    table_id: tableSnapshot?.id || null,
    edit_invoice_id: tableSnapshot?.current_order_id || input.editingInvoiceId,
    edit_order_id: tableSnapshot?.order_id || input.editingOrderId,
    order_type_id: input.orderTypeId || null,
    order_type_is_deferred_settlement: input.orderTypeDeferred === true,
    hash_number: input.requiresHash ? input.hashNumber : null,
    customer_phone: customer.phone,
    customer_name: customer.name,
    customer_address: customer.address,
    delivery_date: customer.deliveryDate || null,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    payment_method: input.payment.method,
    amount_tendered: amountTendered,
    change_due: changeDue,
    cash_amount: cashAmount,
    card_amount: cardAmount,
    order_note: customer.note,
    order_discount_type: discountSnapshot.type,
    order_discount_value: discountSnapshot.value,
    tax_exempt: input.taxExempt === true,
    cart: cartSnapshot,
    service_charge_snapshot: input.serviceChargeSnapshot ? {
      id: input.serviceChargeSnapshot.id,
      version: input.serviceChargeSnapshot.version,
      ...(input.serviceChargeSnapshot.claimToken ? { claim_token: input.serviceChargeSnapshot.claimToken } : {}),
    } : null,
    idempotency_key: input.idempotencyKey,
    void_reason: null,
  };
  if (input.heldOrderContext?.id) {
    payload.held_order_context = {
      id: input.heldOrderContext.id,
      claim_token: input.heldOrderContext.claimToken,
      expected_version: input.heldOrderContext.version,
      operation_id: input.idempotencyKey,
    };
  }
  if (typeof input.managerPin === 'string' && input.managerPin.trim()) {
    payload.manager_pin = input.managerPin;
  }
  if (tableSnapshot?.is_split) Object.assign(payload, {
    is_split: true,
    parent_invoice_id: tableSnapshot.parent_invoice_id,
    parent_order_id: tableSnapshot.parent_order_id,
    split_check_id: tableSnapshot.split_check_id,
    split_revision: tableSnapshot.split_revision || 1,
  });
  const frozenPayload = { ...payload };
  delete frozenPayload.manager_pin;
  return {
    payload,
    frozen: {
      cartSnapshot,
      tableSnapshot,
      tableOwner: input.tableOwner,
      discountSnapshot,
      customer,
      cashier: { name: input.user.name, role: input.user.role },
      orderTypeName: input.orderTypeName || '',
      taxInclusive: input.taxInclusive,
      taxRegistrationType: input.taxRegistrationType,
      totals,
      taxExempt: input.taxExempt === true,
      payload: frozenPayload,
    },
  };
};

export const buildSuccessfulCheckoutResult = ({ response, frozen, now = new Date() }) => {
  const orderTakenAt = response.order_taken_at || response.created_at || frozen.tableSnapshot?.order_taken_at || frozen.tableSnapshot?.active_order_created_at || now.toISOString();
  let receiptDisplay = response.receipt_display_v1 || null;
  let receiptDisplayError = null;
  try {
    if (receiptDisplay) validateReceiptPresentation(receiptDisplay);
    else receiptDisplay = buildReceiptPresentation({
      items: frozen.cartSnapshot.map((item, index) => ({
        ...item,
        ...(frozen.taxExempt ? { price: exemptUnitPrice(item, item.tax_rate, frozen.taxInclusive) } : {}),
        key: String(item.key ?? item.cartId ?? `row-${index}`)
      })),
      summary: {
        subtotal: response.subtotal ?? frozen.totals.subtotal,
        tax: response.tax ?? frozen.totals.tax,
        total: response.total ?? frozen.totals.total,
      },
      orderDiscount: {
        type: frozen.discountSnapshot.type || null,
        value: Number(frozen.discountSnapshot.value || 0),
        amount: response.discount ?? frozen.totals.discount,
      },
      taxMode: frozen.taxInclusive ? 'inclusive' : 'exclusive',
      status: 'original',
      taxExempt: frozen.taxExempt === true,
    });
  } catch (error) {
    receiptDisplay = null;
    receiptDisplayError = error.code || 'RECEIPT_PRESENTATION_INVALID';
  }
  const payload = frozen.payload;
  return {
    wasTableOrder: !!payload.table_id,
    lastOrder: {
      invoice_id: response.invoice_id || response.order_id,
      order_id: response.order_id,
      invoice_number: response.invoice_number ?? null,
      invoice_display_no: response.invoice_display_no ?? null,
      order_display_no: response.order_display_no ?? (response.order_id == null ? null : String(response.order_id)),
      ticket_display_no: response.ticket_display_no ?? null,
      order_taken_at: orderTakenAt,
      date: orderTakenAt,
      cashier: frozen.cashier.name,
      payment_method: response.payment_method ?? payload.payment_method,
      order_type_name: frozen.orderTypeName,
      customer_name: frozen.customer.name,
      customer_phone: frozen.customer.phone,
      customer_address: frozen.customer.address,
      delivery_date: frozen.customer.deliveryDate,
      order_note: frozen.customer.note,
      items: clone(frozen.cartSnapshot),
      subtotal: response.subtotal ?? frozen.totals.subtotal,
      discount: response.discount ?? frozen.totals.discount,
      tax: response.tax ?? frozen.totals.tax,
      total: response.total ?? frozen.totals.total,
      amount_tendered: response.amount_tendered ?? payload.amount_tendered,
      change_due: response.change_due ?? payload.change_due,
      cash_amount: response.cash_amount ?? payload.cash_amount,
      card_amount: response.card_amount ?? payload.card_amount,
      hash_number: payload.hash_number,
      tax_registration_type_at_sale: response.tax_registration_type_at_sale || frozen.taxRegistrationType || 'sales_tax',
      tax_exempt: frozen.taxExempt === true,
      table_number: frozen.tableSnapshot?.table_number || null,
      receipt_display_v1: receiptDisplay,
      ...(receiptDisplayError ? { receipt_display_error: receiptDisplayError } : {}),
    },
  };
};

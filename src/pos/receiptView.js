import { computed } from 'vue';
import { formatBusinessDateTime, formatBusinessTimeShort } from '@/utils/businessDate.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { orderIdentityValue } from '@/utils/orderIdentityDisplay.js';
import { receiptItemDisplayTotal } from '@/utils/receiptLineTotals.js';
import { isArabic } from '@/utils/orderNotesFormat.js';
import { resolveReceiptPresentation } from '@/utils/receiptPresentation.js';
import { serviceChargeDisplayName } from '@/utils/serviceChargeDisplay.js';
import { resolveReceiptTaxNumber } from '@/utils/receiptTaxNumber.js';
import { t } from '@/shared/i18n.js';

// What the receipt shows for terminal.lastOrder, shared by the always-mounted
// browser print layout and the lazy screen preview.
export function useReceiptView() {
  const {
    lastOrder, receiptConfig, storeName, storeAddress, storePhone,
    salesTaxNumber, incomeTaxNumber, useInvoiceNoOnly,
  } = useTerminal();

  const presentationState = computed(() => resolveReceiptPresentation(lastOrder.value));
  const taxNumber = computed(() => resolveReceiptTaxNumber(lastOrder.value, {
    tax_registration_type: lastOrder.value?.tax_registration_type_at_sale,
    jofotara_sales_tax_seller_tax_number: salesTaxNumber.value,
    jofotara_income_tax_seller_tax_number: incomeTaxNumber.value
  }));

  const receiptIdentityKey = (order, preferOrder = false) => {
    if (preferOrder && order?.order_id) return 'Order:';
    if (order?.invoice_display_no) return 'Invoice:';
    if (order?.ticket_display_no) return 'Ticket:';
    if (order?.table_display_no) return 'Table:';
    if (order?.order_id) return 'Order:';
    return 'Identity';
  };

  const receiptIdentityValue = (order, preferOrder = false) => {
    if (preferOrder && order?.order_id) return order.order_display_no || order.order_id;
    return orderIdentityValue(order);
  };

  return {
    lastOrder,
    receiptConfig,
    storeName,
    storeAddress,
    storePhone,
    taxNumber,
    useInvoiceNoOnly,
    receiptItemDisplayTotal,
    serviceChargeDisplayName,
    t,
    isArabic,
    orderIdentityValue,
    receiptIdentityKey,
    receiptIdentityValue,
    receiptTakenTime: order => formatBusinessTimeShort(order?.order_taken_at || order?.date),
    formatBusinessDateTime,
    presentation: computed(() => presentationState.value.presentation),
    presentationError: computed(() => presentationState.value.error),
  };
}

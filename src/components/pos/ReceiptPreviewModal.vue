<template>
  <!-- Receipt Preview Modal -->
  <transition name="pos-modal">
  <div v-if="showReceiptModal"
    class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/90 p-4">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-preview-title" tabindex="-1" class="modal-panel bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col border border-outline-variant/30 max-h-[90vh]">
      <div class="bg-surface-container-low border-b border-outline-variant/30 px-5 sm:px-6 py-4 flex justify-between items-center no-print shrink-0">
        <h3 id="receipt-preview-title" class="font-headline font-bold text-on-surface text-sm sm:text-base tracking-tight">{{ $t('Receipt Preview') }}</h3>
        <button type="button" :aria-label="$t('Close')" @click="closeReceiptModal"
          class="text-on-surface-variant hover:text-error transition-colors w-8 h-8 flex items-center justify-center bg-surface-container-lowest rounded-full shadow-sm border border-outline-variant/30">
          <i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
        </button>
      </div>
      <div class="p-4 sm:p-6 bg-surface overflow-y-auto premium-scroll flex flex-col items-center w-full">
        <div v-if="presentationError" class="text-center font-bold text-error border-2 border-error p-3 mb-4 rounded-xl w-full max-w-[320px] bg-rose-50 text-xs leading-normal font-sans">
          <i class="fa-solid fa-triangle-exclamation text-lg mb-1 block"></i>
          {{ $t('Receipt layout is invalid or missing required financial parameters.') }}
          <div class="text-[9px] mt-1 opacity-70 font-mono">{{ presentationError }}</div>
        </div>
        <div class="bg-white p-4 sm:p-5 shadow-sm w-full max-w-[320px] font-mono text-[10px] sm:text-[11px] font-bold text-black leading-tight border-2 border-outline-variant/30"
          v-if="lastOrder && !presentationError">
          <div v-if="lastOrder.provisional && !lastOrder.guest_check" class="text-center font-black text-[9px] sm:text-[10px] border-2 border-black py-1.5 mb-2 uppercase tracking-widest">
            &#9654; PROVISIONAL — totals confirmed at sync &#9654;
          </div>
          <div v-if="lastOrder.guest_check" class="text-center font-black">{{ $t('Guest check — not paid') }}</div>
          <template v-for="block in (receiptConfig?.layout || ['header', 'meta', 'customer', 'items', 'totals', 'payment', 'footer'])" :key="block">
            <div v-if="block === 'header'" class="mb-4">
              <div :class="['text-center font-black text-base sm:text-lg mb-1 uppercase tracking-widest', { 'font-arabic': isArabic(storeName) }]" data-no-i18n>{{ storeName }}</div>
              <div :class="['text-center text-[9px] sm:text-[10px]', { 'font-arabic': isArabic(storeAddress) }]" data-no-i18n>{{ storeAddress }}</div>
              <div class="text-center text-[9px] sm:text-[10px] mb-1" data-no-i18n>{{ storePhone }}</div>
              <div class="border-b-2 border-dashed border-black mt-2"></div>
            </div>
            <div v-if="block === 'meta'" class="mb-4 font-bold text-[11px] sm:text-xs">
              <div class="flex justify-between items-end mb-1">
                <span v-if="!useInvoiceNoOnly" class="font-black text-xs sm:text-sm uppercase">
                  {{ $t(receiptIdentityKey(lastOrder, true)) }} #<span data-no-i18n>{{ receiptIdentityValue(lastOrder, true) }}</span>
                </span>
                <span v-else class="font-black text-xs sm:text-sm uppercase">
                  {{ $t(receiptIdentityKey(lastOrder)) }} #<span data-no-i18n>{{ receiptIdentityValue(lastOrder) }}</span>
                </span>
                <span class="font-bold text-[9px] sm:text-[10px]" data-no-i18n>{{ receiptTakenTime(lastOrder) }}</span>
              </div>
              <div v-if="!useInvoiceNoOnly" class="flex justify-between mb-1.5 text-[9px] sm:text-[10px] text-gray-600">
                <span>{{ $t(receiptIdentityKey(lastOrder)) }} <span data-no-i18n>{{ receiptIdentityValue(lastOrder) }}</span></span>
              </div>
              <div class="flex justify-between mt-1">
                <span :class="['font-normal', { 'font-arabic': isArabic(lastOrder.cashier) }]">{{ $t('Cashier:') }} <span data-no-i18n>{{ lastOrder.cashier }}</span></span>
                <span :class="['font-normal', { 'font-arabic': isArabic(lastOrder.order_type_name) }]" data-no-i18n>{{ lastOrder.order_type_name }}</span>
              </div>
              <div v-if="taxNumber" class="mt-1 font-normal">{{ $t('Seller tax number') }}: <span data-no-i18n>{{ taxNumber }}</span></div>
              <div v-if="lastOrder.table_number && !lastOrder.table_display_no" class="flex justify-between mt-1">
                <span class="font-normal">{{ $t('Table') }}</span>
                <span class="font-black" data-no-i18n>#{{ lastOrder.table_number }}</span>
              </div>
              <div class="border-b-2 border-dashed border-black mt-2 w-full"></div>
            </div>
            <div v-if="block === 'customer' && lastOrder.customer_name" class="mb-4 font-bold text-[9px] sm:text-[10px]">
              <div :class="['mb-0.5', { 'font-arabic': isArabic(lastOrder.customer_name) }]">{{ $t('Customer:') }} <span data-no-i18n>{{ lastOrder.customer_name }}</span></div>
              <div v-if="lastOrder.customer_phone" class="mb-0.5">{{ $t('Phone:') }} <span data-no-i18n>{{ lastOrder.customer_phone }}</span></div>
              <div v-if="lastOrder.customer_address" :class="[{ 'font-arabic': isArabic(lastOrder.customer_address) }]">{{ $t('Address:') }} <span data-no-i18n>{{ lastOrder.customer_address }}</span></div>
              <div class="border-b-2 border-dashed border-black mt-2 w-full"></div>
            </div>
            <div v-if="block === 'items'" class="mb-4">
              <div class="flex justify-between font-black mb-1 text-[11px] sm:text-xs">
                <span class="w-5 sm:w-6 shrink-0">Qty</span><span class="flex-1 px-1">Item</span><span class="shrink-0 text-end">Total</span>
              </div>
              <div class="border-b-2 border-black mb-2"></div>
              <div v-for="item in presentation.rows" :key="item.key" class="mb-2">
                <div v-if="item.kind === 'item'" class="flex justify-between items-start leading-tight font-black text-[11px] sm:text-xs">
                  <span class="w-5 sm:w-6 shrink-0">{{ item.qty }}x</span>
                  <span :class="['flex-1 px-1', { 'font-arabic': isArabic(serviceChargeDisplayName(item, t)) }]" data-no-i18n>{{ serviceChargeDisplayName(item, t) }}</span>
                  <span class="shrink-0 text-end">{{ item.netAmount.toFixed(2) }} JD</span>
                </div>
                <div v-if="item.kind === 'item' && item.lineDiscountLabel" class="pl-6 sm:pl-7 text-error text-[9px] sm:text-[10px] font-bold">
                  {{ item.lineDiscountLabel }} Off (-{{ item.lineDiscountAmount.toFixed(2) }} JD)
                </div>
                <div v-if="item.kind === 'bundle_child'" class="flex justify-between items-start leading-tight font-bold text-[10px] sm:text-[11px] text-gray-700 pl-4 sm:pl-5">
                  <span class="flex-1 px-1" data-no-i18n>&bull; {{ item.name }} &times; {{ item.qty }}</span>
                </div>
                <div v-if="item.note && item.note !== 'Auto-Gratuity'" class="pl-6 sm:pl-7 italic text-gray-700 text-[9px] sm:text-[10px] mt-0.5 font-bold">
                  <span :class="[{ 'font-arabic': isArabic(item.note) }]" data-no-i18n>- {{ item.note }}</span>
                </div>
              </div>
              <div class="border-b-2 border-dashed border-black mt-2"></div>
            </div>
            <div v-if="block === 'totals'" class="mb-4 font-bold text-[11px] sm:text-xs">
              <div v-if="presentation.taxMode !== 'inclusive'" class="flex justify-between mb-0.5"><span class="font-normal">Subtotal</span><span>{{ presentation.summary.subtotal.toFixed(2) }} JD</span></div>
              <div v-if="presentation.summary.orderDiscountAmount > 0" class="flex justify-between mb-0.5"><span class="font-normal">Discount<template v-if="presentation.summary.orderDiscountLabel"> (<span data-no-i18n>{{ presentation.summary.orderDiscountLabel }}</span>)</template></span><span>-{{ presentation.summary.orderDiscountAmount.toFixed(2) }} JD</span></div>
              <div v-if="presentation.taxMode !== 'inclusive'" class="flex justify-between mb-1">
                <span class="font-normal">Tax</span>
                <span v-if="presentation.summary.taxLabel" class="italic text-[10px]">{{ $t(presentation.summary.taxLabel) }}</span>
                <span v-else>{{ presentation.summary.taxAmount.toFixed(2) }} JD</span>
              </div>
              <div v-if="Math.abs(presentation.summary.roundingAdjustment) > 0" class="flex justify-between mb-1"><span class="font-normal">Rounding</span><span>{{ presentation.summary.roundingAdjustment.toFixed(2) }} JD</span></div>
              <div class="bg-black text-white p-2.5 flex justify-between font-black text-xs sm:text-sm my-2 uppercase tracking-widest">
                <span>TOTAL</span><span>{{ presentation.summary.total.toFixed(2) }} JD</span>
              </div>
            </div>
            <div v-if="block === 'payment'" class="mb-4 font-bold text-[9px] sm:text-[10px]">
              <template v-if="lastOrder.payment_method === 'split'">
                <div class="flex justify-between mb-0.5"><span class="font-normal">{{ $t('Cash') }}</span><span>{{ Number(lastOrder.cash_amount || 0).toFixed(2) }} JD</span></div>
                <div class="flex justify-between mb-0.5"><span class="font-normal">{{ $t('Card') }}</span><span>{{ Number(lastOrder.card_amount || 0).toFixed(2) }} JD</span></div>
                <div v-if="Number(lastOrder.change_due || 0) > 0" class="flex justify-between"><span class="font-normal">Change</span><span>{{ Number(lastOrder.change_due).toFixed(2) }} JD</span></div>
              </template>
              <template v-if="lastOrder.payment_method === 'platform' || lastOrder.payment_method === 'receivable'">
                <div>{{ $t('No payment was collected.') }}</div>
              </template>
              <template v-if="!['split', 'platform', 'receivable'].includes(lastOrder.payment_method)">
                <div class="flex justify-between mb-0.5"><span class="font-normal">Payment</span><span class="uppercase">{{ lastOrder.payment_method }}</span></div>
                <div class="flex justify-between mb-0.5"><span class="font-normal">Tendered</span><span>{{ parseFloat(lastOrder.amount_tendered || 0).toFixed(2) }} JD</span></div>
                <div class="flex justify-between"><span class="font-normal">Change</span><span>{{ parseFloat(lastOrder.change_due || 0).toFixed(2) }} JD</span></div>
              </template>
              <div class="border-b-2 border-dashed border-black mt-2 w-full"></div>
            </div>
            <div v-if="block === 'footer'" class="text-center font-bold text-[9px] sm:text-[10px] mt-4 whitespace-pre-line">
              <span v-if="receiptConfig.customFooterText" :class="[{ 'font-arabic': isArabic(receiptConfig.customFooterText) }]" data-no-i18n>{{ receiptConfig.customFooterText }}</span>
              <span v-else>{{ $t('Thank you for your visit!') }}</span>
            </div>
          </template>
        </div>
      </div>
      <div class="modal-footer modal-actions p-4 sm:p-5 border-t border-outline-variant/20 bg-surface-container-low flex gap-2 sm:gap-3 no-print shrink-0">
        <button @click="closeReceiptModal"
          class="modal-action btn-3d flex-1 py-3 sm:py-3.5 bg-surface border border-outline-variant/40 text-on-surface font-bold rounded-xl hover:bg-surface-container-low transition-colors text-[11px] sm:text-xs uppercase tracking-widest shadow-sm"
          style="--shadow-color: #cbd5e1;">New Order</button>
        <button @click="printReceipt" :disabled="isPrintingBackend || !!presentationError"
          class="modal-action modal-action--primary btn-3d flex-1 py-3 sm:py-3.5 action-gradient text-on-primary font-black rounded-xl shadow-md hover:opacity-90 transition-opacity flex justify-center items-center gap-2 text-[11px] sm:text-xs uppercase tracking-widest disabled:opacity-50"
          style="--shadow-color: #2b4b71;">
          <i v-if="isPrintingBackend" class="fa-solid fa-circle-notch fa-spin"></i>
          <i v-else class="fa-solid fa-print"></i> Print Receipt
        </button>
      </div>
    </div>
  </div>
  </transition>

</template>

<script>
import { ref } from 'vue';
import { useTerminal } from '@/pos/useTerminal.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';
import { useReceiptView } from '@/pos/receiptView.js';

// Screen preview of the last receipt (dormant since 16da3cb9; lazy). The browser
// print layout lives in ReceiptPrintLayout, which the terminal always mounts.
export default {
  setup() {
    const { showReceiptModal, closeReceiptModal, printReceipt, isPrintingBackend } = useTerminal();
    const view = useReceiptView();
    const dialog = ref(null);
    usePosDialogFocus({ open: showReceiptModal, dialog, onEscape: closeReceiptModal });

    const handlePrintReceipt = async () => {
      if (view.presentationError.value) return;
      await printReceipt();
    };

    return {
      ...view,
      showReceiptModal,
      closeReceiptModal,
      printReceipt: handlePrintReceipt,
      isPrintingBackend,
      dialog,
    };
  }
}
</script>

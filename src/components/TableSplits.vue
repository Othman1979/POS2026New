<template>
  <div class="h-screen w-screen overflow-hidden bg-surface font-sans no-select text-on-surface flex flex-col">
    <!-- Header -->
    <header class="min-h-16 bg-surface-container-lowest border-b border-outline-variant/30 px-4 py-2 flex flex-wrap gap-2 items-center justify-between shrink-0 z-30 shadow-sm">
      <div class="flex items-center gap-3">
        <button @click="goBack" class="flex min-h-11 min-w-11 items-center justify-center bg-white hover:bg-gray-50 text-gray-700 rounded-md border border-gray-300 transition-colors shadow-sm focus:outline-none">
          <i class="fa-solid fa-arrow-left text-xs rtl:rotate-180"></i>
        </button>
        <div>
          <h1 class="text-xs font-black uppercase tracking-wider text-gray-900 flex items-center gap-2">
            <i class="fa-solid fa-arrows-split-up-and-left text-teal-600"></i>
            <span>{{ $t('Table Splits Board') }}</span>
          </h1>
          <p class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mt-0.5">{{ $t('Manage and recover unpaid seat check splits') }}</p>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex flex-wrap min-w-0 items-center gap-2">
        <button v-if="parentInvoiceId !== null" type="button" @click="showAllSplits"
          class="min-h-11 px-3 rounded-md border border-gray-300 text-xs font-bold">
          {{ $t('All') }}
        </button>
        <div class="relative w-48 sm:w-60">
          <i class="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 transform -translate-y-1/2 text-gray-500 text-[9px]"></i>
          <input type="text" v-model="searchQuery" :placeholder="$t('Search by Table or Seat...')"
            class="w-full bg-gray-50 text-[10px] font-bold text-gray-800 rounded-md border border-gray-200 focus:border-teal-500 focus:bg-white focus:ring-0 transition-all outline-none py-1.5 pl-7 pr-4 shadow-inner" />
          <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-rose-500 focus:outline-none">
            <i class="fa-solid fa-circle-xmark text-[9px]"></i>
          </button>
        </div>
        <button @click="refreshSplits" :disabled="isLoading"
          class="flex min-h-11 items-center gap-1.5 px-3 bg-white hover:bg-gray-50 text-gray-700 font-bold rounded-md border border-gray-300 text-[9px] uppercase transition-colors focus:outline-none shadow-sm">
          <i class="fa-solid fa-rotate text-[9px]" :class="{ 'fa-spin': isLoading }"></i>
          <span>{{ $t('Refresh') }}</span>
        </button>
      </div>
    </header>

    <!-- Main Content Grid -->
    <main class="flex-1 overflow-y-auto bg-surface-container-low p-4 min-w-0">
      <!-- Loading State -->
      <div v-if="isLoading && tableSplitsList.length === 0" class="h-64 flex flex-col items-center justify-center text-gray-400">
        <i class="fa-solid fa-circle-notch fa-spin text-2xl mb-2 text-teal-600"></i>
        <p class="text-[9px] font-black uppercase tracking-widest">{{ $t('Loading Splits...') }}</p>
      </div>

      <!-- Retryable error state must win over the empty state. -->
      <div v-else-if="tableSplitsError && tableSplitsList.length === 0" class="h-96 flex flex-col items-center justify-center text-error text-center">
        <i class="fa-solid fa-triangle-exclamation text-3xl mb-3" aria-hidden="true"></i>
        <h3 class="text-sm font-black">{{ $t('Split checks could not be loaded') }}</h3>
        <p class="mt-1 max-w-sm text-xs text-on-surface-variant">{{ $t(tableSplitsError) }}</p>
        <button type="button" class="mt-4 min-h-11 rounded-lg bg-primary px-5 text-xs font-black text-on-primary" @click="refreshSplits">
          {{ $t('Retry') }}
        </button>
      </div>

      <!-- Empty State -->
      <div v-else-if="groupedTables.length === 0" class="h-96 flex flex-col items-center justify-center text-gray-400">
        <i class="fa-solid fa-circle-check text-5xl mb-4 text-emerald-600/30 animate-pulse"></i>
        <h3 class="text-sm font-black uppercase tracking-widest text-gray-800">{{ $t('No Unpaid Splits!') }}</h3>
        <p class="text-xs text-gray-500 mt-1">{{ $t('All seat check splits have been paid or merged.') }}</p>
      </div>

      <!-- Grouped Table Cards list (High-Density Grid) -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        <div v-for="group in groupedTables" :key="group.key"
          class="flex flex-col bg-surface-container-lowest rounded-xl border border-outline-variant/30 shadow-sm overflow-hidden transition-shadow duration-200 hover:shadow-md h-fit">
          <div class="h-1 w-full bg-primary"></div>

          <!-- Table Header -->
          <div class="px-3.5 py-2 border-b border-outline-variant/30 bg-surface-container-low flex justify-between items-center select-none">
            <span class="text-[10px] font-bold text-gray-800 uppercase tracking-widest flex items-center gap-1.5">
              <i class="fa-solid fa-utensils text-teal-600 text-[10px]"></i>
              {{ $t('Table') }} {{ group.tableNumber }}
            </span>
            <div class="flex items-center gap-1.5">
              <span class="bg-teal-50 border border-teal-200 text-teal-700 px-1.5 py-0.5 rounded-full text-[8px] font-black font-mono">
                {{ group.splits.length }} {{ $t('Checks') }}
              </span>
              <button v-if="!group.hasPaidChildren" @click="cancelGroup(group)" class="min-h-11 px-2 rounded border border-rose-200 bg-white text-[9px] font-black uppercase text-rose-600 hover:bg-rose-50" :title="$t('Cancel unpaid split group')">
                <i class="fa-solid fa-xmark me-1"></i>{{ $t('Cancel Splits') }}
              </button>
              <button @click="editGroup(group)" class="min-h-11 px-2 rounded border border-teal-200 bg-white text-[9px] font-black uppercase text-teal-700 hover:bg-teal-50" :title="$t('Edit unpaid checks')">
                <i class="fa-solid fa-pen me-1"></i>{{ $t('Edit') }}
              </button>
            </div>
          </div>

          <!-- Splits Inner Stack (No Gap, Touching Rows) -->
          <div class="flex-1 divide-y divide-gray-100">
            <div v-for="check in group.splits" :key="check.id" @click="openPreview(check)"
              class="p-3 hover:bg-teal-50/10 cursor-pointer transition-colors flex flex-col justify-between"
              :class="check.receipt_display_error ? 'bg-rose-50/20 border-s-2 border-s-rose-500' : ''">
              
              <div class="flex justify-between items-start gap-1">
                <div class="min-w-0">
                  <h3 class="text-[10px] font-bold text-gray-900 uppercase tracking-wider truncate">{{ checkLabel(check) }}</h3>
                  <p class="text-[8px] text-gray-400 font-mono mt-0.5">{{ formatTimeOnly(check.created_at) }}</p>
                </div>
                <span class="text-[10px] font-black font-mono text-teal-600 bg-teal-50 border border-teal-100 px-1.5 py-0.5 rounded shrink-0" :class="{ 'text-rose-700 bg-rose-50 border-rose-100': check.receipt_display_error }" data-no-i18n>
                  {{ check.receipt_display_v1 ? check.receipt_display_v1.summary.total.toFixed(2) : Number(check.subtotal).toFixed(2) }} JD
                </span>
              </div>

              <!-- Cart items summary (Denser) -->
              <div class="space-y-0.5 my-1.5 border-t border-dashed border-gray-100 pt-1.5 text-[8px] font-bold text-gray-500">
                <template v-if="check.receipt_display_v1">
                  <div v-for="row in check.receipt_display_v1.rows.slice(0, 2)" :key="row.key" class="flex justify-between">
                    <span class="truncate pr-1.5" :class="{ 'font-arabic': isArabic(row.name), 'text-gray-400 ps-1': row.kind === 'bundle_child' }" data-no-i18n>
                      <template v-if="row.kind !== 'bundle_child'">{{ row.qty }}x </template>{{ row.name }}
                    </span>
                    <span class="font-mono text-gray-600 shrink-0" data-no-i18n>
                      <template v-if="row.kind !== 'bundle_child'">{{ row.netAmount.toFixed(2) }} JD</template>
                    </span>
                  </div>
                  <div v-if="check.receipt_display_v1.rows.length > 2" class="text-[7px] text-teal-600 font-black italic">
                    + {{ check.receipt_display_v1.rows.length - 2 }} more items
                  </div>
                  <!-- Same cent the receipt shows, so the lines visibly add up to the card total. -->
                  <div v-if="check.receipt_display_v1.summary.roundingAdjustment !== 0" class="flex justify-between text-gray-400">
                    <span>{{ $t('Rounding') }}</span>
                    <span class="font-mono shrink-0" data-no-i18n>{{ check.receipt_display_v1.summary.roundingAdjustment > 0 ? '+' : '' }}{{ check.receipt_display_v1.summary.roundingAdjustment.toFixed(2) }} JD</span>
                  </div>
                </template>
                <template v-else>
                  <div v-for="item in check.items.slice(0, 2)" :key="item.cartId" class="flex justify-between">
                    <span class="truncate pr-1.5" :class="{ 'font-arabic': isArabic(item.name) }" data-no-i18n>{{ item.qty }}x {{ item.name }}</span>
                    <span class="font-mono text-gray-600 shrink-0" data-no-i18n>{{ (item.qty * item.price).toFixed(2) }} JD</span>
                  </div>
                  <div v-if="check.items.length > 2" class="text-[7px] text-teal-600 font-black italic">
                    + {{ check.items.length - 2 }} more items
                  </div>
                </template>
              </div>

              <!-- Payment actions stay large enough for a busy touch terminal. -->
              <div class="flex gap-1.5 border-t border-gray-100 pt-2 mt-0.5 shrink-0 select-none">
                <button @click.stop="printCheckBill(check)" :disabled="isPrinting || !!check.receipt_display_error"
                  class="flex-1 min-h-11 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-600 font-bold rounded transition-colors text-[9px] uppercase tracking-wider flex items-center justify-center gap-1 focus:outline-none disabled:opacity-30 disabled:cursor-not-allowed">
                  <i class="fa-solid fa-print text-[9px]"></i>
                  <span>{{ $t('Print') }}</span>
                </button>
                <button @click.stop="payCheck(check)" :disabled="isProcessing || isHolding || !!check.receipt_display_error"
                  class="flex-1 min-h-11 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-600/30 disabled:cursor-not-allowed text-white font-semibold rounded transition-all text-[9px] uppercase tracking-wider flex items-center justify-center gap-1 focus:outline-none shadow-sm">
                  <i class="fa-solid fa-file-invoice-dollar text-[9px]"></i>
                  <span>{{ $t('Pay') }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Receipt Preview Drawer (Glassmorphic Dialog) -->
    <div v-if="showPreviewModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 animate-fade-in">
      <div ref="previewDialog" role="dialog" aria-modal="true" aria-labelledby="split-preview-title" tabindex="-1" class="bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] animate-scale-in">
        <div class="px-5 py-3.5 border-b border-outline-variant/30 bg-surface-container-low flex items-center justify-between select-none">
          <div class="flex items-center gap-2 text-gray-800">
            <i class="fa-solid fa-receipt text-teal-600 text-sm"></i>
            <h3 id="split-preview-title" class="font-bold text-xs uppercase tracking-wider">{{ $t('Split Check Preview') }}</h3>
          </div>
          <button @click="showPreviewModal = false" :aria-label="$t('Close')" class="text-gray-400 hover:text-gray-700 transition-colors focus:outline-none">
            <i class="fa-solid fa-xmark text-sm"></i>
          </button>
        </div>

        <div v-if="selectedCheck" class="p-6 overflow-y-auto premium-scroll flex-1 text-xs">
          <!-- Store Header -->
          <div class="text-center mb-5">
            <h4 class="font-black text-xs uppercase tracking-wide text-gray-900" data-no-i18n>{{ storeName }}</h4>
            <p class="text-[9px] text-gray-500 mt-0.5" data-no-i18n>{{ storeAddress }}</p>
            <p class="text-[9px] text-gray-500" data-no-i18n>{{ storePhone }}</p>
          </div>

          <!-- Metadata -->
          <div class="border-t border-b border-dashed border-gray-200 py-2.5 mb-4 space-y-1 font-semibold text-gray-600">
            <div class="flex justify-between">
              <span>{{ $t('Table') }}:</span>
              <span class="text-gray-900" data-no-i18n>#{{ selectedCheck.tableNumber }}</span>
            </div>
            <div class="flex justify-between">
              <span>{{ $t('Bill Check') }}:</span>
              <span class="text-gray-900">{{ checkLabel(selectedCheck) }}</span>
            </div>
            <div v-if="selectedCheck.parent_invoice_display_no || selectedCheck.parent_ticket_display_no || selectedCheck.parent_table_display_no || selectedCheck.parent_order_display_no || selectedCheck.parent_order_id" class="flex justify-between">
              <span>{{ selectedCheck.parent_invoice_display_no ? $t('Parent Invoice') : (selectedCheck.parent_table_display_no ? $t('Table') : $t('Parent Ticket')) }}:</span>
              <span class="text-gray-900 font-mono" data-no-i18n>#{{ selectedCheck.parent_invoice_display_no || selectedCheck.parent_ticket_display_no || selectedCheck.parent_table_display_no || selectedCheck.parent_order_display_no || selectedCheck.parent_order_id }}</span>
            </div>
            <div class="flex justify-between">
              <span>{{ $t('Cashier') }}:</span>
              <span class="text-gray-900" data-no-i18n>{{ selectedCheck.cashier_name }}</span>
            </div>
            <div class="flex justify-between">
              <span>{{ $t('Date') }}:</span>
              <span class="text-gray-900" data-no-i18n>{{ formatDateTime(selectedCheck.created_at) }}</span>
            </div>
          </div>

          <!-- Error block -->
          <div v-if="selectedPresentation.error" class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-800 mb-4 flex items-start gap-2.5">
            <i class="fa-solid fa-triangle-exclamation text-xs mt-0.5 shrink-0"></i>
            <div class="leading-normal">
              <div class="font-bold text-[11px] uppercase tracking-wide">{{ $t('Receipt Data Invalid') }}</div>
              <div class="text-[10px] opacity-90 mt-0.5">
                {{ $t('The layout integrity checks failed for this split check. It cannot be previewed, printed, or recovered.') }}
              </div>
            </div>
          </div>

          <!-- Historical warning box -->
          <div v-if="selectedCheck.receipt_display_legacy_reason === 'PRE_V1_CENT_MISMATCH' && !selectedPresentation.error" class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 mb-4 flex items-start gap-2.5">
            <i class="fa-solid fa-clock-rotate-left text-xs mt-0.5 shrink-0"></i>
            <div class="leading-normal">
              <div class="font-bold text-[11px] uppercase tracking-wide">{{ $t('Historical Format') }}</div>
              <div class="text-[10px] opacity-90 mt-0.5">
                {{ $t('This order split was generated prior to the modern receipt layout. It is displayed using historical approximations.') }}
              </div>
            </div>
          </div>

          <!-- Items Table (gated on !error) -->
          <div v-if="!selectedPresentation.error && selectedPresentation.presentation" class="mb-5">
            <table class="w-full border-collapse">
              <thead>
                <tr class="text-[9px] uppercase tracking-widest text-gray-500 border-b border-gray-200 pb-1.5">
                  <th class="text-start font-bold pb-1.5">{{ $t('Item') }}</th>
                  <th class="text-center font-bold w-10 pb-1.5">{{ $t('Qty') }}</th>
                  <th class="text-end font-bold w-16 pb-1.5">{{ $t('Price') }}</th>
                  <th class="text-end font-bold w-16 pb-1.5">{{ $t('Total') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 font-semibold text-gray-800">
                <tr v-for="item in selectedPresentation.presentation.rows" :key="item.key">
                  <td class="py-2">
                    <span v-if="item.kind === 'bundle_child'" class="text-gray-400 text-[10px] ps-2 block" data-no-i18n>- {{ item.name }}</span>
                    <span v-else :class="[{ 'font-arabic': isArabic(item.name) }]" data-no-i18n>{{ item.name }}</span>
                    <span v-if="item.note" class="block text-[9px] text-rose-500 font-bold italic" data-no-i18n>- {{ item.note }}</span>
                    <span v-if="item.lineDiscountAmount > 0 && item.lineDiscountLabel" class="block text-[9px] text-slate-500 font-bold italic" data-no-i18n>
                      {{ item.lineDiscountLabel }} Off (-{{ item.lineDiscountAmount.toFixed(2) }} JD)
                    </span>
                  </td>
                  <td class="text-center py-2">
                    <span v-if="item.kind !== 'bundle_child'">{{ item.qty }}</span>
                  </td>
                  <td class="text-end py-2">
                    <span v-if="item.kind !== 'bundle_child'">{{ item.unitPrice.toFixed(2) }}</span>
                  </td>
                  <td class="text-end py-2 font-black">
                    <span v-if="item.kind !== 'bundle_child'">{{ item.netAmount.toFixed(2) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Totals (gated on !error) -->
          <div v-if="!selectedPresentation.error && selectedPresentation.presentation" class="border-t border-dashed border-gray-200 pt-3 space-y-1 font-bold text-gray-600">
            <div class="space-y-1.5 pt-2 text-gray-500 font-semibold border-b border-dashed border-gray-200 pb-3 mb-3">
              <div v-if="selectedPresentation.presentation.taxMode !== 'inclusive'" class="flex justify-between">
                <span>{{ $t('Subtotal') }}</span>
                <span class="font-mono" data-no-i18n>{{ selectedPresentation.presentation.summary.subtotal.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.summary.orderDiscountAmount > 0" class="flex justify-between text-teal-600">
                <span>{{ $t('Discount') }}<template v-if="selectedPresentation.presentation.summary.orderDiscountLabel"> (<span data-no-i18n>{{ selectedPresentation.presentation.summary.orderDiscountLabel }}</span>)</template></span>
                <span class="font-mono" data-no-i18n>-{{ selectedPresentation.presentation.summary.orderDiscountAmount.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.taxMode !== 'inclusive'" class="flex justify-between">
                <span>{{ $t('Tax') }}</span>
                <span v-if="selectedPresentation.presentation.summary.taxLabel" class="italic">{{ $t(selectedPresentation.presentation.summary.taxLabel) }}</span>
                <span v-else class="font-mono" data-no-i18n>{{ selectedPresentation.presentation.summary.taxAmount.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.summary.roundingAdjustment !== 0" class="flex justify-between text-gray-400">
                <span>{{ $t('Rounding') }}</span>
                <span class="font-mono" data-no-i18n>{{ selectedPresentation.presentation.summary.roundingAdjustment > 0 ? '+' : '' }}{{ selectedPresentation.presentation.summary.roundingAdjustment.toFixed(2) }}</span>
              </div>
            </div>
            <div class="flex justify-between text-xs font-black text-gray-900">
              <span class="flex items-center gap-1">
                {{ $t('Total') }}:
                <span v-if="selectedPresentation.presentation.taxMode === 'inclusive'" class="text-[9px] text-gray-400 font-normal normal-case">
                  ({{ $t('incl. tax') }})
                </span>
              </span>
              <span class="text-teal-600 font-black" data-no-i18n>{{ selectedPresentation.presentation.summary.total.toFixed(2) }} JD</span>
            </div>
          </div>
        </div>

        <!-- Print/Pay Footer -->
        <div class="px-5 py-4 border-t border-outline-variant/30 bg-surface-container-low flex gap-2.5 shrink-0 select-none">
          <button @click="showPreviewModal = false"
            class="flex-1 py-2 bg-white hover:bg-gray-100 border border-gray-300 text-gray-700 font-bold rounded-lg text-xs uppercase tracking-wider transition-colors focus:outline-none">
            {{ $t('Close') }}
          </button>
          <button @click="payCheck(selectedCheck)" :disabled="isProcessing || isHolding || !!selectedPresentation.error"
            class="flex-1 py-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-600/30 disabled:cursor-not-allowed text-white font-black rounded-lg text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 focus:outline-none shadow-sm">
            <i class="fa-solid fa-file-invoice-dollar"></i>
            <span>{{ $t('Open in POS') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { formatBusinessTime, formatBusinessDateTime } from '@/utils/businessDate.js';
import { fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useTables } from '@/pos/useTables.js';
import { useCart } from '@/pos/useCart.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { useSocket } from '@/pos/useSocket.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';
import { t } from '@/shared/i18n.js';
import { splitCheckTotals } from '../utils/receiptLineTotals.js';
import { isArabic } from '../utils/orderNotesFormat.js';
import { resolveReceiptPresentation } from '../utils/receiptPresentation.js';

export default {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const parentInvoiceId = computed(() => route.query.parent_invoice_id ?? null);
    const showAllSplits = () => router.push('/table-splits');
    const tablesStore = useTables();
    const terminal = useTerminal();
    const { socket, initSocket } = useSocket();

    const { isProcessing, isHolding } = useCart();
    const { tableSplitsList, tableSplitsError, fetchTableSplits, restoreTableSplit, cancelSplitGroup, editSplitGroup } = tablesStore;
    const { storeName, storeAddress, storePhone } = terminal;

    const searchQuery = ref('');
    const isLoading = ref(false);
    const showPreviewModal = ref(false);
    const previewDialog = ref(null);
    usePosDialogFocus({ open: showPreviewModal, dialog: previewDialog, onEscape: () => { showPreviewModal.value = false; } });
    const selectedCheck = ref(null);

    const goBack = () => {
      router.push('/tables');
    };

    let disposed = false;
    let refreshRequestId = 0;
    let splitsReadFailed = false;
    const refreshSplits = async () => {
      if (disposed) return;
      const requestId = ++refreshRequestId;
      isLoading.value = true;
      try {
        const ok = await fetchTableSplits({ parentInvoiceId: parentInvoiceId.value });
        if (requestId === refreshRequestId) splitsReadFailed = ok === false;
      } catch {
        if (requestId === refreshRequestId) splitsReadFailed = true;
      } finally {
        if (!disposed && requestId === refreshRequestId) isLoading.value = false;
      }
    };

    watch(parentInvoiceId, () => {
      showPreviewModal.value = false;
      selectedCheck.value = null;
      searchQuery.value = '';
      refreshSplits();
    });


    const formatTimeOnly = (value) => formatBusinessTime(value);

    const formatDateTime = (value) => formatBusinessDateTime(value);

    // Filtered & grouped splits
    const processedSplits = computed(() => {
      return tableSplitsList.value.filter(o => parentInvoiceId.value === null
        || String(o.parent_invoice_id) === String(parentInvoiceId.value)).map(o => {
        let items = [];
        let parentInvoiceId = null;
        let parentOrderId = null;
        let orderTypeId = null;
        let parentInvoiceDisplayNo = null;
        let parentTicketDisplayNo = null;
        let parentOrderDisplayNo = null;
        let parentTableDisplayNo = null;
        let splitRole = 'check';
        let splitRevision = 1;
        try {
          const parsed = JSON.parse(o.cart_data || '{}');
          if (Array.isArray(parsed)) {
            items = parsed;
          } else if (parsed && typeof parsed === 'object') {
            items = parsed.items || [];
            parentInvoiceId = parsed.parent_invoice_id || null;
            parentOrderId = parsed.parent_order_id || null;
            orderTypeId = parsed.order_type_id ?? null;
            parentInvoiceDisplayNo = parsed.parent_invoice_display_no || null;
            parentTicketDisplayNo = parsed.parent_ticket_display_no || null;
            parentOrderDisplayNo = parsed.parent_order_display_no || null;
            parentTableDisplayNo = parsed.parent_table_display_no || null;
            splitRole = parsed.split_role === 'remainder' ? 'remainder' : 'check';
            splitRevision = Number(parsed.split_revision || 1);
          }
        } catch (e) {
          items = [];
        }

        // Parse reference_name like "Table 5 - Seat 1"
        let tableNumber = "";
        let seatName = "";
        const match = String(o.reference_name || "").match(/^Table\s+(.+?)\s+-\s+(.+)$/i);
        if (match) {
          tableNumber = match[1];
          seatName = match[2];
        } else {
          tableNumber = String(o.reference_name || "").replace("Table ", "");
          seatName = "Seat";
        }

        return {
          id: o.id,
          reference_name: o.reference_name,
          tableNumber,
          seatName,
          items,
          subtotal: o.subtotal,
          created_at: o.created_at,
          cashier_name: o.cashier_name || 'Cashier',
          table_id: o.table_id || null,
          parent_invoice_id: o.parent_invoice_id ?? parentInvoiceId,
          parent_order_id: parentOrderId,
          order_type_id: orderTypeId,
          parent_invoice_display_no: parentInvoiceDisplayNo,
          parent_ticket_display_no: parentTicketDisplayNo,
          parent_order_display_no: parentOrderDisplayNo,
          parent_table_display_no: parentTableDisplayNo,
          cart_data: o.cart_data,
          receipt_display_v1: o.receipt_display_v1,
          receipt_display_error: o.receipt_display_error,
          receipt_display_legacy_reason: o.receipt_display_legacy_reason,
          paid_split_count: Number(o.paid_split_count || 0),
          split_role: splitRole,
          split_revision: splitRevision
        };
      });
    });

    const filteredSplits = computed(() => {
      const q = searchQuery.value.trim().toLowerCase();
      if (!q) return processedSplits.value;

      return processedSplits.value.filter(s => 
        String(s.tableNumber).toLowerCase().includes(q) ||
        String(s.seatName).toLowerCase().includes(q) ||
        s.items.some(item => String(item.name || "").toLowerCase().includes(q))
      );
    });

    const groupedTables = computed(() => {
      const groups = {};
      for (const split of filteredSplits.value) {
        const groupKey = split.parent_invoice_id ? `invoice:${split.parent_invoice_id}`
          : split.table_id ? `table:${split.table_id}` : `check:${split.id}`;
        if (!groups[groupKey]) {
          groups[groupKey] = { key: groupKey, tableNumber: split.tableNumber, splits: [] };
        }
        groups[groupKey].splits.push(split);
      }

      // Return sorted by table number numerical value if possible, else alphabetically
      return Object.values(groups).map(group => ({
        ...group,
        hasPaidChildren: group.splits.some(split => split.paid_split_count > 0),
        splits: group.splits.sort((left, right) => (
          (left.split_role === 'remainder' ? -1 : 0) - (right.split_role === 'remainder' ? -1 : 0)
          || Number(left.id) - Number(right.id)
        ))
      })).sort((a, b) => {
        const numA = parseInt(a.tableNumber);
        const numB = parseInt(b.tableNumber);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return String(a.tableNumber).localeCompare(String(b.tableNumber));
      });
    });

    const openPreview = (check) => {
      selectedCheck.value = check;
      showPreviewModal.value = true;
    };

    const payCheck = async (check) => {
      if (isProcessing.value || isHolding.value) return;
      showPreviewModal.value = false;
      await restoreTableSplit(check);
    };

    const cancelGroup = async (group) => {
      showPreviewModal.value = false;
      await cancelSplitGroup(group.splits[0]);
    };

    const checkLabel = (check) => {
      if (check?.split_role === 'remainder') return t('Remaining Check');
      const number = String(check?.seatName || '').match(/\d+/)?.[0];
      return number ? `${t('Bill Check')} ${number}` : t('Bill Check');
    };

    const editGroup = (group) => {
      showPreviewModal.value = false;
      editSplitGroup(group);
    };

    const isPrinting = ref(false);

    const printCheckBill = async (check) => {
      if (isPrinting.value) return;
      isPrinting.value = true;
      try {
        const localPrinterId = localStorage.getItem("pos_receipt_printer_id");
        if (!localPrinterId) {
          await window.showPosAlert(t("No receipt printer assigned to this terminal. Please configure it in Terminal Setup."));
          return;
        }

        const totals = splitCheckTotals(check.items);

        const printPayload = {
          print_type: "receipt",
          receipt_printer_id: localPrinterId,
          storeInfo: {
            store_name: storeName.value,
            store_address: storeAddress.value,
            store_phone: storePhone.value
          },
          order_id: check.parent_order_id || "SPLIT-TEMP",
          order_display_no: check.parent_order_display_no || null,
          ticket_display_no: check.parent_ticket_display_no || check.parent_order_display_no || null,
          invoice_id: check.id,
          date: check.created_at,
          cashier: check.cashier_name,
          order_type_name: "Table Split",
          customer_name: "",
          customer_phone: "",
          customer_address: "",
          items: check.items.map(i => ({
            qty: i.qty || i.quantity || 1,
            name: i.name || i.product_name || "Item",
            price: i.price || i.price_at_sale || 0,
            tax_rate: i.tax_rate || 0,
            tax_amount: i.tax_amount || null,
            discountType: i.discountType || i.discount_type || null,
            discountValue: Number(i.discountValue || i.discount_value || 0),
            note: i.note || ""
          })),
          subtotal: check.receipt_display_v1 ? check.receipt_display_v1.summary.subtotal : totals.subtotal,
          tax: check.receipt_display_v1 ? check.receipt_display_v1.summary.taxAmount : totals.tax,
          discount: check.receipt_display_v1 ? check.receipt_display_v1.summary.orderDiscountAmount : 0,
          total: check.receipt_display_v1 ? check.receipt_display_v1.summary.total : totals.total,
          receipt_display_v1: check.receipt_display_v1 || null,
          payment_method: "held",
          amount_tendered: 0,
          change_due: 0,
          table_number: `${check.tableNumber} - ${check.seatName}`
        };

        const { data } = await fetchJsonResponseWithTimeout('api/print/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(printPayload)
        });

        if (data.success) {
          window.showPosToast?.(t("Bill printed successfully!"), "success");
        } else {
          await window.showPosAlert(t("Print Bridge Error:") + " " + (data.message || t("Unknown error")));
        }
      } catch (e) {
        console.error(e);
        await window.showPosAlert(t("Failed to print. Is your Node.js Spooler running?"));
      } finally {
        isPrinting.value = false;
      }
    };

    let splitsTimeout = null;
    const queueSplitsRefresh = () => {
      if (disposed) return;
      if (splitsTimeout) clearTimeout(splitsTimeout);
      splitsTimeout = setTimeout(() => {
        refreshSplits();
      }, 250);
    };
    // Split changes arrive as held_orders_changed; a table row only matters when it is a listed bill.
    const onTableUpdate = (payload) => {
      if (payload?.action === 'update_single_table') {
        const parent = payload.table?.current_order_id;
        if (parent == null || !tableSplitsList.value.some(o => Number(o.parent_invoice_id) === Number(parent))) return;
      }
      queueSplitsRefresh();
    };
    const onHeldOrdersChanged = (payload) => {
      if (disposed) return;
      const parent = payload?.parent_invoice_id;
      // Register holds never appear on this board.
      if (payload?.action && payload.action !== 'cleared' && parent == null && payload.table_id == null) return;
      if (parent != null && parent !== '' && Number.isFinite(Number(parent))
        && parentInvoiceId.value !== null && Number(parent) !== Number(parentInvoiceId.value)) {
        return;
      }
      const id = Number(payload?.held_order_id);
      if (payload?.action === 'removed'
        && Number.isInteger(id) && id > 0 && tableSplitsList.value.some(o => Number(o.id) === id)) {
        tableSplitsList.value = tableSplitsList.value.filter(o => Number(o.id) !== id);
        return;
      }
      // 'settled' refetches: paid_split_count drives hasPaidChildren.
      queueSplitsRefresh();
    };

    // Heartbeat/focus recovery for a read that failed while the socket stayed up.
    // A flag test, so a healthy board sends nothing.
    const retryFailedSplits = () => {
      if (!disposed && splitsReadFailed && !isLoading.value) refreshSplits();
    };

    onMounted(() => {
      window.addEventListener('socket_reconnected', queueSplitsRefresh);
      window.addEventListener('focus', retryFailedSplits);
      refreshSplits();
      try {
        const s = initSocket();
        s.on('table_update', onTableUpdate);
        s.on('held_orders_changed', onHeldOrdersChanged);
        s.io?.off('ping', retryFailedSplits);
        s.io?.on('ping', retryFailedSplits);
      } catch (err) {
        console.error("Failed to initialize splits board Socket connection:", err);
      }
    });

    onUnmounted(() => {
      disposed = true;
      window.removeEventListener('socket_reconnected', queueSplitsRefresh);
      window.removeEventListener('focus', retryFailedSplits);
      if (splitsTimeout) clearTimeout(splitsTimeout);
      if (socket.value) {
        socket.value.off('table_update', onTableUpdate);
        socket.value.off('held_orders_changed', onHeldOrdersChanged);
        socket.value.io?.off('ping', retryFailedSplits);
      }
    });

    const selectedPresentation = computed(() => {
      return resolveReceiptPresentation(selectedCheck.value);
    });

    return {
      parentInvoiceId, showAllSplits,
      isProcessing, isHolding,
      searchQuery,
      isLoading,
      showPreviewModal,
      selectedCheck,
      selectedPresentation,
      tableSplitsList,
      tableSplitsError,
      storeName,
      storeAddress,
      storePhone,
      goBack,
      refreshSplits,
      isArabic,
      formatTimeOnly,
      formatDateTime,
      groupedTables,
      checkLabel,
      openPreview,
      payCheck,
      cancelGroup,
      editGroup,
      printCheckBill,
      isPrinting
    };
  }
}
</script>

<style scoped>
/* The board predates the POS theme tokens. Map its neutral utility palette to
   the active light/graphite surfaces without changing status colors. */
.text-gray-900,.text-gray-800 { color: var(--color-on-surface) !important; }
.text-gray-700,.text-gray-600,.text-gray-500,.text-gray-400 { color: var(--color-on-surface-variant) !important; }
.bg-gray-50,.bg-gray-100 { background-color: var(--color-surface-container-low) !important; }
.border-gray-100,.border-gray-200,.border-gray-300 { border-color: var(--color-outline-variant) !important; }
</style>

<template>
  <div>
    <!-- Z-Report Modal -->
    <transition name="pos-modal">
    <div v-if="showZReportModal"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/90 p-4">
      <div ref="zDialog" role="dialog" aria-modal="true" aria-labelledby="z-report-dialog-title" tabindex="-1" class="modal-panel bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col border border-outline-variant/30 max-h-[90vh]">
        <div class="bg-surface-container-high text-on-surface border-b border-outline-variant/30 px-5 sm:px-6 py-4 sm:py-5 flex justify-between items-center no-print shrink-0">
          <h3 id="z-report-dialog-title" class="font-headline font-bold text-sm sm:text-base tracking-tight">
            <i class="fa-solid fa-cash-register me-2 text-error"></i> {{ hasAdminPrivilege ? $t('Close Shift (Z-Report)') : $t('Close Shift') }}
          </h3>
          <button type="button" :aria-label="$t('Close')" :disabled="isClosingShift" @click="closeZDialog" class="text-on-surface-variant hover:text-error transition-colors disabled:opacity-50">
            <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 sm:p-6 bg-surface overflow-y-auto premium-scroll flex flex-col items-center">
          <!-- Admin: full Z receipt preview -->
          <div v-if="hasAdminPrivilege && zReportData"
            class="bg-white p-4 sm:p-5 shadow-sm w-full max-w-[280px] font-mono text-[10px] sm:text-[11px] font-bold text-black leading-tight border border-outline-variant/30">
            <div class="text-center font-black text-sm sm:text-base mb-1 uppercase tracking-widest" data-no-i18n>{{ storeName }}</div>
            <div class="text-center font-bold mb-2">END OF SHIFT (Z)</div>
            <div class="text-center mb-2">{{ $t('Shift #') }}<span data-no-i18n>{{ zReportData.shift_id }}</span></div>
            <div class="border-b-2 border-dashed border-black mb-2"></div>
            <div class="flex justify-between mb-1"><span>Gross Sales:</span><span>{{ parseFloat(zReportData.gross_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-1"><span>Cash Sales:</span><span>{{ parseFloat(zReportData.cash_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-1"><span>{{ $t('Cash Expenses') }}:</span><span>-{{ parseFloat(zReportData.cash_expenses || 0).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-2"><span>Card Sales:</span><span>{{ parseFloat(zReportData.card_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-2"><span>Platform Sales (Not collected):</span><span>{{ parseFloat(zReportData.platform_sales || 0).toFixed(2) }} JD</span></div>
            <div v-for="category in zReportData.expense_categories || []" :key="`z-preview-expense-${category.category_id}`" class="flex justify-between ps-2 mb-1 text-[9px]">
              <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>-{{ parseFloat(category.total).toFixed(2) }} JD</span>
            </div>
            <div class="border-b-2 border-dashed border-black mb-2"></div>
            <div class="flex justify-between font-black text-xs sm:text-sm mb-2"><span>EXPECTED CASH:</span><span>{{ parseFloat(zReportData.expected_cash).toFixed(2) }} JD</span></div>
            <div class="flex justify-between font-black text-xs sm:text-sm"><span>ACTUAL CASH:</span><span>{{ parseFloat(actualCashInput || 0).toFixed(2) }} JD</span></div>
          </div>

          <!-- Cashier: no preview, plain prompt -->
          <div v-else class="text-center py-4">
            <div class="w-14 h-14 mx-auto mb-3 rounded-full bg-surface-container-high flex items-center justify-center">
              <i class="fa-solid fa-cash-register text-xl text-on-surface-variant"></i>
            </div>
            <p class="text-xs sm:text-sm font-bold text-on-surface-variant max-w-[240px] mx-auto leading-relaxed">
              {{ $t('Count your drawer and enter the cash total to close your shift.') }}
            </p>
          </div>
        </div>
        <div class="p-5 sm:p-6 border-t border-outline-variant/20 bg-surface-container-low no-print shrink-0">
          <label class="block text-[11px] sm:text-xs font-black text-on-surface-variant uppercase tracking-widest mb-2 text-center">{{ $t('Total cash in drawer now (including opening cash)') }}</label>
          <input v-model="actualCashInput" type="number" inputmode="decimal" enterkeyhint="done" step="0.01" min="0"
            class="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-3 sm:p-4 text-xl sm:text-2xl font-black text-on-surface focus:outline-none focus:ring-2 focus:ring-primary text-center mb-4 sm:mb-5 shadow-inner">

          <div class="flex gap-2 sm:gap-3">
            <button data-dialog-initial-focus :disabled="isClosingShift" @click="closeZDialog"
              class="flex-1 py-3 sm:py-4 bg-surface border border-outline-variant/40 text-on-surface font-bold rounded-xl hover:bg-surface-container-low text-xs sm:text-sm uppercase tracking-widest transition-colors">{{ $t('Cancel') }}</button>
            <button @click="closeShiftAuthorized" :disabled="isClosingShift"
              class="flex-1 py-3 sm:py-4 bg-error text-white font-black rounded-xl shadow-sm hover:bg-error/90 disabled:opacity-50 text-xs sm:text-sm uppercase tracking-widest transition-colors">
              {{ hasAdminPrivilege ? $t('Close & Print') : $t('Close Shift') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    </transition>

    <!-- X-Report Modal -->
    <transition name="pos-modal">
    <div v-if="showXReportModal"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/90 p-4">
      <div ref="xDialog" role="dialog" aria-modal="true" aria-labelledby="x-report-dialog-title" tabindex="-1" class="modal-panel bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col border border-outline-variant/30 max-h-[90vh]">
        <div class="bg-surface-container-low text-on-surface border-b border-outline-variant/30 px-5 sm:px-6 py-4 sm:py-5 flex justify-between items-center no-print shrink-0">
          <h3 id="x-report-dialog-title" class="font-headline font-bold text-sm sm:text-base tracking-tight">
            <i class="fa-solid fa-file-lines me-2 text-primary"></i> {{ $t('Mid-Shift (X)') }}
          </h3>
          <button type="button" :aria-label="$t('Close')" @click="closeXDialog" class="text-on-surface-variant hover:text-error transition-colors">
            <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
          </button>
        </div>
        <div class="p-4 sm:p-6 bg-surface overflow-y-auto premium-scroll flex flex-col items-center">
          <div class="bg-white p-4 sm:p-5 shadow-sm w-full max-w-[280px] font-mono text-[10px] sm:text-[11px] font-bold text-black leading-tight border border-outline-variant/30"
            v-if="zReportData">
            <div class="text-center font-black text-sm sm:text-base mb-1 uppercase tracking-widest" data-no-i18n>{{ storeName }}</div>
            <div class="text-center font-bold mb-2">MID-SHIFT AUDIT (X)</div>
            <div class="text-center mb-2">{{ $t('Shift #') }}<span data-no-i18n>{{ zReportData.shift_id }}</span></div>
            <div class="border-b-2 border-dashed border-black mb-2"></div>
            <div class="flex justify-between mb-1"><span>Gross Sales:</span><span>{{ parseFloat(zReportData.gross_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-1"><span>Cash Sales:</span><span>{{ parseFloat(zReportData.cash_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-1"><span>{{ $t('Cash Expenses') }}:</span><span>-{{ parseFloat(zReportData.cash_expenses || 0).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-2"><span>Card Sales:</span><span>{{ parseFloat(zReportData.card_sales).toFixed(2) }} JD</span></div>
            <div class="flex justify-between mb-2"><span>Platform Sales (Not collected):</span><span>{{ parseFloat(zReportData.platform_sales || 0).toFixed(2) }} JD</span></div>
            <div v-for="category in zReportData.expense_categories || []" :key="`x-preview-expense-${category.category_id}`" class="flex justify-between ps-2 mb-1 text-[9px]">
              <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>-{{ parseFloat(category.total).toFixed(2) }} JD</span>
            </div>
            <div class="border-b-2 border-dashed border-black mb-2"></div>
            <div class="flex justify-between font-black text-xs sm:text-sm"><span>EXPECTED CASH:</span><span>{{ parseFloat(zReportData.expected_cash).toFixed(2) }} JD</span></div>
          </div>
        </div>
        <div class="p-4 sm:p-5 border-t border-outline-variant/20 bg-surface-container-low no-print flex gap-2 sm:gap-3 shrink-0">
          <button data-dialog-initial-focus @click="closeXDialog"
            class="flex-1 py-3.5 sm:py-4 bg-surface border border-outline-variant/40 text-on-surface font-bold rounded-xl hover:bg-surface-container-low text-xs sm:text-sm uppercase tracking-widest transition-colors">{{ $t('Close') }}</button>
          <button @click="printXReportOnly(printMethod)"
            class="flex-1 py-3.5 sm:py-4 bg-primary text-white font-black rounded-xl shadow-sm hover:bg-primary/90 text-xs sm:text-sm uppercase tracking-widest transition-colors">
            <i class="fa-solid fa-print me-2"></i> {{ $t('Print Audit') }}
          </button>
        </div>
      </div>
    </div>
    </transition>
  </div>

  <!-- Teleported Z-Report print layout -->
  <teleport to="body">
    <div v-if="showZReportModal && zReportData" class="shift-print-wrapper">
      <div class="thermal-text-center">
        <h1 class="thermal-title" data-no-i18n>{{ storeName }}</h1>
        <p class="thermal-bold thermal-uppercase">End of Shift (Z-Report)</p>
        <p class="thermal-bold">Shift ID: #<span data-no-i18n>{{ zReportData.shift_id }}</span></p>
      </div>
      <div class="thermal-dashed-line"></div>
      
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cashier:</span><span data-no-i18n>{{ zReportData.cashier_name || 'System' }}</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Opened:</span><span data-no-i18n>{{ formatBusinessDateTime(zReportData.opened_at) }}</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Closed:</span><span data-no-i18n>{{ formatBusinessDateTime(zReportData.closed_at) }}</span></div>
      <div class="thermal-solid-line"></div>
      
      <div class="thermal-text-center thermal-black" style="font-size: 14px; margin-bottom: 6px;">SALES SUMMARY</div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Gross Sales:</span><span>{{ parseFloat(zReportData.gross_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cash Sales:</span><span>{{ parseFloat(zReportData.cash_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cash Expenses:</span><span>-{{ parseFloat(zReportData.cash_expenses || 0).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Card Sales:</span><span>{{ parseFloat(zReportData.card_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Platform Sales (Not collected):</span><span>{{ parseFloat(zReportData.platform_sales || 0).toFixed(2) }} JD</span></div>
      <div v-for="category in zReportData.expense_categories || []" :key="`z-print-expense-${category.category_id}`" class="thermal-flex thermal-justify-between">
        <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>-{{ parseFloat(category.total).toFixed(2) }} JD</span>
      </div>
      
      <div v-if="zReportData.order_type_breakdown && zReportData.order_type_breakdown.length > 0">
        <div class="thermal-dashed-line"></div>
        <div class="thermal-text-center thermal-black" style="font-size: 14px; margin-bottom: 6px;">ORDER TYPES</div>
        <div v-for="ot in zReportData.order_type_breakdown" :key="ot.order_type_name" class="thermal-flex thermal-justify-between thermal-bold">
          <span data-no-i18n>{{ ot.order_type_name }}:</span>
          <span>{{ parseFloat(ot.total_sales).toFixed(2) }} JD</span>
        </div>
      </div>
      
      <div class="thermal-dashed-line"></div>
      <div class="thermal-text-center thermal-black" style="font-size: 14px; margin-bottom: 6px;">CASH DRAWER AUDIT</div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Starting Float:</span><span>{{ parseFloat(zReportData.starting_cash).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-black"><span>EXPECTED CASH:</span><span>{{ parseFloat(zReportData.expected_cash).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-black"><span>ACTUAL COUNTED:</span><span>{{ parseFloat(actualCashInput || 0).toFixed(2) }} JD</span></div>
      
      <div class="thermal-dashed-line"></div>
      <div class="thermal-flex thermal-justify-between thermal-black" style="font-size: 14px;">
        <span>VARIANCE:</span>
        <span>{{ (parseFloat(actualCashInput || 0) - parseFloat(zReportData.expected_cash)).toFixed(2) }} JD</span>
      </div>
      <div class="thermal-text-center thermal-bold" style="margin-top: 15px;">--- End of Shift Report ---</div>
    </div>
  </teleport>

  <!-- Teleported X-Report print layout -->
  <teleport to="body">
    <div v-if="showXReportModal && zReportData" class="shift-print-wrapper">
      <div class="thermal-text-center">
        <h1 class="thermal-title" data-no-i18n>{{ storeName }}</h1>
        <p class="thermal-bold thermal-uppercase">Mid-Shift Audit (X-Report)</p>
        <p class="thermal-bold">Shift ID: #<span data-no-i18n>{{ zReportData.shift_id }}</span></p>
      </div>
      <div class="thermal-dashed-line"></div>
      
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cashier:</span><span data-no-i18n>{{ zReportData.cashier_name || 'System' }}</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Opened:</span><span data-no-i18n>{{ formatBusinessDateTime(zReportData.opened_at) }}</span></div>
      <div class="thermal-solid-line"></div>
      
      <div class="thermal-text-center thermal-black" style="font-size: 14px; margin-bottom: 6px;">SALES SUMMARY</div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Gross Sales:</span><span>{{ parseFloat(zReportData.gross_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cash Sales:</span><span>{{ parseFloat(zReportData.cash_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Cash Expenses:</span><span>-{{ parseFloat(zReportData.cash_expenses || 0).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Card Sales:</span><span>{{ parseFloat(zReportData.card_sales).toFixed(2) }} JD</span></div>
      <div class="thermal-flex thermal-justify-between thermal-bold"><span>Platform Sales (Not collected):</span><span>{{ parseFloat(zReportData.platform_sales || 0).toFixed(2) }} JD</span></div>
      <div v-for="category in zReportData.expense_categories || []" :key="`x-print-expense-${category.category_id}`" class="thermal-flex thermal-justify-between">
        <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>-{{ parseFloat(category.total).toFixed(2) }} JD</span>
      </div>
      
      <div v-if="zReportData.order_type_breakdown && zReportData.order_type_breakdown.length > 0">
        <div class="thermal-dashed-line"></div>
        <div class="thermal-text-center thermal-black" style="font-size: 14px; margin-bottom: 6px;">ORDER TYPES</div>
        <div v-for="ot in zReportData.order_type_breakdown" :key="ot.order_type_name" class="thermal-flex thermal-justify-between thermal-bold">
          <span data-no-i18n>{{ ot.order_type_name }}:</span>
          <span>{{ parseFloat(ot.total_sales).toFixed(2) }} JD</span>
        </div>
      </div>
      
      <div class="thermal-dashed-line"></div>
      <div class="thermal-flex thermal-justify-between thermal-black" style="font-size: 14px;">
        <span>EXPECTED CASH:</span>
        <span>{{ parseFloat(zReportData.expected_cash).toFixed(2) }} JD</span>
      </div>
      <div class="thermal-text-center thermal-bold" style="margin-top: 15px;">--- End of Audit Report ---</div>
    </div>
  </teleport>
</template>

<script>
import { formatBusinessDateTime } from '@/utils/businessDate.js';
import { useAuth } from '@/pos/useAuth.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { ref } from 'vue';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

export default {
  setup() {
    const {
      showZReportModal,
      showXReportModal,
      zReportData,
      actualCashInput,
      adminPinInput,
      hasAdminPrivilege,
      closeShiftAuthorized,
      printXReportOnly,
      isClosingShift
    } = useAuth();

    const { printMethod, storeName } = useTerminal();
    const zDialog = ref(null);
    const xDialog = ref(null);
    const closeZDialog = () => {
      if (isClosingShift.value) return;
      showZReportModal.value = false;
      adminPinInput.value = '';
    };
    const closeXDialog = () => { showXReportModal.value = false; };
    usePosDialogFocus({ open: showZReportModal, dialog: zDialog, onEscape: closeZDialog });
    usePosDialogFocus({ open: showXReportModal, dialog: xDialog, onEscape: closeXDialog });

    return {
      formatBusinessDateTime,
      showZReportModal,
      showXReportModal,
      zReportData,
      actualCashInput,
      adminPinInput,
      hasAdminPrivilege,
      closeShiftAuthorized,
      printXReportOnly,
      isClosingShift,
      printMethod,
      storeName,
      zDialog,
      xDialog,
      closeZDialog,
      closeXDialog
    };
  }
}
</script>

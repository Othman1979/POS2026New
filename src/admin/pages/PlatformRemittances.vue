<template>
  <div class="admin-data-page flex h-full min-h-0 flex-col bg-background font-sans text-foreground">
    <header class="admin-grid-page-bar shrink-0">
      <div class="admin-grid-page-context">
        <h2>{{ $t('Platform Payouts') }}</h2>
        <span class="admin-grid-record-count">{{ $t('Match platform sales with the payments you receive.') }}</span>
      </div>
      <div class="admin-grid-page-actions">
        <button type="button" class="admin-grid-icon-button" :aria-label="$t('Refresh')" @click="refreshAll" :disabled="loading">
          <i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <section class="admin-grid-command-bar shrink-0">
      <div class="admin-grid-command-row justify-between">
        <span class="text-xs font-semibold text-muted-foreground">{{ $t('Platform sales are revenue, but they are not cash or card collected at the register.') }}</span>
        <span v-if="errorMessage" class="text-xs font-semibold text-rose-700" role="alert">{{ errorMessage }}</span>
      </div>
    </section>

    <main class="payout-page min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <section class="payout-providers" :aria-label="$t('Platform balances')">
        <button
          v-for="provider in providers"
          :key="provider.order_type_id"
          type="button"
          class="payout-provider"
          :class="{ 'is-active': Number(selectedProviderId) === Number(provider.order_type_id) }"
          @click="selectProvider(provider.order_type_id)"
        >
          <span class="payout-provider__heading">
            <strong data-no-i18n>{{ provider.provider_name }}</strong>
            <small v-if="provider.is_active === false">{{ $t('Inactive') }}</small>
          </span>
          <span class="payout-provider__balance">
            <small>{{ $t('Amount outstanding') }}</small>
            <strong class="tabular-nums" data-no-i18n>{{ money(provider.net_outstanding) }}</strong>
          </span>
          <span class="payout-provider__breakdown">
            <small>{{ $t('Sales owed') }} <b class="tabular-nums" data-no-i18n>{{ money(provider.gross_due) }}</b></small>
            <small>{{ $t('Credit balance') }} <b class="tabular-nums" data-no-i18n>{{ money(provider.provider_credit) }}</b></small>
          </span>
        </button>
        <div v-if="!loading && !providers.length" class="payout-empty">
          {{ $t('No platform sales have been recorded yet.') }}
        </div>
      </section>

      <section class="payout-layout">
        <section class="admin-grid-shell payout-entry-shell">
          <section class="payout-workbench">
          <header class="payout-section-heading">
            <div>
              <h3>{{ $t('Record a payout') }}</h3>
              <p>{{ $t('Match each invoice with the amount included in the platform payment.') }}</p>
            </div>
            <button type="button" class="admin-grid-button" :disabled="!selectedProviderId || loadingReceivables" @click="refreshReceivables()">
              <i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i><span>{{ $t('Refresh amounts') }}</span>
            </button>
          </header>
          <p v-if="staleMessage" class="payout-warning" role="alert">{{ staleMessage }}</p>

          <section class="payout-block">
            <div class="payout-block__title">
              <div><h4>{{ $t('Open invoices') }}</h4><p>{{ $t('Adjust an amount only when the platform paid part of an invoice.') }}</p></div>
              <span class="payout-count tabular-nums" data-no-i18n>{{ receivables.length }}</span>
            </div>
            <div class="payout-invoices">
              <div v-if="loadingReceivables" class="payout-empty">{{ $t('Loading...') }}</div>
              <div v-else-if="!receivables.length" class="payout-empty">{{ $t('No unpaid platform invoices for this provider.') }}</div>
              <template v-else>
                <div class="payout-invoice payout-invoice--head" aria-hidden="true">
                  <span>{{ $t('Invoice') }}</span><span>{{ $t('Sale date') }}</span><span>{{ $t('Outstanding') }}</span><span>{{ $t('Amount included') }}</span>
                </div>
                <div v-for="row in receivables" :key="row.invoice_id" class="payout-invoice">
                  <div class="payout-invoice__identity"><strong class="tabular-nums" data-no-i18n>#{{ row.invoice_number || row.invoice_id }}</strong><small data-no-i18n>{{ row.sale_date }}</small></div>
                  <span class="payout-invoice__date tabular-nums" data-no-i18n>{{ dateOnly(row.sale_date) }}</span>
                  <span class="payout-invoice__balance tabular-nums" :class="Number(row.open_amount) < 0 ? 'text-amber-700' : ''" data-no-i18n>{{ money(row.open_amount) }}</span>
                  <label class="payout-invoice__allocation">
                    <span>{{ $t('Amount included') }}</span>
                    <input class="admin-grid-input tabular-nums" :value="allocationAmount(row)" inputmode="decimal" type="number" step="0.01" @input="setAllocation(row, $event.target.value)">
                    <button type="button" class="admin-grid-button" @click="resetAllocation(row)">{{ $t('Use full amount') }}</button>
                  </label>
                </div>
              </template>
            </div>
          </section>

          <section class="payout-block">
            <div class="payout-block__title">
              <div><h4>{{ $t('Deductions and additions') }}</h4><p>{{ $t('Add commissions, fees, incentives, or other differences shown by the platform.') }}</p></div>
              <button type="button" class="admin-grid-button" :disabled="adjustments.length >= 50" @click="addAdjustment"><i class="fa-solid fa-plus text-[10px]" aria-hidden="true"></i><span>{{ $t('Add line') }}</span></button>
            </div>
            <div v-if="!adjustments.length" class="payout-empty payout-empty--compact">{{ $t('No deductions or additions.') }}</div>
            <div v-for="(adjustment, index) in adjustments" :key="adjustment.id" class="payout-adjustment">
              <select v-model="adjustment.direction" class="admin-grid-select" :aria-label="$t('Type')" @change="normalizeAdjustmentCategory(adjustment)"><option value="deduction">{{ $t('Deduction') }}</option><option value="addition">{{ $t('Addition') }}</option></select>
              <select v-model="adjustment.category" class="admin-grid-select" :aria-label="$t('Reason')"><option v-for="category in categoryOptions(adjustment)" :key="category" :value="category">{{ $t(category) }}</option></select>
              <input v-model="adjustment.amount" class="admin-grid-input tabular-nums" :aria-label="$t('Amount')" inputmode="decimal" type="number" min="0" step="0.01" :placeholder="$t('Amount')">
              <input v-model.trim="adjustment.note" class="admin-grid-input" :class="adjustmentNeedsNote(adjustment) && !adjustment.note ? 'border-rose-300' : ''" :aria-label="$t('Note')" :placeholder="adjustmentNeedsNote(adjustment) ? $t('Required note') : $t('Note (optional)')" maxlength="255">
              <button type="button" class="admin-grid-icon-button" :aria-label="$t('Remove')" @click="removeAdjustment(index)"><i class="fa-solid fa-trash text-[10px]" aria-hidden="true"></i></button>
            </div>
          </section>

          <section class="payout-block payout-block--details">
            <div class="payout-block__title"><div><h4>{{ $t('Payment details') }}</h4><p>{{ $t('Enter the date, reference, and amount exactly as received.') }}</p></div></div>
            <div class="payout-fields">
              <label><span>{{ $t('Period from') }}</span><input v-model="statementStartDate" class="admin-grid-input tabular-nums" type="date"></label>
              <label><span>{{ $t('Period to') }}</span><input v-model="statementEndDate" class="admin-grid-input tabular-nums" type="date"></label>
              <label><span>{{ $t('Payment date') }}</span><input v-model="settledOn" class="admin-grid-input tabular-nums" type="date"></label>
              <label><span>{{ $t('Reference number') }}</span><input v-model.trim="reference" class="admin-grid-input" maxlength="120" :placeholder="$t('Check or transfer reference')"></label>
              <label class="payout-fields__amount"><span>{{ $t('Amount received') }}</span><input v-model="netReceived" class="admin-grid-input tabular-nums" inputmode="decimal" type="number" min="0" step="0.01" placeholder="0.00"></label>
            </div>
          </section>
          </section>

          <aside class="payout-summary">
            <header><h3>{{ $t('Payout summary') }}</h3><p>{{ $t('The received amount must match this calculation.') }}</p></header>
            <dl>
              <div><dt>{{ $t('Invoices included') }}</dt><dd class="tabular-nums">{{ money(centsToAmount(signedInvoiceCents)) }}</dd></div>
              <div><dt>{{ $t('Deductions') }}</dt><dd class="tabular-nums">-{{ money(centsToAmount(deductionsCents)) }}</dd></div>
              <div><dt>{{ $t('Additions') }}</dt><dd class="tabular-nums">{{ money(centsToAmount(additionsCents)) }}</dd></div>
              <div class="payout-summary__total"><dt>{{ $t('Expected payment') }}</dt><dd class="tabular-nums">{{ money(centsToAmount(computedNetCents)) }}</dd></div>
              <div class="payout-summary__difference"><dt>{{ $t('Unmatched difference') }}</dt><dd class="tabular-nums" :class="differenceCents === 0 ? 'text-teal-700' : 'text-rose-700'">{{ signedMoney(centsToAmount(differenceCents)) }}</dd></div>
            </dl>
            <button type="button" class="admin-grid-button admin-grid-button--primary payout-submit" :disabled="!canSubmit || submitting" @click="recordSettlement">{{ submitting ? $t('Saving...') : $t('Save payout') }}</button>
            <p v-if="validationMessage" class="payout-validation" role="alert">{{ $t(validationMessage) }}</p>
          </aside>
        </section>

        <section class="admin-grid-shell payout-history overflow-hidden">
          <header class="payout-section-heading payout-history__heading">
            <div><h3>{{ $t('Previous payouts') }}</h3><p>{{ $t('Open any payout to review or reverse it.') }}</p></div>
            <div class="payout-history__filters">
              <select v-model="historyProviderId" class="admin-grid-select"><option value="">{{ $t('All platforms') }}</option><option v-for="provider in providers" :key="provider.order_type_id" :value="provider.order_type_id" data-no-i18n>{{ provider.provider_name }}</option></select>
              <input v-model="historyStartDate" class="admin-grid-input tabular-nums" type="date" :aria-label="$t('Start date')">
              <input v-model="historyEndDate" class="admin-grid-input tabular-nums" type="date" :aria-label="$t('End date')">
            </div>
          </header>
          <div class="payout-history__list">
            <div v-if="loadingHistory" class="payout-empty">{{ $t('Loading...') }}</div>
            <div v-else-if="!remittances.length" class="payout-empty">{{ $t('No payouts recorded yet.') }}</div>
            <button v-for="remittance in remittances" :key="remittance.id" type="button" class="payout-history-row" @click="openHistory(remittance.id)">
              <span class="payout-history-row__provider"><strong data-no-i18n>{{ remittance.provider_name }}</strong><small class="tabular-nums" data-no-i18n>{{ dateOnly(remittance.settled_on) }}</small></span>
              <span class="payout-history-row__reference"><small>{{ $t('Reference number') }}</small><strong class="tabular-nums" data-no-i18n>{{ remittance.reference || '—' }}</strong></span>
              <strong class="payout-history-row__amount tabular-nums" data-no-i18n>{{ money(remittance.net_received) }}</strong>
              <span class="payout-status" :class="{ 'is-reversal': remittance.kind === 'reversal' }">{{ $t(remittance.kind === 'reversal' ? 'Reversal' : 'Payout') }}</span>
            </button>
          </div>
        </section>
      </section>
    </main>

    <div v-if="historyDetail" class="fixed inset-0 z-40 flex items-end justify-center bg-zinc-900/40 p-0 sm:items-center sm:p-5" @click.self="historyDetail = null">
      <section class="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-t-xl bg-card p-5 shadow-xl sm:rounded-xl" role="dialog" aria-modal="true" :aria-label="$t('Payout details')">
        <div class="flex items-start justify-between gap-3"><div><h3 class="text-base font-bold">{{ $t('Payout details') }}</h3><p class="text-xs text-muted-foreground" data-no-i18n>{{ historyDetail.provider_name }} · {{ dateOnly(historyDetail.settled_on) }}</p></div><button type="button" class="admin-grid-icon-button" :aria-label="$t('Close')" @click="historyDetail = null"><i class="fa-solid fa-xmark text-xs" aria-hidden="true"></i></button></div>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4"><div><dt class="text-muted-foreground">{{ $t('Invoice allocations') }}</dt><dd class="font-bold tabular-nums">{{ money(historyDetail.invoice_allocations) }}</dd></div><div><dt class="text-muted-foreground">{{ $t('Deductions') }}</dt><dd class="font-bold tabular-nums">{{ money(historyDetail.deductions) }}</dd></div><div><dt class="text-muted-foreground">{{ $t('Additions') }}</dt><dd class="font-bold tabular-nums">{{ money(historyDetail.additions) }}</dd></div><div><dt class="text-muted-foreground">{{ $t('Net Received') }}</dt><dd class="font-bold tabular-nums">{{ money(historyDetail.net_received) }}</dd></div></dl>
        <div class="mt-4"><h4 class="text-xs font-bold">{{ $t('Invoices') }}</h4><div v-for="allocation in historyDetail.allocations || []" :key="allocation.invoice_id" class="flex justify-between border-b border-zinc-100 py-2 text-xs"><span class="tabular-nums" data-no-i18n>#{{ allocation.invoice_id }}</span><span class="tabular-nums" data-no-i18n>{{ money(allocation.allocated_amount) }}</span></div></div>
        <div class="mt-4"><h4 class="text-xs font-bold">{{ $t('Adjustments') }}</h4><div v-for="adjustment in historyDetail.adjustments || []" :key="`${adjustment.category}-${adjustment.amount}`" class="flex justify-between border-b border-zinc-100 py-2 text-xs"><span>{{ $t(adjustment.category) }}<small v-if="adjustment.note" class="ms-2 text-muted-foreground" data-no-i18n>{{ adjustment.note }}</small></span><span class="tabular-nums" data-no-i18n>{{ signedMoney((adjustment.direction === 'deduction' ? -1 : 1) * Number(adjustment.amount || 0)) }}</span></div></div>
        <div v-if="historyDetail.kind === 'settlement' && !historyDetail.reversal_id" class="mt-5 flex justify-end"><button type="button" class="admin-grid-button border-rose-200 text-rose-700" @click="beginReversal(historyDetail)">{{ $t('Reverse payout') }}</button></div>
      </section>
    </div>

    <div v-if="reverseTarget" class="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/50 p-0 sm:items-center sm:p-5">
      <section class="w-full max-w-md rounded-t-xl bg-card p-5 shadow-xl sm:rounded-xl" role="dialog" aria-modal="true" :aria-label="$t('Reverse payout')">
        <h3 class="text-base font-bold">{{ $t('Reverse payout') }}</h3><p class="mt-1 text-xs text-muted-foreground">{{ $t('The original payout stays in history and a reversal is recorded against it.') }}</p>
        <textarea v-model.trim="reverseReason" class="admin-grid-input mt-4 min-h-24 w-full" maxlength="255" :placeholder="$t('Reason')"></textarea>
        <div class="mt-4 flex justify-end gap-2"><button type="button" class="admin-grid-button" @click="reverseTarget = null">{{ $t('Cancel') }}</button><button type="button" class="admin-grid-button border-rose-200 text-rose-700" :disabled="!reverseReason || reversing" @click="reverseSettlement">{{ reversing ? $t('Saving...') : $t('Confirm reversal') }}</button></div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { currentBusinessDate } from '@/utils/businessDate.js';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { fetchJson, fetchJsonResponse } from '@/shared/http.js';
import { formatReportMoney } from '../utils/reportFormatting.js';

defineOptions({ name: 'platform-remittances' });

const ADJUSTMENT_CATEGORIES = {
  deduction: ['commission', 'service_fee', 'marketing_fee', 'penalty', 'withholding_tax', 'correction', 'other'],
  addition: ['reimbursement', 'incentive', 'correction', 'other']
};

const providers = ref([]);
const receivables = ref([]);
const remittances = ref([]);
const selectedProviderId = ref('');
const historyProviderId = ref('');
const historyDetail = ref(null);
const reverseTarget = ref(null);
const reverseReason = ref('');
const reversalIdempotencyKey = ref('');
const errorMessage = ref('');
const staleMessage = ref('');
const loading = ref(false);
const loadingReceivables = ref(false);
const loadingHistory = ref(false);
const submitting = ref(false);
const reversing = ref(false);
const statementStartDate = ref('');
const statementEndDate = ref('');
const settledOn = ref(currentBusinessDate());
const reference = ref('');
const netReceived = ref('');
const adjustments = ref([]);
const selectedAllocations = reactive(new Map());
const idempotencyKey = ref('');
const historyStartDate = ref('');
const historyEndDate = ref('');

const newIdempotencyKey = () => {
  idempotencyKey.value = crypto.randomUUID();
};

function today() { return currentBusinessDate(); }
function dateOnly(value) { return value ? String(value).slice(0, 10) : '—'; }
function money(value) { return formatReportMoney(Number(value || 0)); }
function toCents(value) { const amount = Number(value || 0); return Number.isFinite(amount) ? Math.round(amount * 100) : 0; }
function centsToAmount(value) { return Number((Number(value || 0) / 100).toFixed(2)); }
function signedMoney(value) { const amount = Number(value || 0); return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}${money(Math.abs(amount))}`; }

function assertSuccess(data, fallback) {
  if (!data?.success) throw new Error(data?.message || fallback);
  return data;
}

function defaultAllocation(row) { return Number(row.open_amount) || 0; }

function allocationAmount(row) {
  return selectedAllocations.get(Number(row.invoice_id))?.allocationAmount ?? '';
}

function setAllocation(row, value) {
  // Never silently clamp an allocation; the server must reject stale or out-of-bounds cents.
  selectedAllocations.set(Number(row.invoice_id), { allocationAmount: value, balanceToken: row.balance_token });
}

function resetAllocation(row) {
  selectedAllocations.set(Number(row.invoice_id), { allocationAmount: defaultAllocation(row), balanceToken: row.balance_token });
}

const allocationRows = computed(() => receivables.value.map(row => ({ ...row, allocationAmount: allocationAmount(row) })));
const signedInvoiceCents = computed(() => allocationRows.value.reduce((sum, row) => sum + toCents(row.allocationAmount), 0));
const deductionsCents = computed(() => adjustments.value.filter(row => row.direction === 'deduction').reduce((sum, row) => sum + Math.abs(toCents(row.amount)), 0));
const additionsCents = computed(() => adjustments.value.filter(row => row.direction === 'addition').reduce((sum, row) => sum + Math.abs(toCents(row.amount)), 0));
const computedNetCents = computed(() => signedInvoiceCents.value - deductionsCents.value + additionsCents.value);
const differenceCents = computed(() => toCents(netReceived.value) - computedNetCents.value);
const adjustmentError = computed(() => adjustments.value.some(row => !toCents(row.amount) || (adjustmentNeedsNote(row) && !String(row.note || '').trim())));
const validationMessage = computed(() => {
  if (!selectedProviderId.value) return 'Select a provider.';
  if (!allocationRows.value.some(row => toCents(row.allocationAmount) > 0)) return 'At least one positive invoice allocation is required.';
  if (adjustmentError.value) return 'Adjustment note is required and amounts must be greater than zero.';
  if (differenceCents.value !== 0) return 'The entered payout must equal the computed payout exactly.';
  return '';
});
const canSubmit = computed(() => !validationMessage.value && !submitting.value);

function categoryOptions(adjustment) { return ADJUSTMENT_CATEGORIES[adjustment.direction] || ADJUSTMENT_CATEGORIES.deduction; }
function adjustmentNeedsNote(adjustment) { return ['correction', 'other'].includes(adjustment.category); }
function normalizeAdjustmentCategory(adjustment) { if (!categoryOptions(adjustment).includes(adjustment.category)) adjustment.category = categoryOptions(adjustment)[0]; }
function addAdjustment() { adjustments.value.push({ id: `${Date.now()}-${adjustments.value.length}`, direction: 'deduction', category: 'commission', amount: '', note: '' }); }
function removeAdjustment(index) { adjustments.value.splice(index, 1); }

async function loadProviders() {
  const data = assertSuccess(await fetchJson('/api/admin/platform-remittances/providers'), 'Failed to load platform providers.');
  providers.value = data.providers || [];
  if (!providers.value.some(row => String(row.order_type_id) === String(selectedProviderId.value))) selectedProviderId.value = providers.value[0]?.order_type_id || '';
}

async function refreshReceivables({ resetSelections = true } = {}) {
  if (!selectedProviderId.value) { receivables.value = []; selectedAllocations.clear(); return; }
  loadingReceivables.value = true;
  try {
    const data = assertSuccess(await fetchJson(`/api/admin/platform-remittances/receivables?order_type_id=${encodeURIComponent(selectedProviderId.value)}`), 'Failed to load platform receivables.');
    receivables.value = data.receivables || [];
    if (resetSelections) {
      selectedAllocations.clear();
      receivables.value.forEach(resetAllocation);
    }
  } finally {
    loadingReceivables.value = false;
  }
}

async function loadHistory() {
  loadingHistory.value = true;
  try {
    const params = new URLSearchParams();
    if (historyProviderId.value) params.set('order_type_id', historyProviderId.value);
    if (historyStartDate.value) params.set('start_date', historyStartDate.value);
    if (historyEndDate.value) params.set('end_date', historyEndDate.value);
    const data = assertSuccess(await fetchJson(`/api/admin/platform-remittances?${params}`), 'Failed to load platform settlement history.');
    remittances.value = data.remittances || [];
  } finally {
    loadingHistory.value = false;
  }
}

async function refreshAll() {
  loading.value = true;
  errorMessage.value = '';
  try { await loadProviders(); await Promise.all([refreshReceivables(), loadHistory()]); } catch (error) { errorMessage.value = error.message || 'Failed to load platform reconciliation.'; } finally { loading.value = false; }
}

async function selectProvider(id) {
  selectedProviderId.value = id;
  staleMessage.value = '';
  newIdempotencyKey();
  try { await refreshReceivables(); } catch (error) { errorMessage.value = error.message || 'Failed to load platform receivables.'; }
}

async function recordSettlement() {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMessage.value = '';
  const payload = {
    order_type_id: Number(selectedProviderId.value),
    invoice_allocations: allocationRows.value.filter(row => toCents(row.allocationAmount) !== 0).map(row => ({ invoice_id: row.invoice_id, balance_token: row.balance_token, allocation_amount: String(row.allocationAmount) })),
    adjustments: adjustments.value.map(row => ({ direction: row.direction, category: row.category, amount: String(row.amount), note: row.note || null })),
    net_received: String(netReceived.value || '0'),
    settled_on: settledOn.value || today(),
    statement_start_date: statementStartDate.value || undefined,
    statement_end_date: statementEndDate.value || undefined,
    reference: reference.value || undefined,
    idempotency_key: idempotencyKey.value || (newIdempotencyKey(), idempotencyKey.value)
  };
  try {
    const { response, data } = await fetchJsonResponse('/api/admin/platform-remittances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!data.success) {
      if (response.status === 409 && data.code === 'PLATFORM_REMITTANCE_STALE_BALANCE') {
        staleMessage.value = 'A balance changed while you were preparing this statement. Review the refreshed balances and explicitly select the allocations again.';
        await refreshReceivables({ resetSelections: false });
        selectedAllocations.clear();
        newIdempotencyKey();
        return;
      }
      errorMessage.value = data.message || 'Failed to record platform remittance.';
      return;
    }
    staleMessage.value = '';
    adjustments.value = [];
    netReceived.value = '';
    reference.value = '';
    statementStartDate.value = '';
    statementEndDate.value = '';
    newIdempotencyKey();
    await refreshAll();
  } catch (error) {
    errorMessage.value = error.message || 'Failed to record platform remittance.';
  } finally {
    submitting.value = false;
  }
}

async function openHistory(id) {
  errorMessage.value = '';
  try {
    const data = assertSuccess(await fetchJson(`/api/admin/platform-remittances/${id}`), 'Failed to load platform remittance.');
    historyDetail.value = data.remittance;
  } catch (error) {
    errorMessage.value = error.message || 'Failed to load platform remittance.';
  }
}

function beginReversal(target) {
  reverseTarget.value = target;
  reverseReason.value = '';
  reversalIdempotencyKey.value = crypto.randomUUID();
}

async function reverseSettlement() {
  if (!reverseTarget.value || !reverseReason.value) { errorMessage.value = 'A reversal reason is required.'; return; }
  reversing.value = true;
  try {
    const { data } = await fetchJsonResponse(`/api/admin/platform-remittances/${reverseTarget.value.id}/reverse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reverseReason.value, idempotency_key: reversalIdempotencyKey.value }) });
    if (!data.success) { errorMessage.value = data.message || 'Failed to reverse platform remittance.'; return; }
    reverseTarget.value = null;
    historyDetail.value = null;
    reverseReason.value = '';
    reversalIdempotencyKey.value = '';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error.message || 'Failed to reverse platform remittance.';
  } finally { reversing.value = false; }
}

watch([historyProviderId, historyStartDate, historyEndDate], () => loadHistory().catch((error) => {
  errorMessage.value = error.message || 'Failed to load platform settlement history.';
}));
onMounted(() => { newIdempotencyKey(); refreshAll(); });
</script>

<style scoped>
.payout-page {
  background: #f6f7f7;
}

.payout-providers {
  display: flex;
  margin-block-end: 16px;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid #dfe2e4;
  border-radius: 8px;
  background: #fff;
}

.payout-provider {
  flex: 1 0 220px;
  min-width: 0;
  padding: 9px 12px;
  border: 0;
  border-inline-end: 1px solid #e5e7e9;
  border-radius: 5px;
  color: #171b1f;
  background: #fff;
  text-align: start;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.payout-provider:last-of-type {
  border-inline-end: 0;
}

.payout-provider:hover {
  border-color: #99aaa7;
  background: #fbfcfc;
}

.payout-provider:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.payout-provider.is-active {
  background: var(--color-primary-container);
  box-shadow: inset 0 0 0 1px var(--color-primary);
}

.payout-provider__heading,
.payout-provider__balance,
.payout-provider__breakdown {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.payout-provider__heading strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.payout-provider__heading small {
  padding: 2px 5px;
  border-radius: 4px;
  color: #71717a;
  background: #eceeef;
  font-size: 9px;
  font-weight: 750;
}

.payout-provider__balance {
  margin-block: 7px 6px;
}

.payout-provider__balance small,
.payout-provider__breakdown small {
  color: #687078;
  font-size: 10.5px;
  font-weight: 600;
}

.payout-provider__balance strong {
  color: var(--color-primary);
  font-size: 15px;
}

.payout-provider__breakdown {
  padding-block-start: 6px;
  border-block-start: 1px solid #e5e7e9;
}

.payout-provider__breakdown b {
  margin-inline-start: 3px;
  color: #30373d;
}

.payout-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  grid-template-areas:
    "entry entry"
    "history history";
  align-items: start;
  gap: 16px;
}

.payout-entry-shell {
  grid-area: entry;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  grid-template-areas: "workbench summary";
  align-items: stretch;
}

.payout-workbench {
  grid-area: workbench;
  min-width: 0;
}

.payout-section-heading,
.payout-block__title,
.payout-summary > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.payout-section-heading {
  padding: 14px 16px;
  border-block-end: 1px solid #dfe2e4;
}

.payout-section-heading h3,
.payout-block__title h4,
.payout-summary h3 {
  color: #171b1f;
  font-size: 13px;
  font-weight: 800;
}

.payout-section-heading p,
.payout-block__title p,
.payout-summary header p {
  margin-block-start: 2px;
  color: #687078;
  font-size: 10.5px;
  line-height: 1.45;
}

.payout-warning {
  margin: 12px 16px 0;
  padding: 9px 11px;
  border: 1px solid #e7c87d;
  border-radius: 6px;
  color: #713f12;
  background: #fffbeb;
  font-size: 11px;
  font-weight: 650;
}

.payout-block {
  padding: 16px;
  border-block-end: 1px solid #dfe2e4;
}

.payout-block:last-child {
  border-block-end: 0;
}

.payout-block__title {
  margin-block-end: 10px;
}

.payout-count {
  min-width: 28px;
  padding: 3px 7px;
  border-radius: 5px;
  color: #596168;
  background: #eceeef;
  font-size: 11px;
  font-weight: 750;
  text-align: center;
}

.payout-invoices {
  overflow: hidden;
  border: 1px solid #dfe2e4;
  border-radius: 6px;
}

.payout-invoice {
  display: grid;
  grid-template-columns: minmax(110px, 1.35fr) 90px 105px minmax(185px, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 7px 10px;
  border-block-end: 1px solid #e8eaeb;
  font-size: 11.5px;
}

.payout-invoice:last-child {
  border-block-end: 0;
}

.payout-invoice--head {
  min-height: 34px;
  padding-block: 5px;
  color: #596168;
  background: #eef0f1;
  font-size: 10px;
  font-weight: 750;
}

.payout-invoice__identity {
  min-width: 0;
}

.payout-invoice__identity strong,
.payout-invoice__identity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.payout-invoice__identity small {
  margin-block-start: 2px;
  color: #71717a;
  font-size: 9.5px;
}

.payout-invoice__balance {
  font-weight: 750;
}

.payout-invoice__allocation {
  display: grid;
  grid-template-columns: minmax(70px, 1fr) auto;
  align-items: center;
  gap: 6px;
}

.payout-invoice__allocation > span {
  display: none;
}

.payout-invoice__allocation .admin-grid-input {
  width: 100%;
}

.payout-invoice__allocation .admin-grid-button {
  padding-inline: 9px;
  white-space: nowrap;
}

.payout-adjustment {
  display: grid;
  grid-template-columns: 105px 135px minmax(85px, .7fr) minmax(140px, 1.3fr) 34px;
  gap: 6px;
  margin-block-end: 6px;
  padding: 7px;
  border: 1px solid #dfe2e4;
  border-radius: 6px;
  background: #f8f9f9;
}

.payout-adjustment .admin-grid-icon-button {
  width: 34px;
}

.payout-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.payout-fields label {
  min-width: 0;
  color: #30373d;
  font-size: 10.5px;
  font-weight: 700;
}

.payout-fields label > span {
  display: block;
  margin-block-end: 4px;
}

.payout-fields .admin-grid-input {
  width: 100%;
}

.payout-fields__amount {
  grid-column: 1 / -1;
}

.payout-fields__amount .admin-grid-input {
  height: 42px;
  font-size: 15px;
  font-weight: 750;
}

.payout-summary {
  grid-area: summary;
  position: sticky;
  top: 0;
  align-self: start;
  min-width: 0;
  border-inline-start: 1px solid #dfe2e4;
  background: #f8f9f9;
}

.payout-summary > header {
  padding: 14px 16px 11px;
  border-block-end: 1px solid #dfe2e4;
}

.payout-summary dl {
  padding: 10px 16px;
}

.payout-summary dl > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 31px;
  color: #596168;
  font-size: 11px;
}

.payout-summary dd {
  color: #171b1f;
  font-weight: 750;
}

.payout-summary__total {
  margin-block-start: 5px;
  padding-block-start: 9px;
  border-block-start: 1px solid #dfe2e4;
}

.payout-summary__total dt,
.payout-summary__total dd {
  color: #171b1f !important;
  font-size: 13px;
  font-weight: 800;
}

.payout-summary__difference {
  margin-block-start: 3px;
  padding: 6px 8px;
  border-radius: 5px;
  background: #f3f4f5;
}

.payout-submit {
  width: calc(100% - 32px);
  min-height: 42px;
  margin: 0 16px 14px;
  justify-content: center;
}

.payout-validation {
  margin: -5px 16px 14px;
  color: #be123c;
  font-size: 10.5px;
  font-weight: 650;
}

.payout-history__filters {
  display: flex;
  align-items: center;
  gap: 6px;
}

.payout-history__filters select {
  min-width: 160px;
}

.payout-history__filters input {
  width: 145px;
}

.payout-history {
  grid-area: history;
}

.payout-history__heading {
  align-items: center;
}

.payout-history__list {
  max-height: 320px;
  overflow: auto;
}

.payout-history-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) 130px 90px;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 8px 16px;
  border-block-end: 1px solid #e8eaeb;
  color: #30373d;
  background: #fff;
  text-align: start;
}

.payout-history-row:hover {
  background: #f6f8f7;
}

.payout-history-row:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.payout-history-row__provider,
.payout-history-row__reference {
  min-width: 0;
}

.payout-history-row strong,
.payout-history-row small {
  display: block;
}

.payout-history-row strong {
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.payout-history-row small {
  margin-block-start: 2px;
  color: #71717a;
  font-size: 9.5px;
}

.payout-history-row__reference small {
  margin-block: 0 0 2px;
}

.payout-history-row__amount {
  text-align: end;
}

.payout-status {
  width: max-content;
  padding: 2px 5px;
  border-radius: 4px;
  color: var(--color-on-primary-container);
  background: var(--color-primary-container);
  font-size: 9px;
  font-weight: 750;
}

.payout-status.is-reversal {
  color: #be123c;
  background: #fff1f2;
}

.payout-empty {
  padding: 22px 14px;
  color: #71717a;
  font-size: 11px;
  text-align: center;
}

.payout-empty--compact {
  padding: 12px;
  border: 1px dashed #d4d8db;
  border-radius: 6px;
}

@media (max-width: 1279px) {
  .payout-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "entry"
      "history";
  }

  .payout-entry-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "workbench"
      "summary";
  }

  .payout-summary {
    position: static;
    border-block-start: 1px solid #dfe2e4;
    border-inline-start: 0;
  }

  .payout-summary dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 24px;
  }
}

@media (max-width: 767px) {
  .payout-history__heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .payout-history__filters {
    width: 100%;
  }

  .payout-history__filters select,
  .payout-history__filters input {
    flex: 1;
    min-width: 0;
    width: auto;
  }

  .payout-history-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .payout-history-row__reference {
    display: none;
  }

  .payout-adjustment {
    grid-template-columns: 1fr 1fr 44px;
  }

  .payout-adjustment input:nth-of-type(1),
  .payout-adjustment input:nth-of-type(2) {
    grid-column: span 1;
  }

  .payout-adjustment .admin-grid-icon-button {
    grid-column: 3;
    grid-row: 1;
    width: 44px;
  }
}

@media (max-width: 639px) {
  .payout-providers {
    margin-inline: -12px;
    padding-inline: 4px;
    border-inline: 0;
    border-radius: 0;
    scroll-snap-type: inline mandatory;
  }

  .payout-provider {
    flex: 0 0 min(76vw, 260px);
    scroll-snap-align: start;
  }

  .payout-section-heading,
  .payout-block__title {
    align-items: center;
  }

  .payout-section-heading p,
  .payout-block__title p {
    display: none;
  }

  .payout-block {
    padding: 12px;
  }

  .payout-invoice--head {
    display: none;
  }

  .payout-invoice {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px 12px;
    padding: 10px;
  }

  .payout-invoice__date {
    display: none;
  }

  .payout-invoice__balance {
    text-align: end;
  }

  .payout-invoice__allocation {
    grid-column: 1 / -1;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .payout-invoice__allocation > span {
    display: block;
    grid-column: 1 / -1;
    color: #687078;
    font-size: 9.5px;
    font-weight: 700;
  }

  .payout-adjustment {
    grid-template-columns: 1fr 1fr 44px;
  }

  .payout-adjustment input {
    grid-column: span 1;
  }

  .payout-fields {
    grid-template-columns: 1fr;
  }

  .payout-fields__amount {
    grid-column: auto;
  }

  .payout-summary dl {
    grid-template-columns: 1fr;
  }

  .payout-history__filters {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .payout-history__filters select {
    grid-column: 1 / -1;
  }

  .payout-history-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 10px;
    padding-inline: 12px;
  }

  .payout-history-row__amount {
    grid-row: 1 / span 2;
    grid-column: 2;
  }

  .payout-page .admin-grid-button,
  .payout-page .admin-grid-input,
  .payout-page .admin-grid-select {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .payout-provider {
    transition: none;
  }
}
</style>

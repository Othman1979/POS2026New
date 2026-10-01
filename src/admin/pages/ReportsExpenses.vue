<script setup lang="ts">
import { fetchJsonResponse, fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDailyReportPage } from '../composables/useDailyReportPage.js'
import { formatReportMoney } from '../utils/reportFormatting.js'
import { buildDailyExpensePrintPayload } from './dailyReportPayloads.js'
import ExpenseCategoryModal from '../components/ExpenseCategoryModal.vue'
import { t } from '@/shared/i18n.js'
import { formatBusinessDateTime } from '../../utils/businessDate.js'

const period = inject<any>('dailyReportPeriod')
const registerDailyReportPrint = inject<any>('registerDailyReportPrint')
const { data, loading, error, reload } = useDailyReportPage('expenses', period)
const reportData = computed(() => data.value)
const showEntry = ref(false)
const showCategories = ref(false)
const saving = ref(false)
const actionError = ref('')
const cancellingId = ref<number | null>(null)
let cancelController: AbortController | null = null
const form = ref({ category_id: '', amount: '', source: 'outside', shift_id: '', note: '' })

const activeCategories = computed(() => (reportData.value?.categories || []).filter((category: any) => category.is_active))

function resetForm() {
  form.value = { category_id: '', amount: '', source: 'outside', shift_id: '', note: '' }
  actionError.value = ''
}

function openEntry() {
  resetForm()
  if (activeCategories.value.length === 1) form.value.category_id = String(activeCategories.value[0].id)
  showEntry.value = true
}

async function saveExpense() {
  saving.value = true
  actionError.value = ''
  try {
    const { response, data: json } = await fetchJsonResponse('api/admin/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: Number(form.value.category_id),
        amount: Number(form.value.amount),
        source: form.value.source,
        shift_id: form.value.source === 'drawer' ? Number(form.value.shift_id) : null,
        note: form.value.note,
        receipt_printer_id: localStorage.getItem('pos_receipt_printer_id') || '',
        language: localStorage.getItem('pos_admin_language') || 'en',
      }),
    });
    if (!response.ok || !json.success) throw new Error(json.message || 'Could not record expense.')
    const printFailed = form.value.source === 'drawer' && json.print_queued !== true
    showEntry.value = false
    resetForm()
    await reload()
    if (printFailed) actionError.value = 'Expense saved, but it could not be sent to the printer.'
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : 'Could not record expense.'
  } finally {
    saving.value = false
  }
}

async function cancelExpense(expense: any) {
  if (cancellingId.value !== null || expense.status !== 'active') return
  const confirmation = [t('Cancel this expense?'), `${expense.category_name} · ${formatReportMoney(expense.amount)}`]
  if (expense.source === 'drawer') confirmation.push(t('For a closed shift, expected cash increases by this amount. Counted cash stays unchanged.'))
  if (!window.confirm(confirmation.join('\n\n'))) return
  cancellingId.value = expense.id
  const controller = new AbortController()
  cancelController = controller
  actionError.value = ''
  try {
    const { response, data: json } = await fetchJsonResponseWithTimeout(`api/admin/expenses/${expense.id}/cancel`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_printer_id: localStorage.getItem('pos_receipt_printer_id') || '',
        language: localStorage.getItem('pos_admin_language') || 'en',
      }),
    }, 30000);
    if (controller.signal.aborted) return
    if (!response.ok || !json.success) throw new Error(json.message || 'Could not cancel expense.')
    // Keep the confirmed status if refreshing the server-calculated totals fails.
    const entry = data.value?.entries.find((item: any) => item.id === expense.id)
    if (entry) Object.assign(entry, json.expense)
    // The report owns read errors/abort cleanup; its refresh must not lock further actions.
    void reload()
    if (expense.source === 'drawer' && json.print_queued !== true) {
      actionError.value = 'Expense canceled, but it could not be sent to the printer.'
    }
  } catch (caught) {
    if (controller.signal.aborted) return
    actionError.value = caught instanceof Error ? caught.message : 'Could not cancel expense.'
    // A lost response can follow a committed cancellation. Read back; never repeat the POST.
    void reload()
  } finally {
    cancellingId.value = null
    cancelController = null
  }
}

async function reprintExpense(expense: any) {
  actionError.value = ''
  try {
    const { response, data: json } = await fetchJsonResponse('api/print/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        print_type: expense.status === 'canceled' ? 'expense_cancel_slip' : 'expense_slip',
        expense_id: expense.id,
        receipt_printer_id: localStorage.getItem('pos_receipt_printer_id') || '',
        language: localStorage.getItem('pos_admin_language') || 'en',
      }),
    });
    if (!response.ok || !json.success) throw new Error(json.message || 'Could not print expense.')
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : 'Could not print expense.'
  }
}

function registerProvider() {
  registerDailyReportPrint?.(data.value ? async () => buildDailyExpensePrintPayload(data.value) : null)
}

onMounted(registerProvider)
watch(data, registerProvider)
onUnmounted(() => {
  cancelController?.abort()
  registerDailyReportPrint?.(null)
})
</script>

<template>
  <div v-if="loading && !data" class="report-state"><p>{{ $t('Loading report...') }}</p></div>
  <div v-else-if="error && !data" class="report-state"><div><p class="font-semibold text-rose-700">{{ $t(error) }}</p><button class="mt-4" @click="reload">{{ $t('Retry') }}</button></div></div>
  <div v-else-if="reportData" class="report-page expenses-page">
    <div v-if="error || actionError" class="report-error" role="alert"><span>{{ $t(error || actionError) }}</span><button @click="error ? reload() : actionError = ''">{{ $t('Dismiss') }}</button></div>

    <section class="expense-overview">
      <div class="expense-overview__primary"><span>{{ $t('Recorded expenses') }}</span><strong>{{ formatReportMoney(reportData.summary.total) }}</strong><small>{{ reportData.summary.count }} {{ $t('entries') }}</small></div>
      <div><span>{{ $t('From cash drawers') }}</span><strong>{{ formatReportMoney(reportData.summary.drawer) }}</strong></div>
      <div><span>{{ $t('Outside POS') }}</span><strong>{{ formatReportMoney(reportData.summary.outside) }}</strong></div>
      <div class="expense-overview__remaining"><span>{{ $t('Remaining after expenses') }}</span><strong>{{ formatReportMoney(reportData.remaining_after_expenses ?? 0) }}</strong></div>
    </section>

    <div class="expense-toolbar print:hidden">
      <p>{{ $t('Sales stay unchanged. Expenses are shown as a separate business-day outflow.') }}</p>
      <div>
        <button type="button" class="expense-button expense-button--secondary" @click="showCategories = true">{{ $t('Manage categories') }}</button>
        <button type="button" class="expense-button expense-button--primary" :disabled="!reportData.is_current_business_day || activeCategories.length === 0" @click="openEntry">{{ $t('Add expense') }}</button>
      </div>
    </div>

    <div class="expense-content-grid">
      <section class="report-section">
        <header class="report-section__header"><h2 class="report-section__title">{{ $t('By category') }}</h2></header>
        <div v-if="!reportData.by_category.length" class="expense-empty">{{ $t('No expenses in this period.') }}</div>
        <dl v-else class="expense-category-list">
          <div v-for="category in reportData.by_category" :key="category.category_id"><dt><strong data-no-i18n>{{ category.category_name }}</strong><small>{{ category.count }} {{ $t('entries') }}</small></dt><dd>{{ formatReportMoney(category.total) }}</dd></div>
        </dl>
      </section>

      <section class="report-section expense-log">
        <header class="report-section__header"><h2 class="report-section__title">{{ $t('Expense log') }}</h2><span class="report-section__hint">{{ $t('Canceled entries do not affect totals') }}</span></header>
        <div v-if="!reportData.entries.length" class="expense-empty">{{ $t('No expenses in this period.') }}</div>
        <div v-else class="expense-table-wrap">
          <table>
            <thead><tr><th>{{ $t('Time') }}</th><th>{{ $t('Category') }}</th><th>{{ $t('Source') }}</th><th>{{ $t('Recorded by') }}</th><th>{{ $t('Note') }}</th><th>{{ $t('Amount') }}</th><th></th></tr></thead>
            <tbody>
              <tr v-for="entry in reportData.entries" :key="entry.id" :class="{ 'is-canceled': entry.status === 'canceled' }">
                <td class="tabular-nums" data-no-i18n>{{ formatBusinessDateTime(entry.created_at) }}</td>
                <td data-no-i18n>{{ entry.category_name }}</td>
                <td>{{ $t(entry.source) }}<small v-if="entry.shift_id" data-no-i18n>#{{ entry.shift_id }}</small></td>
                <td data-no-i18n>{{ entry.created_by_name }}</td>
                <td data-no-i18n>{{ entry.note || '-' }}</td>
                <td class="tabular-nums"><strong>{{ formatReportMoney(entry.amount) }}</strong><small v-if="entry.status === 'canceled'">{{ $t('Canceled') }}</small></td>
                <td><div class="expense-actions"><button type="button" class="expense-reprint" @click="reprintExpense(entry)">{{ $t('Reprint') }}</button><button v-if="entry.status === 'active'" type="button" class="expense-cancel" :disabled="cancellingId !== null" @click="cancelExpense(entry)">{{ $t(cancellingId === entry.id ? 'Canceling...' : 'Cancel expense') }}</button></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <Teleport to="body"><div v-if="showEntry" class="expense-entry-backdrop" @click.self="showEntry = false"><section class="expense-entry-dialog" role="dialog" aria-modal="true"><header><div><h2>{{ $t('Add expense') }}</h2><p>{{ $t('Record an expense for the current business day.') }}</p></div><button @click="showEntry = false">×</button></header><form @submit.prevent="saveExpense">
      <label><span>{{ $t('Category') }}</span><select v-model="form.category_id" required><option value="" disabled>{{ $t('Choose category') }}</option><option v-for="category in activeCategories" :key="category.id" :value="String(category.id)" data-no-i18n>{{ category.name }}</option></select></label>
      <label><span>{{ $t('Payment source') }}</span><select v-model="form.source"><option value="outside">{{ $t('Outside POS') }}</option><option value="drawer" :disabled="reportData.open_shifts.length === 0">{{ $t('Cash drawer') }}</option></select></label>
      <label v-if="form.source === 'drawer'"><span>{{ $t('Cash drawer') }}</span><select v-model="form.shift_id" required><option value="" disabled>{{ $t('Choose open shift') }}</option><option v-for="shift in reportData.open_shifts" :key="shift.id" :value="String(shift.id)" data-no-i18n>#{{ shift.id }} · {{ shift.cashier_name }}</option></select></label>
      <label><span>{{ $t('Amount') }}</span><input v-model="form.amount" type="number" inputmode="decimal" min="0" step="0.01" required dir="ltr" /></label>
      <label class="expense-entry-note"><span>{{ $t('Note (optional)') }}</span><textarea v-model="form.note" maxlength="255" rows="3"></textarea></label>
      <p v-if="actionError" class="expense-form-error">{{ $t(actionError) }}</p><div class="expense-entry-actions"><button type="button" @click="showEntry = false">{{ $t('Cancel') }}</button><button type="submit" :disabled="saving">{{ saving ? $t('Saving...') : $t('Save expense') }}</button></div>
    </form></section></div></Teleport>

    <ExpenseCategoryModal :open="showCategories" :categories="reportData.categories" @close="showCategories = false" @changed="reload" />
  </div>
</template>

<style scoped>
.expenses-page { display: grid; gap: 1rem; }.expense-overview { display: grid; grid-template-columns: 1.4fr repeat(3, 1fr); overflow: hidden; border: 1px solid #d4d4d8; border-radius: 12px; background: #fff; }.expense-overview > div { display: flex; min-height: 7.5rem; flex-direction: column; justify-content: center; border-inline-start: 1px solid #e4e4e7; padding: 1.1rem; }.expense-overview > div:first-child { border-inline-start: 0; background: #fafafa; }.expense-overview span { color: #71717a; font-size: .72rem; font-weight: 700; }.expense-overview strong { margin-top: .45rem; color: #27272a; font-size: 1.45rem; }.expense-overview__primary strong { font-size: 2.2rem; }.expense-overview small { margin-top: .3rem; color: #71717a; font-size: .68rem; }.expense-overview__remaining strong { color: #24405e; }
.expense-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid #d4d4d8; border-radius: 10px; padding: .75rem 1rem; background: #fafafa; }.expense-toolbar p { color: #71717a; font-size: .72rem; }.expense-toolbar > div { display: flex; gap: .5rem; }.expense-button { min-height: 2.65rem; border-radius: 8px; padding: .55rem .85rem; font-size: .75rem; font-weight: 800; }.expense-button--secondary { border: 1px solid #d4d4d8; color: #3f3f46; background: #fff; }.expense-button--primary { color: #fff; background: #24405e; }.expense-button:disabled { opacity: .45; }
.expense-content-grid { display: grid; grid-template-columns: minmax(14rem,.65fr) minmax(0,2fr); gap: 1rem; }.expense-category-list { padding: .35rem 1rem 1rem; }.expense-category-list > div { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #f4f4f5; padding: .75rem 0; }.expense-category-list dt { display: grid; gap: .2rem; }.expense-category-list dt strong { font-size: .8rem; }.expense-category-list small { color: #71717a; font-size: .66rem; }.expense-category-list dd { font-weight: 800; }.expense-empty { padding: 2rem; color: #71717a; font-size: .78rem; text-align: center; }
.expense-table-wrap { overflow-x: auto; }.expense-log table { width: 100%; min-width: 48rem; border-collapse: collapse; }.expense-log th,.expense-log td { border-bottom: 1px solid #e4e4e7; padding: .7rem .75rem; font-size: .7rem; text-align: start; vertical-align: middle; }.expense-log th { color: #71717a; background: #fafafa; font-weight: 750; }.expense-log td small { display: block; margin-top: .15rem; color: #71717a; }.expense-log tr.is-canceled { color: #71717a; background: #fafafa; text-decoration-color: #a1a1aa; }.expense-cancel { min-height: 2.25rem; border: 1px solid #fecdd3; border-radius: 7px; padding: .35rem .55rem; color: #be123c; background: #fff1f2; font-weight: 750; }
.expense-actions { display: flex; gap: .35rem; }.expense-reprint { min-height: 2.25rem; border: 1px solid #d4d4d8; border-radius: 7px; padding: .35rem .55rem; color: #3f3f46; background: #fff; font-weight: 750; }
.expense-cancel:disabled { opacity: .5; cursor: wait; }
.expense-entry-backdrop { position: fixed; inset: 0; z-index: 170; display: grid; place-items: center; padding: 1rem; background: rgb(15 23 42 / 58%); }.expense-entry-dialog { width: min(38rem,100%); overflow: hidden; border-radius: 12px; background: #fff; box-shadow: 0 20px 55px rgb(15 23 42 / 24%); }.expense-entry-dialog header { display: flex; justify-content: space-between; border-bottom: 1px solid #e4e4e7; padding: 1rem; background: #fafafa; }.expense-entry-dialog h2 { font-weight: 800; }.expense-entry-dialog header p { margin-top: .2rem; color: #71717a; font-size: .72rem; }.expense-entry-dialog header button { width: 2.5rem; height: 2.5rem; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; font-size: 1.3rem; }.expense-entry-dialog form { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; padding: 1rem; }.expense-entry-dialog label span { display: block; margin-bottom: .3rem; color: #52525b; font-size: .72rem; font-weight: 750; }.expense-entry-dialog select,.expense-entry-dialog input,.expense-entry-dialog textarea { width: 100%; min-height: 2.75rem; border: 1px solid #d4d4d8; border-radius: 8px; padding: .55rem .7rem; outline: none; }.expense-entry-note,.expense-entry-actions,.expense-form-error { grid-column: 1/-1; }.expense-form-error { color: #be123c; font-size: .72rem; font-weight: 700; }.expense-entry-actions { display: grid; grid-template-columns: .8fr 1.4fr; gap: .6rem; }.expense-entry-actions button { min-height: 2.8rem; border: 1px solid #d4d4d8; border-radius: 8px; font-weight: 800; }.expense-entry-actions button:last-child { border-color: #24405e; color: #fff; background: #24405e; }
@media (max-width: 900px) { .expense-overview { grid-template-columns: 1fr 1fr; }.expense-overview > div { border-top: 1px solid #e4e4e7; }.expense-overview > div:nth-child(odd) { border-inline-start: 0; }.expense-content-grid { grid-template-columns: 1fr; }.expense-toolbar { flex-direction: column; align-items: stretch; }.expense-toolbar > div { display: grid; grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .expense-overview { grid-template-columns: 1fr; }.expense-overview > div { min-height: 5.5rem; border-inline-start: 0; }.expense-toolbar > div,.expense-entry-dialog form { grid-template-columns: 1fr; }.expense-entry-note,.expense-entry-actions,.expense-form-error { grid-column: auto; }.expense-entry-backdrop { align-items: end; padding: 0; }.expense-entry-dialog { border-radius: 12px 12px 0 0; }.expense-entry-actions { grid-template-columns: 1fr 1fr; } }
</style>

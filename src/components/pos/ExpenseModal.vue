<script setup lang="ts">
import { fetchJsonResponseWithTimeout, fetchReadJsonResponse } from '@/shared/http.js';
import { ref, watch } from 'vue'
import { currentLanguage } from '@/shared/i18n.js'
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js'
import { createRequestId } from '@/shared/requestId.js'

interface ExpenseCategory {
  id: number
  name: string
}

const props = defineProps<{
  open: boolean
  isDarkMode?: boolean
  receiptPrinterId?: number | string | null
}>()

const emit = defineEmits<{
  close: []
  saved: [expense: Record<string, unknown>, printQueued: boolean]
}>()

const categories = ref<ExpenseCategory[]>([])
const categoryId = ref<number | ''>('')
const amount = ref('')
const note = ref('')
const loadingCategories = ref(false)
const saving = ref(false)
// After an unanswered submit the form is frozen: Record retries that exact expense, Cancel starts over.
const unconfirmed = ref(false)
const error = ref('')
const dialog = ref<HTMLElement | null>(null)
// One id per open form: a retry after a lost response replays instead of recording twice.
// createRequestId falls back to getRandomValues on plain-HTTP LAN terminals.
let requestId = createRequestId()

function resetForm() {
  categoryId.value = ''
  amount.value = ''
  note.value = ''
  error.value = ''
  saving.value = false
  unconfirmed.value = false
  requestId = createRequestId()
}

async function loadCategories() {
  loadingCategories.value = true
  error.value = ''
  try {
    const { response, data: json } = await fetchReadJsonResponse('api/pos/expense-categories');
    if (!response.ok || !json.success) throw new Error(json.message || 'Could not load expense categories.')
    categories.value = json.categories || []
    if (categories.value.length === 1) categoryId.value = categories.value[0].id
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load expense categories.'
  } finally {
    loadingCategories.value = false
  }
}

async function submit() {
  if (!categoryId.value || amount.value === '') {
    error.value = 'Choose a category and enter the amount.'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const { response, data: json } = await fetchJsonResponseWithTimeout('api/pos/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category_id: categoryId.value,
        amount: Number(amount.value),
        note: note.value,
        receipt_printer_id: props.receiptPrinterId || null,
        language: currentLanguage.value,
        request_id: requestId,
      }),
    });
    if (!response.ok || !json.success) throw new Error(json.message || 'Could not record expense.')
    emit('saved', json.expense, json.print_queued === true || json.replayed === true)
    resetForm()
    emit('close')
  } catch (caught) {
    // No answer (timeout or network): the server may have saved it, so keep the same request_id.
    unconfirmed.value = caught instanceof TypeError || (caught as Error)?.name === 'TimeoutError' || (caught as Error)?.name === 'AbortError'
    error.value = unconfirmed.value
      ? 'Expense not confirmed. Record expense again to retry the same request.'
      : caught instanceof Error ? caught.message : 'Could not record expense.'
  } finally {
    saving.value = false
  }
}

function close() {
  if (saving.value) return
  resetForm()
  emit('close')
}

usePosDialogFocus({ open: () => props.open, dialog, onEscape: close })

watch(() => props.open, (open) => {
  if (open) {
    resetForm()
    loadCategories()
  } else {
    resetForm()
  }
}, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <Transition name="expense-dialog">
      <div v-if="open" :class="['expense-backdrop', { 'pos-polish': true, 'pos-theme-dark': props.isDarkMode }]" @click.self="close">
        <section ref="dialog" class="expense-dialog modal-panel" role="dialog" aria-modal="true" :aria-label="$t('Record expense')" tabindex="-1">
          <header>
            <div>
              <h2>{{ $t('Record expense') }}</h2>
              <p>{{ $t('This amount will be deducted from your current cash drawer.') }}</p>
            </div>
            <button type="button" class="expense-close" :aria-label="$t('Close')" @click="close">×</button>
          </header>

          <form @submit.prevent="submit">
            <label>
              <span>{{ $t('Category') }}</span>
              <select v-model="categoryId" required :disabled="loadingCategories || saving || unconfirmed">
                <option value="" disabled>{{ $t('Choose category') }}</option>
                <option v-for="category in categories" :key="category.id" :value="category.id" data-no-i18n>
                  {{ category.name }}
                </option>
              </select>
            </label>

            <label>
              <span>{{ $t('Amount') }}</span>
              <div class="expense-amount">
                <input v-model="amount" type="number" inputmode="decimal" enterkeyhint="done" min="0" max="99999999.99" step="0.01" required dir="ltr" :disabled="saving || unconfirmed" />
                <strong data-no-i18n>JD</strong>
              </div>
            </label>

            <label>
              <span>{{ $t('Note (optional)') }}</span>
              <textarea v-model="note" inputmode="text" enterkeyhint="done" maxlength="255" rows="3" :disabled="saving || unconfirmed"></textarea>
            </label>

            <p v-if="error" class="expense-error" role="alert">{{ $t(error) }}</p>
            <p v-else-if="!loadingCategories && categories.length === 0" class="expense-error">
              {{ $t('Ask an administrator to create an expense category first.') }}
            </p>

            <div class="expense-actions modal-actions">
              <button type="button" class="expense-secondary modal-action" :disabled="saving" @click="close">{{ $t('Cancel') }}</button>
              <button type="submit" class="expense-primary modal-action modal-action--primary" :disabled="saving || loadingCategories || categories.length === 0">
                {{ saving ? $t('Saving...') : $t('Record expense') }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.expense-backdrop { position: fixed; inset: 0; z-index: 190; display: grid; place-items: center; padding: 1rem; background: rgb(15 23 42 / 58%); }
.expense-dialog { display: flex; width: min(31rem, 100%); max-height: calc(100dvh - 2rem); overflow: hidden; flex-direction: column; border: 1px solid rgb(148 163 184 / 45%); border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgb(15 23 42 / 25%); }
.expense-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #e2e8f0; padding: 1rem; background: #f8fafc; }
.expense-dialog h2 { margin: 0; color: #0f172a; font-size: 1.05rem; font-weight: 800; line-height: 1.35; }
.expense-dialog header p { margin: .25rem 0 0; color: #64748b; font-size: .78rem; line-height: 1.5; }
.expense-close { display: grid; width: 2.75rem; height: 2.75rem; flex: 0 0 auto; place-items: center; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0; color: #334155; background: #fff; font-size: 1.4rem; line-height: 1; }
.expense-dialog form { display: grid; overflow-y: auto; gap: .75rem; padding: 1rem; overscroll-behavior: contain; }
.expense-dialog label > span { display: block; margin-bottom: .25rem; color: #334155; font-size: .78rem; font-weight: 750; }
.expense-dialog select, .expense-dialog input, .expense-dialog textarea { width: 100%; min-height: 3rem; border: 1px solid #cbd5e1; border-radius: 8px; padding: .7rem .8rem; color: #0f172a; background: #fff; font-size: 1rem; outline: none; }
.expense-dialog select:focus, .expense-dialog textarea:focus { border-color: #24405e; box-shadow: 0 0 0 3px rgb(36 64 94 / 14%); }
.expense-amount { display: grid; overflow: hidden; grid-template-columns: minmax(0, 1fr) auto; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
.expense-amount:focus-within { border-color: #24405e; box-shadow: 0 0 0 3px rgb(36 64 94 / 14%); }
.expense-amount input { min-width: 0; border: 0; border-radius: 0; text-align: end; box-shadow: none; }
.expense-amount input:focus { box-shadow: none; }
.expense-amount strong { display: grid; min-width: 3.5rem; place-items: center; border-inline-start: 1px solid #cbd5e1; color: #475569; background: #f1f5f9; }
.expense-error { margin: 0; color: #be123c; font-size: .78rem; font-weight: 700; line-height: 1.5; }
.expense-actions { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.4fr); gap: .75rem; padding-top: .25rem; }
.expense-actions button { min-height: 3rem; border-radius: 8px; padding: .7rem 1rem; font-weight: 800; }
.expense-secondary { border: 1px solid #cbd5e1; color: #334155; background: #fff; }
.expense-primary { border: 1px solid #24405e; color: #fff; background: #24405e; }
.expense-close:focus-visible, .expense-actions button:focus-visible { outline: 2px solid #24405e; outline-offset: 2px; }
.expense-actions button:disabled { cursor: not-allowed; opacity: .55; }
.expense-dialog-enter-active, .expense-dialog-leave-active { transition: opacity 150ms ease; }
.expense-dialog-enter-active .expense-dialog, .expense-dialog-leave-active .expense-dialog { transition: transform 180ms cubic-bezier(.16, 1, .3, 1), opacity 150ms ease; }
.expense-dialog-enter-from, .expense-dialog-leave-to { opacity: 0; }
.expense-dialog-enter-from .expense-dialog, .expense-dialog-leave-to .expense-dialog { opacity: 0; transform: translateY(8px) scale(.99); }
@media (max-width: 520px) { .expense-backdrop { align-items: end; padding: 0; } .expense-dialog { width: 100%; max-height: 100dvh; border-radius: 12px 12px 0 0; } .expense-dialog form { padding-bottom: max(1rem, env(safe-area-inset-bottom)); } }
@media (prefers-reduced-motion: reduce) { .expense-dialog-enter-active, .expense-dialog-leave-active, .expense-dialog-enter-active .expense-dialog, .expense-dialog-leave-active .expense-dialog { transition: none; } }
</style>

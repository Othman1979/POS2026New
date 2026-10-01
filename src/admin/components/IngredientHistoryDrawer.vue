<template>
    <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-[100] flex justify-end bg-zinc-900/40" @click.self="closeDrawer">
        <aside ref="dialog" tabindex="-1" class="ingredient-history-panel h-full w-full max-w-md bg-card border-s border-zinc-200 shadow-2xl flex flex-col" role="dialog" aria-modal="true" :aria-label="$t(correctionTarget ? 'Correct recorded quantity' : 'History')">
            <header class="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
                <div><h3 class="font-display font-semibold text-sm text-foreground">{{ $t(correctionTarget ? 'Correct recorded quantity' : 'History') }}</h3><p class="text-xs mt-1" data-no-i18n>{{ ingredient?.name }}</p></div>
                <button type="button" :aria-label="$t('Close')" @click="closeDrawer" class="w-11 h-11 text-muted-foreground hover:bg-muted rounded-lg">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>
            <form v-if="!correctionTarget" class="history-filter" @submit.prevent="refresh">
                <label>{{ $t('Show movements from') }}<select v-model="dateRange" @change="changeRange"><option value="today">{{ $t('Today') }}</option><option value="week">{{ $t('Last 7 days') }}</option><option value="month">{{ $t('Last 30 days') }}</option><option value="custom">{{ $t('Choose dates') }}</option></select></label>
                <template v-if="dateRange === 'custom'">
                <label class="min-w-0">{{ $t('From') }}<input v-model="from" type="date" required class="block min-h-11 w-full border border-zinc-300 rounded px-2"></label>
                <label class="min-w-0">{{ $t('To') }}<input v-model="to" type="date" required class="block min-h-11 w-full border border-zinc-300 rounded px-2"></label>
                <button type="submit" :disabled="loading" class="self-end min-h-11 px-2 border border-zinc-300 rounded">{{ $t('Apply') }}</button>
                </template>
            </form>
            <form v-if="correctionTarget" class="correction-form" @submit.prevent="saveCorrection">
                <div class="correction-body">
                    <button type="button" class="back-history" :disabled="correcting" @click="closeCorrection">{{ $t('Back to history') }}</button>
                    <p>{{ $t('Enter what the quantity should have been. The original entry stays in history.') }}</p>
                    <div class="correction-original"><span>{{ $t('Originally recorded') }}</span><strong dir="ltr" data-no-i18n>{{ quantityLabel(Math.abs(Number(correctionTarget.qty))) }}</strong></div>
                    <fieldset :disabled="correcting || correctionUncertain">
                        <label>{{ $t('Correct quantity') }} <span data-no-i18n>({{ ingredient?.display_unit }})</span><input v-model="correctionQty" type="number" min="0" step="any" required></label>
                        <button type="button" class="cancel-entry" @click="correctionQty = 0">{{ $t('This entry should not have been recorded') }}</button>
                        <label>{{ $t('Why are you correcting it?') }}<textarea v-model="correctionNote" required maxlength="500" rows="3" :placeholder="$t('For example: entered 10 kg, but received 8 kg')"></textarea></label>
                    </fieldset>
                    <div v-if="correctionQty !== ''" class="correction-original"><span>{{ $t('Adjustment to the original entry') }}</span><strong dir="ltr" data-no-i18n>{{ correctionDelta }}</strong></div>
                    <p class="history-hint">{{ $t('If stock was counted after this entry, that count stays unchanged. This correction does not record another delivery.') }}</p>
                    <p v-if="correctionUncertain" role="alert">{{ $t('We could not confirm whether this was saved. Retry without changing the quantities to avoid recording it twice.') }}</p>
                    <p v-if="error" role="alert">{{ $t(error) }}</p>
                </div>
                <footer><button type="button" :disabled="correcting" @click="closeCorrection">{{ $t('Cancel') }}</button><button type="submit" class="primary" :disabled="correcting || correctionQty === '' || !correctionNote.trim()">{{ $t(correcting ? 'Saving...' : correctionUncertain ? 'Retry' : 'Save correction') }}</button></footer>
            </form>
            <div v-else class="flex-1 overflow-y-auto p-4 space-y-2">
                <p v-if="error" role="alert" class="text-xs font-semibold text-red-600">{{ $t(error) }}</p>
                <p v-if="loading" role="status" class="text-xs">{{ $t('Loading history...') }}</p>
                <p v-else-if="!rows.length && !error" class="text-xs">{{ $t('No movements in this period.') }}</p>
                <div v-for="row in rows" :key="row.id" class="rounded-lg border border-zinc-200 p-3 text-xs">
                    <div class="flex justify-between gap-2">
                        <span class="font-bold uppercase tracking-wide text-muted-foreground">{{ $t(kindLabel(row.kind)) }}</span>
                        <span dir="ltr" data-no-i18n>{{ quantityLabel(row.qty) }}</span>
                    </div>
                    <div class="text-muted-foreground mt-1" data-no-i18n><bdi dir="ltr">{{ formatBusinessDateTime(row.occurred_at) }}</bdi></div>
                    <div class="mt-1">{{ $t('Balance after this entry') }} <span dir="ltr" data-no-i18n>{{ quantityLabel(row.running_balance) }}</span></div>
                    <button
                        v-if="canCorrect(row)"
                        type="button"
                        :disabled="correcting"
                        class="mt-2 text-teal-700 font-bold"
                        @click="startCorrection(row)"
                    >{{ $t('Correct recorded quantity') }}</button>
                    <p v-if="row.corrected_by_id" class="history-hint">{{ $t('Corrected — original entry retained') }}</p>
                    <p v-if="row.kind === 'correction' && row.original_qty != null" class="history-hint">{{ $t('Corrected quantity') }}: <strong dir="ltr" data-no-i18n>{{ quantityLabel(Math.abs(Number(row.original_qty) + Number(row.qty))) }}</strong></p>
                    <p v-if="row.user_name" class="history-hint" data-no-i18n>{{ row.user_name }}</p>
                    <p v-if="row.note" class="mt-1" data-no-i18n>{{ row.note }}</p>
                </div>
                <button v-if="hasMore" type="button" :disabled="loading" class="w-full h-11 border border-zinc-300 rounded-md text-xs font-bold" @click="loadMore">{{ $t('Load more') }}</button>
            </div>
        </aside>
    </div>
    </Teleport>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { fetchJson, fetchJsonResponse } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';
import { createRequestId } from '@/shared/requestId.js';
import { customAlert, customConfirm, customPrompt } from '../composables/useAdminDialogs.js';
import { fromBaseQty, SCALE } from '@/shared/ingredientUnits.js';
import { currentBusinessDate, addBusinessDateDays, formatBusinessDateTime } from '../../utils/businessDate.js';

const props = defineProps({
    show: { type: Boolean, default: false },
    ingredient: { type: Object, default: null }
});
const emit = defineEmits(['close', 'changed']);

const rows = ref([]);
const error = ref('');
const hasMore = ref(false);
const correctedIds = ref(new Set());
const from = ref('');
const to = ref('');
const dialog = ref(null);
const loading = ref(false);
const correcting = ref(false);
const dateRange = ref('week');
const correctionTarget = ref(null), correctionQty = ref(''), correctionNote = ref(''), correctionUncertain = ref(false);
let correctionKey = '', correctionPayload = '';
const correctionDelta = computed(() => {
    if (!correctionTarget.value || correctionQty.value === '') return '—';
    const old = Number(correctionTarget.value.qty);
    const desired = Number(correctionQty.value) * (SCALE[props.ingredient?.display_unit] || 1) * (correctionTarget.value.kind === 'waste' ? -1 : 1);
    return quantityLabel(desired - old);
});
function changeRange() {
    if (dateRange.value === 'custom') return;
    to.value = currentBusinessDate();
    from.value = addBusinessDateDays(to.value, dateRange.value === 'today' ? 0 : dateRange.value === 'month' ? -29 : -6);
    void refresh();
}
function startCorrection(row) {
    correctionTarget.value = row; correctionQty.value = ''; correctionNote.value = ''; error.value = '';
    correctionUncertain.value = false; correctionKey = ''; correctionPayload = '';
    void nextTick(() => dialog.value?.querySelector('input[type=number]')?.focus());
}
async function closeCorrection() {
    if (correcting.value) return false;
    if ((correctionQty.value !== '' || correctionNote.value) && !await window.showAdminConfirm(t(correctionUncertain.value ? 'The result is unconfirmed. Check movement history before entering this operation again. Close anyway?' : 'Discard this correction draft?'))) return false;
    correctionTarget.value = null; error.value = ''; return true;
}
async function closeDrawer() {
    if (correcting.value) return;
    if (correctionTarget.value && !await closeCorrection()) return;
    emit('close');
}
let requestSeq = 0;
let controller;
let restoreFocus;

function quantityLabel(qty) {
    if (qty == null) return '—';
    const unit = props.ingredient?.display_unit || 'unit';
    return `${fromBaseQty(qty, unit)} ${unit}`;
}

function onKeydown(event) {
    if (customAlert.value.show || customConfirm.value.show || customPrompt.value.show) return;
    if (event.key === 'Escape') { event.preventDefault(); void (correctionTarget.value ? closeCorrection() : closeDrawer()); }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
        event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
    }
}

function kindLabel(kind) {
    return ({
        receipt: 'Ingredients received',
        waste: 'Waste',
        count: 'Stock count',
        usage: 'Consumed',
        reversal: 'Quantity restored',
        correction: 'Quantity corrected'
    })[kind] || kind;
}

function canCorrect(row) {
    // A purchase-invoice receipt is corrected by reversing its invoice, never here.
    return (row.kind === 'receipt' || row.kind === 'waste') && row.source_label !== 'Purchase invoice'
        && !row.corrected_by_id && !correctedIds.value.has(Number(row.id));
}

async function fetchPage(beforeId) {
    if (!props.ingredient || !props.show) return;
    controller?.abort();
    controller = new AbortController();
    const seq = ++requestSeq;
    loading.value = true;
    error.value = '';
    const params = new URLSearchParams({ from: from.value, to: to.value, limit: '50' });
    if (beforeId) params.set('before_id', String(beforeId));
    try {
        const data = await fetchJson(`api/admin/ingredients/${props.ingredient.id}/movements?${params}`, { signal: controller.signal });
        if (seq !== requestSeq) return;
        if (!data.success) throw new Error(data.message || 'Load failed.');
        const page = data.rows || [];
        const nextCorrected = new Set(correctedIds.value);
        for (const row of page) {
            if (row.corrects_movement_id) nextCorrected.add(Number(row.corrects_movement_id));
        }
        correctedIds.value = nextCorrected;
        rows.value = beforeId ? [...rows.value, ...page] : page;
        hasMore.value = page.length === 50;
    } catch (caught) {
        if (seq === requestSeq && caught.name !== 'AbortError') error.value = caught.message || 'Load failed.';
    } finally {
        if (seq === requestSeq) loading.value = false;
    }
}

watch(() => [props.show, props.ingredient?.id], async ([open]) => {
    controller?.abort();
    requestSeq++;
    document.removeEventListener('keydown', onKeydown);
    if (!open) { restoreFocus?.focus(); return; }
    restoreFocus = document.activeElement;
    document.addEventListener('keydown', onKeydown);
    error.value = ''; correctionTarget.value = null; dateRange.value = 'week';
    to.value = currentBusinessDate();
    from.value = addBusinessDateDays(to.value, -6);
    rows.value = [];
    correctedIds.value = new Set();
    await nextTick();
    dialog.value?.focus();
    await fetchPage(null);
});

function refresh() {
    if (from.value > to.value) { error.value = 'From date must be on or before To date.'; return; }
    rows.value = [];
    correctedIds.value = new Set();
    return fetchPage(null);
}

async function loadMore() {
    if (loading.value) return;
    const last = rows.value[rows.value.length - 1];
    if (!last) return;
    await fetchPage(last.id);
}

async function saveCorrection() {
    if (correcting.value || !correctionTarget.value) return;
    if (correctionQty.value === '' || !Number.isFinite(Number(correctionQty.value)) || Number(correctionQty.value) < 0 || !correctionNote.value.trim()) {
        error.value = 'Enter the correct quantity and a reason.'; return;
    }
    const movementId = correctionTarget.value.id;
    const payload = JSON.stringify({ qty: Number(correctionQty.value), unit: props.ingredient.display_unit, note: correctionNote.value.trim() });
    if (payload !== correctionPayload) { correctionPayload = payload; correctionKey = createRequestId(); }
    correcting.value = true; error.value = '';
    try {
        const { response, data } = await fetchJsonResponse(`api/admin/ingredient-movements/${movementId}/amend`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(correctionPayload), client_key: correctionKey })
        });
        if (!response.ok || !data.success) throw Object.assign(new Error(data.message || 'Correct failed.'), { status: response.status });
        correctionTarget.value = null; emit('changed');
        correctedIds.value.add(Number(movementId));
        if (props.show) await fetchPage(null);
    } catch (caught) {
        error.value = caught.message || 'Correct failed.';
        correctionUncertain.value = !caught.status || caught.status >= 500;
    } finally { correcting.value = false; }
}
onUnmounted(() => {
    controller?.abort(); requestSeq++;
    document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.history-filter { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: end; padding: 12px 16px; border-bottom: 1px solid #dce3eb; font-size: 12px; flex-shrink: 0; }
.history-filter label { min-width: 0; }
.history-filter label:first-child, .history-filter > button { grid-column: 1 / -1; }
.history-filter > button { justify-self: end; padding-inline: 18px; }
.history-filter input { margin-top: 6px; }
.history-filter select { display: block; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid #cbd0d7; border-radius: 6px; margin-top: 6px; }
.correction-form { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.correction-body { padding: 20px 24px; overflow-y: auto; font-size: 13px; line-height: 1.7; }
.correction-body label { display: block; font-weight: 600; margin-block: 16px; }
.correction-body input, .correction-body textarea { display: block; width: 100%; padding: 10px 12px; border: 1px solid #cbd0d7; border-radius: 6px; margin-top: 6px; font-size: 14px; }
.correction-body input { min-height: 44px; }
.correction-original { display: flex; justify-content: space-between; gap: 12px; padding: 12px; background: #f1f5f9; border-radius: 6px; margin-block: 16px; }
.back-history, .cancel-entry { min-height: 44px; color: #24405e; text-decoration: underline; }
.history-hint { font-size: 12px; color: #616b76; margin-top: 8px; }
footer { padding: 16px 24px; display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid #dce3eb; }
footer button { min-height: 44px; padding: 8px 14px; border: 1px solid #cbd0d7; border-radius: 6px; }
footer .primary { background: #24405e; color: white; border-color: #24405e; }
button:disabled, fieldset:disabled { opacity: .6; }
[role=alert] { color: #ad2929; }
input:focus-visible, textarea:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid #3a5c85; outline-offset: 2px; }

.ingredient-history-panel > header { background: var(--color-brand-50); border-color: var(--color-brand-100); padding: 20px; }
.ingredient-history-panel > header h3 { font-size: 18px; color: var(--color-primary); }
.ingredient-history-panel input, .ingredient-history-panel select { border-color: var(--color-border); border-radius: 7px; }
</style>

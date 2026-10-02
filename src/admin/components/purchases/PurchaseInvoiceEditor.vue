<template>
    <section ref="root" class="pi-pane pi-editor-pane lg-book" :class="`lg-book--${meta.status}`" :aria-busy="busy || loading">
        <!-- Controls live on the desk, outside the paper: real buttons, never lines of the invoice. -->
        <div class="lg-toolbar">
            <button type="button" class="lg-btn pi-back" @click="$emit('back')">
                <i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to list') }}
            </button>
            <span class="lg-state" :class="`lg-state--${meta.status}`">{{ title }}</span>
            <span class="lg-grow"></span>
            <template v-if="!readOnly">
                <button type="button" class="lg-btn" :disabled="locked || busy" @click="repeatLast">
                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('Repeat last invoice') }}</span>
                </button>
                <div v-if="itemKind === 'product'" class="lg-pop-anchor">
                    <button type="button" class="lg-btn" :class="{ 'is-open': showCategories }" :disabled="locked || busy" :aria-expanded="showCategories" @click="toggleCategories">
                        <i class="fa-solid fa-layer-group" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('Add category') }}</span>
                    </button>
                    <div v-if="showCategories" class="lg-pop" role="dialog" :aria-label="$t('Add category')" @keydown.esc="showCategories = false">
                        <select v-model="categoryId" class="lg-select" :aria-label="$t('Category')" :disabled="locked || busy">
                            <option value="">{{ $t('Choose a category') }}</option>
                            <option v-for="category in categories" :key="category.id" :value="String(category.id)" data-no-i18n>{{ category.name }} ({{ category.item_count }})</option>
                        </select>
                        <button type="button" class="lg-btn lg-btn--ink" :disabled="!categoryId || locked || busy" @click="addCategory">{{ $t('Add items') }}</button>
                    </div>
                </div>
            </template>
            <template v-else-if="!loading">
                <button type="button" class="lg-btn" :disabled="busy || !!pending" @click="reviseInvoice">
                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>{{ $t('Edit invoice') }}
                </button>
                <button v-if="meta.status === 'posted'" type="button" class="lg-btn lg-btn--danger" :disabled="busy || !!pending" @click="reverseInvoice">
                    <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>{{ $t('Reverse invoice') }}
                </button>
            </template>
            <button type="button" class="lg-btn" :aria-label="$t('New invoice')" @click="$emit('request-new')">
                <i class="fa-solid fa-plus" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('New invoice') }}</span><kbd class="lg-kbd">Alt N</kbd>
            </button>
        </div>

        <div class="lg-desk">
        <div class="lg-page">
            <!-- Header: the supplier is written at the top of the page; the rest are fill-in blanks. -->
            <header class="lg-head">
                <div class="lg-title">
                    <span class="lg-cap">{{ $t('Supplier') }}</span>
                    <PurchaseSupplierCombobox
                        ref="supplierBox"
                        v-model="form.supplier_id"
                        class="lg-supplier"
                        :suppliers="suppliers"
                        :fallback-name="form.supplier_name"
                        :create-supplier="createSupplier"
                        :disabled="locked"
                        :invalid="fieldInvalid === 'supplier'"
                        @done="focusField('invoice_no')"
                    />
                </div>
                <div class="lg-blanks">
                    <label class="lg-blank">
                        <span class="lg-cap">{{ $t('Supplier invoice number') }}</span>
                        <input v-model="form.supplier_invoice_no" class="lg-fill pi-num-input" :class="{ 'is-invalid': fieldInvalid === 'invoice_no' }" type="text" maxlength="60" autocomplete="off" :disabled="locked" data-field="invoice_no" @keydown.enter.prevent="focusField('date')">
                    </label>
                    <label class="lg-blank">
                        <span class="lg-cap">{{ $t('Invoice date') }}</span>
                        <input v-model="form.invoice_date" class="lg-fill pi-num-input" type="date" :disabled="locked" data-field="date" @keydown.enter.prevent="focusFirstLine">
                    </label>
                    <div class="lg-blank">
                        <span class="lg-cap">{{ $t('Payment') }}</span>
                        <div class="lg-toggle" role="group" :aria-label="$t('Payment')">
                            <button type="button" :aria-pressed="form.payment_status === 'paid'" :disabled="locked" @click="form.payment_status = 'paid'">{{ $t('Paid') }}</button>
                            <button type="button" :aria-pressed="form.payment_status === 'credit'" :disabled="locked" @click="form.payment_status = 'credit'">{{ $t('On credit') }}</button>
                        </div>
                    </div>
                </div>
                <div v-if="readOnly && !loading" class="lg-stamp" :class="`lg-stamp--${meta.status}`" aria-hidden="true">{{ $t(statusLabel(meta.status)) }}</div>
            </header>

            <p v-if="loading" class="lg-note" role="status">{{ $t('Loading...') }}</p>
            <p v-if="readOnly && !loading" class="lg-note">{{ meta.status === 'posted' ? $t('To correct a posted invoice, press Edit invoice: it is reversed and reopened as a draft.') : $t('This invoice was reversed. Edit invoice reopens its lines as a new draft.') }}</p>
            <p v-if="backupOffer" class="lg-note lg-note--warn" role="alert" data-test="purchase-backup">
                <span>{{ $t('An unsaved invoice was found on this device (for example after a power cut).') }} <bdi dir="ltr" data-no-i18n>{{ backupOffer.when }} · {{ backupOffer.lines }}</bdi> {{ $t('lines') }}</span>
                <span class="lg-actions">
                    <button type="button" class="lg-btn lg-btn--sm lg-btn--ink" :disabled="busy || loading" @click="restoreBackup">{{ $t('Restore it') }}</button>
                    <button type="button" class="lg-btn lg-btn--sm" :disabled="busy || loading" @click="discardBackup">{{ $t('Discard it') }}</button>
                </span>
            </p>

            <!-- The ruled lines. Every row is exactly one ruled line tall. -->
            <div class="lg-sheet" role="table" :aria-label="$t('Items')">
                <div class="lg-row lg-row--head" role="row">
                    <span class="lg-c-no" role="columnheader">#</span>
                    <span class="lg-c-item" role="columnheader">{{ $t('Item') }}</span>
                    <span class="lg-c-qty" role="columnheader">{{ $t('Qty') }}</span>
                    <span class="lg-c-unit" role="columnheader">{{ $t('Unit') }}</span>
                    <span class="lg-c-bonus" role="columnheader" :title="$t('Free units received, in the base unit')">{{ $t('Bonus') }}</span>
                    <span class="lg-c-price" role="columnheader">{{ $t('Unit price') }}</span>
                    <span class="lg-c-tax" role="columnheader">{{ $t('Tax %') }}</span>
                    <span class="lg-c-total" role="columnheader">{{ $t('Line total') }}</span>
                    <span class="lg-c-del" role="columnheader"><span class="sr-only">{{ $t('Remove line') }}</span></span>
                </div>
                <template v-for="(row, index) in rows" :key="row.key">
                <div
                    class="lg-row"
                    :class="{ 'is-empty': !row.item, 'is-invalid': problemKeys.has(row.key) }"
                    role="row"
                    @keydown="onRowKeydown($event, index)"
                >
                    <span class="lg-c-no pi-num" role="cell" data-no-i18n>{{ index + 1 }}</span>
                    <div class="lg-c-item" :class="{ 'has-track': startsTracking(row) }" role="cell">
                        <PurchaseItemCombobox
                            :item="row.item"
                            :item-kind="itemKind"
                            :row-index="index"
                            :supplier-id="form.supplier_id"
                            :disabled="locked"
                            :invalid="problemKeys.has(row.key) && !row.item"
                            @pick="onPick(index, $event)"
                            @scan="onScan(index, $event)"
                            @next="go(index, 'item')"
                        />
                        <span v-if="startsTracking(row)" class="pi-track" :title="$t('Stock is unlimited now. Receiving it starts counting its stock.')">{{ $t('Starts stock tracking') }}</span>
                    </div>
                    <div class="lg-c-qty" role="cell">
                        <input v-model.number="row.qty" class="lg-cell lg-cell--num" :class="{ 'is-invalid': problemKeys.has(row.key) }" type="number" inputmode="decimal" min="0" step="any" :placeholder="$t('Qty')" :disabled="locked || !row.item" :aria-label="`${$t('Qty')} ${index + 1}`" data-cell="qty" :data-row="index" @keydown.enter.prevent="go(index, 'qty')">
                    </div>
                    <div class="lg-c-unit" role="cell">
                        <select class="lg-cell" :value="packKey({ label: row.unit_label, factor: row.unit_factor })" :disabled="locked || !row.item" :aria-label="`${$t('Unit')} ${index + 1}`" data-cell="unit" :data-row="index" @change="selectUnit(row, $event.target.value)" @keydown.enter.prevent="go(index, 'unit')">
                            <option v-for="pack in row.item?.packs || []" :key="packKey(pack)" :value="packKey(pack)" data-no-i18n>{{ unitText(pack, row.item) }}</option>
                        </select>
                    </div>
                    <div class="lg-c-bonus" role="cell">
                        <input v-model.number="row.bonus_qty" class="lg-cell lg-cell--num" type="number" inputmode="decimal" min="0" step="any" placeholder="0" :disabled="locked || !row.item" :aria-label="`${$t('Bonus')} ${index + 1}`" :title="$t('Free units received, in the base unit')" data-cell="bonus" :data-row="index">
                    </div>
                    <div class="lg-c-price" role="cell">
                        <input v-model.number="row.unit_price" class="lg-cell lg-cell--num" :class="{ 'is-invalid': problemKeys.has(row.key) }" type="number" inputmode="decimal" min="0" step="any" :placeholder="$t('Unit price')" :disabled="locked || !row.item" :aria-label="`${$t('Unit price')} ${index + 1}`" data-cell="price" :data-row="index" @input="row.price_touched = true" @keydown.enter.prevent="go(index, 'price')">
                        <span v-if="change(row)" class="lg-delta" :class="`lg-delta--${change(row).direction}`" role="status" :title="`${$t('vs last price')} ${money(change(row).ref)}`">
                            <bdi class="pi-num" data-no-i18n>{{ change(row).direction === 'up' ? '↑' : '↓' }}{{ change(row).percent }}%</bdi>
                            <span class="sr-only">{{ $t('vs last price') }} {{ money(change(row).ref) }}</span>
                        </span>
                    </div>
                    <div class="lg-c-tax" role="cell">
                        <select v-model.number="row.tax_rate" class="lg-cell" :disabled="locked || !row.item" :aria-label="`${$t('Tax %')} ${index + 1}`" data-cell="tax" :data-row="index" @keydown.enter.prevent="go(index, 'tax')">
                            <option v-for="rate in TAX_RATES" :key="rate" :value="rate" data-no-i18n>{{ rate }}%</option>
                        </select>
                    </div>
                    <div class="lg-c-total" role="cell"><bdi class="pi-num" data-no-i18n>{{ row.item ? money(lineAmounts(row).total) : '' }}</bdi></div>
                    <div class="lg-c-del" role="cell">
                        <button v-if="!readOnly" type="button" class="lg-x" :disabled="locked" :aria-label="`${$t('Remove line')} ${index + 1}`" @click="removeRow(index)"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                    </div>
                </div>
                <div v-if="bonusReceipt(row)" class="lg-insight" role="note">
                    <span class="lg-c-no" aria-hidden="true"></span>
                    <p class="lg-insight-text">
                        <span>{{ $t('Received with bonus') }}: <bdi class="pi-num" data-no-i18n>{{ formatQty(bonusReceipt(row).base) }}</bdi> <span data-no-i18n>{{ baseUnitText(row.item) }}</span></span>
                        <span>{{ $t('Cost per unit after bonus') }}: <bdi class="pi-num" data-no-i18n>{{ money(bonusReceipt(row).cost) }}</bdi></span>
                    </p>
                </div>
                <div v-if="!readOnly && insightFor(row)" class="lg-insight" :class="{ 'is-up': insightFor(row).increase }" role="note" :aria-label="`${$t('Purchase history')} ${index + 1}`">
                    <span class="lg-c-no" aria-hidden="true"></span>
                    <p class="lg-insight-text">
                        <span v-if="insightFor(row).increase" class="lg-insight-alert" role="status">
                            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>{{ $t('Higher than the last purchase price by') }}
                            <bdi class="pi-num" data-no-i18n>{{ money(insightFor(row).increase.amount) }}<template v-if="insightFor(row).increase.percent !== null"> ({{ insightFor(row).increase.percent }}%)</template></bdi>
                        </span>
                        <span v-if="insightFor(row).last">
                            {{ $t('Last price') }}: <bdi class="pi-num" data-no-i18n>{{ money(insightFor(row).last.price) }}</bdi> / <span data-no-i18n>{{ unitText({ label: row.unit_label, factor: row.unit_factor }, row.item) }}</span>
                            <small data-no-i18n>· {{ insightFor(row).last.invoice_date }} · {{ insightFor(row).last.supplier_name }} · {{ $t('Invoice') }} {{ insightFor(row).last.reference }}</small>
                            <small v-if="insightFor(row).lastFromSupplier"> · {{ $t('this supplier') }}</small>
                        </span>
                        <span v-else>{{ $t('No previous purchase') }}</span>
                        <span v-if="insightFor(row).supplierLast">
                            {{ $t('Last from this supplier') }}: <bdi class="pi-num" data-no-i18n>{{ money(insightFor(row).supplierLast.price) }}</bdi>
                            <small data-no-i18n>· {{ insightFor(row).supplierLast.invoice_date }}</small>
                        </span>
                        <span v-if="insightFor(row).average !== null">{{ $t('Average purchase price') }}: <bdi class="pi-num" data-no-i18n>{{ money(insightFor(row).average) }}</bdi></span>
                        <span>{{ $t('On hand') }}: <bdi class="pi-num" data-no-i18n>{{ insightFor(row).onHand === null ? $t('Unknown') : formatQty(insightFor(row).onHand) }}</bdi> <span v-if="insightFor(row).onHand !== null" data-no-i18n>{{ baseUnitText(row.item) }}</span></span>
                    </p>
                </div>
                </template>
                <button v-if="!readOnly" type="button" class="lg-row lg-add" :disabled="locked" @click="addRow">
                    <span class="lg-c-no" aria-hidden="true"><i class="fa-solid fa-plus"></i></span>
                    <span class="lg-add-text">{{ $t('Add line') }} <kbd class="lg-kbd">/</kbd> {{ $t('or scan a barcode') }}</span>
                </button>
                <div class="lg-spare" aria-hidden="true"></div>
            </div>

            <!-- Totals written under the lines, closed by a double rule. -->
            <div class="lg-sums">
                <div class="lg-sum"><span class="lg-c-no"></span><span>{{ $t('Subtotal') }}</span><bdi class="pi-num" data-no-i18n>{{ money(totals.subtotal) }}</bdi></div>
                <div class="lg-sum"><span class="lg-c-no"></span><span>{{ $t('Tax') }}</span><bdi class="pi-num" data-no-i18n>{{ money(totals.tax) }}</bdi></div>
                <div class="lg-sum lg-sum--total"><span class="lg-c-no"></span><span>{{ $t('Total') }}</span><bdi class="pi-num" data-no-i18n>{{ money(totals.total) }} <small>JD</small></bdi></div>
                <label v-if="!readOnly || form.paper_total !== ''" class="lg-sum lg-paper" :class="paperState ? `lg-paper--${paperState}` : ''">
                    <span class="lg-c-no"></span>
                    <span>{{ $t('Total on paper') }}</span>
                    <span class="lg-paper-field">
                        <span v-if="paperState === 'match'" class="lg-mark" role="status"><i class="fa-solid fa-check" aria-hidden="true"></i>{{ $t('Matches the paper total.') }}</span>
                        <span v-else-if="paperState === 'mismatch'" class="lg-mark" role="status"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>{{ $t('Differs from the paper total by') }} <bdi class="pi-num" data-no-i18n>{{ money(paperDiff) }}</bdi></span>
                        <input v-model.number="form.paper_total" class="lg-fill lg-fill--num" type="number" inputmode="decimal" min="0" step="any" placeholder="0.000" :disabled="locked" data-field="paper">
                    </span>
                </label>
            </div>

        </div>
        </div>

        <footer v-if="!readOnly || loadError || errorText || note || pending" class="lg-foot">
            <div v-if="loadError || errorText || note || pending" class="lg-messages">
                <p v-if="loadError" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ loadError }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" @click="loadInvoice(meta.id || openId)">{{ $t('Retry') }}</button>
                </p>
                <p v-if="pending" class="lg-msg lg-msg--warn" role="alert">
                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>{{ $t('The result is unconfirmed. Check it before trying again.') }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" :disabled="busy" @click="checkOutcome">{{ $t('Check result') }}</button>
                </p>
                <p v-if="errorText" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ errorText }}</span>
                    <button v-if="canReload" type="button" class="lg-btn lg-btn--sm" :disabled="busy" @click="reloadFromServer">{{ $t('Reload invoice') }}</button>
                </p>
                <p v-if="note" class="lg-msg lg-msg--done" role="status"><i class="fa-solid fa-check" aria-hidden="true"></i><span>{{ note }}</span></p>
            </div>
            <div v-if="!readOnly" class="lg-actions">
                <button v-if="meta.id" type="button" class="lg-btn lg-btn--danger" :disabled="locked || busy" @click="deleteDraft"><i class="fa-solid fa-trash-can" aria-hidden="true"></i>{{ $t('Delete draft') }}</button>
                <span class="lg-grow"></span>
                <button type="button" class="lg-btn" :disabled="locked || busy" @click="saveDraft">{{ $t('Save draft') }} <kbd class="lg-kbd">Ctrl S</kbd></button>
                <button type="button" class="lg-btn" :disabled="locked || busy" @click="requestPost('stay')">{{ $t('Post to stock') }}</button>
                <button type="button" class="lg-btn lg-btn--ink" :disabled="locked || busy" @click="requestPost('new')">{{ $t('Post and new') }} <kbd class="lg-kbd lg-kbd--ink">Ctrl ↵</kbd></button>
            </div>
            <p v-if="!readOnly" class="lg-keys" :aria-label="$t('Keyboard shortcuts')">
                <span><kbd>Enter</kbd> {{ $t('next cell') }}</span>
                <span><kbd>/</kbd> <kbd>F2</kbd> {{ $t('new line') }}</span>
                <span><kbd>Ctrl</kbd>+<kbd>Backspace</kbd> {{ $t('remove line') }}</span>
                <span><kbd>Ctrl</kbd>+<kbd>S</kbd> {{ $t('save draft') }}</span>
                <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ $t('post and new') }}</span>
                <span><kbd>Alt</kbd>+<kbd>N</kbd> {{ $t('new invoice') }}</span>
            </p>
        </footer>
    </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { isUnansweredRequest } from '@/shared/http.js';
import { createRequestId } from '@/shared/requestId.js';
import { currentBusinessDate } from '@/utils/businessDate.js';
import PurchaseSupplierCombobox from './PurchaseSupplierCombobox.vue';
import PurchaseItemCombobox from './PurchaseItemCombobox.vue';
import { purchasesApi, describeError } from './purchasesApi.js';
import {
    TAX_RATES, MAX_LINES, addOrIncrement, applyItem, buildLines, findRowByItem, invoiceTotals, isBlankRow, isEntered,
    bonusReceipt, lineAmounts, mergeRows, newRow, nextCell, packKey, paperTotalState, priceChange, purchaseInsight, rowFromLine, sameDraft, selectUnit,
    toNumber,
} from './purchaseMath.js';

const props = defineProps({
    // 'product' or 'ingredient': an invoice holds one kind of item, set by the page that opened the screen.
    itemKind: { type: String, required: true },
    openId: { type: [Number, String], default: null },
    suppliers: { type: Array, default: () => [] },
});
const emit = defineEmits(['saved', 'deleted', 'active', 'dirty', 'back', 'request-new', 'supplier-created']);

const root = ref(null);
const supplierBox = ref(null);

const today = () => {
    try { return currentBusinessDate(); } catch { return new Date().toISOString().slice(0, 10); }
};
const blankForm = () => ({ supplier_id: null, supplier_name: '', supplier_invoice_no: '', invoice_date: today(), payment_status: 'credit', paper_total: '', notes: '' });

const form = reactive(blankForm());
const rows = ref([newRow()]);
const meta = reactive({ id: null, version: null, status: 'draft', cost_includes_tax: null, create_key: createRequestId(), post_key: createRequestId(), reverse_key: createRequestId(), revise_key: createRequestId(), baseline: '' });

const busy = ref(false);
const loading = ref(false);
const loadError = ref('');
const errorText = ref('');
const canReload = ref(false);
const note = ref('');
const fieldInvalid = ref('');
const problemKeys = ref(new Set());
// A mutation whose reply was lost: { op, mode?, body?, create?, expectedVersion? }.
const pending = ref(null);
const categories = ref([]);
const categoryId = ref('');
const showCategories = ref(false);

const readOnly = computed(() => meta.status !== 'draft');
const locked = computed(() => readOnly.value || !!pending.value || loading.value);
const totals = computed(() => invoiceTotals(rows.value));
const paperState = computed(() => paperTotalState(form.paper_total, totals.value.total));
const paperDiff = computed(() => Math.abs((toNumber(form.paper_total) || 0) - totals.value.total));
const title = computed(() => {
    if (!meta.id) return t('New purchase invoice');
    return t({ draft: 'Draft invoice', posted: 'Posted invoice', reversed: 'Reversed invoice' }[meta.status] || 'Purchase invoice');
});

const money = (value) => (Number(value) || 0).toFixed(3);
const enteredCount = computed(() => rows.value.filter(row => row.item).length);
// Base units read as words; buying packs keep their own label.
const BASE_UNIT_NAMES = { g: 'gram', ml: 'millilitre', unit: 'piece' };
const unitText = (pack, item) => {
    if (Number(pack.factor) === 1 && BASE_UNIT_NAMES[pack.label] && pack.label === item?.base_unit) return t(BASE_UNIT_NAMES[pack.label]);
    // Two packs with one label read apart by their size.
    const shared = (item?.packs || []).filter(other => other.label === pack.label).length > 1;
    return shared ? `${pack.label} × ${Number(pack.factor)}` : pack.label;
};
const baseUnitText = (item) => (BASE_UNIT_NAMES[item?.base_unit] ? t(BASE_UNIT_NAMES[item.base_unit]) : item?.base_unit || '');
const formatQty = (value) => String(Number(Number(value).toFixed(3)));
const statusLabel = (status) => ({ draft: 'Draft', posted: 'Posted', reversed: 'Reversed' }[status] || status);
const change = (row) => priceChange(row);
// A product whose stock is unlimited today starts being counted when this invoice is posted.
const startsTracking = (row) => !readOnly.value && Boolean(row.item?.starts_tracking);

function serialize() {
    return JSON.stringify([
        form.supplier_id, form.supplier_invoice_no.trim(), form.invoice_date, form.payment_status, form.paper_total, form.notes,
        rows.value.filter(row => row.item).map(row => [row.item.item_key, row.qty, row.bonus_qty, row.unit_label, row.unit_factor, row.unit_price, row.tax_rate]),
    ]);
}
const snapshot = computed(serialize);
const dirty = computed(() => !readOnly.value && snapshot.value !== meta.baseline);
const markClean = () => { meta.baseline = serialize(); };
markClean();
watch(dirty, value => emit('dirty', value));
// Prefilled prices, units and comparisons come from the previous supplier's history; when the supplier
// changes on a draft, untouched lines lose them instead of silently carrying them over.
watch(() => form.supplier_id, (next, previous) => {
    if (previous == null || next == null || Number(next) === Number(previous) || readOnly.value || loading.value) return;
    let cleared = 0;
    for (const row of rows.value) {
        if (!row.item || row.price_touched) continue;
        if (row.unit_price !== '') cleared += 1;
        row.unit_price = '';
        row.ref_price = null;
        row.ref_factor = null;
    }
    if (cleared) note.value = t("Prices from the previous supplier were cleared. Enter this supplier's prices.");
});
watch(() => meta.id, id => emit('active', id));

// Purchase history under each line is informational: a failed lookup only hides it.
const insights = ref(new Map());
let insightTimer = null;
let insightSequence = 0;
const insightKeys = computed(() => (readOnly.value ? '' : [...new Set(rows.value.filter(row => row.item).map(row => row.item.item_key))].sort().join(',')));
async function loadInsights() {
    const keys = insightKeys.value ? insightKeys.value.split(',') : [];
    const sequence = ++insightSequence;
    if (!keys.length) { insights.value = new Map(); return; }
    try {
        const data = await purchasesApi.itemInsights({ kind: props.itemKind, itemKeys: keys, supplierId: form.supplier_id });
        if (sequence === insightSequence) insights.value = new Map((data || []).map(entry => [entry.item_key, entry]));
    } catch {
        if (sequence === insightSequence) insights.value = new Map();
    }
}
watch([insightKeys, () => form.supplier_id], () => {
    clearTimeout(insightTimer);
    insightTimer = setTimeout(loadInsights, 250);
});
const insightFor = (row) => purchaseInsight(row, insights.value.get(row.item?.item_key));

const supplierLabel = () => props.suppliers.find(s => Number(s.id) === Number(form.supplier_id))?.name || form.supplier_name || '';

const ask = async (message, heading) => (window.showAdminConfirm ? window.showAdminConfirm(message, heading) : window.confirm(message));

function clearMessages() {
    errorText.value = ''; canReload.value = false; note.value = ''; fieldInvalid.value = ''; problemKeys.value = new Set();
}

// Focus -----------------------------------------------------------------
function focusCell(row, cell) {
    nextTick(() => {
        const el = root.value?.querySelector(`[data-row="${row}"][data-cell="${cell}"]`);
        if (!el) return;
        el.focus();
        if (el.tagName === 'INPUT') el.select?.();
    });
}
function focusField(name) {
    nextTick(() => {
        const el = root.value?.querySelector(`[data-field="${name}"]`);
        el?.focus();
        if (el?.tagName === 'INPUT') el.select?.();
    });
}
const focusSupplier = () => focusField('supplier');
function focusFirstLine() {
    const index = Math.max(0, rows.value.findIndex(row => !row.item));
    focusCell(rows.value.length && rows.value[index] ? index : 0, 'item');
}
function ensureTrailingBlank() {
    if (!rows.value.length || !isBlankRow(rows.value[rows.value.length - 1])) {
        if (rows.value.length < MAX_LINES) rows.value.push(newRow());
    }
}
function addRow() {
    if (locked.value) return;
    ensureTrailingBlank();
    focusCell(rows.value.length - 1, 'item');
}
function removeRow(index) {
    if (locked.value) return;
    if (rows.value.length <= 1) rows.value = [newRow()];
    else rows.value.splice(index, 1);
    focusCell(Math.min(index, rows.value.length - 1), 'item');
}
function go(index, cell) {
    const target = nextCell(rows.value, index, cell);
    if (target.createRow) {
        if (rows.value.length >= MAX_LINES) { note.value = t('An invoice can have at most 200 lines.'); return; }
        rows.value.push(newRow());
    }
    focusCell(target.row, target.cell);
}
function onRowKeydown(event, index) {
    if (event.ctrlKey && event.key === 'Backspace') {
        event.preventDefault();
        removeRow(index);
    }
}

// Items -----------------------------------------------------------------
function onPick(index, item) {
    note.value = '';
    const existing = findRowByItem(rows.value, item.item_key);
    if (existing >= 0 && existing !== index) {
        note.value = t('This item is already on the invoice.');
        focusCell(existing, 'qty');
        return;
    }
    applyItem(rows.value[index], item);
    focusCell(index, 'qty');
}
function onScan(index, item) {
    note.value = '';
    const result = addOrIncrement(rows.value, item, { targetIndex: index });
    if (result.added) {
        ensureTrailingBlank();
        focusCell(rows.value.length - 1, 'item');
    } else {
        focusCell(index, 'item');
    }
    note.value = `${item.name} +1`;
}

// Quick actions ---------------------------------------------------------
async function repeatLast() {
    clearMessages();
    if (!form.supplier_id) { fieldInvalid.value = 'supplier'; errorText.value = t('Choose a supplier first.'); focusSupplier(); return; }
    busy.value = true;
    try {
        const last = await purchasesApi.lastInvoice(form.supplier_id, props.itemKind);
        const lines = Array.isArray(last) ? last : last?.lines;
        if (!lines?.length) { note.value = t('This supplier has no posted invoice yet.'); return; }
        const merged = mergeRows(rows.value, lines.map(line => rowFromLine(line, { repeated: true })));
        rows.value = merged.rows;
        if (merged.skipped) note.value = t('Some lines were skipped because the item is already on the invoice or the line limit was reached.');
        focusFirstLine();
    } catch (error) {
        errorText.value = describeError(error);
    } finally {
        busy.value = false;
    }
}
async function toggleCategories() {
    showCategories.value = !showCategories.value;
    if (!showCategories.value || categories.value.length) return;
    try { categories.value = await purchasesApi.listCategories(); } catch (error) { errorText.value = describeError(error); showCategories.value = false; }
}
async function addCategory() {
    if (!categoryId.value) return;
    clearMessages();
    busy.value = true;
    try {
        const items = await purchasesApi.searchItems({ kind: props.itemKind, categoryId: categoryId.value, supplierId: form.supplier_id, limit: 100 });
        const merged = mergeRows(rows.value, items.map(item => applyItem(newRow(), item)));
        rows.value = merged.rows;
        note.value = t('Fill in the quantities. Lines without a quantity are not saved.');
        categoryId.value = '';
        showCategories.value = false;
        focusFirstQty();
    } catch (error) {
        errorText.value = describeError(error);
    } finally {
        busy.value = false;
    }
}
function focusFirstQty() {
    const index = rows.value.findIndex(row => row.item && (row.qty === '' || row.qty == null));
    if (index >= 0) focusCell(index, 'qty');
}

// A create whose reply was lost may have committed: on a duplicate or an unanswered request,
// read the suppliers back and adopt the one with this name instead of failing.
async function createSupplier(fields) {
    const body = typeof fields === 'string' ? { name: fields } : fields;
    const name = body.name;
    let supplier;
    try {
        supplier = await purchasesApi.createSupplier(body);
    } catch (error) {
        if (error?.code !== 'PURCHASE_SUPPLIER_DUPLICATE' && !isUnansweredRequest(error)) throw error;
        const wanted = name.trim().toLocaleLowerCase();
        const found = (await purchasesApi.listSuppliers()).find(row => String(row.name).trim().toLocaleLowerCase() === wanted);
        if (!found) throw error;
        supplier = found;
    }
    emit('supplier-created', supplier);
    return supplier;
}

// Load / state ----------------------------------------------------------
function applyInvoice(invoice) {
    Object.assign(form, {
        supplier_id: invoice.supplier_id, supplier_name: invoice.supplier_name || '', supplier_invoice_no: invoice.supplier_invoice_no || '',
        invoice_date: String(invoice.invoice_date || today()).slice(0, 10), payment_status: invoice.payment_status || 'credit',
        paper_total: invoice.paper_total === null || invoice.paper_total === undefined ? '' : Number(invoice.paper_total), notes: invoice.notes || '',
    });
    Object.assign(meta, { id: invoice.id, version: invoice.version, status: invoice.status, cost_includes_tax: invoice.cost_includes_tax ?? null });
    rows.value = (invoice.lines || []).map(line => rowFromLine(line));
    if (invoice.status === 'draft') ensureTrailingBlank();
    if (!rows.value.length) rows.value = [newRow()];
    markClean();
}
function adoptStatus(invoice) {
    Object.assign(meta, { status: invoice.status || meta.status, version: invoice.version ?? meta.version, cost_includes_tax: invoice.cost_includes_tax ?? meta.cost_includes_tax });
    markClean();
}
function resetToNew() {
    Object.assign(form, blankForm());
    rows.value = [newRow()];
    Object.assign(meta, { id: null, version: null, status: 'draft', cost_includes_tax: null, create_key: createRequestId(), post_key: createRequestId(), reverse_key: createRequestId(), revise_key: createRequestId() });
    pending.value = null;
    clearMessages();
    markClean();
}

let loadSequence = 0;
async function loadInvoice(id) {
    if (!id) return;
    const current = ++loadSequence;
    loading.value = true;
    loadError.value = '';
    try {
        const invoice = await purchasesApi.getInvoice(id);
        if (current !== loadSequence) return;
        pending.value = null;
        applyInvoice(invoice);
        Object.assign(meta, { post_key: createRequestId(), reverse_key: createRequestId(), revise_key: createRequestId() });
    } catch (error) {
        if (current === loadSequence) loadError.value = describeError(error);
    } finally {
        if (current === loadSequence) loading.value = false;
    }
}

const summaryOf = (invoice, lineCount) => ({
    ...invoice,
    supplier_name: invoice.supplier_name || supplierLabel(),
    line_count: invoice.line_count ?? invoice.lines?.length ?? lineCount,
});

// Validation and save ---------------------------------------------------
function validate() {
    clearMessages();
    if (!form.supplier_id) { fieldInvalid.value = 'supplier'; focusSupplier(); return t('Choose a supplier.'); }
    if (!form.supplier_invoice_no.trim()) { fieldInvalid.value = 'invoice_no'; focusField('invoice_no'); return t('Enter the supplier invoice number.'); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.invoice_date || '')) { focusField('date'); return t('Choose the invoice date.'); }
    const { lines, problems } = buildLines(rows.value);
    if (problems.length) { problemKeys.value = new Set(problems.map(p => p.key)); return t('Fix the highlighted lines. Each needs a quantity and a price.'); }
    if (!lines.length) return t('Add at least one item with a quantity.');
    if (lines.length > MAX_LINES) return t('An invoice can have at most 200 lines.');
    return '';
}

function buildBody() {
    const { lines } = buildLines(rows.value);
    const paper = toNumber(form.paper_total);
    return {
        supplier_id: Number(form.supplier_id),
        supplier_invoice_no: form.supplier_invoice_no.trim(),
        invoice_date: form.invoice_date,
        payment_status: form.payment_status,
        paper_total: paper,
        notes: form.notes.trim() || null,
        lines,
    };
}

const staleCodes = new Set(['PURCHASE_INVOICE_STALE', 'PURCHASE_INVOICE_NOT_DRAFT', 'PURCHASE_INVOICE_NOT_FOUND']);
function showFailure(error) {
    errorText.value = describeError(error);
    canReload.value = Boolean(meta.id) && staleCodes.has(error?.code) && error.code !== 'PURCHASE_INVOICE_NOT_FOUND';
}

// `submitted` is the snapshot that was sent: edits typed while the save was in flight stay unsaved.
function adoptSaved(invoice, lineCount, submitted = null) {
    Object.assign(meta, { id: invoice.id, version: invoice.version, status: invoice.status || 'draft' });
    rows.value = rows.value.filter(isEntered);
    ensureTrailingBlank();
    if (!rows.value.length) rows.value = [newRow()];
    if (submitted === null) markClean();
    else meta.baseline = submitted;
    if (meta.baseline === serialize()) clearBackup();
    emit('saved', summaryOf(invoice, lineCount));
}

// Runs with `busy` already held. Returns the saved invoice, or null.
async function persist() {
    const body = buildBody();
    const submitted = serialize();
    const creating = !meta.id;
    const expectedVersion = meta.version;
    try {
        const invoice = creating
            ? await purchasesApi.createInvoice({ ...body, kind: props.itemKind, client_key: meta.create_key })
            : await purchasesApi.updateInvoice(meta.id, { ...body, expected_version: expectedVersion });
        adoptSaved(invoice, body.lines.length, submitted);
        return invoice;
    } catch (error) {
        if (isUnansweredRequest(error)) {
            // Keep the same key and the full original intent for the retry.
            pending.value = { op: 'save', create: creating, body: creating ? { ...body, kind: props.itemKind, client_key: meta.create_key } : { ...body, expected_version: expectedVersion }, expectedVersion, lineCount: body.lines.length, submitted };
            return null;
        }
        if (creating) meta.create_key = createRequestId();
        showFailure(error);
        return null;
    }
}

async function saveDraft() {
    if (busy.value || locked.value) return null;
    const problem = validate();
    if (problem) { errorText.value = problem; return null; }
    busy.value = true;
    try {
        const invoice = await persist();
        if (invoice) note.value = t('Draft saved.');
        return invoice;
    } finally {
        busy.value = false;
    }
}

// Post ------------------------------------------------------------------
async function requestPost(mode = 'new') {
    if (busy.value || locked.value) return;
    const problem = validate();
    if (problem) { errorText.value = problem; return; }
    busy.value = true;
    try {
        let message = `${t('Post this invoice to stock?')} ${supplierLabel()} · JD ${money(totals.value.total)}. ${t('Quantities and costs will change.')}`;
        if (paperState.value === 'mismatch') message += ` ${t('The total does not match the paper total.')}`;
        if (!await ask(message, t('Post to stock'))) return;
        if (dirty.value || !meta.id) {
            if (!await persist()) return;
        }
        await doPost(mode);
    } finally {
        busy.value = false;
    }
}

async function doPost(mode) {
    try {
        const invoice = await purchasesApi.postInvoice(meta.id, meta.version, meta.post_key);
        finishPosted(invoice, mode);
    } catch (error) {
        if (isUnansweredRequest(error)) { pending.value = { op: 'post', mode }; return; }
        meta.post_key = createRequestId();
        showFailure(error);
    }
}

function finishPosted(invoice, mode) {
    const label = `${invoice.supplier_invoice_no || form.supplier_invoice_no} · ${invoice.supplier_name || supplierLabel()} · JD ${money(invoice.total ?? totals.value.total)}`;
    emit('saved', summaryOf({ ...invoice, status: invoice.status || 'posted' }, rows.value.filter(isEntered).length));
    pending.value = null;
    clearBackup();
    if (mode === 'new') {
        resetToNew();
        note.value = `${t('Posted invoice')} ${label}`;
        focusSupplier();
        return;
    }
    if (invoice.lines?.length) applyInvoice(invoice); else adoptStatus({ ...invoice, status: invoice.status || 'posted' });
    clearMessages();
    note.value = `${t('Posted invoice')} ${label}`;
}

// Reverse / delete ------------------------------------------------------
async function reverseInvoice() {
    if (busy.value || pending.value || meta.status !== 'posted') return;
    busy.value = true;
    try {
        if (!await ask(`${t('Reverse this posted invoice? Its stock movements will be undone.')} ${form.supplier_invoice_no} · JD ${money(totals.value.total)}`, t('Reverse invoice'))) return;
        clearMessages();
        try {
            const invoice = await purchasesApi.reverseInvoice(meta.id, meta.reverse_key);
            finishReversed(invoice);
        } catch (error) {
            if (isUnansweredRequest(error)) { pending.value = { op: 'reverse' }; return; }
            meta.reverse_key = createRequestId();
            showFailure(error);
        }
    } finally {
        busy.value = false;
    }
}
function finishReversed(invoice) {
    pending.value = null;
    if (invoice.lines?.length) applyInvoice(invoice); else adoptStatus({ ...invoice, status: invoice.status || 'reversed' });
    emit('saved', summaryOf({ ...invoice, status: invoice.status || 'reversed' }, rows.value.filter(isEntered).length));
    clearMessages();
    note.value = t('Invoice reversed.');
}

async function reviseInvoice() {
    if (busy.value || pending.value || meta.status === 'draft' || !meta.id) return;
    busy.value = true;
    try {
        const question = meta.status === 'posted'
            ? t('Edit this posted invoice? It is reversed (its stock is undone) and reopened as a new draft with the same lines. Post the draft again after editing.')
            : t('Reopen this reversed invoice as a new draft with the same lines?');
        if (!await ask(`${question} ${form.supplier_invoice_no} · JD ${money(totals.value.total)}`, t('Edit invoice'))) return;
        clearMessages();
        try {
            const { invoice, reversed } = await purchasesApi.reviseInvoice(meta.id, meta.reverse_key, meta.revise_key);
            emit('saved', summaryOf(reversed, reversed.lines?.length || 0));
            applyInvoice(invoice);
            Object.assign(meta, { create_key: createRequestId(), post_key: createRequestId(), reverse_key: createRequestId(), revise_key: createRequestId() });
            emit('saved', summaryOf(invoice, invoice.lines?.length || 0));
            note.value = t('The invoice was reversed and reopened as a draft. Edit it, then post it again.');
        } catch (error) {
            // Keys are kept: pressing Edit invoice again finishes the same correction without repeating it.
            showFailure(error);
        }
    } finally {
        busy.value = false;
    }
}

async function deleteDraft() {
    if (busy.value || locked.value || !meta.id) return;
    busy.value = true;
    try {
        if (!await ask(t('Delete this draft? This cannot be undone.'), t('Delete draft'))) return;
        clearMessages();
        const id = meta.id;
        try {
            await purchasesApi.deleteInvoice(id, meta.version);
            finishDeleted(id);
        } catch (error) {
            if (isUnansweredRequest(error)) { pending.value = { op: 'delete' }; return; }
            showFailure(error);
        }
    } finally {
        busy.value = false;
    }
}
function finishDeleted(id) {
    clearBackup();
    emit('deleted', id);
    resetToNew();
    note.value = t('Draft deleted.');
}

// Lost replies ----------------------------------------------------------
// The request may have committed. Nothing is resent blindly: a create replays the same
// key with the original body; every other operation re-reads the invoice first.
async function checkOutcome() {
    const op = pending.value;
    if (busy.value || !op) return;
    busy.value = true;
    errorText.value = '';
    try {
        if (op.op === 'save' && op.create) {
            try {
                const invoice = await purchasesApi.createInvoice(op.body);
                pending.value = null;
                adoptSaved(invoice, op.lineCount, op.submitted ?? null);
                note.value = t('Draft saved.');
            } catch (error) {
                if (!isUnansweredRequest(error)) { pending.value = null; meta.create_key = createRequestId(); showFailure(error); }
                else errorText.value = describeError(error);
            }
            return;
        }
        let server;
        try {
            server = await purchasesApi.getInvoice(meta.id);
        } catch (error) {
            if (op.op === 'delete' && error?.code === 'PURCHASE_INVOICE_NOT_FOUND') { finishDeleted(meta.id); return; }
            errorText.value = describeError(error);
            return;
        }
        if (op.op === 'post' && server.status === 'posted') { finishPosted(server, op.mode); return; }
        if (op.op === 'reverse' && server.status === 'reversed') { finishReversed(server); return; }
        if (server.status !== 'draft' && op.op !== 'reverse') {
            pending.value = null;
            applyInvoice(server);
            emit('saved', summaryOf(server, server.lines?.length || 0));
            note.value = t('The invoice changed on the server. It is shown as it is now.');
            return;
        }
        pending.value = null;
        if (op.op === 'save') {
            const committed = server.version !== op.expectedVersion;
            if (!committed) { note.value = t('Nothing was saved. You can save again.'); return; }
            if (sameDraft(server, op.body)) {
                meta.version = server.version;
                if (op.submitted) meta.baseline = op.submitted; else markClean();
                emit('saved', summaryOf(server, server.lines.length));
                note.value = t('Draft saved.');
            } else {
                // Someone else changed it: keep the old version so a blind save stays stale, and offer a reload.
                errorText.value = t('The invoice changed on the server. Review it and save again.');
                canReload.value = true;
            }
        } else if (op.op === 'post') {
            meta.version = server.version;
            note.value = t('The invoice was not posted. You can post it again.');
        } else {
            note.value = op.op === 'delete' ? t('The draft was not deleted.') : t('The invoice was not reversed.');
        }
    } finally {
        busy.value = false;
    }
}

async function reloadFromServer() {
    if (busy.value || !meta.id) return;
    if (dirty.value && !await ask(t('Discard your unsaved changes and reload this invoice?'), t('Reload invoice'))) return;
    clearMessages();
    await loadInvoice(meta.id);
}

async function confirmDiscard() {
    if (busy.value) return false;
    if (pending.value) return ask(t('The result is unconfirmed. Check it before leaving. Leave anyway?'), t('Unconfirmed result'));
    if (dirty.value) {
        const discard = await ask(t('Discard the unsaved changes to this invoice?'), t('Unsaved changes'));
        if (discard) clearBackup();
        return discard;
    }
    return true;
}

function focusNewLine() {
    if (locked.value) return;
    addRow();
}

// Local recovery copy -----------------------------------------------------
// Every unsaved change is mirrored to this device so a power cut or a closed tab does not lose
// a long invoice. It is removed once the invoice is saved, posted, deleted or knowingly discarded.
const backupKey = `pos_purchase_backup_${props.itemKind}`;
const backupOffer = ref(null);
let backupTimer = null;

function readBackup() {
    try {
        const saved = JSON.parse(localStorage.getItem(backupKey) || 'null');
        return saved && Array.isArray(saved.rows) && saved.form ? saved : null;
    } catch {
        return null;
    }
}
function clearBackup() {
    clearTimeout(backupTimer);
    backupOffer.value = null;
    try { localStorage.removeItem(backupKey); } catch { /* storage unavailable */ }
}
function writeBackup() {
    if (readOnly.value || loading.value || backupOffer.value || !dirty.value) return;
    const entered = rows.value.filter(row => row.item || !isBlankRow(row)).map(({ key, ...row }) => row);
    try {
        localStorage.setItem(backupKey, JSON.stringify({ saved_at: Date.now(), id: meta.id, version: meta.version, form: { ...form }, rows: entered }));
    } catch { /* storage full or unavailable: the server draft is still the record */ }
}
watch([snapshot, () => meta.id], () => {
    clearTimeout(backupTimer);
    backupTimer = setTimeout(writeBackup, 400);
});

function offerBackup() {
    const saved = readBackup();
    if (!saved) return;
    if (props.openId && saved.id !== props.openId) return;
    if (!saved.rows.some(row => row.item) && !saved.form.supplier_id) return;
    backupOffer.value = {
        id: saved.id,
        when: new Date(saved.saved_at).toLocaleString(),
        lines: saved.rows.filter(row => row.item).length,
    };
}
async function restoreBackup() {
    const saved = readBackup();
    if (!saved) { backupOffer.value = null; return; }
    if (saved.id && meta.id !== saved.id) await loadInvoice(saved.id);
    if (saved.id && (meta.id !== saved.id || meta.status !== 'draft')) {
        errorText.value = t('The saved draft is no longer editable, so the recovery copy could not be applied.');
        return;
    }
    Object.assign(form, saved.form);
    await nextTick();
    rows.value = saved.rows.map(row => newRow(row));
    ensureTrailingBlank();
    if (!rows.value.length) rows.value = [newRow()];
    backupOffer.value = null;
    clearMessages();
    note.value = t('The unsaved invoice was restored. Save it as a draft or post it.');
    writeBackup();
}
async function discardBackup() {
    if (!await ask(t('Discard the recovered invoice? It cannot be restored afterwards.'), t('Discard it'))) return;
    clearBackup();
}

onMounted(async () => {
    if (props.openId) await loadInvoice(props.openId); else focusSupplier();
    offerBackup();
});
onBeforeUnmount(() => { loadSequence += 1; insightSequence += 1; clearTimeout(insightTimer); clearTimeout(backupTimer); writeBackup(); });

const unsaved = computed(() => dirty.value || !!pending.value);
defineExpose({ saveDraft, requestPost, focusNewLine, focusSupplier, confirmDiscard, dirty, busy, unsaved, resetToNew });
</script>

<style scoped>
.pi-head-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pi-kbd { margin-inline-start: 6px; padding: 0 5px; border: 1px solid #d4d4d8; border-radius: 4px; background: #fafafa; font: inherit; font-size: 11px; direction: ltr; }
.pi-field-label { font-size: 12px; font-weight: 750; letter-spacing: .02em; color: #3f3f46; }
.pi-base-unit { display: block; margin-block-start: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

<template>
    <section ref="root" class="pi-pane pi-editor-pane lg-book ct-book" :aria-busy="loading">
        <!-- Controls live on the desk, outside the paper. -->
        <div class="lg-toolbar">
            <button type="button" class="lg-btn pi-back" @click="$emit('back')">
                <i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to list') }}
            </button>
            <span class="lg-state lg-state--draft">{{ $t('Counting') }}</span>
            <span class="lg-grow"></span>
            <button type="button" class="lg-btn lg-btn--danger" :disabled="loading || deleting" @click="deleteDraft">
                <i class="fa-solid fa-trash-can" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('Delete draft') }}</span>
            </button>
            <button type="button" class="lg-btn" :aria-label="$t('New count')" @click="$emit('request-new')">
                <i class="fa-solid fa-plus" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('New count') }}</span>
            </button>
        </div>
        <div class="lg-toolbar ct-tools">
            <label class="ct-find">
                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input
                    ref="findInput"
                    v-model="findTerm"
                    class="ct-find-input"
                    type="search"
                    autocomplete="off"
                    :placeholder="$t('Find item')"
                    :aria-label="$t('Find item')"
                    @keydown.enter.prevent="onFindEnter"
                    @keydown.esc.prevent="clearFind"
                    @keydown.down.prevent="stepMatch(1)"
                    @keydown.up.prevent="stepMatch(-1)"
                >
                <kbd class="lg-kbd">F2</kbd>
            </label>
            <div class="lg-toggle ct-filters" role="group" :aria-label="$t('Show')">
                <button v-for="option in FILTERS" :key="option.key" type="button" :aria-pressed="filter === option.key" @click="filter = option.key">{{ $t(option.label) }}</button>
            </div>
            <span class="lg-grow"></span>
            <div class="lg-pop-anchor">
                <button type="button" class="lg-btn" :class="{ 'is-open': showAdd }" :disabled="loading" :aria-expanded="showAdd" @click="toggleAdd">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('Add item') }}</span>
                </button>
                <div v-if="showAdd" class="lg-pop ct-add" role="dialog" :aria-label="$t('Add item')" @keydown.esc="showAdd = false">
                    <input ref="addInput" v-model="addTerm" class="lg-select ct-add-input" type="search" autocomplete="off" :placeholder="$t('Search item name or barcode')" :aria-label="$t('Search')" @input="onAddInput">
                    <p v-if="addError" class="ct-add-msg ct-add-msg--error" role="alert">{{ addError }}</p>
                    <p v-else-if="addSearching" class="ct-add-msg" role="status">{{ $t('Loading...') }}</p>
                    <p v-else-if="addTerm.trim() && !addResults.length" class="ct-add-msg">{{ $t('No items found.') }}</p>
                    <ul v-if="addResults.length" class="ct-add-list">
                        <li v-for="item in addResults" :key="item.item_key">
                            <button type="button" class="ct-add-item" :disabled="adding" @click="addItem(item)">
                                <strong data-no-i18n>{{ item.name }}</strong>
                                <small data-no-i18n>{{ groupText(item) }}</small>
                            </button>
                        </li>
                    </ul>
                </div>
            </div>
        </div>

        <div class="lg-desk">
            <div class="lg-page">
                <header class="lg-head">
                    <div class="lg-title">
                        <span class="lg-cap">{{ $t('Stock count') }}</span>
                        <h3 class="ct-title" data-no-i18n>{{ count.reference || titleFallback }}</h3>
                    </div>
                    <div class="lg-blanks">
                        <div class="lg-blank">
                            <span class="lg-cap">{{ $t('Date') }}</span>
                            <bdi class="pi-num ct-val" data-no-i18n>{{ String(count.count_date || '').slice(0, 10) }}</bdi>
                        </div>
                        <div class="lg-blank">
                            <span class="lg-cap">{{ $t('Counted items') }}</span>
                            <span class="ct-val"><bdi class="pi-num" data-no-i18n>{{ countedCount }} / {{ lines.length }}</bdi></span>
                        </div>
                    </div>
                </header>

                <p v-if="loading" class="lg-note" role="status">{{ $t('Loading...') }}</p>
                <p v-else class="lg-note ct-blind"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i>{{ $t('Blind count: expected quantities stay hidden until review.') }}</p>

                <div class="ct-sheet" role="table" :aria-label="$t('Items')">
                    <div class="ct-row ct-row--head" role="row">
                        <span class="ct-c-no" role="columnheader">#</span>
                        <span class="ct-c-item" role="columnheader">{{ $t('Item') }}</span>
                        <span class="ct-c-qty" role="columnheader">{{ $t('Counted quantity') }}</span>
                        <span class="ct-c-unit" role="columnheader">{{ $t('Unit') }}</span>
                        <span class="ct-c-meta" role="columnheader"><span class="sr-only">{{ $t('Status') }}</span></span>
                    </div>
                    <template v-for="section in sections" :key="section.id">
                        <div class="ct-group" role="row">
                            <span aria-hidden="true"></span>
                            <span class="ct-group-text" role="cell"><span data-no-i18n>{{ section.label }}</span> <bdi class="pi-num" data-no-i18n>{{ section.counted }} / {{ section.lines.length }}</bdi></span>
                        </div>
                        <div
                            v-for="line in section.lines"
                            :key="line.id"
                            class="ct-row"
                            :class="{ 'is-hl': highlightId === line.id, 'is-done': isCounted(line), 'is-bad': marker(line) === 'error' || marker(line) === 'invalid' }"
                            role="row"
                            :data-line="line.id"
                        >
                            <span class="ct-c-no pi-num" role="cell" data-no-i18n>{{ line.line_no }}</span>
                            <span class="ct-c-item" role="cell" data-no-i18n>{{ line.name }}</span>
                            <div class="ct-c-qty" role="cell">
                                <input
                                    v-model="line.qty"
                                    class="lg-cell lg-cell--num"
                                    :class="{ 'is-invalid': marker(line) === 'invalid' }"
                                    type="text"
                                    inputmode="decimal"
                                    autocomplete="off"
                                    placeholder="—"
                                    :disabled="loading"
                                    :aria-label="`${$t('Counted quantity')}: ${line.name}`"
                                    :data-qty="line.id"
                                    @input="onQtyInput(line)"
                                    @keydown.enter.prevent="onQtyEnter($event, line)"
                                >
                            </div>
                            <div class="ct-c-unit" role="cell">
                                <select class="lg-cell" :value="unitKey(currentUnit(line))" :disabled="loading" :aria-label="`${$t('Unit')}: ${line.name}`" @change="onUnitChange(line, $event.target.value)">
                                    <option v-for="option in unitOptions(line)" :key="unitKey(option)" :value="unitKey(option)" data-no-i18n>{{ unitText(option, line) }}</option>
                                </select>
                            </div>
                            <div class="ct-c-meta" role="cell">
                                <span v-if="marker(line) === 'pending'" class="ct-dot" role="status" :title="$t('Saving...')"><span class="sr-only">{{ $t('Saving...') }}</span></span>
                                <button v-else-if="marker(line) === 'error'" type="button" class="ct-retry" :title="$t('Not saved. Tap to retry.')" @click="flush">
                                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span class="sr-only">{{ $t('Not saved. Tap to retry.') }}</span>
                                </button>
                                <span v-else-if="marker(line) === 'invalid'" class="ct-bad" role="status"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>{{ $t('Invalid quantity') }}</span>
                                <span v-else-if="line.counted_at" class="ct-by" data-no-i18n>{{ byText(line) }}</span>
                            </div>
                        </div>
                    </template>
                    <p v-if="!loading && !sections.length" class="lg-note ct-empty">{{ lines.length ? $t('No items match this view.') : $t('This count has no items yet.') }}</p>
                    <div class="lg-spare" aria-hidden="true"></div>
                </div>
            </div>
        </div>

        <footer class="lg-foot">
            <div v-if="loadError || saveError || errorText || note" class="lg-messages">
                <p v-if="loadError" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ loadError }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" @click="load">{{ $t('Retry') }}</button>
                </p>
                <p v-if="saveError" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ saveError }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" @click="flush">{{ $t('Retry') }}</button>
                </p>
                <p v-if="errorText" class="lg-msg lg-msg--error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ errorText }}</span></p>
                <p v-if="note" class="lg-msg lg-msg--done" role="status"><i class="fa-solid fa-check" aria-hidden="true"></i><span>{{ note }}</span></p>
            </div>
            <div class="lg-actions">
                <span class="ct-saved" role="status">{{ statusText }}</span>
                <span class="lg-grow"></span>
                <button type="button" class="lg-btn" :disabled="loading || !unsaved" @click="flush">{{ $t('Save now') }} <kbd class="lg-kbd">Ctrl S</kbd></button>
                <button type="button" class="lg-btn lg-btn--ink" :disabled="loading || !!loadError || reviewing" @click="goReview">{{ $t('Review differences') }}</button>
            </div>
            <p class="lg-keys" :aria-label="$t('Keyboard shortcuts')">
                <span><kbd>Enter</kbd> {{ $t('save and next uncounted') }}</span>
                <span><kbd>Shift</kbd>+<kbd>Enter</kbd> {{ $t('previous item') }}</span>
                <span><kbd>F2</kbd> <kbd>Ctrl</kbd>+<kbd>F</kbd> {{ $t('find item') }}</span>
                <span><kbd>Esc</kbd> {{ $t('clear find') }}</span>
                <span><kbd>Ctrl</kbd>+<kbd>S</kbd> {{ $t('save now') }}</span>
            </p>
        </footer>
    </section>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { isUnansweredRequest } from '@/shared/http.js';
import { formatReportBusinessTime } from '../../utils/reportFormatting.js';
import { countsApi, describeError } from './countsApi.js';
import { MAX_BATCH, canonQty, groupName, trimFactor, nextIndex, parseQty, sameUnit, trimQty, unitKey, unitOptionText } from './countMath.js';
import './counts.css';

const props = defineProps({
    countId: { type: [Number, String], required: true },
});
const emit = defineEmits(['saved', 'deleted', 'active', 'back', 'request-new', 'review', 'already-posted']);

const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'uncounted', label: 'Not counted' },
    { key: 'counted', label: 'Counted items' },
];
const SAVE_DEBOUNCE_MS = 700;
const UNIT_NAMES = { g: 'gram', kg: 'kilogram', ml: 'millilitre', l: 'litre', unit: 'piece' };

const root = ref(null);
const findInput = ref(null);
const addInput = ref(null);

const count = reactive({ id: null, reference: '', count_date: '', status: 'draft', created_by_name: '' });
const lines = ref([]);
const loading = ref(true);
const loadError = ref('');
const saveError = ref('');
const errorText = ref('');
const note = ref('');
const deleting = ref(false);
const reviewing = ref(false);
const filter = ref('all');
const findTerm = ref('');
const highlightId = ref(null);
const showAdd = ref(false);
const addTerm = ref('');
const addResults = ref([]);
const addSearching = ref(false);
const addError = ref('');
const adding = ref(false);

let loadSequence = 0;
let saveTimer = null;
let addTimer = null;
let addSequence = 0;
let inflight = null;
let queued = false;

const ask = async (message, heading) => (window.showAdminConfirm ? window.showAdminConfirm(message, heading) : window.confirm(message));

// A line as the sheet holds it: what the person typed (qty, unit) next to what the server
// has (saved). The two are compared to decide what still needs to be sent.
function lineView(line) {
    const qty = canonQty(line.qty);
    return {
        id: line.id,
        line_no: line.line_no,
        item_key: line.item_key,
        name: line.name,
        group_label: line.group_label,
        group_key: line.group_key || null,
        base_unit: line.base_unit,
        unit_options: Array.isArray(line.unit_options) ? line.unit_options : [],
        qty: qty === null ? '' : trimQty(qty),
        unit_label: line.unit_label,
        unit_factor: String(line.unit_factor),
        counted_at: line.counted_at || null,
        counted_by_name: line.counted_by_name || '',
        saved: { qty, unit_label: line.unit_label, unit_factor: String(line.unit_factor) },
        status: 'idle',
    };
}

const isCounted = (line) => line.saved.qty !== null;
// Typed but not yet accepted by the server: a different quantity, or the same quantity in another unit.
function isDirty(line) {
    const typed = parseQty(line.qty);
    if (typed.state === 'invalid') return true;
    if (typed.value !== line.saved.qty) return true;
    return typed.value !== null && !sameUnit(line.unit_label, line.unit_factor, line.saved.unit_label, line.saved.unit_factor);
}
const isSendable = (line) => parseQty(line.qty).state !== 'invalid' && isDirty(line);
function marker(line) {
    if (parseQty(line.qty).state === 'invalid') return 'invalid';
    if (line.status === 'error' && isDirty(line)) return 'error';
    if (line.status === 'saving' || isDirty(line)) return 'pending';
    return '';
}

const countedCount = computed(() => lines.value.filter(isCounted).length);
const unsaved = computed(() => lines.value.some(isDirty));

const hasInvalid = computed(() => lines.value.some(line => parseQty(line.qty).state === 'invalid'));
const statusText = computed(() => {
    if (!unsaved.value) return t('All changes saved');
    if (hasInvalid.value) return t('Fix the marked quantities first.');
    return saveError.value ? t('Not saved yet') : t('Saving...');
});

// Lines saved while a filter is on stay in view until the filter changes or the count reloads,
// so a row does not vanish from under the cursor 700 ms after the person typed in it.
const kept = ref(new Set());
watch(filter, () => { kept.value = new Set(); });
const visible = computed(() => lines.value.filter(line => {
    if (kept.value.has(line.id)) return true;
    if (filter.value === 'uncounted') return !isCounted(line);
    if (filter.value === 'counted') return isCounted(line);
    return true;
}));
const sections = computed(() => {
    const order = [];
    const byLabel = new Map();
    for (const line of visible.value) {
        const groupId = line.group_key || line.group_label;
        if (!byLabel.has(groupId)) {
            const section = { id: groupId, label: groupText(line), lines: [], counted: 0 };
            byLabel.set(groupId, section);
            order.push(section);
        }
        const section = byLabel.get(groupId);
        section.lines.push(line);
        if (isCounted(line)) section.counted += 1;
    }
    return order;
});
// Sheet order on screen, which is the order Enter walks.
const ordered = computed(() => sections.value.flatMap(section => section.lines));

const unitOptions = (line) => {
    const current = currentUnit(line);
    const options = line.unit_options.length ? line.unit_options : [{ label: line.unit_label, factor: line.unit_factor }];
    return options.some(option => unitKey(option) === unitKey(current)) ? options : [current, ...options];
};
const currentUnit = (line) => ({ label: line.unit_label, factor: line.unit_factor });
const unitText = (option, line) => {
    const options = unitOptions(line);
    const base = unitOptionText(option, line.base_unit, Object.fromEntries(Object.entries(UNIT_NAMES).map(([key, name]) => [key, t(name)])), options);
    // Two packs that share a label read apart by their factor.
    const shared = options.filter(other => other.label === option.label).length > 1;
    return shared ? `${base} × ${trimFactor(option.factor)}` : base;
};
const groupText = (line) => groupName(line, t);
const titleFallback = computed(() => `${t('Stock count')} ${String(count.count_date || '').slice(0, 10)}`.trim());
const byText = (line) => {
    // The admin's own formatter: business-offset clock with AM/PM in the selected language.
    const time = line.counted_at ? formatReportBusinessTime(line.counted_at) : '';
    return [line.counted_by_name, time].filter(Boolean).join(' · ');
};

function summary() {
    return {
        id: count.id, reference: count.reference, count_date: count.count_date, status: count.status,
        line_count: lines.value.length, counted_count: countedCount.value, variance_value: null,
        created_by_name: count.created_by_name, posted_at: null,
    };
}

// Loading ---------------------------------------------------------------
async function load() {
    const current = ++loadSequence;
    loading.value = true;
    loadError.value = '';
    try {
        const data = await countsApi.getCount(props.countId);
        if (current !== loadSequence) return;
        Object.assign(count, { id: data.id, reference: data.reference || '', count_date: data.count_date, status: data.status, created_by_name: data.created_by_name || '' });
        lines.value = (data.lines || []).map(lineView);
        kept.value = new Set();
        emit('active', data.id);
        if (data.status !== 'draft') emit('already-posted', data.id);
    } catch (error) {
        if (current === loadSequence) loadError.value = describeError(error);
    } finally {
        if (current === loadSequence) loading.value = false;
    }
}

// Saving ----------------------------------------------------------------
// Every edit restarts a short timer; the batch that goes out is whatever differs from what the
// server has. Setting a quantity is idempotent, so a batch whose reply was lost is simply sent
// again with the same values the next time.
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (loading.value || count.status !== 'draft') return undefined;
    if (inflight) {
        // Edits made while a batch is on the wire go out right after it returns.
        queued = true;
        return inflight;
    }
    const batch = lines.value.filter(isSendable).slice(0, MAX_BATCH);
    if (!batch.length) return undefined;
    inflight = runBatch(batch);
    return inflight;
}

async function runBatch(batch) {
    queued = false;
    // The values actually sent. After the reply a line is only clean if it still holds these.
    const sent = batch.map(line => {
        const typed = parseQty(line.qty);
        return { line, qty: typed.value, unit_label: line.unit_label, unit_factor: line.unit_factor };
    });
    for (const entry of sent) entry.line.status = 'saving';
    let ok = false;
    try {
        const data = await countsApi.saveLines(count.id, sent.map(({ line, qty, unit_label, unit_factor }) => ({ id: line.id, qty, unit_label, unit_factor })));
        const returned = new Map((data?.lines || []).map(line => [line.id, line]));
        for (const { line, qty, unit_label, unit_factor } of sent) {
            line.saved = { qty, unit_label, unit_factor };
            line.status = 'idle';
            const server = returned.get(line.id);
            if (server) {
                line.counted_at = server.counted_at || null;
                line.counted_by_name = server.counted_by_name || '';
            }
        }
        if (filter.value !== 'all') kept.value = new Set([...kept.value, ...sent.map(entry => entry.line.id)]);
        saveError.value = '';
        ok = true;
        emit('saved', summary());
    } catch (error) {
        for (const { line } of sent) line.status = 'error';
        saveError.value = describeError(error);
    } finally {
        inflight = null;
    }
    // A full batch leaves more behind, and a flush asked for while this one was in flight must still run.
    if (ok && (queued || (batch.length === MAX_BATCH && lines.value.some(isSendable)))) flush();
    return ok;
}

// Waits until nothing is left to send. True when every line is on the server.
async function saveAll() {
    for (let round = 0; round < 50; round += 1) {
        const pending = flush();
        if (!pending) break;
        if (!(await pending)) break;
    }
    return !lines.value.some(isDirty);
}

function onQtyInput(line) {
    note.value = '';
    if (line.status === 'error') line.status = 'idle';
    scheduleSave();
}
function onUnitChange(line, key) {
    const option = unitOptions(line).find(candidate => unitKey(candidate) === key);
    if (!option) return;
    line.unit_label = option.label;
    line.unit_factor = String(option.factor);
    if (isDirty(line)) scheduleSave();
}

// Focus and keys -----------------------------------------------------------
function focusLine(id) {
    highlightId.value = id;
    nextTick(() => {
        const input = root.value?.querySelector(`[data-qty="${id}"]`);
        if (!input) return;
        input.focus();
        input.select?.();
        input.scrollIntoView?.({ block: 'nearest' });
    });
}
function onQtyEnter(event, line) {
    if (event.isComposing) return;
    flush();
    const index = ordered.value.findIndex(candidate => candidate.id === line.id);
    const target = nextIndex(ordered.value, index, event.shiftKey ? -1 : 1, !event.shiftKey);
    if (target >= 0) {
        note.value = '';
        focusLine(ordered.value[target].id);
    } else {
        note.value = event.shiftKey ? t('This is the first item.') : t('No more items left to count.');
    }
}

const normalizeTerm = (value) => String(value || '').toLocaleLowerCase().trim();
const matches = computed(() => {
    const term = normalizeTerm(findTerm.value);
    return term ? lines.value.filter(line => normalizeTerm(line.name).includes(term)) : [];
});
watch(findTerm, () => {
    if (!matches.value.length) { highlightId.value = null; return; }
    jumpTo(matches.value[0]);
});
function jumpTo(line, focus = false) {
    if (!visible.value.includes(line)) filter.value = 'all';
    highlightId.value = line.id;
    nextTick(() => {
        const row = root.value?.querySelector(`[data-line="${line.id}"]`);
        row?.scrollIntoView?.({ block: 'center' });
        if (focus) focusLine(line.id);
    });
}
function stepMatch(step) {
    if (!matches.value.length) return;
    const at = matches.value.findIndex(line => line.id === highlightId.value);
    jumpTo(matches.value[(at + step + matches.value.length) % matches.value.length]);
}
function onFindEnter() {
    const target = matches.value.find(line => line.id === highlightId.value) || matches.value[0];
    if (target) jumpTo(target, true);
}
function clearFind() {
    findTerm.value = '';
    highlightId.value = null;
}
function focusFind() {
    findInput.value?.focus();
    findInput.value?.select?.();
}

function onKeydown(event) {
    if (event.isComposing || loading.value) return;
    const command = event.ctrlKey || event.metaKey;
    if (event.key === 'F2' || (command && !event.altKey && event.code === 'KeyF')) {
        event.preventDefault();
        focusFind();
    } else if (command && !event.altKey && event.code === 'KeyS') {
        event.preventDefault();
        flush();
    }
}
let attached = false;
function attach() {
    if (attached) return;
    attached = true;
    document.addEventListener('keydown', onKeydown);
}
function detach() {
    attached = false;
    document.removeEventListener('keydown', onKeydown);
}

// Add item ---------------------------------------------------------------
function toggleAdd() {
    showAdd.value = !showAdd.value;
    addError.value = '';
    if (showAdd.value) nextTick(() => addInput.value?.focus());
}
function onAddInput() {
    clearTimeout(addTimer);
    addError.value = '';
    const q = addTerm.value.trim();
    if (!q) { addResults.value = []; addSearching.value = false; addSequence += 1; return; }
    addTimer = setTimeout(searchItems, 250);
}
async function searchItems() {
    const current = ++addSequence;
    addSearching.value = true;
    try {
        const results = await countsApi.searchItems({ q: addTerm.value.trim() });
        if (current === addSequence) addResults.value = results;
    } catch (error) {
        if (current === addSequence) { addResults.value = []; addError.value = describeError(error); }
    } finally {
        if (current === addSequence) addSearching.value = false;
    }
}
async function addItem(item) {
    const known = lines.value.find(line => line.item_key === item.item_key);
    if (known) { closeAdd(); note.value = t('This item is already on the sheet.'); jumpTo(known, true); return; }
    adding.value = true;
    addError.value = '';
    try {
        const result = await countsApi.addLine(count.id, item.item_key);
        const existing = lines.value.find(line => line.id === result.line.id || line.item_key === result.line.item_key);
        let target = existing;
        if (!existing) {
            target = lineView(result.line);
            lines.value.push(target);
            emit('saved', summary());
        }
        closeAdd();
        note.value = result.existing || existing ? t('This item is already on the sheet.') : '';
        jumpTo(target, true);
    } catch (error) {
        addError.value = describeError(error);
    } finally {
        adding.value = false;
    }
}
function closeAdd() {
    showAdd.value = false;
    addTerm.value = '';
    addResults.value = [];
    clearTimeout(addTimer);
    addSequence += 1;
}

// Leaving -----------------------------------------------------------------
async function goReview() {
    errorText.value = '';
    reviewing.value = true;
    try {
        if (await saveAll()) emit('review');
        else errorText.value = hasInvalid.value ? t('Fix the marked quantities first.') : t('Some counted quantities are not saved yet. Retry before reviewing.');
    } finally {
        reviewing.value = false;
    }
}

async function deleteDraft() {
    if (!await ask(t('Delete this draft count? Everything counted so far is lost.'), t('Delete draft'))) return;
    deleting.value = true;
    errorText.value = '';
    clearTimeout(saveTimer);
    try {
        await countsApi.deleteCount(count.id);
        emit('deleted', count.id);
    } catch (error) {
        // The reply may have been lost after the delete went through.
        if (isUnansweredRequest(error) || error?.code === 'STOCK_COUNT_NOT_FOUND') {
            try { await countsApi.getCount(count.id); } catch (check) {
                if (check?.code === 'STOCK_COUNT_NOT_FOUND') { emit('deleted', count.id); return; }
            }
        }
        errorText.value = describeError(error);
    } finally {
        deleting.value = false;
    }
}

// Leaving the sheet: try to save what is typed; ask only when that fails.
async function confirmDiscard() {
    if (!unsaved.value) return true;
    if (await saveAll()) return true;
    return ask(t('Some counted quantities are not saved. Leave anyway and lose them?'), t('Unsaved changes'));
}

onMounted(() => {
    attach();
    load();
});
onActivated(attach);
onDeactivated(detach);
onBeforeUnmount(() => {
    detach();
    loadSequence += 1;
    addSequence += 1;
    clearTimeout(saveTimer);
    clearTimeout(addTimer);
});

defineExpose({ flush, saveAll, confirmDiscard, canLeave: confirmDiscard, unsaved, focusFind });
</script>

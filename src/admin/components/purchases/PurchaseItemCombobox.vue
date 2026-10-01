<template>
    <div class="pi-combo">
        <input
            ref="input"
            v-model="text"
            class="pi-input"
            :class="{ 'is-invalid': invalid }"
            type="text"
            role="combobox"
            autocomplete="off"
            aria-autocomplete="list"
            :aria-expanded="open"
            :aria-controls="listId"
            :aria-activedescendant="activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined"
            :aria-label="`${$t('Item')} ${rowNumber}`"
            :placeholder="$t('Item name or barcode')"
            :disabled="disabled"
            data-cell="item"
            :data-row="rowIndex"
            @input="onInput"
            @keydown="onKeydown"
            @blur="onBlur"
        >
        <ul v-if="open" :id="listId" class="pi-list" role="listbox">
            <li
                v-for="(entry, index) in results"
                :id="`${listId}-${index}`"
                :key="entry.item_key"
                class="pi-option"
                role="option"
                :aria-selected="index === activeIndex"
                @mousedown.prevent="choose(entry)"
            >
                <span class="pi-opt-main">
                    <span data-no-i18n>{{ entry.name }}</span>
                    <span v-if="entry.starts_tracking" class="pi-track" :title="$t('Stock is unlimited now. Receiving it starts counting its stock.')">{{ $t('Starts stock tracking') }}</span>
                </span>
                <small data-no-i18n>{{ entry.base_unit }}<template v-if="entry.matched_barcode || entry.barcode"> · {{ entry.matched_barcode || entry.barcode }}</template></small>
            </li>
            <li v-if="!results.length" class="pi-list-empty" role="presentation">{{ $t('No matching items.') }}</li>
        </ul>
        <p v-if="message" class="pi-error" role="alert">{{ message }}</p>
    </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { purchasesApi, describeError } from './purchasesApi.js';

const props = defineProps({
    itemKind: { type: String, required: true },
    item: { type: Object, default: null },
    rowIndex: { type: Number, required: true },
    supplierId: { type: [Number, String], default: null },
    disabled: { type: Boolean, default: false },
    invalid: { type: Boolean, default: false },
});
// pick: chosen from the list (the editor then moves to quantity).
// scan: exact barcode hit (the editor adds or +1 and stays in the search).
// next: Enter on a filled row with nothing typed.
const emit = defineEmits(['pick', 'scan', 'next']);

const input = ref(null);
const text = ref(props.item?.name || '');
const editing = ref(false);
const results = ref([]);
const open = ref(false);
const activeIndex = ref(-1);
const message = ref('');
const listId = `pi-items-${Math.random().toString(36).slice(2, 8)}`;
const rowNumber = computed(() => props.rowIndex + 1);

let sequence = 0;
let debounce = null;

watch(() => props.item, (item) => {
    if (!editing.value) text.value = item?.name || '';
});

function close() {
    open.value = false;
    activeIndex.value = -1;
}

function reset(keepText = false) {
    clearTimeout(debounce);
    sequence += 1;
    editing.value = false;
    results.value = [];
    message.value = '';
    close();
    if (!keepText) text.value = props.item?.name || '';
}

async function search(query) {
    const current = ++sequence;
    const trimmed = query.trim();
    if (!trimmed) { results.value = []; close(); return []; }
    try {
        const found = await purchasesApi.searchItems({ kind: props.itemKind, q: trimmed, supplierId: props.supplierId });
        if (current !== sequence) return null;
        results.value = found;
        message.value = '';
        open.value = true;
        activeIndex.value = found.length ? 0 : -1;
        return found;
    } catch (error) {
        if (current !== sequence) return null;
        results.value = [];
        message.value = describeError(error);
        close();
        return null;
    }
}

function onInput() {
    editing.value = true;
    message.value = '';
    clearTimeout(debounce);
    debounce = setTimeout(() => search(text.value), 180);
}

// The server reports which of the item's barcodes (main or extra) the typed text equals exactly;
// an older response without it falls back to the main barcode. The database matches barcodes
// ignoring case, so the comparison does too.
function choose(entry) {
    const matched = entry.matched_barcode ?? entry.barcode;
    const scanned = Boolean(matched) && String(matched).toLowerCase() === text.value.trim().toLowerCase();
    reset(true);
    if (scanned) {
        text.value = '';
        emit('scan', entry);
        return;
    }
    text.value = entry.name;
    emit('pick', entry);
}

// Enter with nothing highlighted: a scanner types digits then Enter, so try an exact
// barcode first, then fall back to the best name match.
async function submitTyped() {
    clearTimeout(debounce);
    const typed = text.value.trim();
    if (!typed) return;
    const current = ++sequence;
    try {
        const exact = await purchasesApi.searchItems({ kind: props.itemKind, barcode: typed, supplierId: props.supplierId, limit: 1 });
        if (current !== sequence) return;
        if (exact.length) {
            reset();
            text.value = '';
            emit('scan', exact[0]);
            return;
        }
        const found = await purchasesApi.searchItems({ kind: props.itemKind, q: typed, supplierId: props.supplierId });
        if (current !== sequence) return;
        results.value = found;
        open.value = true;
        activeIndex.value = found.length ? 0 : -1;
        message.value = '';
        if (found.length === 1) choose(found[0]);
    } catch (error) {
        if (current !== sequence) return;
        message.value = describeError(error);
    }
}

function onKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!results.value.length) return;
        event.preventDefault();
        if (!open.value) { open.value = true; return; }
        const last = results.value.length - 1;
        activeIndex.value = event.key === 'ArrowDown' ? Math.min(last, activeIndex.value + 1) : Math.max(0, activeIndex.value - 1);
    } else if (event.key === 'Escape') {
        if (open.value) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (open.value && activeIndex.value >= 0 && results.value[activeIndex.value]) choose(results.value[activeIndex.value]);
        else if (editing.value && text.value.trim()) submitTyped();
        else if (props.item) emit('next');
    }
}

function onBlur() {
    reset();
}

onBeforeUnmount(() => { clearTimeout(debounce); sequence += 1; });
defineExpose({ focus: () => input.value?.focus(), clear: () => { reset(); text.value = ''; } });
</script>

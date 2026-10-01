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
            :aria-label="$t('Supplier')"
            :placeholder="$t('Search or add a supplier')"
            :disabled="disabled"
            data-field="supplier"
            @focus="onFocus"
            @click="openList"
            @input="onInput"
            @keydown="onKeydown"
            @blur="onBlur"
        >
        <ul v-if="open" :id="listId" class="pi-list" role="listbox">
            <li
                v-for="(option, index) in options"
                :id="`${listId}-${index}`"
                :key="option.key"
                class="pi-option"
                :class="{ 'pi-option--add': option.kind !== 'supplier' }"
                role="option"
                :aria-selected="index === activeIndex"
                @mousedown.prevent="choose(option)"
            >
                <template v-if="option.kind === 'create'"><span>{{ $t('Add supplier') }} «<bdi data-no-i18n>{{ option.name }}</bdi>»</span></template>
                <template v-else-if="option.kind === 'generic'"><span><i class="fa-solid fa-store" aria-hidden="true"></i> {{ $t('General supplier') }}</span></template>
                <template v-else-if="option.kind === 'details'"><span><i class="fa-solid fa-plus" aria-hidden="true"></i> {{ $t('New supplier with details…') }}</span></template>
                <template v-else>
                    <span data-no-i18n>{{ option.supplier.name }}</span>
                    <small v-if="option.supplier.phone" data-no-i18n>{{ option.supplier.phone }}</small>
                </template>
            </li>
        </ul>
        <form v-if="showDetails" class="lg-pop pi-supplier-form" role="dialog" :aria-label="$t('New supplier')" @submit.prevent="saveDetails" @keydown.esc.stop.prevent="closeDetails">
            <strong class="pi-supplier-form-title">{{ $t('New supplier') }}</strong>
            <label class="lg-blank">
                <span class="lg-cap">{{ $t('Supplier name') }}</span>
                <input ref="detailsName" v-model="details.name" class="lg-fill" type="text" maxlength="120" autocomplete="off" required data-field="supplier_name">
            </label>
            <label class="lg-blank">
                <span class="lg-cap">{{ $t('Phone') }} ({{ $t('Optional') }})</span>
                <input v-model="details.phone" class="lg-fill pi-num-input" type="tel" maxlength="40" autocomplete="off" data-field="supplier_phone">
            </label>
            <label class="lg-blank">
                <span class="lg-cap">{{ $t('Tax number') }} ({{ $t('Optional') }})</span>
                <input v-model="details.tax_number" class="lg-fill pi-num-input" type="text" maxlength="40" autocomplete="off" data-field="supplier_tax">
            </label>
            <label class="lg-blank">
                <span class="lg-cap">{{ $t('Notes') }} ({{ $t('Optional') }})</span>
                <input v-model="details.notes" class="lg-fill" type="text" maxlength="255" autocomplete="off" data-field="supplier_notes">
            </label>
            <div class="pi-supplier-form-actions">
                <button type="submit" class="lg-btn lg-btn--ink" :disabled="creating || !details.name.trim()">{{ $t('Save') }}</button>
                <button type="button" class="lg-btn" :disabled="creating" @click="closeDetails">{{ $t('Cancel') }}</button>
            </div>
        </form>
        <p v-if="message" class="pi-error" role="alert">{{ message }}</p>
    </div>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { describeError } from './purchasesApi.js';

const props = defineProps({
    suppliers: { type: Array, default: () => [] },
    modelValue: { type: [Number, String], default: null },
    fallbackName: { type: String, default: '' },
    // Receives { name, phone?, tax_number?, notes? } and resolves to the saved supplier.
    createSupplier: { type: Function, required: true },
    disabled: { type: Boolean, default: false },
    invalid: { type: Boolean, default: false },
});
// update:modelValue carries the supplier id; done fires after a choice so the editor can advance.
const emit = defineEmits(['update:modelValue', 'done']);

// Every spelling the shared walk-in supplier may have been saved under, so it is reused, not duplicated.
const GENERIC_NAMES = ['General supplier', 'مورد عام'];

const input = ref(null);
const detailsName = ref(null);
const text = ref('');
const open = ref(false);
const editing = ref(false);
const activeIndex = ref(-1);
const message = ref('');
const creating = ref(false);
const showDetails = ref(false);
const details = reactive({ name: '', phone: '', tax_number: '', notes: '' });
const listId = `pi-suppliers-${Math.random().toString(36).slice(2, 8)}`;

const normalized = (name) => String(name || '').trim().toLocaleLowerCase();
const selectedName = computed(() => {
    const found = props.suppliers.find(s => Number(s.id) === Number(props.modelValue));
    return found?.name || (props.modelValue ? props.fallbackName : '');
});
const genericSupplier = computed(() => props.suppliers.find(s => GENERIC_NAMES.some(name => normalized(name) === normalized(s.name))) || null);

const options = computed(() => {
    const needle = normalized(text.value);
    const list = props.suppliers
        .filter(s => s !== genericSupplier.value)
        .filter(s => !needle || s.name.toLocaleLowerCase().includes(needle))
        .slice(0, 50)
        .map(supplier => ({ kind: 'supplier', key: `s${supplier.id}`, supplier }));
    const exact = props.suppliers.some(s => normalized(s.name) === needle);
    if (needle && !exact) list.push({ kind: 'create', key: 'create', name: text.value.trim() });
    list.push({ kind: 'details', key: 'details' });
    list.push({ kind: 'generic', key: 'generic' });
    return list;
});

watch(selectedName, (name) => { if (!editing.value) text.value = name; }, { immediate: true });

function onFocus() {
    if (props.disabled) return;
    input.value?.select();
}
function openList() {
    if (props.disabled || showDetails.value) return;
    open.value = true;
    if (activeIndex.value < 0) activeIndex.value = 0;
}
function onInput() {
    editing.value = true;
    message.value = '';
    open.value = true;
    activeIndex.value = options.value.length ? 0 : -1;
}
function close() { open.value = false; activeIndex.value = -1; }

function adopt(supplier) {
    editing.value = false;
    text.value = supplier.name;
    close();
    emit('update:modelValue', supplier.id);
    emit('done');
}

async function create(fields) {
    creating.value = true;
    message.value = '';
    try {
        return await props.createSupplier(fields);
    } catch (error) {
        message.value = describeError(error);
        return null;
    } finally {
        creating.value = false;
    }
}

async function openDetails() {
    const typed = text.value.trim();
    Object.assign(details, { name: typed && typed !== selectedName.value ? typed : '', phone: '', tax_number: '', notes: '' });
    close();
    message.value = '';
    showDetails.value = true;
    await nextTick();
    detailsName.value?.focus();
}
function closeDetails() {
    showDetails.value = false;
    editing.value = false;
    text.value = selectedName.value;
    nextTick(() => input.value?.focus());
}
async function saveDetails() {
    if (creating.value || !details.name.trim()) return;
    const fields = { name: details.name.trim() };
    for (const key of ['phone', 'tax_number', 'notes']) if (details[key].trim()) fields[key] = details[key].trim();
    const supplier = await create(fields);
    if (!supplier) return;
    showDetails.value = false;
    adopt(supplier);
}

async function choose(option) {
    if (creating.value) return;
    if (option.kind === 'details') return openDetails();
    let supplier = option.supplier;
    if (option.kind === 'generic') supplier = genericSupplier.value || await create({ name: t('General supplier') });
    else if (option.kind === 'create') supplier = await create({ name: option.name });
    if (supplier) adopt(supplier);
}

function onKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open.value) { openList(); return; }
        const last = options.value.length - 1;
        activeIndex.value = event.key === 'ArrowDown' ? Math.min(last, activeIndex.value + 1) : Math.max(0, activeIndex.value - 1);
    } else if (event.key === 'Escape') {
        if (open.value) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (open.value && options.value[activeIndex.value]) choose(options.value[activeIndex.value]);
        else if (!editing.value && props.modelValue) emit('done');
        else if (options.value.length) choose(options.value[0]);
    }
}

function onBlur() {
    close();
    if (showDetails.value) return;
    editing.value = false;
    text.value = selectedName.value;
}

defineExpose({ focus: () => input.value?.focus() });
</script>

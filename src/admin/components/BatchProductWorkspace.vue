<template>
    <section class="h-full min-h-0 flex flex-col gap-3 text-foreground" :dir="isRtl ? 'rtl' : 'ltr'">
        <header class="shrink-0 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
                <h2 class="text-lg font-extrabold tracking-tight">{{ $t('Add Multiple Products') }}</h2>
                <p class="mt-1 max-w-2xl text-xs font-medium text-muted-foreground">
                    {{ $t('Create one category at a time. Shared values can still be changed for any product.') }}
                </p>
            </div>
            <div class="flex w-full gap-2 sm:w-auto">
                <button type="button" @click="discardDraft" class="h-11 flex-1 rounded-md border border-zinc-300 bg-card px-4 text-xs font-bold text-rose-700 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 sm:flex-none">
                    {{ $t('Discard Draft') }}
                </button>
                <button type="button" @click="$emit('close')" class="h-11 flex-1 rounded-md border border-zinc-300 bg-muted px-4 text-xs font-bold hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 sm:flex-none">
                    {{ $t('Back to Inventory') }}
                </button>
            </div>
        </header>

        <div class="shrink-0 rounded-xl border border-zinc-300 bg-card p-3 sm:p-4">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label class="block">
                    <span class="mb-1.5 block text-xs font-bold">{{ $t('Category *') }}</span>
                    <select v-model="categoryId" class="h-11 w-full rounded-md border border-zinc-300 bg-muted px-3 text-sm font-semibold outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15">
                        <option value="">{{ $t('Select a category') }}</option>
                        <option v-for="category in categoryOptions" :key="category.id" :value="String(category.id)" data-no-i18n>
                            {{ category.treeLabel }}
                        </option>
                    </select>
                </label>

                <label class="block">
                    <span class="mb-1.5 block text-xs font-bold">{{ $t('Shared Tax (%)') }}</span>
                    <input v-model="defaultTax" type="number" inputmode="decimal" min="0" max="100" step="0.01" class="h-11 w-full rounded-md border border-zinc-300 bg-muted px-3 text-sm font-bold tabular-nums outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15" data-no-i18n>
                </label>

                <div>
                    <span class="mb-1.5 block text-xs font-bold">{{ $t('Shared Card Color') }}</span>
                    <div class="flex h-11 items-center gap-2 rounded-md border border-zinc-300 bg-muted px-2">
                        <template v-if="defaultColor">
                            <input v-model="defaultColor" type="color" :aria-label="$t('Shared Card Color')" class="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0">
                            <span class="min-w-0 flex-1 truncate text-xs font-bold tabular-nums" data-no-i18n>{{ defaultColor }}</span>
                            <button type="button" @click="defaultColor = ''" class="h-8 rounded px-2 text-xs font-bold text-muted-foreground hover:bg-zinc-200 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600">
                                {{ $t('System Default') }}
                            </button>
                        </template>
                        <button v-else type="button" @click="defaultColor = '#ffffff'" class="h-9 w-full rounded text-start text-xs font-bold text-muted-foreground hover:bg-zinc-200 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600">
                            {{ $t('Choose Color') }}
                        </button>
                    </div>
                </div>
            </div>

            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3 text-xs">
                <p class="font-medium text-muted-foreground">{{ $t('Enter the gross selling price. The system stores tax exactly like the normal product form.') }}</p>
                <p v-if="draftRestored" class="font-bold text-teal-700">{{ $t('Draft Restored') }}</p>
            </div>
        </div>

        <div v-if="topError" role="alert" class="shrink-0 rounded-md border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs font-bold text-rose-800">
            {{ topError }}
        </div>

        <div class="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-300 bg-card">
            <div class="flex h-full min-h-0 flex-col">
                <div class="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-muted px-3 py-2.5 sm:px-4">
                    <div>
                        <p class="text-sm font-extrabold">{{ $t('Products') }}</p>
                        <p class="text-[11px] font-medium text-muted-foreground">{{ $t('Press Enter after the price to start the next product.') }}</p>
                    </div>
                    <span class="rounded-md bg-teal-50 px-2.5 py-1 text-xs font-bold text-teal-800">
                        {{ $t('Products Ready') }}: <span class="tabular-nums" data-no-i18n>{{ productCount }}</span>
                    </span>
                </div>

                <div class="batch-scroll min-h-0 flex-1 overflow-auto">
                    <div class="batch-head sticky top-0 z-10 border-b border-zinc-300 bg-zinc-100 px-3 py-2 text-[11px] font-bold text-muted-foreground" :class="{ 'batch-without-stock': !stockEnabled }">
                        <span>#</span>
                        <span>{{ $t('Product Name') }}</span>
                        <span>{{ $t('Gross Price') }}</span>
                        <span>{{ $t('Tax') }}</span>
                        <span>{{ $t('Barcode') }}</span>
                        <span>{{ $t('Cost') }}</span>
                        <span v-if="stockEnabled">{{ $t('Opening Stock') }}</span>
                        <span>{{ $t('Card Color') }}</span>
                        <span></span>
                    </div>

                    <div
                        v-for="(row, index) in rows"
                        :key="row.key"
                        class="batch-row border-b border-zinc-200 px-3 py-3 last:border-b-0"
                        :class="[rowHasErrors(row) ? 'bg-rose-50/40' : 'bg-card', { 'batch-without-stock': !stockEnabled }]"
                    >
                        <div class="row-number flex items-center justify-between">
                            <span class="text-xs font-extrabold tabular-nums text-muted-foreground" data-no-i18n>{{ index + 1 }}</span>
                            <span v-if="rowHasErrors(row)" class="text-[11px] font-bold text-rose-700">{{ $t('Check this row') }}</span>
                        </div>

                        <label class="batch-field field-name">
                            <span class="batch-mobile-label">{{ $t('Product Name') }}</span>
                            <input
                                v-model="row.name"
                                type="text"
                                maxlength="100"
                                :data-row-name="index"
                                :aria-label="$t('Product Name')"
                                :placeholder="$t('Product name')"
                                class="batch-input"
                                :class="row.errors.name ? 'batch-input-error' : ''"
                                @input="clearRowError(row, 'name')"
                            >
                            <span v-if="row.errors.name" class="batch-error">{{ row.errors.name }}</span>
                        </label>

                        <label class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Gross Price') }}</span>
                            <input
                                v-model="row.price"
                                type="number"
                                inputmode="decimal"
                                min="0"
                                step="0.01"
                                :aria-label="$t('Gross Price')"
                                placeholder="0.00"
                                class="batch-input tabular-nums"
                                :class="row.errors.price ? 'batch-input-error' : ''"
                                data-no-i18n
                                @input="clearRowError(row, 'price')"
                                @keydown.enter.prevent="focusNextProduct(index)"
                            >
                            <span v-if="row.errors.price" class="batch-error">{{ row.errors.price }}</span>
                        </label>

                        <div class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Tax') }}</span>
                            <button v-if="row.tax_rate === null" type="button" @click="overrideTax(row)" class="batch-choice">
                                <span class="tabular-nums" data-no-i18n>{{ normalizedDefaultTax }}%</span>
                                <span>{{ $t('Shared') }}</span>
                            </button>
                            <div v-else class="flex gap-1">
                                <input v-model="row.tax_rate" type="number" inputmode="decimal" min="0" max="100" step="0.01" :aria-label="$t('Tax')" class="batch-input min-w-0 flex-1 tabular-nums" :class="row.errors.tax_rate ? 'batch-input-error' : ''" data-no-i18n @input="clearRowError(row, 'tax_rate')">
                                <button type="button" @click="row.tax_rate = null; clearRowError(row, 'tax_rate')" :title="$t('Use Shared Value')" :aria-label="$t('Use Shared Value')" class="batch-reset">↺</button>
                            </div>
                            <span v-if="row.errors.tax_rate" class="batch-error">{{ row.errors.tax_rate }}</span>
                        </div>

                        <label class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Barcode') }}</span>
                            <input v-model="row.barcode" type="text" inputmode="numeric" maxlength="50" :aria-label="$t('Barcode')" :placeholder="$t('Optional')" class="batch-input tabular-nums" :class="row.errors.barcode ? 'batch-input-error' : ''" data-no-i18n @input="clearRowError(row, 'barcode')">
                            <span v-if="row.errors.barcode" class="batch-error">{{ row.errors.barcode }}</span>
                        </label>

                        <label class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Cost') }}</span>
                            <input v-model="row.cost_price" type="number" inputmode="decimal" min="0" step="0.01" :aria-label="$t('Cost')" placeholder="0.00" class="batch-input tabular-nums" :class="row.errors.cost_price ? 'batch-input-error' : ''" data-no-i18n @input="clearRowError(row, 'cost_price')">
                            <span v-if="row.errors.cost_price" class="batch-error">{{ row.errors.cost_price }}</span>
                        </label>

                        <label v-if="stockEnabled" class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Opening Stock') }}</span>
                            <input v-model="row.stock" type="number" inputmode="decimal" min="0" step="0.000001" :aria-label="$t('Opening Stock')" :placeholder="$t('Unlimited')" class="batch-input tabular-nums" :class="row.errors.stock ? 'batch-input-error' : ''" data-no-i18n @input="clearRowError(row, 'stock')">
                            <span v-if="row.errors.stock" class="batch-error">{{ row.errors.stock }}</span>
                        </label>

                        <div class="batch-field">
                            <span class="batch-mobile-label">{{ $t('Card Color') }}</span>
                            <button v-if="row.background_color === null" type="button" @click="overrideColor(row)" class="batch-choice">
                                <span class="h-4 w-4 rounded border border-zinc-300" :style="{ backgroundColor: defaultColor || '#f2f4f6' }"></span>
                                <span>{{ $t('Shared') }}</span>
                            </button>
                            <div v-else class="flex gap-1">
                                <input v-model="row.background_color" type="color" :aria-label="$t('Card Color')" class="batch-color-input">
                                <button type="button" @click="row.background_color = null" :title="$t('Use Shared Value')" :aria-label="$t('Use Shared Value')" class="batch-reset">↺</button>
                            </div>
                        </div>

                        <div class="row-action flex items-start justify-end">
                            <button type="button" @click="removeRow(index)" :aria-label="$t('Remove Product Row')" class="h-10 min-w-10 rounded-md border border-transparent px-2 text-lg font-bold text-muted-foreground hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-600">
                                <span class="remove-symbol">×</span>
                                <span class="remove-text">{{ $t('Remove Row') }}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <footer class="shrink-0 flex flex-col gap-2 border-t border-zinc-300 bg-muted p-3 sm:flex-row sm:items-center sm:justify-between">
                    <button type="button" @click="addRow(true)" class="h-11 rounded-md border border-zinc-300 bg-card px-4 text-xs font-bold hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600">
                        {{ $t('Add Another Row') }}
                    </button>
                    <button type="button" :disabled="isSaving || productCount === 0" @click="saveBatch" class="h-11 rounded-md bg-teal-700 px-5 text-xs font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700">
                        <span v-if="isSaving">{{ $t('Saving...') }}</span>
                        <span v-else>{{ $t('Save Products') }} · <span class="tabular-nums" data-no-i18n>{{ productCount }}</span></span>
                    </button>
                </footer>
            </div>
        </div>
    </section>
</template>

<script setup>
import { fetchJson } from '@/shared/http.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { currentLanguage, t } from '@/shared/i18n.js';

const props = defineProps({
    categoriesTree: { type: Array, default: () => [] },
    stockEnabled: { type: Boolean, default: false }
});

const emit = defineEmits(['close', 'saved']);

const DRAFT_KEY = 'posapp.inventory.batch-products.v1';
let nextRowKey = 1;
let draftTimer = null;

function newRow(source = {}) {
    return {
        key: nextRowKey++,
        name: source.name || '',
        price: source.price ?? '',
        tax_rate: source.tax_rate === null || source.tax_rate === undefined ? null : source.tax_rate,
        barcode: source.barcode || '',
        cost_price: source.cost_price ?? '',
        stock: source.stock ?? '',
        background_color: source.background_color === null || source.background_color === undefined ? null : source.background_color,
        errors: {}
    };
}

const categoryId = ref('');
const defaultTax = ref(0);
const defaultColor = ref('');
const rows = ref([newRow()]);
const isSaving = ref(false);
const draftRestored = ref(false);
const topError = ref('');

const isRtl = computed(() => currentLanguage.value === 'ar');
const categoryOptions = computed(() => props.categoriesTree.filter(category =>
    Number(category.is_notes || 0) !== 1 && (category.is_active === undefined || Number(category.is_active) === 1)
));
const normalizedDefaultTax = computed(() => {
    const value = Number(defaultTax.value);
    return Number.isFinite(value) ? value : 0;
});

function rowHasData(row) {
    return [row.name, row.price, row.barcode, row.cost_price, row.stock].some(value => value !== null && value !== undefined && String(value).trim() !== '');
}

const productCount = computed(() => rows.value.filter(rowHasData).length);

function rowHasErrors(row) {
    return Object.keys(row.errors).length > 0;
}

function clearRowError(row, field) {
    if (row.errors[field]) delete row.errors[field];
    topError.value = '';
}

function addRow(focus = false) {
    rows.value.push(newRow());
    if (focus) focusRowName(rows.value.length - 1);
}

async function focusRowName(index) {
    await nextTick();
    document.querySelector(`[data-row-name="${index}"]`)?.focus();
}

function focusNextProduct(index) {
    if (!rows.value[index + 1]) rows.value.push(newRow());
    focusRowName(index + 1);
}

async function removeRow(index) {
    const row = rows.value[index];
    if (rowHasData(row)) {
        const confirmed = await window.showAdminConfirm(t('Remove this product row?'), t('Remove Product Row'));
        if (!confirmed) return;
    }
    rows.value.splice(index, 1);
    if (rows.value.length === 0) rows.value.push(newRow());
}

function overrideTax(row) {
    row.tax_rate = String(normalizedDefaultTax.value);
}

function overrideColor(row) {
    row.background_color = defaultColor.value || '#ffffff';
}

function effectiveTax(row) {
    return row.tax_rate === null ? normalizedDefaultTax.value : Number(row.tax_rate);
}

function effectiveColor(row) {
    return row.background_color === null ? defaultColor.value : row.background_color;
}

function validateBatch() {
    topError.value = '';
    rows.value.forEach(row => { row.errors = {}; });

    if (!categoryId.value) {
        topError.value = t('Select a category before saving.');
        return false;
    }

    const activeRows = rows.value.filter(rowHasData);
    if (activeRows.length === 0) {
        topError.value = t('Add at least one product.');
        return false;
    }

    const sharedTax = normalizedDefaultTax.value;
    if (!Number.isFinite(sharedTax) || sharedTax < 0 || sharedTax > 100) {
        topError.value = t('Shared tax must be between 0 and 100.');
        return false;
    }

    const names = new Map();
    const barcodes = new Map();

    for (const row of activeRows) {
        const name = String(row.name || '').trim();
        const price = Number(row.price);
        const tax = effectiveTax(row);
        const barcode = String(row.barcode || '').trim();

        if (!name) row.errors.name = t('Product name is required.');
        else if (name.length > 100) row.errors.name = t('Product name cannot exceed 100 characters.');
        else {
            const nameKey = name.toLocaleLowerCase();
            if (names.has(nameKey)) row.errors.name = t('Product name is repeated in this category batch.');
            else names.set(nameKey, true);
        }

        if (row.price === '' || !Number.isFinite(price) || price < 0) row.errors.price = t('Enter a valid price of zero or more.');
        if (!Number.isFinite(tax) || tax < 0 || tax > 100) row.errors.tax_rate = t('Tax must be between 0 and 100.');

        if (barcode.length > 50) row.errors.barcode = t('Barcode cannot exceed 50 characters.');
        else if (barcode) {
            const barcodeKey = barcode.toLocaleLowerCase();
            if (barcodes.has(barcodeKey)) row.errors.barcode = t('Barcode is repeated in this batch.');
            else barcodes.set(barcodeKey, true);
        }

        if (row.cost_price !== '' && (!Number.isFinite(Number(row.cost_price)) || Number(row.cost_price) < 0)) {
            row.errors.cost_price = t('Enter a valid cost of zero or more.');
        }
        if (props.stockEnabled && row.stock !== '' && (!Number.isFinite(Number(row.stock)) || Number(row.stock) < 0)) {
            row.errors.stock = t('Opening stock must be zero or more.');
        }
    }

    const valid = activeRows.every(row => !rowHasErrors(row));
    if (!valid) topError.value = t('Fix the highlighted products before saving.');
    return valid;
}

function serializeDraft() {
    return {
        category_id: categoryId.value,
        default_tax: defaultTax.value,
        default_color: defaultColor.value,
        rows: rows.value.map(row => ({
            name: row.name,
            price: row.price,
            tax_rate: row.tax_rate,
            barcode: row.barcode,
            cost_price: row.cost_price,
            stock: row.stock,
            background_color: row.background_color
        }))
    };
}

function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(serializeDraft()));
    }, 250);
}

function restoreDraft() {
    try {
        const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
        if (!parsed || !Array.isArray(parsed.rows)) return;
        categoryId.value = parsed.category_id ? String(parsed.category_id) : '';
        defaultTax.value = parsed.default_tax ?? 0;
        defaultColor.value = /^#[0-9a-f]{6}$/i.test(parsed.default_color || '') ? parsed.default_color : '';
        rows.value = parsed.rows.slice(0, 500).map(newRow);
        if (rows.value.length === 0) rows.value = [newRow()];
        draftRestored.value = Boolean(categoryId.value || rows.value.some(rowHasData));
    } catch (_) {
        localStorage.removeItem(DRAFT_KEY);
    }
}

async function discardDraft() {
    if (productCount.value > 0 || categoryId.value) {
        const confirmed = await window.showAdminConfirm(t('Discard this batch draft?'), t('Discard Draft'));
        if (!confirmed) return;
    }
    clearTimeout(draftTimer);
    localStorage.removeItem(DRAFT_KEY);
    categoryId.value = '';
    defaultTax.value = 0;
    defaultColor.value = '';
    rows.value = [newRow()];
    topError.value = '';
    draftRestored.value = false;
}

async function saveBatch() {
    if (!validateBatch()) return;

    const activeEntries = rows.value
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(entry => rowHasData(entry.row));
    const payload = {
        category_id: Number(categoryId.value),
        products: activeEntries.map(({ row }) => ({
            name: String(row.name).trim(),
            price: Number(row.price),
            tax_rate: effectiveTax(row),
            barcode: String(row.barcode || '').trim() || null,
            cost_price: row.cost_price === '' ? null : Number(row.cost_price),
            stock: props.stockEnabled && row.stock !== '' ? Number(row.stock) : null,
            background_color: effectiveColor(row) || null
        }))
    };

    isSaving.value = true;
    try {
        const data = await fetchJson('/api/admin/products/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!data.success) {
            for (const error of data.row_errors || []) {
                const entry = activeEntries[Number(error.row)];
                if (!entry) continue;
                entry.row.errors[error.field || 'name'] = t(error.message || 'Check this row');
            }
            topError.value = t(data.message || 'Could not save products.');
            return;
        }

        clearTimeout(draftTimer);
        localStorage.removeItem(DRAFT_KEY);
        window.showAdminToast(t('Products added successfully.'), 'success');
        emit('saved');
    } catch (_) {
        topError.value = t('Network error. Nothing was saved.');
    } finally {
        isSaving.value = false;
    }
}

watch([categoryId, defaultTax, defaultColor, rows], scheduleDraftSave, { deep: true });

onMounted(restoreDraft);
onBeforeUnmount(() => clearTimeout(draftTimer));
</script>

<style scoped>
.batch-head,
.batch-row {
    display: grid;
    grid-template-columns: 2rem minmax(12rem, 2fr) minmax(6.5rem, .8fr) minmax(7rem, .85fr) minmax(8rem, 1fr) minmax(6.5rem, .8fr) minmax(7rem, .8fr) minmax(7rem, .8fr) 2.5rem;
    align-items: start;
    gap: .5rem;
}

.batch-mobile-label {
    display: none;
}

.batch-head.batch-without-stock,
.batch-row.batch-without-stock {
    grid-template-columns: 2rem minmax(12rem, 2fr) minmax(6.5rem, .8fr) minmax(7rem, .85fr) minmax(8rem, 1fr) minmax(6.5rem, .8fr) minmax(7rem, .8fr) 2.5rem;
}

.batch-field {
    display: block;
    min-width: 0;
}

.batch-input,
.batch-choice {
    width: 100%;
    min-height: 2.5rem;
    border: 1px solid #d4d4d8;
    border-radius: .375rem;
    background: #f4f4f5;
    padding: 0 .625rem;
    color: #111827;
    font-size: .75rem;
    font-weight: 650;
    outline: none;
}

.batch-input:focus,
.batch-choice:focus-visible,
.batch-color-input:focus-visible,
.batch-reset:focus-visible {
    border-color: #24405e;
    box-shadow: 0 0 0 2px rgb(36 64 94 / 15%);
}

.batch-choice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .375rem;
    cursor: pointer;
    color: #52525b;
}

.batch-choice:hover {
    background: #e4e4e7;
    color: #18181b;
}

.batch-color-input {
    height: 2.5rem;
    min-width: 0;
    flex: 1;
    cursor: pointer;
    border: 1px solid #d4d4d8;
    border-radius: .375rem;
    background: #f4f4f5;
    padding: .25rem;
}

.batch-reset {
    height: 2.5rem;
    width: 2.25rem;
    flex: 0 0 2.25rem;
    border-radius: .375rem;
    border: 1px solid #d4d4d8;
    background: #fff;
    color: #52525b;
    font-size: 1rem;
    font-weight: 800;
}

.batch-reset:hover {
    background: #e4e4e7;
    color: #18181b;
}

.batch-input-error {
    border-color: #fb7185;
    background: #fff1f2;
}

.batch-error {
    display: block;
    margin-top: .25rem;
    color: #be123c;
    font-size: .65rem;
    font-weight: 700;
    line-height: 1.25;
}

.remove-text {
    display: none;
}

@media (max-width: 1279px) {
    .batch-head {
        display: none;
    }

    .batch-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .75rem;
    }

    .batch-row.batch-without-stock {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .row-number,
    .field-name {
        grid-column: 1 / -1;
    }

    .row-action {
        align-self: end;
    }

    .batch-mobile-label {
        display: block;
        margin-bottom: .375rem;
        color: #52525b;
        font-size: .7rem;
        font-weight: 750;
    }

    .batch-input,
    .batch-choice,
    .batch-color-input,
    .batch-reset {
        min-height: 2.75rem;
    }
}

@media (max-width: 639px) {
    .batch-row {
        grid-template-columns: minmax(0, 1fr);
    }

    .batch-row.batch-without-stock {
        grid-template-columns: minmax(0, 1fr);
    }

    .row-number,
    .field-name {
        grid-column: auto;
    }

    .row-action {
        justify-content: stretch;
    }

    .row-action button {
        width: 100%;
        border-color: #fecdd3;
        font-size: .8rem;
    }

    .remove-symbol {
        display: none;
    }

    .remove-text {
        display: inline;
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
    }
}
</style>

<template>
    <div class="recipe-editor space-y-4">
        <p v-if="!productId" class="text-xs font-semibold text-muted-foreground">{{ $t('Save the product first, then add its recipe.') }}</p>
        <template v-else>
            <p class="recipe-explanation">{{ $t('Enter the quantity used for one sold portion. Selling 2 portions consumes twice these quantities.') }}</p>
            <p class="recipe-example">{{ $t('Example: one shawarma uses 150 g of chicken and 30 g of pickles.') }}</p>
            <p v-if="loading" role="status" class="text-xs">{{ $t('Loading recipe...') }}</p>
            <p v-if="isBundle" class="text-xs text-muted-foreground">{{ $t("A bundle with its own recipe ignores its members' recipes.") }}</p>
            <div class="recipe-picker">
                <label>{{ $t('Find an ingredient for this recipe') }}<input v-model="ingredientSearch" type="search" :disabled="loading || saving || !loaded" :placeholder="$t('Search ingredients by name...')"></label>
                <div class="recipe-choices"><button v-for="item in availableIngredients.slice(0, 8)" :key="item.id" type="button" :disabled="loading || saving" @click="pickerId = item.id; addLine()"><span data-no-i18n>{{ item.name }}</span><span aria-hidden="true">＋</span></button><button type="button" :disabled="loading || saving || !loaded" @click="showIngredientForm = true">{{ $t('Add a new ingredient') }}</button></div>
            </div>
            <p v-if="loaded && !loading && !lines.length" class="recipe-empty">{{ $t('No recipe yet. Choose an ingredient above and add its quantity.') }}</p>
            <div v-if="lines.length" class="recipe-table-scroll">
            <table class="w-full text-xs">
                <thead>
                    <tr class="text-muted-foreground uppercase tracking-wider">
                        <th class="text-start py-1">{{ $t('Name') }}</th>
                        <th class="text-start">{{ $t('Quantity per portion') }}</th>
                        <th class="text-start">{{ $t('Unit') }}</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(line, index) in lines" :key="line.ingredient_id">
                        <td><span data-no-i18n>{{ line.name }}</span><small v-if="line.is_active === false" class="block text-destructive">{{ $t('Inactive') }}</small></td>
                        <td :data-label="$t('Quantity per portion')">
                            <input :ref="el => { if (el) quantityInputs.set(line.ingredient_id, el); else quantityInputs.delete(line.ingredient_id); }" v-model="line.qty" :disabled="loading || saving" :aria-label="`${$t('Quantity')} — ${line.name}`" type="number" min="0" step="any" class="w-20 h-11 bg-muted border border-zinc-300 rounded-md px-2 font-semibold">
                            <small v-if="Number(line.yield_pct) !== 100" class="stock-demand">{{ $t('Stock deducted per portion') }}: <span dir="ltr" data-no-i18n>{{ stockQuantity(line) }} {{ line.unit }}</span></small>
                        </td>
                        <td :data-label="$t('Unit')">
                            <select :value="line.unit" @change="changeLineUnit(line, $event.target.value)" :disabled="loading || saving" :aria-label="`${$t('Unit')} — ${line.name}`" class="h-11 bg-muted border border-zinc-300 rounded-md px-1">
                                <option v-for="unit in unitsFor(line.measure)" :key="unit" :value="unit" data-no-i18n>{{ unit }}</option>
                            </select>
                        </td>
                        <td>
                            <button type="button" :disabled="loading || saving" class="min-h-11 text-destructive font-bold" @click="lines.splice(index, 1)">{{ $t('Remove') }}</button>
                        </td>
                    </tr>
                </tbody>
            </table>
            </div>
            <details v-if="lines.length" class="recipe-preview"><summary>{{ $t('Quantity retained after preparation (optional)') }}</summary><p>{{ $t('Use this only when the recipe quantity is ready-to-serve weight. For example, 10 kg purchased gives 8 kg served: enter 80%. Leave 100% for direct stock quantities.') }}</p><div v-for="line in lines" :key="line.ingredient_id" class="yield-row"><label><span data-no-i18n>{{ line.name }}</span><input v-model="line.yield_pct" :disabled="saving || loading" :aria-label="`${$t('Usable quantity %')} — ${line.name}`" type="number" min="0.0001" max="1000" step="any"></label><span>{{ $t('Stock deducted per portion') }}: <strong dir="ltr" data-no-i18n>{{ stockQuantity(line) }} {{ line.unit }}</strong></span></div></details>
            <details v-if="lines.length" class="recipe-preview"><summary>{{ $t('Check quantities for several portions') }}</summary><label>{{ $t('Number of portions') }}<input v-model="previewPortions" type="number" min="1" max="1000" step="1"></label><p v-for="line in lines" :key="line.ingredient_id"><span data-no-i18n>{{ line.name }}</span><strong dir="ltr" data-no-i18n>{{ previewQuantity(stockQuantity(line)) }} {{ line.unit }}</strong></p></details>
            <p v-if="hasInactiveLines" role="alert" class="text-xs text-destructive">{{ $t('Reactivate inactive ingredients or remove them from this recipe before saving.') }}</p>
            <p v-if="hasChanges" class="text-xs">{{ $t('Save changes to update cost and portions.') }}</p>
            <div v-else-if="loaded && !loading && lines.length" class="text-xs text-muted-foreground space-y-1">
                <p v-if="allCosted && plateCost != null">
                    {{ $t('Ingredient cost per portion') }}:
                    <span data-no-i18n>{{ plateCost.toFixed(2) }}</span>
                    · {{ $t('Selling price') }}: <span data-no-i18n>{{ savedPrice.toFixed(2) }}</span>
                    · {{ $t('Margin before other expenses') }}: <span data-no-i18n>{{ marginLabel }}</span>
                </p>
                <p v-else data-no-i18n>{{ plateCostPartialLabel }}<span v-if="plateCost != null"> — {{ plateCost.toFixed(2) }}</span></p>
                <p v-if="portionsPossible != null">{{ $t('Possible portions') }} <span data-no-i18n>{{ portionsPossible }}</span></p>
            </div>
            <p v-if="error" role="alert" class="text-xs font-semibold text-red-600">{{ $t(error) }}</p>
            <button v-if="!loaded && !loading" type="button" class="min-h-11 underline text-xs" @click="load">{{ $t('Retry') }}</button>
            <div class="recipe-save-bar">
                <button type="button" :disabled="saving || loading || !loaded || !hasChanges || hasInactiveLines" @click="save" class="recipe-save">{{ $t(saving ? 'Saving...' : 'Save recipe') }}</button>
                <p v-if="saved && !hasChanges" role="status">{{ $t('Recipe saved.') }}</p>
            </div>
        </template>
        <IngredientFormModal :show="showIngredientForm" @close="showIngredientForm = false" @saved="ingredientCreated" />
    </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { fetchJson } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

import IngredientFormModal from './IngredientFormModal.vue';
import { DISPLAY_UNITS, SCALE } from '@/shared/ingredientUnits.js';

const props = defineProps({
    productId: { type: [Number, String], default: null },
    price: { type: [Number, String], default: 0 },
    isBundle: { type: Boolean, default: false }
});

const lines = ref([]);
const ingredients = ref([]);
const pickerId = ref('');
const ingredientSearch = ref('');
const showIngredientForm = ref(false);
const previewPortions = ref(10);
const quantityInputs = new Map();
const plateCost = ref(null);
const marginPct = ref(null);
const portionsPossible = ref(null);
const saving = ref(false);
const saved = ref(false);
const error = ref('');
const baseline = ref('[]');
const loading = ref(false);
const loaded = ref(false);
const savedPrice = ref(0);
let savedLines = [];
let loadSeq = 0;

const availableIngredients = computed(() => {
    const used = new Set(lines.value.map((line) => Number(line.ingredient_id)));
    return ingredients.value.filter((item) => item.is_active && !used.has(item.id) && item.name.toLocaleLowerCase().includes(ingredientSearch.value.trim().toLocaleLowerCase()));
});
const costedCount = computed(() => lines.value.filter((line) => line.unit_cost != null).length);
const allCosted = computed(() => lines.value.length > 0 && costedCount.value === lines.value.length);
const plateCostPartialLabel = computed(() => (
    t('Portion cost ({costed} of {total} ingredient costs available)')
        .replace('{costed}', costedCount.value).replace('{total}', lines.value.length)
));
const marginLabel = computed(() => (
    marginPct.value == null ? '—' : `${Math.round(Number(marginPct.value) * 100)}%`
));
const hasChanges = computed(() => JSON.stringify(serializeLines()) !== baseline.value);
const hasInactiveLines = computed(() => lines.value.some(line => line.is_active === false));

function unitsFor(measure) {
    return DISPLAY_UNITS[measure] || ['unit'];
}

function previewQuantity(qty) {
    if (qty === '' || qty == null) return '—';
    const n = Number(qty);
    return Number.isFinite(n) && Number.isInteger(Number(previewPortions.value)) && Number(previewPortions.value) > 0 && Number(previewPortions.value) <= 1000 ? String(Math.round(n * Number(previewPortions.value) * 1e6) / 1e6) : '—';
}
function stockQuantity(line) {
    const yieldPct=Number(line.yield_pct ?? 100);
    return line.qty!=='' && yieldPct>0 && yieldPct<=1000 ? Math.round(Number(line.qty)*100/yieldPct*1e6)/1e6 : '—';
}

function serializeLines() {
    return lines.value.map((line) => ({
        ingredient_id: Number(line.ingredient_id),
        qty: Number(line.qty),
        unit: line.unit,
        ...(Number(line.yield_pct ?? 100) === 100 ? {} : {yield_pct:Number(line.yield_pct)})
    }));
}

async function loadIngredients() {
    const data = await fetchJson('api/admin/ingredients/options');
    if (!data.success) throw new Error(data.message || 'Load failed.');
    return (data.ingredients || []).map((row) => ({
        id: Number(row.id),
        name: row.name,
        measure: row.measure,
        display_unit: row.display_unit,
        unit_cost: row.unit_cost,
        is_active: row.is_active !== false
    }));
}

async function loadRecipe(productId, seq) {
    const [available, data] = await Promise.all([
        loadIngredients(), fetchJson(`api/admin/products/${productId}/recipe`)
    ]);
    if (seq !== loadSeq) return;
    if (!data.success) throw new Error(data.message || 'Load failed.');
    ingredients.value = available;
    const incoming = data.lines || [];
    lines.value = incoming.map((line) => ({
        ingredient_id: Number(line.ingredient_id),
        is_active: line.is_active !== false,
        name: line.name,
        qty: line.qty,
        unit: line.unit,
        yield_pct: line.yield_pct ?? 100,
        measure: line.measure,
        unit_cost: line.unit_cost
    }));
    plateCost.value = data.plate_cost == null ? null : Number(data.plate_cost);
    marginPct.value = data.margin_pct == null ? null : Number(data.margin_pct);
    savedPrice.value = Number(data.price ?? props.price) || 0;
    baseline.value = JSON.stringify(serializeLines());
    savedLines = lines.value.map(line => ({ ...line }));
    loaded.value = true;
    void loadPortions(productId, seq);
}

async function loadPortions(productId, seq) {
    // Portions are optional; a failure here must not invalidate a loaded recipe.
    try {
        const portions = await fetchJson(`api/admin/ingredients/portions?product_id=${productId}`);
        if (seq !== loadSeq) return;
        portionsPossible.value = (portions.portions || []).find((row) => Number(row.product_id) === Number(productId))?.portions_possible ?? null;
    } catch { if (seq === loadSeq) portionsPossible.value = null; }
}

function addLine() {
    if (!loaded.value || loading.value || saving.value) return;
    const id = Number(pickerId.value);
    const item = availableIngredients.value.find((row) => row.id === id);
    if (!item) return;
    lines.value.push({
        ingredient_id: item.id,
        name: item.name,
        qty: '',
        unit: item.display_unit,
        yield_pct: 100,
        measure: item.measure,
        unit_cost: item.unit_cost
    });
    pickerId.value = ''; ingredientSearch.value = '';
    void nextTick(() => quantityInputs.get(item.id)?.focus());
}
function changeLineUnit(line, unit) {
    if (!unitsFor(line.measure).includes(unit)) return;
    if (line.qty !== '' && line.qty != null) line.qty = Math.round(Number(line.qty) * SCALE[line.unit] / SCALE[unit] * 1e6) / 1e6;
    line.unit = unit;
}
function ingredientCreated(row) {
    if (!row) return;
    ingredientSearch.value = '';
    ingredients.value.push({ ...row, id: Number(row.id) });
    pickerId.value = Number(row.id); addLine();
}

async function save() {
    if (!props.productId || !loaded.value || loading.value || saving.value) return;
    if (hasInactiveLines.value) return;
    if (lines.value.some(line => !Number.isFinite(Number(line.qty)) || Number(line.qty) <= 0)) {
        error.value = 'Recipe quantity must be greater than zero.';
        return;
    }
    if (lines.value.some(line => !Number.isFinite(Number(line.yield_pct)) || Number(line.yield_pct)<=0 || Number(line.yield_pct)>1000)) {
        error.value='Preparation yield must be greater than zero and at most 1000%.'; return;
    }
    saving.value = true;
    error.value = '';
    try {
        const data = await fetchJson(`api/admin/products/${props.productId}/recipe`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lines: serializeLines() })
        });
        if (!data.success) throw new Error(data.message || 'Save failed.');
        await load();
        saved.value = !error.value;
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : 'Save failed.';
    } finally {
        saving.value = false;
    }
}

async function requestClose() {
    if (saving.value) return false;
    if (!hasChanges.value) return true;
    const discard = await window.showAdminConfirm(t('Discard unsaved recipe changes?'));
    if (discard) lines.value = savedLines.map(line => ({ ...line }));
    return discard;
}

async function load() {
    const id = props.productId;
    const seq = ++loadSeq;
    saved.value = false;
    loading.value = !!id;
    loaded.value = false;
    error.value = '';
    lines.value = [];
    plateCost.value = null;
    marginPct.value = null;
    portionsPossible.value = null;
    baseline.value = '[]';
    savedLines = [];
    pickerId.value = ''; ingredientSearch.value = ''; showIngredientForm.value = false;
    if (!id) return;
    try {
        await loadRecipe(id, seq);
    } catch (caught) {
        if (seq === loadSeq) error.value = caught.message || 'Load failed.';
    } finally {
        if (seq === loadSeq) loading.value = false;
    }
}
watch(() => props.productId, load, { immediate: true });
onUnmounted(() => { loadSeq++; });

defineExpose({ requestClose, hasChanges });
</script>

<style scoped>
.recipe-editor { font-size: .875rem; }
.recipe-explanation { font-weight: 600; line-height: 1.65; }
.recipe-example { color: #52525b; line-height: 1.65; }
.recipe-empty { padding: 1rem; background: var(--color-muted); border: 1px solid var(--color-border); border-radius: 6px; line-height: 1.65; }
.recipe-table-scroll { overflow-x: auto; }
table { min-width: 480px; border-collapse: collapse; font-size: .875rem; }
th, td { text-align: start; padding: .6rem .4rem; border-bottom: 1px solid var(--color-border); }
th { color: #52525b; font-weight: 600; letter-spacing: normal; text-transform: none; }
select, input { font-size: .875rem; border-color: #a1a1aa; }
button { font-size: .875rem; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.recipe-save-bar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; padding-top: 1rem; border-top: 1px solid var(--color-border); }
.recipe-save { min-height: 44px; padding: .6rem 1rem; border-radius: 6px; background: var(--color-primary); color: white; font-weight: 700; }
.recipe-save:hover:not(:disabled) { background: var(--color-brand-800); }
@media (max-width: 540px) {
    table, tbody { display: block; min-width: 0; }
    thead { display: none; }
    tr { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; padding-block: .75rem; border-bottom: 1px solid var(--color-border); }
    td { border: 0; padding: 0; }
    td:first-child { grid-column: 1 / -1; font-weight: 700; overflow-wrap: anywhere; }
    td[data-label]::before { content: attr(data-label); display: block; color: #52525b; font-size: .8rem; margin-bottom: .35rem; }
    td input, td select { width: 100%; }
    td:last-child { align-self: end; }
}
.recipe-picker label { display: block; color: #53606f; font-size: 12px; }
.recipe-picker input { display: block; width: 100%; height: 44px; padding: 8px 12px; border: 1px solid #cbd0d7; border-radius: 6px; margin-top: 6px; }
.recipe-choices { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.recipe-choices button { display: flex; align-items: center; gap: 16px; min-height: 44px; padding: 8px 12px; border: 1px solid #cbd0d7; border-radius: 6px; }
.recipe-preview { border-top: 1px solid #dce3eb; padding-top: 10px; }
.recipe-preview summary { min-height: 44px; cursor: pointer; font-weight: 600; }
.recipe-preview label { display: flex; align-items: center; gap: 12px; }
.recipe-preview input { width: 90px; height: 44px; border: 1px solid #cbd0d7; border-radius: 6px; padding: 8px; }
.recipe-preview p { display: flex; justify-content: space-between; gap: 16px; padding-block: 8px; }
.stock-demand { display: block; margin-top: 6px; color: #53606f; }
.yield-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-block: 12px; }
.yield-row label::after { content: '%'; }
</style>

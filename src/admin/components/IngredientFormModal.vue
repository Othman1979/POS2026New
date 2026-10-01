<template>
    <ModalShell :show="show" :title="ingredient ? $t('Edit ingredient') : $t('Add ingredient')" width-class="max-w-xl" @close="close">
        <form class="setup-form" @submit.prevent="save">
            <div class="setup-body">
                <p class="setup-intro">{{ $t('Start with a name and the unit you use to count stock. You can add the other details later.') }}</p>
                <p v-if="error" role="alert">{{ $t(error) }}</p>
                <fieldset :disabled="saving || activating">
                    <label>{{ $t('Ingredient name') }}<input v-model="form.name" :placeholder="$t('For example: chicken or potatoes')" required maxlength="100"></label>
                    <label>{{ $t('How do you measure this ingredient?') }}<select :value="form.display_unit" @change="chooseUnit($event)"><option v-for="option in unitOptions" :key="option.unit" :value="option.unit" :disabled="!!ingredient && option.measure !== form.measure">{{ $t(option.label) }}</option></select></label>
                    <p class="setup-hint">{{ $t('Recipes may use smaller units: stock in kilograms can be used in grams per portion.') }}</p>
                    <details class="setup-section"><summary>{{ $t('Low-stock reminder') }} <small>{{ $t('Optional') }}</small></summary><label>{{ $t('Remind me below') }} <span data-no-i18n>({{ form.display_unit }})</span><input v-model="form.par_qty" type="number" min="0" step="any"></label><p class="setup-hint">{{ $t('Leave blank if you do not need a shortage reminder.') }}</p></details>
                    <details class="setup-section"><summary>{{ $t('Reference unit cost') }} <small>{{ $t('Optional') }}</small></summary><label>{{ $t('Cost per stock unit') }} <span data-no-i18n>({{ form.display_unit }})</span><input v-model="form.unit_cost" type="number" min="0" step="any"></label><p class="setup-hint">{{ $t('Costs use the average of priced deliveries in the 30-day calculation period, weighted by quantity. This reference cost is used when no priced deliveries are available.') }}</p></details>
                    <details class="setup-section"><summary>{{ $t('Pack sizes') }} <small>{{ $t('Optional') }}</small></summary><div class="setup-pair"><label>{{ $t('Pack name') }}<input v-model="form.pack_name" :placeholder="$t('For example: carton or bag')" maxlength="40"></label><label>{{ $t('Quantity in one pack') }} <span data-no-i18n>({{ form.display_unit }})</span><input v-model="form.pack_size" type="number" min="0" step="any"></label></div><p v-if="form.pack_name && Number(form.pack_size) > 0" class="pack-preview" dir="auto" data-no-i18n>1 {{ form.pack_name }} = {{ form.pack_size }} {{ form.display_unit }}</p><p class="setup-hint">{{ $t('For example: a bag contains 10 kg, or a carton contains 24 pieces.') }}</p></details>
                    <label v-if="ingredient" class="setup-active"><input v-model="form.is_active" type="checkbox" :disabled="activating">{{ $t('Allow new stock entries') }}</label>
                </fieldset>
            </div>
            <footer><button type="button" :disabled="saving || activating" @click="close">{{ $t('Cancel') }}</button><button type="submit" class="primary" :disabled="saving || activating || !form.name.trim()">{{ $t(saving ? 'Saving...' : 'Save ingredient') }}</button></footer>
        </form>
        <IngredientActivationPanel v-if="show && ingredient?.id" class="activation-panel" :ingredient-id="ingredient.id" @busy="activating = $event" @activated="onActivated" />
    </ModalShell>
</template>

<script setup>
import { ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { fetchJson } from '@/shared/http.js';
import ModalShell from './ModalShell.vue';
import IngredientActivationPanel from './IngredientActivationPanel.vue';

import { SCALE, DISPLAY_UNITS, fromBaseQty, fromBaseCost as displayCost } from '@/shared/ingredientUnits.js';
const fromBase = (qty, unit) => qty == null || qty === '' ? '' : String(fromBaseQty(qty, unit));
const fromBaseCost = (cost, unit) => cost == null || cost === '' ? '' : String(displayCost(cost, unit));

const props = defineProps({
    show: { type: Boolean, default: false },
    ingredient: { type: Object, default: null }
});
const emit = defineEmits(['close', 'saved']);

const form = ref(blankForm());
const saving = ref(false);
const activating = ref(false);
const error = ref('');
let initialForm = '';
const unitOptions = [
    { unit: 'kg', measure: 'weight', label: 'Kilograms (kg) — chicken, flour' },
    { unit: 'g', measure: 'weight', label: 'Grams (g) — spices, small quantities' },
    { unit: 'l', measure: 'volume', label: 'Litres (l) — oil, milk' },
    { unit: 'ml', measure: 'volume', label: 'Millilitres (ml) — sauces' },
    { unit: 'unit', measure: 'count', label: 'Pieces — bottles, packaging' },
];
async function close() {
    if (saving.value || activating.value) return;
    if (JSON.stringify(form.value) !== initialForm && !await window.showAdminConfirm(t('Discard ingredient changes?'))) return;
    emit('close');
}
async function chooseUnit(event) {
    const unit = event.target.value;
    const option = unitOptions.find(item => item.unit === unit);
    if (!option) return;
    if (option.measure !== form.value.measure) {
        if (props.ingredient) { event.target.value = form.value.display_unit; return; }
        if (['unit_cost', 'par_qty', 'pack_size', 'pack_name'].some(key => form.value[key] !== '') && !await window.showAdminConfirm(t('Changing the measurement type clears cost, minimum and pack values. Continue?'))) { event.target.value = form.value.display_unit; return; }
        for (const key of ['unit_cost', 'par_qty', 'pack_size', 'pack_name']) form.value[key] = '';
        form.value.measure = option.measure; form.value.display_unit = unit;
    } else changeDisplayUnit(unit);
}


function blankForm() {
    return {
        name: '',
        measure: 'weight',
        display_unit: 'kg',
        unit_cost: '',
        par_qty: '',
        pack_name: '',
        pack_size: '',
        is_active: true
    };
}

function onActivated() {
    emit('saved', props.ingredient);
}

watch(() => props.show, (open) => {
    if (!open) { activating.value = false; return; }
    error.value = '';
    const row = props.ingredient;
    if (!row) {
        form.value = blankForm();
        initialForm = JSON.stringify(form.value);
        return;
    }
    const unit = row.display_unit;
    form.value = {
        name: row.name,
        measure: row.measure,
        display_unit: unit,
        unit_cost: fromBaseCost(row.unit_cost, unit),
        par_qty: fromBase(row.par_qty, unit),
        pack_name: row.pack_name || '',
        pack_size: fromBase(row.pack_size, unit),
        is_active: !!row.is_active
    };
    initialForm = JSON.stringify(form.value);
});

watch(() => form.value.measure, (measure) => {
    if (!DISPLAY_UNITS[measure]?.includes(form.value.display_unit)) {
        form.value.display_unit = DISPLAY_UNITS[measure][0];
    }
});

function changeDisplayUnit(unit) {
    const previous = form.value.display_unit;
    if (unit === previous) return;
    // Convert only explicit presentation changes, never a freshly loaded form.
    for (const field of ['par_qty', 'pack_size']) {
        if (form.value[field] !== '') form.value[field] = fromBase(Number(form.value[field]) * SCALE[previous], unit);
    }
    if (form.value.unit_cost !== '') form.value.unit_cost = fromBaseCost(Number(form.value.unit_cost) / SCALE[previous], unit);
    form.value.display_unit = unit;
}

async function save() {
    if (saving.value || activating.value) return;
    if (!form.value.name.trim()) { error.value = 'Enter an ingredient name.'; return; }
    const hasPackName = !!form.value.pack_name.trim(), hasPackSize = form.value.pack_size !== '';
    if (hasPackName !== hasPackSize || (hasPackSize && !(Number(form.value.pack_size) > 0))) { error.value = 'Enter both a pack name and the quantity inside it, or leave both blank.'; return; }
    if (['unit_cost', 'par_qty', 'pack_size'].some(key => form.value[key] !== '' && (!Number.isFinite(Number(form.value[key])) || Number(form.value[key]) < 0))) { error.value = 'Enter valid non-negative quantities and costs.'; return; }
    saving.value = true;
    error.value = '';
    const unit = form.value.display_unit;
    const payload = {
        name: form.value.name.trim(),
        display_unit: unit,
        unit_cost: form.value.unit_cost === '' ? null : Number(form.value.unit_cost),
        cost_unit: unit,
        par_qty: form.value.par_qty === '' ? null : Number(form.value.par_qty),
        par_unit: unit,
        pack_name: form.value.pack_name.trim() || null,
        pack_size: form.value.pack_size === '' ? null : Number(form.value.pack_size),
        pack_unit: unit
    };
    try {
        const data = props.ingredient
            ? await fetchJson(`api/admin/ingredients/${props.ingredient.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, is_active: form.value.is_active ? 1 : 0 })
            })
            : await fetchJson('api/admin/ingredients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, measure: form.value.measure })
            });
        if (!data.success) throw new Error(data.message || 'Save failed.');
        initialForm = JSON.stringify(form.value);
        emit('saved', data.ingredient);
        emit('close');
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : 'Save failed.';
    } finally {
        saving.value = false;
    }
}
</script>

<style scoped>
.setup-form { display: flex; flex-direction: column; min-height: 0; }
.setup-body { padding: 20px 24px; overflow-y: auto; font-size: 13px; line-height: 1.7; }
.setup-intro { color: #53606f; margin-bottom: 18px; }
.setup-body label { display: block; font-weight: 600; margin-block: 12px; }
.setup-body input:not([type=checkbox]), select { display: block; width: 100%; min-width: 0; height: 44px; padding: 8px 12px; margin-top: 6px; background: white; border: 1px solid #cbd0d7; border-radius: 6px; color: #263342; font-size: 14px; }
.setup-hint { color: #616b76; font-size: 12px; font-weight: 400; }
.setup-section { border-top: 1px solid #e1e5ea; margin-top: 16px; }
summary { padding-block: 14px; cursor: pointer; font-weight: 600; }
summary small { font-weight: 400; color: #616b76; margin-inline-start: 8px; }
.setup-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pack-preview { background: #f1f5f9; padding: 8px 12px; border-radius: 6px; }
.setup-body .setup-active { display: flex; gap: 8px; align-items: center; }
footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 24px; border-top: 1px solid #dce3eb; background: #f7f9fc; }
button { min-height: 44px; padding: 8px 16px; border: 1px solid #cbd0d7; border-radius: 6px; background: white; }
button.primary { background: #24405e; border-color: #24405e; color: white; }
button:disabled, fieldset:disabled { opacity: .6; }
input:focus-visible, select:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid #3a5c85; outline-offset: 2px; }
[role=alert] { color: #ad2929; }

.setup-body { background: var(--color-background); padding: 24px; }
.setup-intro { padding: 12px 16px; background: var(--color-brand-50); border-inline-start: 3px solid var(--color-brand-500); color: var(--color-muted-foreground); border-radius: 5px; }
.setup-body label { color: var(--color-foreground); font-size: 12px; }
.setup-body input:not([type=checkbox]), select { border-color: var(--color-border); border-radius: 8px; }
.setup-section { border: 1px solid var(--color-border); border-radius: 9px; padding-inline: 14px; margin-top: 14px; background: white; }
.setup-pair { gap: 16px; }
button.primary { background: var(--color-primary); border-color: var(--color-primary); }
footer { background: var(--color-brand-50); border-color: var(--color-border); }
.activation-panel { margin: 0 24px 24px; }
</style>

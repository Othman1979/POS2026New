<template>
    <ModalShell :show="show" :title="title" width-class="max-w-md" @close="$emit('close')">
        <form @submit.prevent="save" class="ingredient-movement-form flex-1 flex flex-col min-h-0">
            <div class="p-5 bg-card space-y-4 overflow-y-auto min-h-0">
                <p v-if="error" role="alert" class="text-xs font-semibold text-red-600">{{ $t(error) }}</p>
                <p class="text-sm font-semibold" data-no-i18n>{{ ingredient?.name }}</p>
                <p class="text-sm text-zinc-600 leading-relaxed">{{ $t('Enter the quantity lost and its reason. It will be deducted from the balance.') }}</p>
                <button v-if="ingredient?.pack_name && !showPacks" type="button" class="text-xs text-teal-700 underline" @click="showPacks = true">{{ $t('Enter quantity by packs') }}</button>
                <p v-if="showPacks" class="text-xs text-zinc-600">{{ $t('Enter whole packs and any extra loose quantity separately.') }}</p>
                <div v-if="showPacks" class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-semibold text-muted-foreground mb-1.5">{{ $t('Packs') }} <span data-no-i18n>({{ ingredient.pack_name }})</span></label>
                        <input v-model="form.packs" :aria-label="$t('Packs')" type="number" min="0" step="any" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 outline-none">
                    </div>
                    <div>
                        <label class="block text-sm font-semibold text-zinc-700 mb-1.5">{{ $t('Quantity') }}</label>
                        <input v-model="form.qty" :aria-label="$t('Quantity')" type="number" min="0" step="any" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 outline-none">
                    </div>
                </div>
                <div v-else>
                    <label class="block text-sm font-semibold text-zinc-700 mb-1.5">{{ $t('Quantity') }}</label>
                    <input v-model="form.qty" :aria-label="$t('Quantity')" type="number" min="0" step="any" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 outline-none">
                </div>
                <div>
                    <label class="block text-sm font-semibold text-zinc-700 mb-1.5">{{ $t('Unit') }}</label>
                    <select v-model="form.unit" :aria-label="$t('Unit')" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 outline-none">
                        <option v-for="unit in units" :key="unit" :value="unit" data-no-i18n>{{ unit }}</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-semibold text-zinc-700 mb-1.5">{{ $t('Reason') }}</label>
                    <select v-model="form.reason" :aria-label="$t('Reason')" required class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 outline-none">
                        <option v-for="reason in reasons" :key="reason" :value="reason">{{ $t(reasonLabel(reason)) }}</option>
                    </select>
                </div>
            </div>
            <div class="p-4 border-t border-zinc-200 bg-muted flex justify-end gap-3 shrink-0">
                <button type="button" @click="$emit('close')" class="px-4 h-11 bg-card border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-md text-xs">{{ $t('Cancel') }}</button>
                <button type="submit" :disabled="saving" class="px-4 h-11 bg-teal-600 text-white font-bold rounded-md hover:bg-teal-700 text-xs">{{ $t(saving ? 'Saving...' : 'Record waste') }}</button>
            </div>
        </form>
    </ModalShell>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { fetchJson } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';
import { createRequestId } from '@/shared/requestId.js';
import ModalShell from './ModalShell.vue';

import { DISPLAY_UNITS } from '@/shared/ingredientUnits.js';
const REASONS = ['spoiled', 'expired', 'dropped_or_burnt', 'over_prepared', 'staff_meal', 'other'];

const props = defineProps({
    show: { type: Boolean, default: false },
    ingredient: { type: Object, default: null }
});
const emit = defineEmits(['close', 'saved']);

const form = ref({ qty: '', unit: 'kg', packs: '', reason: 'spoiled' });
const showPacks = ref(false);
const clientKey = ref(createRequestId());
const saving = ref(false);
const error = ref('');
const units = computed(() => DISPLAY_UNITS[props.ingredient?.measure] || ['unit']);
const reasons = REASONS;
const title = computed(() => t('Record waste'));

function reasonLabel(reason) {
    return ({
        spoiled: 'Spoiled',
        expired: 'Expired',
        dropped_or_burnt: 'Dropped or burnt',
        over_prepared: 'Over-prepared',
        staff_meal: 'Staff meal',
        other: 'Other'
    })[reason];
}

watch(() => props.show, (open) => {
    if (!open || !props.ingredient) return;
    error.value = '';
    showPacks.value = false;
    form.value = {
        qty: '',
        unit: props.ingredient.display_unit,
        packs: '',
        reason: 'spoiled'
    };
    clientKey.value = createRequestId();
});

watch(
    () => [form.value.qty, form.value.unit, form.value.packs, form.value.reason],
    () => { clientKey.value = createRequestId(); }
);

async function save() {
    if (saving.value) return;
    if (form.value.qty === '' && form.value.packs === '') {
        error.value = 'Enter a quantity or number of packs.';
        return;
    }
    saving.value = true;
    error.value = '';
    const payload = {
        kind: 'waste',
        reason: form.value.reason,
        qty: form.value.qty === '' ? 0 : Number(form.value.qty),
        unit: form.value.unit,
        client_key: clientKey.value
    };
    if (props.ingredient?.pack_name && form.value.packs !== '') payload.packs = Number(form.value.packs);
    try {
        const data = await fetchJson(`api/admin/ingredients/${props.ingredient.id}/movements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!data.success) throw new Error(data.message || 'Save failed.');
        emit('saved');
        emit('close');
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : 'Save failed.';
    } finally {
        saving.value = false;
    }
}
</script>

<style scoped>
.ingredient-movement-form > div:first-child { background: var(--color-background); padding: 24px; }
.ingredient-movement-form input, .ingredient-movement-form select { background: white; border-color: var(--color-border); border-radius: 8px; }
.ingredient-movement-form > div:first-child > p[data-no-i18n] { padding: 12px 14px; background: var(--color-brand-50); border-radius: 7px; color: var(--color-primary); font-size: 17px; }
</style>

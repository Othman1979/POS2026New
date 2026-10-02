<template>
    <section class="border border-zinc-200 rounded-lg p-4 space-y-3" :aria-label="$t('Packaging units')">
        <div>
            <h4 class="text-[11px] font-bold text-foreground uppercase tracking-wider">{{ $t('Packaging units') }}</h4>
            <p class="text-[10px] text-muted-foreground mt-1">{{ $t('Each pack can be chosen in purchase invoices and stock counts. A pack with a sale price also sells at the register by its own barcode and takes its units from this product\'s stock.') }}</p>
        </div>
        <p v-if="loading" class="text-xs text-muted-foreground" role="status">{{ $t('Loading...') }}</p>
        <template v-else>
            <div v-if="packs.length" class="space-y-2">
                <div class="hidden md:grid grid-cols-[1fr_88px_96px_1fr_32px] gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    <span>{{ $t('Pack name') }}</span><span>{{ $t('Units inside') }}</span><span>{{ $t('Sale price') }}</span><span>{{ $t('Pack barcode') }}</span><span></span>
                </div>
                <div v-for="(pack, index) in packs" :key="pack.key" class="grid grid-cols-2 md:grid-cols-[1fr_88px_96px_1fr_32px] gap-2 items-center" data-pack-row>
                    <input v-model="pack.label" type="text" maxlength="40" :placeholder="$t('Carton')" :aria-label="`${$t('Pack name')} ${index + 1}`" :class="inputClass" :disabled="saving" @input="dirty = true">
                    <input v-model="pack.factor" type="text" inputmode="decimal" placeholder="12" :aria-label="`${$t('Units inside')} ${index + 1}`" :class="inputClass" :disabled="saving" @input="dirty = true">
                    <input v-model="pack.sale_price" type="text" inputmode="decimal" :placeholder="$t('Not sold')" :aria-label="`${$t('Sale price')} ${index + 1}`" :class="inputClass" :disabled="saving" @input="dirty = true">
                    <input v-model="pack.barcode" type="text" autocomplete="off" :placeholder="$t('Scan or Enter...')" :aria-label="`${$t('Pack barcode')} ${index + 1}`" :class="inputClass" :disabled="saving" @input="dirty = true">
                    <button type="button" class="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:bg-rose-100 hover:text-rose-600" :aria-label="`${$t('Remove pack')} ${index + 1}`" :disabled="saving" @click="removePack(index)">
                        <i class="fa-solid fa-xmark text-xs" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('No packs yet. Sold and counted in its base unit only.') }}</p>
            <p v-if="error" role="alert" class="text-[11px] font-semibold text-rose-700">{{ error }}</p>
            <p v-else-if="notice" role="status" class="text-[11px] font-semibold text-emerald-700">{{ notice }}</p>
            <div class="flex gap-2">
                <button type="button" class="px-3 h-8 bg-card border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-lg text-[10px]" :disabled="saving || packs.length >= MAX_PACKS" @click="addPack">{{ $t('Add pack') }}</button>
                <button type="button" class="px-3 h-8 bg-primary text-white font-bold rounded-lg text-[10px] disabled:opacity-50" :disabled="saving || !dirty" @click="save">{{ saving ? $t('Saving...') : $t('Save packs') }}</button>
            </div>
        </template>
    </section>
</template>

<script setup>
import { ref, watch } from 'vue';
import { fetchJsonResponse } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

const MAX_PACKS = 10;
const props = defineProps({ productId: { type: [Number, String], required: true } });
const emit = defineEmits(['saved', 'busy']);
const inputClass = 'w-full min-w-0 bg-muted border border-zinc-300 rounded-lg py-1.5 px-2 text-xs font-semibold text-foreground focus:bg-card focus:border-primary outline-none h-8 tabular-nums';

const packs = ref([]);
const loading = ref(false);
const saving = ref(false);
const dirty = ref(false);
const error = ref('');
const notice = ref('');
let counter = 0;
let sequence = 0;

const view = (pack) => ({
    key: `pk${++counter}`,
    label: pack.label || '',
    factor: pack.factor == null ? '' : String(pack.factor),
    sale_price: pack.sale_price == null ? '' : String(pack.sale_price),
    barcode: pack.barcode || '',
});

async function load() {
    const current = ++sequence;
    loading.value = true;
    error.value = '';
    notice.value = '';
    try {
        const { response, data } = await fetchJsonResponse(`api/admin/products/${props.productId}/packs`, { cache: 'no-store' });
        if (!response.ok || !data.success) throw new Error(data.message || t('Unable to load the packs.'));
        if (current !== sequence) return;
        packs.value = (data.packs || []).map(view);
        dirty.value = false;
    } catch (failure) {
        if (current === sequence) error.value = failure instanceof Error ? failure.message : t('Unable to load the packs.');
    } finally {
        if (current === sequence) loading.value = false;
    }
}

function addPack() {
    packs.value.push(view({}));
    dirty.value = true;
}
function removePack(index) {
    packs.value.splice(index, 1);
    dirty.value = true;
}

async function save() {
    if (saving.value) return;
    saving.value = true;
    emit('busy', true);
    error.value = '';
    notice.value = '';
    try {
        const body = {
            packs: packs.value.map(pack => ({
                label: pack.label.trim(),
                factor: pack.factor.trim().replace(',', '.'),
                sale_price: pack.sale_price.trim() === '' ? null : pack.sale_price.trim().replace(',', '.'),
                barcode: pack.barcode.trim() || null,
            })),
        };
        const { response, data } = await fetchJsonResponse(`api/admin/products/${props.productId}/packs`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!response.ok || !data.success) throw new Error(data.message || t('Unable to save the packs.'));
        packs.value = (data.packs || []).map(view);
        dirty.value = false;
        notice.value = t('Packs saved.');
        emit('saved', data.packs || []);
    } catch (failure) {
        error.value = failure instanceof Error ? failure.message : t('Unable to save the packs.');
    } finally {
        saving.value = false;
        emit('busy', false);
    }
}

watch(() => props.productId, load, { immediate: true });
</script>

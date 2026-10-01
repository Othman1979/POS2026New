<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { fetchJsonResponse } from '@/shared/http.js';

type State = {
    active: boolean; can_activate: boolean; quantity_known: boolean;
    stock: string | null; stock_version: string; stock_item_id: string | null;
    blockers: Array<{ code: string; message: string }>;
};
type Intent = { expected_stock_version: string; request_key: string };
const props = defineProps<{ productId: number | string; stockDirty?: boolean }>();
const emit = defineEmits<{
    state: [state: State]; activated: [state: State]; busy: [busy: boolean]; openStock: [];
}>();
const state = shallowRef<State | null>(null);
const pending = shallowRef<Intent | null>(null);
const loading = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef('');
let sequence = 0;
let disposed = false;
onScopeDispose(() => { disposed = true; sequence++; });
const quantityLabel = computed(() => String(state.value?.stock ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
const slot = (id: number | string) => `posapp.stock-activation.${id}`;

async function loadState() {
    if (disposed) return;
    const current = ++sequence;
    const id = props.productId;
    loading.value = true;
    error.value = '';
    try {
        try {
            const saved = sessionStorage.getItem(slot(id));
            pending.value = saved ? JSON.parse(saved) : null;
        } catch { pending.value = null; }
        const { response, data } = await fetchJsonResponse(`api/admin/stock/products/${id}/activation`, { cache: 'no-store' });
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to check stock activation.');
        if (current !== sequence) return;
        state.value = data;
        emit('state', data);
    } catch (failure) {
        if (current === sequence) error.value = failure instanceof Error ? failure.message : 'Unable to check stock activation.';
    } finally { if (current === sequence) loading.value = false; }
}

async function activate() {
    if (disposed || loading.value || busy.value || !state.value || (!pending.value && (!state.value.can_activate || props.stockDirty))) return;
    const id = props.productId;
    busy.value = true;
    emit('busy', true);
    error.value = '';
    try {
        const intent = pending.value ?? {
            expected_stock_version: state.value.stock_version,
            request_key: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
        };
        // Persist before sending: a lost response must retry the original key.
        sessionStorage.setItem(slot(id), JSON.stringify(intent));
        pending.value = intent;
        const { response, data } = await fetchJsonResponse(`api/admin/stock/products/${id}/activate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent)
        });
        if (data.success || [400, 403, 409, 422].includes(response.status)) sessionStorage.removeItem(slot(id));
        if (disposed || String(id) !== String(props.productId)) return;
        if (!data.success) {
            if ([400, 403, 409, 422].includes(response.status)) { pending.value = null; await loadState(); }
            error.value = data.message || 'Unable to activate stock. Retry the same operation.';
            return;
        }
        pending.value = null;
        state.value = { ...state.value, ...data, active: true, can_activate: false, blockers: [] };
        emit('state', state.value);
        emit('activated', state.value);
    } catch {
        error.value = 'Unable to activate stock. Retry the same operation.';
    } finally { busy.value = false; emit('busy', false); }
}

watch(() => props.productId, () => { state.value = null; loadState(); }, { immediate: true });
</script>

<template>
    <section class="rounded-xl border border-border bg-muted/40 p-4 space-y-3 text-start" aria-live="polite" :aria-busy="loading || busy">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
                <h4 class="text-sm font-semibold text-foreground">{{ $t(state?.active ? 'Stock movements enabled' : 'Start a stock record') }}</h4>
                <p class="text-xs leading-relaxed text-muted-foreground">{{ $t(state?.active ? 'Sales, receipts and counts now share one stock record.' : 'Your current balance carries over. Previous movements are not recreated.') }}</p>
            </div>
            <button v-if="state?.active && !pending" type="button" class="text-xs font-semibold text-primary underline underline-offset-4" @click="emit('openStock')">{{ $t('Open stock counts') }}</button>
        </div>
        <p v-if="loading" class="text-xs text-muted-foreground">{{ $t('Checking stock and pending orders...') }}</p>
        <template v-else-if="state && !state.active">
            <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
                <span class="text-xs text-muted-foreground">{{ $t('Starting balance') }}</span>
                <bdi v-if="state.quantity_known" dir="ltr" class="text-lg font-semibold tabular-nums text-foreground" data-no-i18n>{{ quantityLabel }}</bdi>
                <span v-else class="text-sm font-medium text-foreground">{{ $t('Not counted yet') }}</span>
            </div>
            <p v-if="!state.quantity_known" class="text-xs leading-relaxed text-foreground">{{ $t('After enabling, record a count before selling this product.') }}</p>
            <ul v-if="state.blockers.length" class="space-y-1 text-xs leading-relaxed text-foreground">
                <li v-for="blocker in state.blockers" :key="blocker.code">{{ $t(blocker.message) }}</li>
            </ul>
            <p v-if="stockDirty" class="text-xs text-foreground">{{ $t('Save your quantity change before enabling stock movements.') }}</p>
        </template>
        <p v-if="error" role="alert" class="text-xs leading-relaxed text-destructive">{{ $t(error) }}</p>
        <div v-if="pending || !state?.active" class="flex flex-wrap items-center justify-end gap-2">
            <button v-if="!busy" type="button" :disabled="loading" class="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50" @click="loadState">{{ $t('Check again') }}</button>
            <button type="button" :disabled="busy || loading || (!pending && (!state?.can_activate || stockDirty))" class="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50" @click="activate">
                {{ $t(busy ? 'Saving...' : pending ? 'Confirm previous activation' : 'Enable stock movements') }}
            </button>
        </div>
    </section>
</template>

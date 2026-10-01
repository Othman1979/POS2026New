<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { fetchJsonResponse } from '@/shared/http.js';

type State = {
    active: boolean; can_activate: boolean; quantity_known: boolean;
    quantity: string | null; observation_token: string; stock_item_id: string | null;
    availability_policy: 'estimate' | 'strict';
    blockers: Array<{ code: string; message: string }>;
};
type Intent = { observation_token: string; request_key: string; availability_policy: 'estimate' | 'strict' };
const props = defineProps<{ ingredientId: number | string }>();
const emit = defineEmits<{
    state: [state: State]; activated: [state: State]; busy: [busy: boolean];
}>();
const state = shallowRef<State | null>(null);
const pending = shallowRef<Intent | null>(null);
const loading = shallowRef(false);
const busy = shallowRef(false);
const error = shallowRef('');
const strict = shallowRef(false);
let sequence = 0;
let disposed = false;
onScopeDispose(() => { disposed = true; sequence++; });
const quantityLabel = computed(() => String(state.value?.quantity ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
const slot = (id: number | string) => `posapp.ingredient-activation.${id}`;

async function loadState() {
    if (disposed) return;
    const current = ++sequence;
    const id = props.ingredientId;
    loading.value = true;
    error.value = '';
    try {
        try {
            const saved = sessionStorage.getItem(slot(id));
            pending.value = saved ? JSON.parse(saved) : null;
        } catch { pending.value = null; }
        const { response, data } = await fetchJsonResponse(`api/admin/stock/ingredients/${id}/activation`, { cache: 'no-store' });
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to check stock activation.');
        if (current !== sequence) return;
        state.value = data;
        if (pending.value?.availability_policy === 'strict' || data.availability_policy === 'strict') strict.value = true;
        emit('state', data);
    } catch (failure) {
        if (current === sequence) error.value = failure instanceof Error ? failure.message : 'Unable to check stock activation.';
    } finally { if (current === sequence) loading.value = false; }
}

async function activate() {
    if (disposed || loading.value || busy.value || !state.value || (!pending.value && !state.value.can_activate)) return;
    const id = props.ingredientId;
    busy.value = true;
    emit('busy', true);
    error.value = '';
    try {
        const intent = pending.value ?? {
            observation_token: state.value.observation_token,
            request_key: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
            availability_policy: strict.value ? 'strict' : 'estimate'
        };
        sessionStorage.setItem(slot(id), JSON.stringify(intent));
        pending.value = intent;
        const { response, data } = await fetchJsonResponse(`api/admin/stock/ingredients/${id}/activate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent)
        });
        if (data.success || [400, 403, 409, 422].includes(response.status)) sessionStorage.removeItem(slot(id));
        if (disposed || String(id) !== String(props.ingredientId)) return;
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

watch(() => props.ingredientId, () => { state.value = null; loadState(); }, { immediate: true });
defineExpose({ loadState, activate, state, pending, loading, busy, error, strict });
</script>

<template>
    <section class="rounded-xl border border-border bg-muted/40 p-4 space-y-3 text-start" aria-live="polite" :aria-busy="loading || busy">
        <div class="space-y-1">
            <h4 class="text-sm font-semibold text-foreground">{{ $t(state?.active ? 'Stock movement log enabled' : 'Enable the stock movement log') }}</h4>
            <p class="text-xs leading-relaxed text-muted-foreground">{{ $t(state?.active ? 'Sales, deliveries and counts are recorded together in the stock movement log.' : 'Your current expected balance carries over. Previous movements are not recreated.') }}</p>
        </div>
        <p v-if="loading" class="text-xs text-muted-foreground">{{ $t('Checking stock and pending orders...') }}</p>
        <template v-else-if="state && !state.active">
            <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
                <span class="text-xs text-muted-foreground">{{ $t('Starting balance') }}</span>
                <bdi v-if="state.quantity_known" dir="ltr" class="text-lg font-semibold tabular-nums text-foreground" data-no-i18n>{{ quantityLabel }}</bdi>
                <span v-else class="text-sm font-medium text-foreground">{{ $t('No stock count yet') }}</span>
            </div>
            <p class="text-xs leading-relaxed text-foreground">{{ $t(state.quantity_known ? 'Expected stock may fall below zero until you record another count.' : 'You can record usage before the first count, but available stock stays unknown until you count it.') }}</p>
            <label class="flex items-start gap-2 text-xs leading-relaxed text-foreground">
                <input v-model="strict" type="checkbox" class="mt-0.5 accent-primary" :disabled="busy">
                <span>{{ $t('Require a count before recording usage') }}</span>
            </label>
            <ul v-if="state.blockers.length" class="space-y-1 text-xs leading-relaxed text-foreground">
                <li v-for="blocker in state.blockers" :key="blocker.code">{{ $t(blocker.message) }}</li>
            </ul>
        </template>
        <p v-if="error" role="alert" class="text-xs leading-relaxed text-destructive">{{ $t(error) }}</p>
        <div v-if="pending || !state?.active" class="flex flex-wrap items-center justify-end gap-2">
            <button v-if="!busy" type="button" :disabled="loading" class="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50" @click="loadState">{{ $t('Check again') }}</button>
            <button type="button" :disabled="busy || loading || (!pending && !state?.can_activate)" class="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50" @click="activate">
                {{ $t(busy ? 'Saving...' : pending ? 'Confirm previous activation' : 'Enable stock movement log') }}
            </button>
        </div>
    </section>
</template>

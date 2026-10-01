<template>
    <div class="h-full min-h-0 flex flex-col gap-4 text-foreground">
        <header class="admin-grid-page-bar shrink-0">
            <div class="admin-grid-page-context">
                <h2>{{ $t('JoFotara Operations') }}</h2>
                <span class="admin-grid-record-count">
                    <span class="tabular-nums" data-no-i18n>{{ data.summary.total }}</span>
                    {{ $t('unresolved') }}
                </span>
            </div>
            <div class="flex flex-wrap gap-2">
                <button
                    class="admin-grid-button min-h-11"
                    type="button"
                    :disabled="loading || processing || batchSubmitting"
                    @click="processNow"
                >
                    <i :class="['fa-solid fa-rotate', processing && 'fa-spin']" aria-hidden="true"></i>
                    <span>{{ $t(processing ? 'Recovering automatic sales…' : 'Recover automatic sales') }}</span>
                </button>
                <button
                    class="admin-grid-button min-h-11"
                    type="button"
                    :disabled="!selectedItems.length || batchSubmitting"
                    @click="submitSelected"
                >
                    <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
                    <span>{{ $t('Submit selected') }}</span>
                    <span class="tabular-nums" data-no-i18n>({{ selectedItems.length }})</span>
                </button>
            </div>
        </header>

        <section v-if="!data.enabled" class="border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            {{ $t('JoFotara is disabled. Unsubmitted documents remain visible, but nothing is sent.') }}
        </section>

        <section class="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-zinc-200 py-2 text-xs shrink-0">
            <span v-for="metric in metrics" :key="metric.key" class="flex items-center gap-1.5">
                <span class="text-muted-foreground">{{ $t(metric.label) }}</span>
                <strong class="tabular-nums" data-no-i18n>{{ data.summary[metric.key] || 0 }}</strong>
            </span>
        </section>

        <section class="flex flex-wrap gap-2 shrink-0 text-sm" :aria-label="$t('JoFotara filters')">
            <label>
                <span class="sr-only">{{ $t('Source') }}</span>
                <select v-model="filters.source_kind" class="admin-grid-input min-h-11" :disabled="batchSubmitting" @change="load">
                    <option value="">{{ $t('All sources') }}</option>
                    <option value="standard">{{ $t('Standard') }}</option>
                    <option value="platform">{{ $t('Platform') }}</option>
                </select>
            </label>
            <label>
                <span class="sr-only">{{ $t('Provider') }}</span>
                <select v-model="filters.order_type_id" class="admin-grid-input min-h-11" :disabled="batchSubmitting" @change="load">
                    <option value="">{{ $t('All providers') }}</option>
                    <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
                </select>
            </label>
            <label>
                <span class="sr-only">{{ $t('Status') }}</span>
                <select v-model="filters.status" class="admin-grid-input min-h-11" :disabled="batchSubmitting" @change="load">
                    <option value="">{{ $t('All statuses') }}</option>
                    <option v-for="metric in metrics" :key="metric.key" :value="metric.key">{{ $t(metric.label) }}</option>
                </select>
            </label>
            <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{{ $t('Issued from') }}</span>
                <input v-model="filters.issued_from" class="admin-grid-input min-h-11" type="date" :disabled="batchSubmitting" @change="load">
            </label>
            <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{{ $t('Issued to') }}</span>
                <input v-model="filters.issued_to" class="admin-grid-input min-h-11" type="date" :disabled="batchSubmitting" @change="load">
            </label>
            <button
                v-if="filters.invoice_id"
                class="admin-grid-button min-h-11"
                type="button"
                :disabled="batchSubmitting"
                @click="clearInvoiceFocus"
            >
                <span>{{ $t('Invoice') }} <span class="tabular-nums" data-no-i18n>#{{ filters.invoice_id }}</span></span>
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </section>

        <div v-if="error" class="border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">{{ error }}</div>
        <div v-if="batchResult" class="border border-teal-300 bg-teal-50 p-3 text-sm text-teal-900" role="status">
            {{ $t('Accepted') }}: <span class="tabular-nums" data-no-i18n>{{ batchResult.accepted }}</span>
            · {{ $t('Rejected by JoFotara') }}: <span class="tabular-nums" data-no-i18n>{{ batchResult.rejected }}</span>
            · {{ $t('Failed') }}: <span class="tabular-nums" data-no-i18n>{{ batchResult.failed }}</span>
        </div>

        <section class="min-h-0 flex-1 overflow-auto admin-grid-scroll border border-zinc-300 bg-card">
            <div v-if="loading" class="h-40 flex items-center justify-center text-sm text-muted-foreground">{{ $t('Loading…') }}</div>
            <div v-else-if="!data.items.length" class="h-40 flex flex-col items-center justify-center gap-2 p-6 text-center">
                <i class="fa-solid fa-circle-check text-2xl text-teal-700" aria-hidden="true"></i>
                <p class="text-sm font-semibold">{{ $t('No unresolved JoFotara documents') }}</p>
            </div>
            <div v-else class="divide-y divide-zinc-200">
                <article
                    v-for="item in data.items"
                    :key="keyFor(item)"
                    class="p-3 flex flex-col md:grid md:grid-cols-[2.75rem_minmax(10rem,1fr)_8rem_7rem_8rem_minmax(10rem,1fr)] gap-2 md:items-center"
                >
                    <label v-if="item.can_submit" class="min-h-11 min-w-11 flex items-center justify-center">
                        <input
                            v-model="selectedKeys"
                            class="size-5 accent-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700 focus:ring-offset-2"
                            type="checkbox"
                            :value="keyFor(item)"
                            :disabled="batchSubmitting"
                            :aria-label="$t('Select document')"
                        >
                    </label>
                    <span v-else aria-hidden="true"></span>
                    <button class="logical-text-start min-w-0" type="button" @click="openOrder(item.order_invoice_id)">
                        <span class="block text-xs font-semibold truncate" data-no-i18n>{{ item.document_number || `#${item.source_id}` }}</span>
                        <span class="block text-[11px] text-muted-foreground">
                            {{ $t(sourceLabel(item.source_kind)) }} · {{ item.order_type_name || $t('No provider') }}
                        </span>
                    </button>
                    <span class="w-fit rounded px-2 py-1 text-[10px] font-bold uppercase" :class="statusClass(item.status)">
                        {{ $t(statusLabel(item.status)) }}
                    </span>
                    <span class="text-xs font-semibold tabular-nums">
                        <span data-no-i18n>{{ Number(item.gross_total || 0).toFixed(2) }}</span> {{ $t('JD') }}
                    </span>
                    <span class="text-xs text-muted-foreground tabular-nums" data-no-i18n>{{ issuedDate(item.invoice_issued_at) }}</span>
                    <div class="flex items-center gap-2 min-w-0">
                        <p class="min-w-0 flex-1 text-xs text-muted-foreground break-words" :title="item.last_error || ''">
                            {{ item.last_error || $t('Awaiting submission') }}
                        </p>
                        <button
                            v-if="item.document_id"
                            class="admin-grid-button min-h-10 min-w-10 px-0 shrink-0"
                            type="button"
                            :aria-label="$t('View JoFotara response')"
                            :title="$t('View JoFotara response')"
                            @click="openResponse(item)"
                        >
                            <i class="fa-solid fa-eye" aria-hidden="true"></i>
                        </button>
                    </div>
                </article>
            </div>
        </section>

        <Teleport to="body">
            <div v-if="responseModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" @click.self="closeResponse">
                <section class="w-full max-w-3xl max-h-[88vh] overflow-hidden border border-zinc-300 bg-card text-foreground shadow-2xl" role="dialog" aria-modal="true" :aria-label="$t('JoFotara response')">
                    <header class="flex items-center justify-between gap-3 border-b border-zinc-200 p-4">
                        <div>
                            <h3 class="text-sm font-bold">{{ $t('JoFotara response') }}</h3>
                            <p v-if="responseModal.http_status != null" class="mt-1 text-xs text-muted-foreground"><span>{{ $t('HTTP status') }}</span>: <span data-no-i18n>{{ responseModal.http_status }}</span></p>
                        </div>
                        <button class="admin-grid-button min-h-11 min-w-11 px-0" type="button" :aria-label="$t('Close')" @click="closeResponse"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                    </header>
                    <div class="max-h-[70vh] overflow-auto p-4">
                        <p v-if="responseLoading" class="text-sm text-muted-foreground">{{ $t('Loading…') }}</p>
                        <p v-else-if="responseError" class="text-sm text-red-700" role="alert">{{ responseError }}</p>
                        <div v-else class="space-y-3">
                            <p v-if="responseModal.last_error" class="border border-red-200 bg-red-50 p-3 text-xs text-red-800">{{ responseModal.last_error }}</p>
                            <pre class="whitespace-pre-wrap break-all text-xs leading-relaxed font-mono" dir="ltr" data-no-i18n>{{ formattedResponse }}</pre>
                        </div>
                    </div>
                </section>
            </div>
        </Teleport>
    </div>
</template>

<script setup>
import { formatBusinessDate } from '@/utils/businessDate.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fetchJsonResponse } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

const router = useRouter();
const route = useRoute();
const loading = ref(true);
const processing = ref(false);
const batchSubmitting = ref(false);
const error = ref('');
const batchResult = ref(null);
const selectedKeys = ref([]);
const routeSourceKind = ['standard', 'platform'].includes(String(route.query.source_kind || ''))
    ? String(route.query.source_kind)
    : '';
const routeInvoiceId = /^[1-9]\d*$/.test(String(route.query.invoice_id || '')) ? String(route.query.invoice_id) : '';
const filters = ref({ source_kind: routeSourceKind, order_type_id: '', status: '', issued_from: '', issued_to: '', invoice_id: routeInvoiceId });
const data = ref({ enabled: false, summary: { total: 0 }, items: [] });
const providers = ref([]);
const responseModal = ref(null);
const responseLoading = ref(false);
const responseError = ref('');
let loadVersion = 0;

const operationStatuses = {
    not_submitted: { label: 'Not sent to JoFotara', className: 'bg-zinc-100 text-zinc-700' },
    waiting_for_original: { label: 'Waiting for original invoice', className: 'bg-amber-50 text-amber-800' },
    pending: { label: 'Ready to send', className: 'bg-blue-50 text-blue-700' },
    submitting: { label: 'Sending to JoFotara', className: 'bg-teal-50 text-teal-700' },
    rejected: { label: 'Rejected by JoFotara', className: 'bg-red-50 text-red-700' },
    unknown: { label: 'Needs review', className: 'bg-amber-50 text-amber-800' }
};
const metrics = Object.entries(operationStatuses).map(([key, value]) => ({ key, label: value.label }));

const keyFor = item => `${item.source_type}:${item.source_id}`;
const selectedItems = computed(() => data.value.items.filter(item => item.can_submit && selectedKeys.value.includes(keyFor(item))));
const sourceLabel = source => ({ standard: 'Standard', platform: 'Platform' }[source] || source);
const statusLabel = status => operationStatuses[status]?.label || status;
const statusClass = status => operationStatuses[status]?.className;
const issuedDate = value => value ? formatBusinessDate(value) : '—';
const formattedResponse = computed(() => {
    const response = responseModal.value?.response;
    if (response == null || response === '') return t('No response was stored.');
    return typeof response === 'string' ? response : JSON.stringify(response, null, 2);
});

async function openResponse(item) {
    responseModal.value = { document_id: item.document_id, response: null };
    responseLoading.value = true;
    responseError.value = '';
    try {
        const { response, data: payload } = await fetchJsonResponse(`api/admin/jofotara/operations/documents/${item.document_id}/response`);
        if (!response.ok || !payload.success) throw new Error(payload.message || t('Failed to load JoFotara response.'));
        responseModal.value = payload;
    } catch (cause) {
        responseError.value = cause.message;
    } finally {
        responseLoading.value = false;
    }
}

function closeResponse() {
    responseModal.value = null;
    responseError.value = '';
}

function queryString() {
    const params = new URLSearchParams({ limit: '100' });
    for (const [key, value] of Object.entries(filters.value)) {
        if (value) params.set(key, value);
    }
    return params.toString();
}

async function load() {
    const version = ++loadVersion;
    loading.value = true;
    error.value = '';
    try {
        const { response, data: payload } = await fetchJsonResponse(`api/admin/jofotara/operations?${queryString()}`);
        if (!response.ok || !payload.success) throw new Error(payload.message || t('Failed to load JoFotara operations.'));
        if (version !== loadVersion) return;
        data.value = payload;
        const knownProviders = new Map(providers.value.map(provider => [provider.id, provider]));
        for (const item of payload.items) {
            if (item.order_type_id) {
                const id = String(item.order_type_id);
                knownProviders.set(id, { id, name: item.order_type_name || `#${id}` });
            }
        }
        providers.value = [...knownProviders.values()];
        selectedKeys.value = selectedKeys.value.filter(key => payload.items.some(item => item.can_submit && keyFor(item) === key));
    } catch (cause) {
        if (version === loadVersion) error.value = cause.message;
    } finally {
        if (version === loadVersion) loading.value = false;
    }
}

async function processNow() {
    processing.value = true;
    batchResult.value = null;
    error.value = '';
    try {
        const { response, data: payload } = await fetchJsonResponse('api/admin/jofotara/operations/process', { method: 'POST' });
        if (!response.ok || !payload.success) throw new Error(payload.message || t('JoFotara recovery failed.'));
        await load();
    } catch (cause) {
        error.value = cause.message;
    } finally {
        processing.value = false;
    }
}

async function submitSelected() {
    const items = [...selectedItems.value];
    const total = items.reduce((sum, item) => sum + Number(item.gross_total || 0), 0);
    const confirmed = await window.showAdminConfirm?.(
        `${t('Submit selected')}: ${items.length} · ${t('Gross total')}: ${total.toFixed(2)} ${t('JD')}?`
    );
    if (confirmed === false) return;

    batchSubmitting.value = true;
    batchResult.value = null;
    error.value = '';
    const results = { accepted: 0, rejected: 0, failed: 0 };
    try {
        for (const item of items) {
            const path = item.source_type === 'invoice'
                ? `api/admin/jofotara/operations/invoices/${item.source_id}/submit`
                : `api/admin/jofotara/operations/refunds/${item.source_id}/submit`;
            try {
                const { response, data: payload } = await fetchJsonResponse(path, { method: 'POST' });
                if (response.status === 401 || response.status === 403) {
                    results.failed += 1;
                    error.value = t('Your session expired. Sign in again.');
                    break;
                }
                if (!response.ok || !payload.success) {
                    results.failed += 1;
                    continue;
                }
                if (payload.document?.status === 'accepted') results.accepted += 1;
                else if (payload.document?.status === 'rejected') results.rejected += 1;
                else results.failed += 1;
            } catch {
                results.failed += 1;
            }
        }
        batchResult.value = results;
    } finally {
        batchSubmitting.value = false;
        await load();
    }
}

function clearInvoiceFocus() {
    filters.value.invoice_id = '';
    const query = { ...route.query };
    delete query.invoice_id;
    router.replace({ query });
    load();
}

const openOrder = invoiceId => router.push({ name: 'orders', query: { open_invoice_id: invoiceId } });
const onChanged = () => {
    if (!batchSubmitting.value) load();
};

onMounted(() => {
    load();
    window.addEventListener('jofotara_operations_changed', onChanged);
});
onUnmounted(() => window.removeEventListener('jofotara_operations_changed', onChanged));
</script>

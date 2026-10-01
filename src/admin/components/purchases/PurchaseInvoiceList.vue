<template>
    <section class="pi-pane pi-list-pane" :aria-busy="loading">
        <header class="pi-pane-head">
            <h3>{{ $t('Purchase invoices') }}</h3>
            <div style="display: flex; gap: 8px">
                <button type="button" class="pi-btn pi-btn--icon" :disabled="loading" :aria-label="$t('Refresh')" :title="$t('Refresh')" @click="$emit('refresh')"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i></button>
                <button type="button" class="pi-btn pi-btn--primary" @click="$emit('new')">{{ $t('New invoice') }}</button>
            </div>
        </header>
        <div class="pi-filters">
            <input :value="filters.q" class="pi-input" type="search" :placeholder="$t('Search invoice number or supplier')" :aria-label="$t('Search')" @input="$emit('update-filter', { q: $event.target.value })">
            <select :value="filters.status" class="pi-select" :aria-label="$t('Status')" @change="$emit('update-filter', { status: $event.target.value })">
                <option value="">{{ $t('All statuses') }}</option>
                <option value="draft">{{ $t('Draft') }}</option>
                <option value="posted">{{ $t('Posted') }}</option>
                <option value="reversed">{{ $t('Reversed') }}</option>
            </select>
            <select :value="filters.supplierId" class="pi-select" :aria-label="$t('Supplier')" @change="$emit('update-filter', { supplierId: $event.target.value })">
                <option value="">{{ $t('All suppliers') }}</option>
                <option v-for="supplier in suppliers" :key="supplier.id" :value="String(supplier.id)" data-no-i18n>{{ supplier.name }}</option>
            </select>
        </div>
        <p v-if="error" class="pi-note pi-note--error" role="alert">
            <span>{{ error }}</span>
            <button type="button" class="pi-btn" @click="$emit('refresh')">{{ $t('Retry') }}</button>
        </p>
        <div class="pi-list-rows">
            <p v-if="loading && !invoices.length" class="pi-empty" role="status">{{ $t('Loading...') }}</p>
            <p v-else-if="!invoices.length && !error" class="pi-empty">{{ $t('No purchase invoices yet.') }}</p>
            <button
                v-for="invoice in invoices"
                :key="invoice.id"
                type="button"
                class="pi-list-row"
                :aria-current="invoice.id === activeId"
                @click="$emit('select', invoice.id)"
            >
                <strong data-no-i18n>{{ invoice.supplier_name }}</strong>
                <span class="pi-num" data-no-i18n>{{ (Number(invoice.total) || 0).toFixed(3) }}</span>
                <span class="pi-list-meta">
                    <span class="pi-chip" :class="`pi-chip--${invoice.status}`">{{ $t(statusLabel(invoice.status)) }}</span>
                    <span class="pi-chip">{{ $t(invoice.payment_status === 'paid' ? 'Paid' : 'On credit') }}</span>
                    <bdi class="pi-num" data-no-i18n>{{ invoice.supplier_invoice_no }}</bdi>
                    <bdi class="pi-num" data-no-i18n>{{ String(invoice.invoice_date || '').slice(0, 10) }}</bdi>
                    <span><bdi class="pi-num" data-no-i18n>{{ invoice.line_count }}</bdi> {{ $t('Items') }}</span>
                </span>
            </button>
            <button v-if="hasMore" type="button" class="pi-btn pi-btn--link" :disabled="loading" @click="$emit('load-more')">{{ $t('Load more') }}</button>
        </div>
    </section>
</template>

<script setup>
defineProps({
    invoices: { type: Array, default: () => [] },
    suppliers: { type: Array, default: () => [] },
    filters: { type: Object, required: true },
    activeId: { type: [Number, String], default: null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    hasMore: { type: Boolean, default: false },
});
defineEmits(['select', 'refresh', 'load-more', 'update-filter', 'new']);

const statusLabel = (status) => ({ draft: 'Draft', posted: 'Posted', reversed: 'Reversed' }[status] || status);
</script>

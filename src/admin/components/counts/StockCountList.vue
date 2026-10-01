<template>
    <section class="pi-pane pi-list-pane" :aria-busy="loading">
        <header class="pi-pane-head">
            <h3>{{ $t('Stock counts') }}</h3>
            <div style="display: flex; gap: 8px">
                <button type="button" class="pi-btn pi-btn--icon" :disabled="loading" :aria-label="$t('Refresh')" :title="$t('Refresh')" @click="$emit('refresh')"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i></button>
                <button type="button" class="pi-btn pi-btn--primary" @click="$emit('new')">{{ $t('New count') }}</button>
            </div>
        </header>
        <div class="pi-filters">
            <select :value="status" class="pi-select" :aria-label="$t('Status')" @change="$emit('update-status', $event.target.value)">
                <option value="">{{ $t('All statuses') }}</option>
                <option value="draft">{{ $t('Counting') }}</option>
                <option value="posted">{{ $t('Posted') }}</option>
            </select>
        </div>
        <p v-if="error" class="pi-note pi-note--error" role="alert">
            <span>{{ error }}</span>
            <button type="button" class="pi-btn" @click="$emit('refresh')">{{ $t('Retry') }}</button>
        </p>
        <div class="pi-list-rows">
            <p v-if="loading && !counts.length" class="pi-empty" role="status">{{ $t('Loading...') }}</p>
            <p v-else-if="!counts.length && !error" class="pi-empty">{{ $t('No stock counts yet.') }}</p>
            <button
                v-for="row in counts"
                :key="row.id"
                type="button"
                class="pi-list-row"
                :aria-current="row.id === activeId"
                @click="$emit('select', row)"
            >
                <strong data-no-i18n>{{ row.reference || `${$t('Stock count')} ${String(row.count_date || '').slice(0, 10)}` }}</strong>
                <span v-if="row.status === 'posted' && row.variance_value !== null && row.variance_value !== undefined" class="pi-num" :class="{ 'ct-neg': isShortage(row.variance_value) }" data-no-i18n>{{ signedValue(row.variance_value) }}</span>
                <span class="pi-list-meta">
                    <span class="pi-chip" :class="`pi-chip--${row.status}`">{{ row.status === 'posted' ? $t('Posted') : $t('Counting') }}</span>
                    <bdi class="pi-num" data-no-i18n>{{ String(row.count_date || '').slice(0, 10) }}</bdi>
                    <span><bdi class="pi-num" data-no-i18n>{{ row.counted_count }} / {{ row.line_count }}</bdi> {{ $t('counted') }}</span>
                </span>
            </button>
            <button v-if="hasMore" type="button" class="pi-btn pi-btn--link" :disabled="loading" @click="$emit('load-more')">{{ $t('Load more') }}</button>
        </div>
    </section>
</template>

<script setup>
import { isShortage, toThousandths } from './countMath.js';

defineProps({
    counts: { type: Array, default: () => [] },
    status: { type: String, default: '' },
    activeId: { type: [Number, String], default: null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    hasMore: { type: Boolean, default: false },
});
defineEmits(['select', 'refresh', 'load-more', 'update-status', 'new']);

const signedValue = (value) => ((toThousandths(value) ?? 0n) > 0n ? `+${value}` : String(value));
</script>

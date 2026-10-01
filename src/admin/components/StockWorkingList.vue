<template>
    <section class="stock-working" :aria-busy="loading">
        <header class="working-heading">
            <div>
                <h3>{{ $t('Stock levels') }}</h3>
                <p>{{ $t('Unknown quantity is not zero.') }}</p>
            </div>
            <button type="button" class="control" :disabled="loading" @click="reload">{{ $t('Refresh') }}</button>
        </header>
        <p v-if="error" role="alert">{{ $t(error) }} <button type="button" @click="reload">{{ $t('Retry') }}</button></p>
        <div class="working-filters">
            <label>{{ $t('Search') }}<input v-model="search" type="search" :placeholder="$t('Name')"></label>
            <label>{{ $t('Attention') }}<select v-model="attention">
                <option value="">{{ $t('All statuses') }}</option>
                <option value="ok">{{ $t('In stock') }}</option>
                <option value="low">{{ $t('Low') }}</option>
                <option value="negative">{{ $t('Out or below zero') }}</option>
                <option value="unknown">{{ $t('Not counted yet') }}</option>
            </select></label>
            <label>{{ $t('Kind') }}<select v-model="kind">
                <option value="all">{{ $t('All kinds') }}</option>
                <option value="product">{{ $t('Products') }}</option>
                <option value="ingredient">{{ $t('Ingredients') }}</option>
            </select></label>
        </div>
        <div class="working-table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>{{ $t('Item') }}</th>
                        <th>{{ $t('Kind') }}</th>
                        <th>{{ $t('Expected balance') }}</th>
                        <th>{{ $t('Attention') }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="loading && !items.length"><td colspan="4">{{ $t('Loading...') }}</td></tr>
                    <tr v-else-if="!items.length"><td colspan="4">{{ $t('No matching stock items.') }}</td></tr>
                    <tr v-for="item in items" :key="item.item_key">
                        <th scope="row"><strong data-no-i18n>{{ item.name }}</strong><small v-if="item.kind === 'ingredient'">{{ $t('Ingredients') }}</small><small v-else-if="item.group_label === OTHER_ITEMS">{{ $t('Other items') }}</small><small v-else data-no-i18n>{{ item.group_label }}</small></th>
                        <td>{{ $t(item.kind === 'ingredient' ? 'Ingredient' : 'Product') }}</td>
                        <td v-if="item.quantity_known"><bdi dir="ltr" data-no-i18n>{{ formatQuantity(item.quantity) }}</bdi> {{ $t(unitLabel(item.base_unit)) }}</td>
                        <td v-else>{{ $t('Not counted yet') }}</td>
                        <td><span class="badge" :class="`badge-${item.attention}`">{{ $t(attentionLabel(item.attention)) }}</span></td>
                    </tr>
                </tbody>
            </table>
        </div>
        <footer class="working-footer">
            <span>{{ items.length }} {{ $t('Items') }}</span>
            <button type="button" class="control" :disabled="loading || !nextCursor" @click="loadMore">{{ $t('Next') }}</button>
        </footer>
    </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchJson } from '@/shared/http.js';

const OTHER_ITEMS = 'Other items'; // the backend's label for products without a category
const items = ref([]);
const loading = ref(false);
const error = ref('');
const search = ref('');
const attention = ref('');
const kind = ref('all');
const nextCursor = ref(null);
let sequence = 0;
let debounce = null;

function attentionLabel(value) {
    return { ok: 'In stock', low: 'Low', unknown: 'Not counted yet', negative: 'Out or below zero' }[value] || value;
}

// The API sends an exact decimal string; trim it as text so large values never pass through a float.
function formatQuantity(value) {
    const text = String(value);
    return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function unitLabel(value) {
    return { g: 'Grams', ml: 'Milliliters', unit: 'Unit' }[value] || value;
}

function query(extra = {}) {
    const params = { limit: '50', kind: kind.value };
    if (search.value.trim()) params.q = search.value.trim();
    if (attention.value) params.attention = attention.value;
    return { ...params, ...extra };
}

async function load(reset = true) {
    const seq = ++sequence;
    loading.value = true;
    error.value = '';
    try {
        const data = await fetchJson(`api/admin/stock/items?${new URLSearchParams(query(reset ? {} : { cursor: nextCursor.value }))}`);
        if (seq !== sequence) return;
        if (!data.success) throw new Error(data.message || 'Load failed.');
        items.value = reset ? (data.items || []) : [...items.value, ...(data.items || [])];
        nextCursor.value = data.next_cursor || null;
    } catch (caught) {
        if (seq === sequence) error.value = caught.message || 'Load failed.';
    } finally {
        if (seq === sequence) loading.value = false;
    }
}

function reload() { nextCursor.value = null; return load(true); }
function loadMore() { if (nextCursor.value) return load(false); }

watch([attention, kind], () => { nextCursor.value = null; load(true); });
watch(search, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { nextCursor.value = null; load(true); }, 300);
});
onMounted(() => load(true));
onUnmounted(() => { sequence++; clearTimeout(debounce); });
</script>

<style scoped>
.stock-working { min-width: 0; padding: 16px; color: #273544; font-size: 13px; }
.working-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
.working-heading > div { min-width: 0; }
.working-heading h3 { font-size: 20px; font-weight: 700; }
.working-heading p { color: #66717f; margin-top: 4px; }
.working-filters { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.working-filters label { display: flex; flex-direction: column; min-width: 0; max-width: 100%; gap: 6px; font-size: 12px; color: #53606f; }
.working-filters label:first-child { flex: 1 1 240px; }
.working-filters input, .working-filters select { min-width: 0; max-width: 100%; }
.working-filters input, .working-filters select, .control { min-height: 44px; border: 1px solid #cbd2dc; border-radius: 6px; padding: 8px 12px; background: white; color: inherit; }
.working-table-scroll { overflow-x: auto; border: 1px solid #dce3ea; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: start; padding: 14px; border-bottom: 1px solid #e5e9ef; vertical-align: top; }
thead { background: #f4f6f8; }
th small { display: block; color: #66717f; font-weight: 400; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef1f4; color: #53606f; font-size: 12px; }
.badge-low { background: #fff3d6; color: #8a5a00; }
.badge-negative { background: #fde4e4; color: #a22a2a; }
.badge-ok { background: #e3f4e8; color: #1f6b3a; }
.working-footer { display: flex; justify-content: space-between; align-items: center; padding-block: 12px; }
.control { cursor: pointer; }
.control:disabled { opacity: .5; cursor: default; }
[role=alert] { color: #a22a2a; }
</style>

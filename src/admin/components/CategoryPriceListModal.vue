<template>
  <ModalShell
    :show="show"
    :title="$t('Category prices')"
    width-class="max-w-5xl"
    @close="requestClose"
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="space-y-3 border-b border-border p-4 sm:p-5">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-xs text-muted-foreground">
            {{ $t('Leave a price blank to use the product price.') }}
          </p>
          <p class="text-xs font-bold text-foreground tabular-nums" data-no-i18n>
            {{ filteredProducts.length }} / {{ products.length }}
          </p>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(12rem,1fr)_minmax(10rem,14rem)_auto]">
          <input
            v-model.trim="searchQuery"
            type="search"
            :placeholder="$t('Search products')"
            class="h-11 w-full rounded-md border border-border bg-muted px-3 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
          >
          <select
            v-model="categoryFilter"
            class="h-11 w-full rounded-md border border-border bg-muted px-3 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
          >
            <option value="">{{ $t('All categories') }}</option>
            <option v-for="category in categoryOptions" :key="category.id" :value="String(category.id)" data-no-i18n>
              {{ category.path }}
            </option>
          </select>
          <label class="flex h-11 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-bold">
            <input v-model="changedOnly" type="checkbox" class="h-4 w-4 accent-teal-600">
            {{ $t('Changed only') }}
          </label>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(10rem,14rem)_auto_auto] sm:justify-end">
          <label class="relative block">
            <span class="sr-only">{{ $t('Percentage') }}</span>
            <input
              v-model="bulkPercentage"
              type="number"
              min="-100"
              step="0.1"
              inputmode="decimal"
              :placeholder="$t('Percentage')"
              class="h-11 w-full rounded-md border border-border bg-muted px-3 pe-9 text-sm tabular-nums outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
              data-no-i18n
            >
            <span class="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground" data-no-i18n>%</span>
          </label>
          <button type="button" class="h-11 rounded-md border border-border bg-card px-4 text-xs font-bold hover:bg-muted disabled:opacity-50" :disabled="loading || !filteredProducts.length" @click="applyBulkPercentage">
            {{ $t('Apply percentage') }}
          </button>
          <button type="button" class="h-11 rounded-md border border-border bg-card px-4 text-xs font-bold hover:bg-muted disabled:opacity-50" :disabled="loading || !filteredProducts.length" @click="clearFilteredOverrides">
            {{ $t('Use normal prices') }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="flex min-h-48 items-center justify-center p-6 text-sm text-muted-foreground">
        {{ $t('Loading...') }}
      </div>
      <div v-else-if="!filteredProducts.length" class="flex min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {{ $t('No matching products.') }}
      </div>
      <div v-else class="max-h-[56dvh] overflow-y-auto">
        <div
          v-for="item in filteredProducts"
          :key="item.product_id"
          class="grid grid-cols-1 gap-3 border-b border-border/70 p-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_10rem] sm:items-center sm:px-5"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-bold text-foreground" data-no-i18n>{{ item.name }}</p>
              <span v-if="!item.is_active" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                {{ $t('Inactive') }}
              </span>
            </div>
            <p class="mt-0.5 truncate text-[11px] text-muted-foreground" data-no-i18n>{{ item.category_path }}</p>
          </div>
          <div class="flex items-center justify-between sm:block sm:text-end">
            <span class="text-[10px] font-bold text-muted-foreground sm:block">{{ $t('Normal price') }}</span>
            <span class="text-sm font-semibold tabular-nums" data-no-i18n>{{ money(item.base_gross_price) }}</span>
          </div>
          <div class="flex items-center justify-between sm:block sm:text-end">
            <span class="text-[10px] font-bold text-muted-foreground sm:block">{{ $t('Effective price') }}</span>
            <span class="text-sm font-semibold tabular-nums" data-no-i18n>{{ effectiveMoney(item) }}</span>
          </div>
          <label class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:block">
            <span class="text-[10px] font-bold text-muted-foreground sm:mb-1 sm:block">{{ $t('This price') }}</span>
            <input
              v-model="draft[item.product_id]"
              type="number"
              min="0"
              step="0.001"
              inputmode="decimal"
              :aria-label="`${$t('This price')}: ${item.name}`"
              class="h-11 w-full rounded-md border border-border bg-muted px-3 text-end text-sm font-bold tabular-nums outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
              data-no-i18n
            >
          </label>
        </div>
      </div>
    </div>

    <div class="flex flex-col-reverse gap-2 border-t border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p class="text-xs text-muted-foreground">
        {{ hasChanges ? $t('Unsaved price changes') : $t('No price changes') }}
      </p>
      <div class="grid grid-cols-2 gap-2 sm:flex">
        <button type="button" class="h-11 rounded-md border border-border bg-card px-4 text-xs font-bold hover:bg-muted" @click="requestClose">
          {{ $t('Cancel') }}
        </button>
        <button type="button" class="h-11 rounded-md bg-teal-600 px-5 text-xs font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50" :disabled="saving || !hasChanges" @click="save">
          {{ saving ? $t('Saving...') : $t('Save prices') }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>

<script setup>
import { fetchJsonResponse } from '@/shared/http.js';
import { computed, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import ModalShell from './ModalShell.vue';

const props = defineProps({
  show: Boolean,
  root: Object
});
const emit = defineEmits(['close', 'saved']);

const loading = ref(false);
const saving = ref(false);
const products = ref([]);
const draft = ref({});
const initialDraft = ref({});
const searchQuery = ref('');
const categoryFilter = ref('');
const changedOnly = ref(false);
const bulkPercentage = ref('');
let loadRequestId = 0;

const money = value => `${Number(value || 0).toFixed(3)} JD`;
const blankPrice = value => value === '' || value === null || value === undefined;
const effectiveMoney = item => {
  const rawPrice = draft.value[item.product_id];
  if (blankPrice(rawPrice)) return money(item.base_gross_price);
  const price = Number(rawPrice);
  return Number.isFinite(price) && price >= 0 ? money(price) : '—';
};
const samePrice = (left, right) => {
  if (blankPrice(left) && blankPrice(right)) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
    && leftNumber.toFixed(6) === rightNumber.toFixed(6);
};
const priceChanged = productId => !samePrice(draft.value[productId], initialDraft.value[productId]);

const categoryOptions = computed(() => {
  const categories = new Map();
  for (const item of products.value) {
    categories.set(String(item.category_id), { id: item.category_id, path: item.category_path });
  }
  return [...categories.values()].sort((left, right) => left.path.localeCompare(right.path));
});

const filteredProducts = computed(() => {
  const query = searchQuery.value.toLocaleLowerCase();
  return products.value.filter(item => {
    if (categoryFilter.value && String(item.category_id) !== categoryFilter.value) return false;
    if (changedOnly.value && !priceChanged(item.product_id)) return false;
    if (!query) return true;
    return String(item.name).toLocaleLowerCase().includes(query)
      || String(item.category_path).toLocaleLowerCase().includes(query);
  });
});

const hasChanges = computed(() => products.value.some(item => priceChanged(item.product_id)));

function buildChangedPrices() {
  const changedPrices = [];
  for (const item of products.value) {
    if (!priceChanged(item.product_id)) continue;
    const rawPrice = draft.value[item.product_id];
    if (blankPrice(rawPrice)) {
      changedPrices.push({ product_id: item.product_id, gross_price: null });
      continue;
    }
    const grossPrice = Number(rawPrice);
    if (!Number.isFinite(grossPrice) || grossPrice < 0) {
      throw new Error(`${t('Enter a valid price for')} ${item.name}.`);
    }
    changedPrices.push({ product_id: item.product_id, gross_price: grossPrice });
  }
  return changedPrices;
}

async function load() {
  const rootId = Number(props.root?.id);
  const requestId = ++loadRequestId;
  products.value = [];
  draft.value = {};
  initialDraft.value = {};
  searchQuery.value = '';
  categoryFilter.value = '';
  changedOnly.value = false;
  bulkPercentage.value = '';
  if (!rootId) return;

  loading.value = true;
  try {
    const { response, data } = await fetchJsonResponse(`api/admin/category-price-lists/${rootId}/products`);
    if (!response.ok || !data.success) throw new Error(data.message);
    if (requestId !== loadRequestId || Number(props.root?.id) !== rootId || !props.show) return;

    products.value = data.products || [];
    const values = Object.fromEntries(products.value.map(item => [item.product_id, item.override_gross_price ?? '']));
    draft.value = { ...values };
    initialDraft.value = { ...values };
  } catch (error) {
    if (requestId === loadRequestId) {
      window.showAdminAlert?.(error.message || t('Failed to load prices.'));
    }
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

async function requestClose() {
  if (saving.value) return;
  if (hasChanges.value) {
    const confirmed = await window.showAdminConfirm(t('Discard unsaved price changes?'));
    if (!confirmed) return;
  }
  emit('close');
}

async function applyBulkPercentage() {
  const percentage = Number(bulkPercentage.value);
  if (bulkPercentage.value === '' || !Number.isFinite(percentage) || percentage < -100) {
    await window.showAdminAlert(t('Enter a valid percentage of -100 or more.'));
    return;
  }
  const confirmed = await window.showAdminConfirm(t('Apply this percentage to the visible products?'));
  if (!confirmed) return;
  for (const item of filteredProducts.value) {
    draft.value[item.product_id] = Math.round(Number(item.base_gross_price) * (1 + percentage / 100) * 1000) / 1000;
  }
}

async function clearFilteredOverrides() {
  const confirmed = await window.showAdminConfirm(t('Use normal prices for the visible products?'));
  if (!confirmed) return;
  for (const item of filteredProducts.value) draft.value[item.product_id] = '';
}

async function save() {
  let changedPrices;
  try {
    changedPrices = buildChangedPrices();
  } catch (error) {
    await window.showAdminAlert(error.message);
    return;
  }
  if (!changedPrices.length) return;

  saving.value = true;
  try {
    const { response, data } = await fetchJsonResponse(`api/admin/category-price-lists/${props.root.id}/prices`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: changedPrices })
    });
    if (!response.ok || !data.success) throw new Error(data.message);
    window.showAdminToast?.(t('Prices saved.'), 'success');
    emit('saved');
  } catch (error) {
    window.showAdminAlert?.(error.message || t('Failed to save prices.'));
  } finally {
    saving.value = false;
  }
}

watch(
  () => [props.show, props.root?.id],
  ([shown]) => {
    if (shown) load();
    else loadRequestId += 1;
  },
  { immediate: true }
);
</script>

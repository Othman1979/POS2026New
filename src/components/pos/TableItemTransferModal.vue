<template>
  <div class="item-transfer-backdrop" @click.self="close">
    <section ref="dialog" class="item-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="item-transfer-title" @keydown="onKeydown">
      <header>
        <div><h2 id="item-transfer-title">{{ $t('Move Items') }} · {{ $t('Table') }} <span data-no-i18n>{{ source.table_number }}</span></h2><p>{{ $t('Choose quantities and a destination, then review both bills.') }}</p></div>
        <button type="button" :disabled="saving" :aria-label="$t('Close')" @click="close">×</button>
      </header>
      <div class="item-transfer-body">
        <p v-if="loading" role="status">{{ $t('Loading items...') }}</p>
        <template v-else-if="order">
          <label class="item-transfer-target">{{ $t('Destination table') }}
            <input v-model="search" type="search" :aria-label="$t('Search tables')" :placeholder="$t('Search tables')" :disabled="saving" />
            <select v-model="targetId" :aria-label="$t('Destination table')" :disabled="saving">
              <option value="">{{ $t('Select a table') }}</option>
              <option v-for="table in targets" :key="table.id" :value="String(table.id)">{{ $t('Table') }} {{ table.table_number }} · {{ table.section_name }} · {{ $t(table.current_order_id ? 'Occupied' : 'Available') }}</option>
            </select>
          </label>
          <div class="item-transfer-selection">
            <button type="button" :disabled="saving" @click="selectAll">{{ $t('Select all items') }}</button>
            <button v-if="selection.length" type="button" :disabled="saving" @click="quantities = Object.fromEntries(items.map(item => [item.order_item_id, '0']))">{{ $t('Clear selection') }}</button>
          </div>
          <div class="item-transfer-list">
            <article v-for="item in visibleItems" :key="item.order_item_id" class="item-transfer-line">
              <div><strong data-no-i18n>{{ item.name }}</strong><p><span data-no-i18n>{{ item.qty }}</span> {{ $t('available') }}</p><p v-if="item.note" data-no-i18n>{{ item.note }}</p><p v-if="item.bundleItems?.length" data-no-i18n>{{ item.bundleItems.map(child => child.name).join(' · ') }}</p><p v-if="item.selectedModifiers?.length" data-no-i18n>{{ item.selectedModifiers.map(modifier => modifier.name || modifier.option_name).filter(Boolean).join(' · ') }}</p></div>
              <ItemQuantityInput v-model="quantities[item.order_item_id]" :max="item.qty" :label="`${$t('Quantity to move')}: ${item.name}`" :disabled="saving" />
            </article>
          </div>
          <button v-if="visibleItems.length < items.length" type="button" @click="visibleCount += 40">{{ $t('Show more items') }}</button>
          <p v-if="invalid" class="item-transfer-error" role="status">{{ $t('Enter a quantity from zero to the available amount, with up to six decimal places.') }}</p>
          <div v-if="quote" class="item-transfer-preview" aria-live="polite">
            <section v-for="side in [quote.source, quote.target]" :key="side.table_id">
              <h3>{{ $t('Table') }} <span data-no-i18n>{{ side.table_number }}</span></h3>
              <p class="item-transfer-total" data-no-i18n>{{ money(side.before.total) }} → <b>{{ money(side.after.total) }}</b></p>
              <p>{{ $t('Subtotal') }} <span data-no-i18n>{{ money(side.before.subtotal) }} → {{ money(side.after.subtotal) }}</span></p>
              <p>{{ $t('Tax') }} <span data-no-i18n>{{ money(side.before.tax) }} → {{ money(side.after.tax) }}</span></p>
            </section>
          </div>
        </template>
        <p v-if="error" class="item-transfer-error" role="alert">{{ error }}</p>
        <button v-if="!order && !loading" type="button" @click="load">{{ $t('Retry') }}</button>
      </div>
      <footer>
        <button type="button" :disabled="saving" @click="close">{{ $t('Cancel') }}</button>
        <button v-if="!quote" class="item-transfer-primary" type="button" :disabled="!selection.length || invalid || !targetId || loading || previewing" @click="preview">{{ $t(previewing ? 'Loading...' : 'Preview Transfer') }}</button>
        <button v-else class="item-transfer-primary" type="button" :disabled="saving" @click="submit">{{ $t(saving ? 'Moving items...' : 'Confirm Move') }}</button>
      </footer>
    </section>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { useTables } from '@/pos/useTables.js';
import { quantityUnits, quantityText, validQuantity } from '@/utils/itemQuantity.js';
import ItemQuantityInput from './ItemQuantityInput.vue';
const props = defineProps({ source: { type: Object, required: true } });
const emit = defineEmits(['close']);
const { restaurantTables, getTableItemsForTransfer, previewTableItems, moveTableItems } = useTables();
const dialog = ref(null), order = ref(null), quantities = ref({}), targetId = ref(''), search = ref('');
const loading = ref(false), previewing = ref(false), saving = ref(false), quote = ref(null), error = ref(''), visibleCount = ref(40);
const items = computed(() => (order.value?.cart || []).filter(item => item.note !== 'Auto-Gratuity'));
const visibleItems = computed(() => items.value.slice(0, visibleCount.value));
const targets = computed(() => restaurantTables.value.filter(table => !table.parent_table_id && table.id !== props.source.id
  && table.current_order_id !== props.source.current_order_id && ['occupied', 'available'].includes(table.status) && !Number(table.active_split_count)
  && `${table.table_number} ${table.section_name || ''}`.toLowerCase().includes(search.value.toLowerCase())));
const invalid = computed(() => items.value.some(item => !validQuantity(quantities.value[item.order_item_id], item.qty)));
const selection = computed(() => items.value.filter(item => quantityUnits(quantities.value[item.order_item_id]) > 0).map(item => ({ order_item_id: item.order_item_id, quantity: quantityText(quantityUnits(quantities.value[item.order_item_id])) })));
let controller, sequence = 0, previousFocus;
const money = value => `${Number(value || 0).toFixed(2)} JD`;
function selectAll() { quantities.value = Object.fromEntries(items.value.map(item => [item.order_item_id, String(item.qty)])); }
function invalidate() { sequence++; controller?.abort(); quote.value = null; previewing.value = false; }
watch([targetId, quantities], invalidate, { deep: true, flush: 'sync' });
async function load() {
  invalidate(); const seq = sequence; controller = new AbortController(); loading.value = true; error.value = '';
  try { const data = await getTableItemsForTransfer(props.source, { signal: controller.signal }); if (seq !== sequence) return;
    order.value = data; quantities.value = Object.fromEntries(data.cart.map(item => [item.order_item_id, '0']));
  } catch (err) { if (seq === sequence) error.value = err.message; }
  finally { loading.value = false; }
}
async function preview() {
  invalidate(); const seq = sequence; controller = new AbortController(); previewing.value = true; error.value = '';
  const target = targets.value.find(table => String(table.id) === targetId.value);
  if (!target) { previewing.value = false; return; }
  try { const data = await previewTableItems(props.source, target, order.value, selection.value, { signal: controller.signal }); if (seq === sequence) quote.value = data; }
  catch (err) { if (seq === sequence) error.value = err.message; }
  finally { if (seq === sequence) previewing.value = false; }
}
async function submit() {
  if (saving.value) return;
  saving.value = true; error.value = '';
  const result = await moveTableItems(quote.value);
  saving.value = false;
  if (result.success || result.uncertain) { if (result.success) window.showPosToast?.(t('Items moved successfully.'), 'success'); emit('close'); }
  else { error.value = t(result.message || 'Could not move items. Try again.'); invalidate(); }
}
function close() { if (!saving.value) emit('close'); }
function onKeydown(event) {
  if (event.key === 'Escape') { event.stopPropagation(); close(); }
  if (event.key !== 'Tab') return;
  const controls = [...dialog.value.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
onMounted(async () => { previousFocus = document.activeElement; await nextTick(); dialog.value?.querySelector('button')?.focus(); load(); });
onUnmounted(() => { invalidate(); previousFocus?.focus?.(); });
</script>
<style scoped>
.item-transfer-backdrop{position:fixed;inset:0;z-index:150;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgb(17 24 39 / 72%)}
.item-transfer-dialog{display:flex;flex-direction:column;width:min(48rem,100%);max-height:92dvh;border:1px solid var(--color-outline-variant);border-radius:.75rem;overflow:hidden;background:var(--color-surface-container-lowest);color:var(--color-on-surface)}
.item-transfer-selection{display:flex;gap:.5rem;margin-top:1rem}.item-transfer-selection button{font-size:.8rem}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem;border-bottom:1px solid var(--color-outline-variant)}header h2{font-size:1.125rem;font-weight:800}header p,.item-transfer-line p{font-size:.8rem;color:var(--color-on-surface-variant);margin-top:.25rem}header>button{font-size:1.5rem}button,input,select{min-height:2.75rem;border:1px solid var(--color-outline-variant);border-radius:.4rem;padding:.5rem .75rem;background:var(--color-surface-container-lowest);color:inherit}button{font-weight:700}button:disabled{opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}.item-transfer-body{padding:1rem;overflow:auto;overscroll-behavior:contain}.item-transfer-target{display:grid;gap:.5rem;font-size:.875rem;font-weight:700}.item-transfer-target select{width:100%}.item-transfer-list{margin-top:1rem}.item-transfer-line{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.85rem 0;border-bottom:1px solid var(--color-outline-variant)}.item-transfer-line>div:first-child{min-width:0;overflow-wrap:anywhere}.item-transfer-line strong{font-size:.9rem}.item-transfer-preview{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;padding:1rem;background:var(--color-surface-container-low);border:1px solid var(--color-outline-variant);border-radius:.5rem}.item-transfer-preview h3{font-weight:800}.item-transfer-preview p{font-size:.75rem;margin-top:.3rem}.item-transfer-preview .item-transfer-total{font-size:1rem;direction:ltr;text-align:start}.item-transfer-preview span{display:inline-block;direction:ltr}.item-transfer-error{margin-top:1rem;color:var(--color-error);font-size:.875rem}footer{border-bottom:0;border-top:1px solid var(--color-outline-variant)}.item-transfer-primary{background:var(--color-primary);color:var(--color-on-primary);border-color:var(--color-primary)}
@media(max-width:600px){.item-transfer-backdrop{padding:.5rem}.item-transfer-dialog{max-height:96dvh}.item-transfer-line{align-items:flex-start;flex-direction:column;gap:.6rem}.item-transfer-preview{gap:.5rem;padding:.75rem}header,footer,.item-transfer-body{padding:.75rem}header h2{font-size:1rem}}
</style>

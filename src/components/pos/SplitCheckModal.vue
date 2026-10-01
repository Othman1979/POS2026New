<template>
  <Transition name="pos-modal">
    <div v-if="showSplitModal" class="split-check-backdrop pos-modal-backdrop fixed inset-0 z-[100]">
      <section
        ref="dialog"
        class="split-check-dialog modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-check-title"
      >
        <header class="split-check-header modal-header">
          <div class="split-check-heading">
            <h2 id="split-check-title">{{ $t(splitEditContext ? 'Edit Split Checks' : 'Split Check') }}</h2>
            <p>{{ $t('Move only what should be paid separately. Everything else stays here.') }}</p>
          </div>
          <div class="split-check-header-actions">
            <span class="split-check-progress" aria-live="polite">
              <strong data-no-i18n>{{ itemQuantity(unassignedSplitItems) }}</strong>
              {{ $t('remaining') }}
            </span>
            <button type="button" class="split-check-close" :disabled="isProcessing" :aria-label="$t('Close')" @click="closeSplitModal">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </header>

        <nav class="split-seat-nav" :aria-label="$t('Destination Seats')">
          <span class="split-seat-nav-label">{{ $t('Assign to') }}</span>
          <div class="split-seat-list">
            <div
              v-for="seat in splitSeats"
              :key="seat.id"
              class="split-seat-entry"
            >
              <button
                type="button"
                class="split-seat-option"
                :disabled="isProcessing"
                :class="{ 'is-active': activeSplitSeat === seat.id }"
                :aria-pressed="activeSplitSeat === seat.id"
                @click="selectSeat(seat.id)"
                @dragover.prevent
                @drop="dropOnSeat($event, seat.id)"
              >
                <span>{{ checkName(seat) }}</span>
                <small data-no-i18n>{{ itemQuantity(seat.items) }} · {{ getSeatTotal(seat) }} JD</small>
              </button>
              <button
                v-if="splitSeats.length > 1 && seat.items.length === 0"
                type="button"
                class="split-seat-remove"
                :disabled="isProcessing"
                :aria-label="`${$t('Remove Check')} ${checkName(seat)}`"
                :title="$t('Remove Check')"
                @click="removeSplitSeat(seat.id)"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
            <button type="button" class="split-seat-add" :disabled="isProcessing" @click="addSeat">
              <i class="fa-solid fa-plus" aria-hidden="true"></i>
              <span>{{ $t('Add Check') }}</span>
            </button>
          </div>
        </nav>

        <div class="split-mobile-switch" role="group" :aria-label="$t('Split Check')">
          <button type="button" :class="{ 'is-active': mobileView === 'items' }" :aria-pressed="mobileView === 'items'" @click="mobileView = 'items'">
            {{ $t('Remaining Check') }} <span data-no-i18n>{{ itemQuantity(unassignedSplitItems) }}</span>
          </button>
          <button type="button" :class="{ 'is-active': mobileView === 'seat' }" :aria-pressed="mobileView === 'seat'" @click="mobileView = 'seat'">
            {{ activeSeat ? checkName(activeSeat) : $t('Bill Check') }} <span data-no-i18n>{{ itemQuantity(activeSeat?.items) }}</span>
          </button>
        </div>

        <div class="split-check-body modal-body">
          <section
            class="split-source-pane"
            :class="{ 'is-mobile-hidden': mobileView !== 'items' }"
            @dragover.prevent
          >
            <div class="split-pane-heading">
              <div>
                <h3>{{ $t('Remaining Check') }}</h3>
                <p>{{ $t('Move only what should be paid separately. Everything else stays here.') }}</p>
              </div>
              <span data-no-i18n>{{ itemQuantity(unassignedSplitItems) }}</span>
            </div>

            <div class="split-line-list">
              <article
                v-for="(item, index) in visibleUnassignedItems"
                :key="`unassigned-${item.cartId}`"
                class="split-line"
                :draggable="!isProcessing"
                @dragstart="handleDragStart($event, 'unassigned', null, item, index)"
              >
                <button type="button" class="split-line-main" :disabled="isProcessing || !selectionValid('remaining', item)" @click="assignItem(item, index)">
                  <span class="split-line-copy">
                    <strong :class="{ 'font-arabic': isArabic(item.name) }" data-no-i18n>{{ item.name }}</strong>
                    <small v-if="item.note" data-no-i18n>{{ item.note }}</small>
                    <small class="split-line-price" data-no-i18n>
                      <span>{{ quantity(item.qty) }}×</span>
                      <span>{{ money(getSplitItemTotal('unassigned', index)) }}</span>
                      <span v-if="isFractionalSplit(item)" class="split-line-price-original">{{ $t('Original price') }} {{ money(splitItemUnitGross(item)) }}</span>
                    </small>
                  </span>
                  <span class="split-line-action">
                    <b data-no-i18n>{{ quantity(selectedQuantity('remaining', item)) }}×</b>
                    <small>{{ $t('Move') }}</small>
                    <i class="fa-solid fa-arrow-right rtl:rotate-180" aria-hidden="true"></i>
                  </span>
                </button>
                <div class="split-quantity-controls">
                  <ItemQuantityInput :model-value="selectedQuantity('remaining', item)" @update:model-value="setQuantity('remaining', item, $event)" :max="item.qty" :label="`${$t('Quantity to move')}: ${item.name}`" :disabled="isProcessing" />
                  <details class="split-advanced">
                    <summary>{{ $t('Advanced fractions') }}</summary>
                    <div class="split-line-presets" role="group" :aria-label="$t('Split item')">
                      <button v-for="ways in [2, 3, 4]" :key="ways" type="button" :disabled="isProcessing || !canDivide(item, ways)" @click="divideItem(item, index, ways)" :aria-label="`${$t('Split item')} 1/${ways}`" data-no-i18n>1/{{ ways }}</button>
                    </div>
                  </details>
                </div>
              </article>

              <button v-if="visibleUnassignedItems.length < unassignedSplitItems.length" type="button" class="split-show-more" @click="sourceLimit += 40">{{ $t('Show more items') }}</button>

              <div v-if="unassignedSplitItems.length === 0" class="split-empty is-complete">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
                <strong>{{ $t('Remaining Check is empty') }}</strong>
                <p>{{ $t('All items have been moved to separate checks.') }}</p>
              </div>
            </div>
          </section>

          <section
            v-if="activeSeat"
            class="split-seat-pane"
            :class="{ 'is-mobile-hidden': mobileView !== 'seat' }"
            @dragover.prevent
            @drop="dropOnSeat($event, activeSeat.id)"
          >
            <div class="split-pane-heading split-seat-heading">
              <div>
                <h3>{{ checkName(activeSeat) }}</h3>
                <p>{{ $t('Choose a quantity to return to the Remaining Check.') }}</p>
              </div>
              <strong data-no-i18n>{{ getSeatTotal(activeSeat) }} JD</strong>
            </div>

            <div class="split-seat-lines">
              <article
                v-for="(item, index) in visibleSeatItems"
                :key="`seat-${activeSeat.id}-${item.cartId}`"
                class="split-seat-row"
                :draggable="!isProcessing"
                @dragstart="handleDragStart($event, 'seat', activeSeat.id, item, index)"
              >
                <button type="button" class="split-seat-line" :disabled="isProcessing || !selectionValid(activeSeat.id, item)" @click="returnItem(item, index)">
                <span class="split-line-copy">
                  <strong :class="{ 'font-arabic': isArabic(item.name) }" data-no-i18n>{{ item.name }}</strong>
                  <small v-if="item.note" data-no-i18n>{{ item.note }}</small>
                  <small class="split-line-price" data-no-i18n>
                    <span>{{ quantity(item.qty) }}×</span>
                    <span>{{ money(getSplitItemTotal(activeSeat.id, index)) }}</span>
                    <span v-if="isFractionalSplit(item)" class="split-line-price-original">{{ $t('Original price') }} {{ money(splitItemUnitGross(item)) }}</span>
                  </small>
                </span>
                <span class="split-line-action">
                  <b data-no-i18n>{{ quantity(selectedQuantity(activeSeat.id, item)) }}×</b>
                  <small>{{ $t('Return items') }}</small>
                  <i class="fa-solid fa-rotate-left rtl:rotate-180" aria-hidden="true"></i>
                </span>
                </button>
                <div class="split-quantity-controls">
                  <ItemQuantityInput :model-value="selectedQuantity(activeSeat.id, item)" @update:model-value="setQuantity(activeSeat.id, item, $event)" :max="item.qty" :label="`${$t('Quantity to return')}: ${item.name}`" :disabled="isProcessing" />
                </div>
              </article>
              <button v-if="visibleSeatItems.length < activeSeat.items.length" type="button" class="split-show-more" @click="seatLimit += 40">{{ $t('Show more items') }}</button>

              <div v-if="activeSeat.items.length === 0" class="split-empty">
                <i class="fa-solid fa-arrow-pointer" aria-hidden="true"></i>
                <strong>{{ $t('No items on this check') }}</strong>
                <p>{{ $t('Choose this check above, then move items from the Remaining Check.') }}</p>
              </div>
            </div>
          </section>
        </div>

        <footer class="split-check-footer modal-footer">
          <p>
            <span>{{ $t('Selected destination') }}</span>
            <strong>{{ activeSeat ? checkName(activeSeat) : $t('Bill Check') }}</strong>
          </p>
          <button type="button" class="split-finalize" :disabled="!canFinalize || isProcessing" @click="confirmSplit">
            <i v-if="isProcessing" class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
            <i v-else class="fa-solid fa-check" aria-hidden="true"></i>
            <span>{{ isProcessing ? $t('Saving...') : $t(splitEditContext ? 'Save Changes' : 'Finalize Splits') }}</span>
          </button>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useTables } from '@/pos/useTables.js';
import { useCart } from '@/pos/useCart.js';
import { isArabic } from '../../utils/orderNotesFormat.js';
import { lineGross } from '../../utils/posTotals.js';
import { t } from '@/shared/i18n.js';
import { quantityUnits, validQuantity } from '@/utils/itemQuantity.js';
import ItemQuantityInput from './ItemQuantityInput.vue';

const {
  showSplitModal,
  splitSeats,
  unassignedSplitItems,
  activeSplitSeat,
  splitEditContext,
  getSeatTotal,
  getSplitItemTotal,
  addSplitSeat,
  removeSplitSeat,
  splitItemFractionally,
  moveItemToSeat,
  moveItemToUnassigned,
  confirmSplit,
  handleDragStart,
  handleDropOnSeat,
  closeSplitModal,
} = useTables();
const { isProcessing, taxInclusivePricing } = useCart();

const dialog = ref(null);
const mobileView = ref('items');
const activeSeat = computed(() => splitSeats.value.find((seat) => seat.id === activeSplitSeat.value) || splitSeats.value[0] || null);
const hasDestinationItems = computed(() => splitSeats.value.some((seat) => seat.items.length > 0));
const canFinalize = computed(() => hasDestinationItems.value || (splitEditContext.value && unassignedSplitItems.value.length > 0));
const chosenQuantities = ref({}), sourceLimit = ref(40), seatLimit = ref(40);
const visibleUnassignedItems = computed(() => unassignedSplitItems.value.slice(0, sourceLimit.value));
const visibleSeatItems = computed(() => (activeSeat.value?.items || []).slice(0, seatLimit.value));
const selectionKey = (scope, item) => `${scope}:${item.cartId}`;
const selectedQuantity = (scope, item) => chosenQuantities.value[selectionKey(scope, item)] ?? String(Math.min(1, Number(item.qty)));
const setQuantity = (scope, item, value) => { chosenQuantities.value[selectionKey(scope, item)] = value; };
const selectionValid = (scope, item) => validQuantity(selectedQuantity(scope, item), item.qty, false);
function canDivide(item, ways) {
  const units = quantityUnits(item.qty), piece = Math.round(units / ways);
  return units !== null && piece > 0 && units - piece * (ways - 1) > 0;
}
function divideItem(item, index, ways) {
  if (isProcessing.value || !canDivide(item, ways)) return;
  delete chosenQuantities.value[selectionKey('remaining', item)];
  splitItemFractionally(index, ways);
}
watch(activeSplitSeat, () => { seatLimit.value = 40; });
let previouslyFocused = null;

function quantity(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
function money(value) { return `${Number(value || 0).toFixed(2)} JD`; }
function itemQuantity(items = []) { return quantity(items.reduce((sum, item) => sum + Number(item.qty || 0), 0)); }
function checkName(seat) { return `${t('Bill Check')} ${seat.id}`; }
function splitItemUnitGross(item) {
  return lineGross({ ...item, qty: 1, discountValue: 0 }, { taxInclusive: taxInclusivePricing.value });
}
function isFractionalSplit(item) { return Number(item?.qty) > 0 && Number(item.qty) < 1; }
function selectSeat(id) { activeSplitSeat.value = id; }
function addSeat() {
  addSplitSeat();
  const newest = splitSeats.value[splitSeats.value.length - 1];
  if (newest) activeSplitSeat.value = newest.id;
}
function assignItem(item, index) {
  if (!activeSeat.value || isProcessing.value || !selectionValid('remaining', item)) return;
  moveItemToSeat(item, index, activeSeat.value.id, selectedQuantity('remaining', item));
  delete chosenQuantities.value[selectionKey('remaining', item)];
}
function returnItem(item, index) {
  if (!activeSeat.value || isProcessing.value || !selectionValid(activeSeat.value.id, item)) return;
  moveItemToUnassigned(activeSeat.value.id, item, index, selectedQuantity(activeSeat.value.id, item));
  delete chosenQuantities.value[selectionKey(activeSeat.value.id, item)];
}
function dropOnSeat(event, seatId) { if (!isProcessing.value) { activeSplitSeat.value = seatId; handleDropOnSeat(event, seatId); } }

function onKeydown(event) {
  if (!showSplitModal.value) return;
  if (event.key === 'Escape') { if (!isProcessing.value) closeSplitModal(); return; }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = [...dialog.value.querySelectorAll('button:not(:disabled), summary, [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

watch(showSplitModal, async (open) => {
  chosenQuantities.value = {}; sourceLimit.value = 40; seatLimit.value = 40;
  if (open) {
    mobileView.value = 'items';
    previouslyFocused = document.activeElement;
    await nextTick();
    dialog.value?.querySelector('.split-check-close')?.focus();
  } else previouslyFocused?.focus?.();
}, { immediate: true });
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
.split-check-backdrop{display:flex;align-items:center;justify-content:center;padding:1rem;background:rgb(17 24 39 / 72%)}
.split-check-dialog{display:flex;width:min(72rem,100%);height:min(90dvh,50rem);min-height:34rem;overflow:hidden;flex-direction:column;border:1px solid var(--color-outline-variant);border-radius:.75rem;background:var(--color-surface-container-lowest);color:var(--color-on-surface)}
.split-check-header{display:flex;min-height:4.25rem;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--color-outline-variant);background:var(--color-surface-container-lowest);padding:.75rem 1rem}
.split-check-heading{min-width:0}.split-check-heading h2{font-size:1rem;font-weight:800;line-height:1.3}.split-check-heading p{margin-top:.18rem;color:var(--color-on-surface-variant);font-size:.75rem;line-height:1.4}
.split-check-header-actions{display:flex;align-items:center;gap:.65rem}.split-check-progress{display:flex;align-items:baseline;gap:.3rem;color:var(--color-on-surface-variant);font-size:.75rem}.split-check-progress strong{color:var(--color-on-surface);font-size:.875rem}.split-check-close{display:grid;width:2.75rem;height:2.75rem;place-items:center;border-radius:.5rem;color:var(--color-on-surface-variant)}.split-check-close:hover{background:var(--color-surface-container-low)}
.split-seat-nav{display:flex;min-height:4.75rem;align-items:center;gap:.75rem;border-bottom:1px solid var(--color-outline-variant);background:var(--color-surface-container-low);padding:.65rem 1rem}.split-seat-nav-label{flex:none;color:var(--color-on-surface-variant);font-size:.75rem;font-weight:750}.split-seat-list{display:flex;min-width:0;flex:1;gap:.5rem;overflow-x:auto;overscroll-behavior-inline:contain;padding:.1rem;touch-action:pan-x}.split-seat-entry{display:flex;flex:none;align-items:stretch;gap:.25rem}.split-seat-option,.split-seat-add,.split-seat-remove{display:flex;min-height:3rem;flex:none;align-items:center;justify-content:center;border:1px solid var(--color-outline-variant);border-radius:.5rem;background:var(--color-surface-container-lowest);color:var(--color-on-surface);font-size:.875rem;font-weight:750}.split-seat-option{min-width:7rem;flex-direction:column;align-items:flex-start;padding:.45rem .75rem}.split-seat-option small{margin-top:.1rem;color:var(--color-on-surface-variant);font-size:.75rem;font-weight:650}.split-seat-option.is-active{border-color:var(--color-primary);background:var(--color-primary-fixed);color:var(--color-on-primary-fixed-variant)}.split-seat-option.is-active small{color:var(--color-on-primary-fixed-variant)}.split-seat-add{gap:.4rem;border-style:dashed;padding:.45rem .75rem;color:var(--color-primary)}.split-seat-remove{width:2.75rem;color:var(--color-on-surface-variant)}.split-seat-remove:hover{background:color-mix(in srgb,var(--color-error) 10%,transparent);color:var(--color-error)}
.split-mobile-switch{display:none}.split-check-body{display:grid;min-height:0;flex:1;grid-template-columns:minmax(18rem,.85fr) minmax(0,1.4fr);padding:0!important}.split-source-pane,.split-seat-pane{display:flex;min-width:0;min-height:0;flex-direction:column}.split-source-pane{border-inline-end:1px solid var(--color-outline-variant);background:var(--color-surface-container-low)}.split-seat-pane{background:var(--color-surface-container-lowest)}
.split-pane-heading{display:flex;min-height:4.25rem;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--color-outline-variant);padding:.75rem 1rem;background:var(--color-surface-container-lowest)}.split-pane-heading h3{font-size:1rem;font-weight:800}.split-pane-heading p{margin-top:.2rem;color:var(--color-on-surface-variant);font-size:.75rem;line-height:1.35}.split-pane-heading>span{display:grid;min-width:1.8rem;height:1.8rem;place-items:center;border-radius:999px;background:var(--color-surface-container-high);font-size:.75rem;font-weight:800}.split-seat-heading>strong{flex:none;font-size:1rem;font-variant-numeric:tabular-nums}
.split-line-list,.split-seat-lines{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain}.split-line-list{padding:.6rem}.split-seat-lines{padding:.75rem}.split-line{display:flex;flex-direction:column;overflow:hidden;align-items:stretch;border-bottom:1px solid var(--color-outline-variant);background:var(--color-surface-container-lowest)}.split-line:first-child{border-start-start-radius:.5rem;border-start-end-radius:.5rem}.split-line:last-child{border-end-start-radius:.5rem;border-end-end-radius:.5rem;border-bottom:0}.split-line-main,.split-seat-line{display:flex;width:100%;min-height:3.8rem;align-items:center;justify-content:space-between;gap:.75rem;padding:.65rem .75rem;text-align:start}.split-line-main{width:auto;min-width:0;flex:1}.split-line-main:hover,.split-seat-line:hover{background:var(--color-primary-fixed)}.split-line-copy{min-width:0}.split-line-copy strong{display:block;overflow:hidden;font-size:.875rem;font-weight:750;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.split-line-copy small{display:block;margin-top:.2rem;color:var(--color-on-surface-variant);font-size:.75rem;font-variant-numeric:tabular-nums}.split-line-price{display:flex!important;align-items:baseline;flex-wrap:wrap;gap:.15rem .35rem}.split-line-price>span:first-child{color:var(--color-on-surface);font-weight:800}.split-line-price-original{font-weight:500}.split-line-action{display:flex;flex:none;align-items:center;gap:.65rem}.split-line-action b{font-size:.75rem;font-variant-numeric:tabular-nums}.split-line-action i{color:var(--color-primary);font-size:.75rem}.split-line-presets{display:flex;align-items:center;gap:.25rem;padding:.25rem 0}.split-line-presets button{min-width:2.75rem;min-height:2.75rem;border-radius:.375rem;color:var(--color-on-surface-variant);font-size:.75rem;font-weight:750;font-variant-numeric:tabular-nums}.split-line-presets button:hover{background:var(--color-surface-container-high);color:var(--color-on-surface)}
.split-seat-row{margin-bottom:.5rem;border:1px solid var(--color-outline-variant);border-radius:.5rem;overflow:hidden;background:var(--color-surface-container-low)}.split-seat-line{border:0;background:transparent}.split-seat-line:hover .split-line-action i{color:var(--color-error)}.split-empty{display:flex;min-height:12rem;align-items:center;justify-content:center;flex-direction:column;padding:1.5rem;text-align:center;color:var(--color-on-surface-variant)}.split-empty i{display:grid;width:2.75rem;height:2.75rem;place-items:center;border-radius:999px;background:var(--color-surface-container-high);color:var(--color-on-surface-variant)}.split-empty strong{margin-top:.75rem;color:var(--color-on-surface);font-size:.85rem}.split-empty p{max-width:28rem;margin-top:.3rem;font-size:.75rem;line-height:1.5}.split-empty.is-complete i{background:var(--color-primary-fixed);color:var(--color-primary)}
.split-check-footer{display:flex;min-height:4.5rem;align-items:center;justify-content:space-between;gap:1rem;border-top:1px solid var(--color-outline-variant);background:var(--color-surface-container-low);padding:.65rem 1rem}.split-check-footer p{display:flex;flex-direction:column;color:var(--color-on-surface-variant);font-size:.75rem}.split-check-footer p strong{margin-top:.1rem;color:var(--color-on-surface);font-size:.875rem}.split-finalize{display:flex;min-width:13rem;min-height:3rem;align-items:center;justify-content:center;gap:.5rem;border-radius:.5rem;background:var(--color-primary);padding:.65rem 1.1rem;color:var(--color-on-primary);font-size:.75rem;font-weight:800}.split-finalize:hover:not(:disabled){background:var(--color-primary-container)}.split-finalize:disabled{cursor:not-allowed;opacity:.45}
.split-check-dialog button:focus-visible{outline:3px solid color-mix(in srgb,var(--color-primary) 28%,transparent);outline-offset:2px}
.split-line-action small{color:var(--color-primary);font-size:.7rem;font-weight:750}
.split-quantity-controls{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:.5rem;padding:0 .75rem .65rem}
.split-advanced summary{display:flex;min-height:2.75rem;align-items:center;gap:.35rem;cursor:pointer;color:var(--color-on-surface-variant);font-size:.75rem;font-weight:700}
.split-advanced summary::before{content:"+";font-size:1rem}.split-advanced[open] summary::before{content:"−"}
.split-advanced summary:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.split-show-more{min-height:2.75rem;width:100%;margin-top:.5rem;border:1px solid var(--color-outline-variant);border-radius:.5rem;color:var(--color-primary);font-size:.875rem;font-weight:700}
.split-check-dialog button:disabled{opacity:.45;cursor:not-allowed}
@media(max-width:767px){
  .split-check-backdrop{padding:0}
  .split-check-dialog{width:100vw;height:100dvh;min-height:0;border:0;border-radius:0}
  .split-check-header{min-height:3.9rem;padding:.55rem .75rem}
  .split-check-heading h2{font-size:1rem}
  .split-check-heading p{display:none}
  .split-check-progress{font-size:.875rem}
  .split-seat-nav{min-height:4.4rem;align-items:flex-start;flex-direction:column;gap:.35rem;padding:.45rem .65rem}
  .split-seat-nav-label{font-size:.75rem}
  .split-seat-list{width:100%}
  .split-seat-option,.split-seat-add,.split-seat-remove{min-height:2.75rem;font-size:.875rem}
  .split-seat-option{min-width:7.5rem}
  .split-seat-option small{font-size:.75rem}
  .split-mobile-switch{display:grid;grid-template-columns:1fr 1fr;gap:.25rem;border-bottom:1px solid var(--color-outline-variant);background:var(--color-surface-container-low);padding:.35rem .65rem}
  .split-mobile-switch button{min-height:2.75rem;border-radius:.5rem;color:var(--color-on-surface-variant);font-size:.875rem;font-weight:750}
  .split-mobile-switch button span{margin-inline-start:.25rem}
  .split-mobile-switch button.is-active{background:var(--color-surface-container-lowest);color:var(--color-primary);box-shadow:0 1px 2px rgb(17 24 39 / 12%)}
  .split-check-body{display:block;overflow:hidden}
  .split-source-pane,.split-seat-pane{height:100%;border:0}
  .split-source-pane.is-mobile-hidden,.split-seat-pane.is-mobile-hidden{display:none}
  .split-pane-heading{min-height:3.7rem;padding:.55rem .75rem}
  .split-pane-heading h3{font-size:1rem}
  .split-pane-heading p{font-size:.75rem}
  .split-line-list,.split-seat-lines{padding:.45rem .55rem}
  .split-line-main,.split-seat-line{min-height:3.75rem;padding:.6rem .7rem}
  .split-line-copy strong{font-size:.875rem}
  .split-line-copy small,.split-line-action b,.split-line-presets button{font-size:.75rem}
  .split-line-presets button{min-width:2.75rem;min-height:2.75rem}
  .split-check-footer{min-height:4.25rem;padding:.5rem .65rem}
  .split-check-footer p{display:none}
  .split-finalize{width:100%;min-width:0;min-height:3.1rem;font-size:.875rem}
}
@media(max-width:767px){.split-check-dialog{border-radius:0!important;box-shadow:none!important}}
@media(max-width:350px){.split-check-progress{display:none}.split-seat-option{min-width:6.8rem}.split-seat-add span{display:none}.split-seat-add{width:2.75rem;padding:0}.split-pane-heading p{max-width:15rem}.split-line-main{gap:.4rem;padding-inline:.55rem}.split-line-action{gap:.35rem}.split-line-presets{gap:.1rem;padding:.2rem}.split-line-presets button{min-width:2.6rem}}
@media(prefers-reduced-motion:reduce){.split-check-dialog *{scroll-behavior:auto!important;transition-duration:.01ms!important}}
</style>

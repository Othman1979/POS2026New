<template>
  <div :class="['order-notes-page h-[100dvh] w-full overflow-hidden no-select flex flex-col', { 'pos-theme-dark': isPosDark }]">
    <header class="notes-header">
      <button type="button" class="notes-icon-action" :aria-label="$t('Back')" @click="goBack">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
      </button>

      <div class="notes-heading">
        <span class="notes-heading__icon" aria-hidden="true">
          <i class="fa-solid fa-receipt"></i>
        </span>
        <div class="min-w-0">
          <h1>{{ $t('Order Notes') }}</h1>
          <p>{{ showHistory ? $t('History') : $t('Suspended') }}</p>
        </div>
      </div>

      <div class="notes-header__spacer"></div>

      <label class="notes-search notes-search--desktop">
        <span class="sr-only">{{ $t('Search invoice, queue...') }}</span>
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input v-model="searchQuery" type="search" :placeholder="$t('Search invoice, queue...')" />
        <button v-if="searchQuery" type="button" :aria-label="$t('Clear')" @click="searchQuery = ''">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </label>

      <button type="button" class="notes-icon-action notes-mobile-search-trigger"
        :class="{ 'notes-icon-action--active': searchOpen }"
        :aria-label="$t('Search invoice, queue...')" :aria-expanded="searchOpen"
        @click="searchOpen = !searchOpen">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      </button>

      <div v-if="canViewHeldOrders && canViewHistory" class="notes-mode" role="group" :aria-label="$t('Order History')">
        <button type="button" :class="{ 'notes-mode__button--active': !showHistory }"
          :aria-pressed="!showHistory" @click="showHistory = false">
          {{ $t('Suspended') }}
        </button>
        <button type="button" :class="{ 'notes-mode__button--active': showHistory }"
          :aria-pressed="showHistory" @click="showHistory = true">
          {{ $t('History') }}
        </button>
      </div>

      <Transition name="notes-search">
        <div v-if="searchOpen" class="notes-mobile-search">
          <label class="notes-search">
            <span class="sr-only">{{ $t('Search invoice, queue...') }}</span>
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input v-model="searchQuery" type="search" :placeholder="$t('Search invoice, queue...')" />
            <button v-if="searchQuery" type="button" :aria-label="$t('Clear')" @click="searchQuery = ''">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </label>
        </div>
      </Transition>
    </header>

    <div v-if="loadError" class="notes-load-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="fetchOrders">{{ $t('Retry') }}</button>
    </div>

    <div class="notes-source-filter" role="group" :aria-label="$t('All sources')">
      <button v-for="option in sourceFilterOptions" :key="option.value" type="button"
        :class="{ 'notes-source-filter__button--active': sourceFilter === option.value }"
        :aria-pressed="sourceFilter === option.value" @click="sourceFilter = option.value">
        <i :class="option.icon" aria-hidden="true"></i>
        {{ $t(option.label) }}
      </button>
    </div>

    <div v-if="isMobile" class="notes-type-strip premium-scroll" :aria-label="$t('Order Type')">
      <button type="button" class="notes-type-filter"
        :class="{ 'notes-type-filter--active': activeChip === 'All' }"
        :aria-pressed="activeChip === 'All'" @click="activeChip = 'All'">
        <span>{{ $t('All') }}</span>
        <b data-no-i18n>{{ totalCardCount }}</b>
      </button>
      <button v-for="colName in orderTypeColumns" :key="colName" type="button"
        class="notes-type-filter" :class="{ 'notes-type-filter--active': activeChip === colName }"
        :aria-pressed="activeChip === colName" @click="activeChip = colName">
        <i class="notes-type-dot" :class="getTypeAccent(colName).dot" aria-hidden="true"></i>
        <span data-no-i18n>{{ colName }}</span>
        <b data-no-i18n>{{ (groupedOrders[colName] || []).length }}</b>
      </button>
    </div>

    <div v-if="isMobile && mobilePlatformLane" class="notes-platform-mobile">
      <div>
        <strong data-no-i18n>{{ mobilePlatformLane.type.name }}</strong>
        <span data-no-i18n>{{ mobilePlatformLane.summary.count }} {{ $t('orders') }} · {{ mobilePlatformLane.summary.total.toFixed(2) }} JD</span>
      </div>
      <button type="button" :disabled="platformSettlementTypeId !== null"
        @click="settlePlatformLane(mobilePlatformLane.type.name)">
        <i class="fa-solid fa-receipt" aria-hidden="true"></i>
        {{ $t('Close & print') }}
      </button>
    </div>

    <div v-if="metadataLoading || (isLoading && filteredOrders.length === 0)" class="notes-loading" aria-busy="true">
      <p>{{ $t('Loading Orders...') }}</p>
      <div class="notes-loading__grid" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="notes-loading__lane">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>

    <div v-else-if="loadError && filteredOrders.length === 0" class="flex-1"></div>
    <main v-else-if="!isMobile" class="notes-board premium-scroll">
      <section v-for="colName in orderTypeColumns" :key="colName" class="order-lane"
        :aria-label="colName">
        <div class="order-lane__header">
          <div>
            <i class="notes-type-dot" :class="getTypeAccent(colName).dot" aria-hidden="true"></i>
            <h2 data-no-i18n>{{ colName }}</h2>
          </div>
          <div class="flex items-center gap-2">
            <button v-if="platformLaneType(colName) && (groupedOrders[colName] || []).some(order => order.isHeld)"
              type="button" class="notes-platform-close"
              :disabled="platformSettlementTypeId !== null"
              @click="settlePlatformLane(colName)">
              <i class="fa-solid fa-receipt" aria-hidden="true"></i>
              <span>{{ $t('Close & print') }}</span>
              <strong data-no-i18n>
                {{ platformLaneSummary(colName).count }} · {{ platformLaneSummary(colName).total.toFixed(2) }} JD
              </strong>
            </button>
            <b class="notes-lane-count" data-no-i18n>{{ (groupedOrders[colName] || []).length }}</b>
          </div>
        </div>
        <div class="order-lane__body premium-scroll">
          <div v-if="(groupedOrders[colName] || []).length === 0" class="notes-empty">
            {{ showHistory ? $t('No orders found') : $t('No suspended orders') }}
          </div>
          <OrderNoteCard v-for="order in groupedOrders[colName]" :key="order.invoice_id"
            :order="order" :firing-kitchen="kitchenFiring(order.id)" :claim-clock="claimClock" :restore-resumable="Number(order.id) === resumableHeldOrderId" :can-reprint="canReprint"
            @open="openPreviewModal" @fire="fireToKitchen" @restore="restoreHeldOrder" @cancel="cancelHeldOrder" @reprint="reprintDirect" />
        </div>
      </section>
    </main>

    <main v-else class="notes-phone-list premium-scroll">
      <div v-if="phoneCards.length === 0" class="notes-empty notes-empty--page">
        {{ showHistory ? $t('No orders found') : $t('No suspended orders') }}
      </div>
      <OrderNoteCard v-for="order in phoneCards" :key="order.invoice_id"
        :order="order" :firing-kitchen="kitchenFiring(order.id)" :claim-clock="claimClock" :restore-resumable="Number(order.id) === resumableHeldOrderId" :can-reprint="canReprint"
         @open="openPreviewModal" @fire="fireToKitchen" @restore="restoreHeldOrder" @cancel="cancelHeldOrder" @reprint="reprintDirect" />
    </main>

    <!-- ============ RECEIPT PREVIEW MODAL ============ -->
    <div v-if="showPreviewModal" class="notes-modal-backdrop">
      <div ref="previewDialog" class="notes-dialog" role="dialog" aria-modal="true" aria-labelledby="order-preview-title" tabindex="-1">
        <div class="notes-dialog__header">
          <div>
            <span class="notes-type-dot" :class="getTypeAccent(selectedOrder?.order_type_name || 'Unspecified').dot" aria-hidden="true"></span>
            <h3 id="order-preview-title">{{ $t('Order Details') }}</h3>
          </div>
          <button type="button" :aria-label="$t('Close')" @click="showPreviewModal = false">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>

        <div v-if="selectedOrder" class="notes-dialog__body premium-scroll">
          <div class="notes-receipt">
            <div class="notes-receipt-store">
              <h4 data-no-i18n>{{ storeName }}</h4>
              <p v-if="storeAddress" data-no-i18n>{{ storeAddress }}</p>
              <p v-if="storePhone" data-no-i18n>{{ storePhone }}</p>
            </div>

            <dl class="notes-receipt-meta">
              <div>
                <dt>{{ orderIdentityTitle(selectedOrder, $t || ((v) => v)) }}</dt>
                <dd class="notes-receipt-meta__strong" data-no-i18n>{{ orderIdentityLabel(selectedOrder, $t || ((v) => v)) }}</dd>
              </div>
              <div v-if="selectedOrder.order_id">
                <dt>{{ $t('Queue ID') }}</dt>
                <dd data-no-i18n>{{ $t('Order') }} {{ selectedOrder.order_display_no || selectedOrder.order_id }}</dd>
              </div>
              <div v-if="selectedOrder.table_number">
                <dt>{{ $t('Table') }}</dt>
                <dd data-no-i18n>#{{ selectedOrder.table_number }}</dd>
              </div>
              <div v-if="!selectedOrder.isHeld || !selectedOrder.call_center_user_id">
                <dt>{{ $t('Cashier') }}</dt>
                <dd data-no-i18n>{{ selectedOrder.cashier_name }}</dd>
              </div>
              <div v-if="selectedOrder.call_center_user_id">
                <dt>{{ $t('Original call-center worker') }}</dt>
                <dd data-no-i18n>{{ selectedOrder.call_center_user_name }}</dd>
              </div>
              <div v-if="selectedOrder.isHeld && selectedOrder.call_center_user_id">
                <dt>{{ $t('Kitchen') }}</dt>
                <dd>
                  {{ $t(selectedOrder.raw_held_data?.kitchen_fired ? 'Kitchen sent' : 'Not sent') }}
                  <template v-if="Number(selectedOrder.raw_held_data?.kitchen_dispatch_version) > 1">
                    · {{ $t('FOLLOW UP') }} #{{ Number(selectedOrder.raw_held_data.kitchen_dispatch_version) - 1 }}
                  </template>
                </dd>
              </div>
              <div v-if="selectedOrder.isHeld && selectedOrder.call_center_user_id && heldClaimIsActive(selectedOrder)">
                <dt>{{ $t('Being edited') }}</dt>
                <dd data-no-i18n>{{ selectedOrder.raw_held_data?.claim_owner_name }}</dd>
              </div>
              <div>
                <dt>{{ $t('Order Type') }}</dt>
                <dd data-no-i18n>{{ selectedOrder.order_type_name || $t('Unspecified') }}</dd>
              </div>
              <div>
                <dt>{{ $t('Date') }}</dt>
                <dd class="notes-num">{{ formatDateTime(selectedOrder.created_at) }}</dd>
              </div>
              <div v-if="!selectedOrder.isHeld && selectedOrder.payment_method">
                <dt>{{ $t('Payment Method') }}</dt>
                <dd>{{ $t(selectedOrder.payment_method) }}</dd>
              </div>
            </dl>

            <div v-if="selectedPresentation.error" class="notes-receipt-alert notes-receipt-alert--error" role="alert">
              <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
              <div>
                <strong>{{ $t('Receipt Data Invalid') }}</strong>
                <p>{{ $t('The layout integrity checks failed for this order. It cannot be previewed, printed, or restored.') }}</p>
              </div>
            </div>

            <div v-if="selectedOrder.receipt_display_legacy_reason === 'PRE_V1_CENT_MISMATCH' && !selectedPresentation.error" class="notes-receipt-alert notes-receipt-alert--legacy">
              <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
              <div>
                <strong>{{ $t('Historical Format') }}</strong>
                <p>{{ $t('This order was generated prior to the modern receipt layout. It is displayed using historical approximations.') }}</p>
              </div>
            </div>

            <table v-if="!selectedPresentation.error && selectedPresentation.presentation" class="notes-receipt-items">
              <thead>
                <tr>
                  <th>{{ $t('Item') }}</th>
                  <th class="notes-receipt-items__qty">{{ $t('Qty') }}</th>
                  <th class="notes-receipt-items__money">{{ $t('Price') }}</th>
                  <th class="notes-receipt-items__money">{{ $t('Total') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in selectedPresentation.presentation.rows" :key="item.key"
                  :class="{ 'notes-receipt-items__child': item.kind === 'bundle_child' }">
                  <td>
                    <span v-if="item.kind === 'bundle_child'" class="notes-receipt-items__child-name" data-no-i18n>- {{ item.name }}</span>
                    <span v-else class="notes-receipt-items__name" :class="[{ 'font-arabic': isArabic(item.name) }]" data-no-i18n>{{ item.name }}</span>
                    <span v-if="item.note" class="notes-receipt-items__note" data-no-i18n>- {{ item.note }}</span>
                    <span v-if="item.lineDiscountAmount > 0 && item.lineDiscountLabel" class="notes-receipt-items__discount">
                      <span data-no-i18n>{{ item.lineDiscountLabel }}</span> {{ $t('Discount') }}
                      <span data-no-i18n>(-{{ item.lineDiscountAmount.toFixed(2) }} JD)</span>
                    </span>
                  </td>
                  <td class="notes-receipt-items__qty notes-num">
                    <span v-if="item.kind !== 'bundle_child'">{{ getQtyFormatted(item.qty) }}</span>
                  </td>
                  <td class="notes-receipt-items__money notes-num" data-no-i18n>
                    <span v-if="item.kind !== 'bundle_child'">{{ item.unitPrice.toFixed(2) }}</span>
                  </td>
                  <td class="notes-receipt-items__money notes-receipt-items__net notes-num" data-no-i18n>
                    <span v-if="item.kind !== 'bundle_child'">{{ item.netAmount.toFixed(2) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div v-if="!selectedPresentation.error && selectedPresentation.presentation" class="notes-receipt-sums">
              <div v-if="selectedPresentation.presentation.taxMode !== 'inclusive'">
                <span>{{ $t('Subtotal') }}</span>
                <span class="notes-num" data-no-i18n>{{ selectedPresentation.presentation.summary.subtotal.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.summary.orderDiscountAmount > 0" class="notes-receipt-sums__discount">
                <span>{{ $t('Discount') }}<template v-if="selectedPresentation.presentation.summary.orderDiscountLabel"> (<span data-no-i18n>{{ selectedPresentation.presentation.summary.orderDiscountLabel }}</span>)</template></span>
                <span class="notes-num" data-no-i18n>-{{ selectedPresentation.presentation.summary.orderDiscountAmount.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.taxMode !== 'inclusive'">
                <span>{{ $t('Tax') }}</span>
                <span v-if="selectedPresentation.presentation.summary.taxLabel">{{ $t(selectedPresentation.presentation.summary.taxLabel) }}</span>
                <span v-else class="notes-num" data-no-i18n>{{ selectedPresentation.presentation.summary.taxAmount.toFixed(2) }}</span>
              </div>
              <div v-if="selectedPresentation.presentation.summary.roundingAdjustment !== 0">
                <span>{{ $t('Rounding') }}</span>
                <span class="notes-num" data-no-i18n>{{ selectedPresentation.presentation.summary.roundingAdjustment > 0 ? '+' : '' }}{{ selectedPresentation.presentation.summary.roundingAdjustment.toFixed(2) }}</span>
              </div>
              <div class="notes-receipt-total">
                <span>
                  {{ $t('Total') }}
                  <small v-if="selectedPresentation.presentation.taxMode === 'inclusive'">· {{ $t('incl. tax') }}</small>
                </span>
                <strong class="notes-num" data-no-i18n>{{ selectedPresentation.presentation.summary.total.toFixed(2) }}<small>JD</small></strong>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="notes-dialog__footer">
          <button type="button" class="notes-dialog-action notes-dialog-action--secondary" @click="showPreviewModal = false">
            {{ $t('Close') }}
          </button>

          <template v-if="selectedOrder?.isHeld">
            <button type="button" class="notes-dialog-action notes-dialog-action--kitchen"
              :disabled="heldClaimIsActive(selectedOrder) || selectedOrder.raw_held_data?.kitchen_fired || kitchenFiring(selectedOrder.id) || !!selectedPresentation.error"
              @click="fireToKitchen(selectedOrder)">
              <i :class="kitchenFiring(selectedOrder.id) ? 'fa-solid fa-spinner fa-spin' : (selectedOrder.raw_held_data?.kitchen_fired ? 'fa-solid fa-check' : 'fa-solid fa-fire')" aria-hidden="true"></i>
              {{ selectedOrder.raw_held_data?.kitchen_fired ? $t('Kitchen sent') : $t('Kitchen') }}
            </button>
            <button type="button" class="notes-dialog-action notes-dialog-action--primary"
              :disabled="heldRestoreBlocked(selectedOrder) || !!selectedPresentation.error"
              @click="restoreHeldOrder(selectedOrder); showPreviewModal = false">
              <i class="fa-solid fa-file-import" aria-hidden="true"></i>
              {{ $t('Restore') }}
            </button>
          </template>

          <button v-if="selectedOrder?.isHeld || canReprint" type="button" class="notes-dialog-action notes-dialog-action--primary"
            :disabled="!!selectedPresentation.error" @click="reprintDirect(selectedOrder)">
            <i class="fa-solid fa-print" aria-hidden="true"></i>
            {{ $t(selectedOrder?.isHeld ? 'Print Receipt' : 'Reprint') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { printHeldCustomerReceipt } from '@/utils/heldReceiptPrint.js';
import { fetchJsonResponseWithTimeout, fetchReadJsonResponse, isUnansweredRequest } from '@/shared/http.js';
import { createRequestId } from '@/shared/requestId.js';
import { ref, shallowRef, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { orderIdentityLabel, orderIdentityTitle } from '../utils/orderIdentityDisplay.js';
import OrderNoteCard from './OrderNoteCard.vue';
import { getTypeAccent } from '../utils/orderTypeAccent.js';
import {
  buildOrderTypeBoard,
  mergedCardsByTime,
  filterOrdersBySource,
  platformSettlementSummary,
  printSettledReceipts,
} from '../utils/orderNotesBoard.js';
import { heldOrderTotal } from '../utils/orderNotesTax.js';
import { formatDateTime, getQtyFormatted, isArabic } from '../utils/orderNotesFormat.js';
import { resolveReceiptPresentation } from '../utils/receiptPresentation.js';
import { useRouter } from 'vue-router';
import { usePermissions } from '@/pos/usePermissions.js';
import { useSocket } from '@/pos/useSocket.js';
import { useCart } from '@/pos/useCart.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';
import { useTables } from '@/pos/useTables.js';
import { useTerminal } from '@/pos/useTerminal.js';
import {
  clearHeldOperationId,
  clearHeldOrderHandoff,
  clearTablePrefill,
  getHeldOperationId,
  readHeldOrderHandoff,
  setHeldKitchenFired,
  storeHeldOrderHandoff,
} from '@/pos/posSessionStorage.js';
import { t } from '@/shared/i18n.js';

const router = useRouter();
const isPosDark = localStorage.getItem('pos_theme') === 'dark';
const { can } = usePermissions();
const cartStore = useCart();
const tablesStore = useTables();

const canViewHeldOrders = computed(() => can('pos.hold_orders'));
const canViewHistory = computed(() => can('orders.view'));
const canReprint = computed(() => can('pos.reprint_receipt'));

const isLoading = ref(true);
const metadataLoading = ref(true);
const loadError = ref('');
// Read-only server snapshots are replaced after refresh, never edited in place.
const orders = shallowRef([]);
const orderTypesList = shallowRef([]);
const searchQuery = ref('');
const sourceFilter = ref('all');
const sourceFilterOptions = [
  { value: 'all', label: 'All sources', icon: 'fa-solid fa-layer-group' },
  { value: 'phone', label: 'Phone orders', icon: 'fa-solid fa-headset' },
  { value: 'other', label: 'Other orders', icon: 'fa-solid fa-cash-register' },
];
const showPreviewModal = ref(false);
const previewDialog = ref(null);
usePosDialogFocus({ open: showPreviewModal, dialog: previewDialog, onEscape: () => { showPreviewModal.value = false; } });
const selectedOrder = ref(null);
const showHistory = ref(canViewHistory.value && !canViewHeldOrders.value);
const heldOrdersList = shallowRef([]);

// Leases expire on the server silently. One one-shot timer bumps this clock at the
// earliest future expiry so claim bindings re-render; no polling.
const claimClock = ref(Date.now());
let claimExpiryTimer = null;
const armClaimExpiry = () => {
  clearTimeout(claimExpiryTimer);
  claimExpiryTimer = null;
  const now = Date.now();
  claimClock.value = now;
  let next = Infinity;
  for (const row of heldOrdersList.value) {
    const at = row?.claimed_by_user_id && row.claim_expires_at ? new Date(row.claim_expires_at).getTime() : NaN;
    if (at > now && at < next) next = at;
  }
  if (next !== Infinity && !disposed) claimExpiryTimer = setTimeout(armClaimExpiry, Math.min(next - now + 50, 2 ** 31 - 1));
};
watch(heldOrdersList, armClaimExpiry);

const heldClaimIsActive = (order) => {
  void claimClock.value;
  const expiresAt = order?.raw_held_data?.claim_expires_at;
  return Boolean(order?.raw_held_data?.claimed_by_user_id && expiresAt && new Date(expiresAt).getTime() > Date.now());
};

// --- Presentational state for the responsive board ---
const isMobile = ref(false);
const activeChip = ref('All');
const searchOpen = ref(false);
let mediaQuery = null;
const applyIsMobile = (e) => { isMobile.value = e.matches; };

const totalCardCount = computed(() => filteredOrders.value.length);
const phoneCards = computed(() => {
  if (activeChip.value === 'All' || !orderTypeColumns.value.includes(activeChip.value)) {
    return mergedCardsByTime(groupedOrders.value, orderTypeColumns.value);
  }
  return groupedOrders.value[activeChip.value] || [];
});

// Store info only fills the preview header, so it never gates the board.
const terminal = useTerminal();
const { storeName, storeAddress, storePhone } = terminal;
const { socket, initSocket } = useSocket();

const goBack = () => {
  router.push('/pos');
};

let disposed = false;
const lifetimeController = new AbortController();
let ordersRead = null;
let queuedOrdersRead = null;
let ordersReadVersion = 0;
let ordersController = null;
let heldSnapshotSerial = 0;

const cancelOrdersRead = () => {
  ordersReadVersion += 1;
  ordersController?.abort();
  ordersController = null;
  ordersRead = null;
  queuedOrdersRead = null;
};

const fetchOrders = () => {
  if (disposed) return Promise.resolve();
  const version = ordersReadVersion;
  if (ordersRead) {
    if (!queuedOrdersRead) {
      queuedOrdersRead = ordersRead.then(() => {
        if (disposed || version !== ordersReadVersion) return;
        queuedOrdersRead = null;
        return fetchOrders();
      });
    }
    return queuedOrdersRead;
  }
  isLoading.value = true;
  loadError.value = '';
  const controller = new AbortController();
  ordersController = controller;
  const ownsRead = () => !disposed && version === ordersReadVersion;
  const [allowed, url, field, target] = showHistory.value
    ? [canViewHistory.value, 'api/pos/order_notes?limit=200', 'orders', orders]
    : [canViewHeldOrders.value, 'api/pos/held_orders', 'data', heldOrdersList];
  ordersRead = (async () => {
    if (!allowed) { target.value = []; return; }
    try {
      const { response, data } = await fetchReadJsonResponse(url, { signal: controller.signal });
      if (!response.ok || !data?.success || !Array.isArray(data[field])) throw new Error('Invalid orders response');
      if (ownsRead()) {
        target.value = data[field];
        if (target === heldOrdersList) heldSnapshotSerial += 1;
      }
    } catch {
      if (ownsRead()) loadError.value = t('Unable to load orders.');
    }
  })().finally(() => {
    if (ownsRead()) {
      ordersRead = null;
      ordersController = null;
      isLoading.value = false;
    }
  });
  return ordersRead;
};

watch(showHistory, () => {
  cancelOrdersRead();
  fetchOrders();
}, { flush: 'sync' });

let orderTypesRequestId = 0;
let orderTypesFailed = false;
const fetchOrderTypes = async () => {
  if (disposed) return;
  const requestId = ++orderTypesRequestId;
  try {
    const { data } = await fetchReadJsonResponse('api/pos/order_types', { signal: lifetimeController.signal });
    if (!disposed && requestId === orderTypesRequestId) {
      orderTypesFailed = !data.success;
      if (data.success) orderTypesList.value = data.data || [];
    }
  } catch (e) {
    if (!disposed && requestId === orderTypesRequestId) orderTypesFailed = true;
    if (!disposed) console.error("Failed to fetch active order types:", e);
  }
};

const processedHeldOrders = computed(() => {
  return heldOrdersList.value.map(o => {
    let parsed = {};
    try {
      parsed = JSON.parse(o.cart_data || '{}');
    } catch (e) {
      parsed = {};
    }

    const items = Array.isArray(parsed) ? parsed : (parsed.items || []);
    const order_type_id = Array.isArray(parsed) ? null : parsed.order_type_id;
    const order_discount = Array.isArray(parsed) ? null : parsed.order_discount;

    let orderTypeName = null;
    if (order_type_id) {
      const matched = orderTypesList.value.find(t => t.id === order_type_id);
      if (matched) orderTypeName = matched.name;
    }

    return {
      isHeld: true,
      id: o.id,
      invoice_id: `HELD-${o.id}`,
      order_id: o.order_id ?? null,
      order_display_no: o.order_display_no ?? null,
      created_at: o.created_at,
      total: o.receipt_display_v1?.summary?.total
        ?? heldOrderTotal(items, order_discount, Number(parsed.tax_inclusive_at_hold) === 1),
      payment_method: 'held',
      cashier_name: o.cashier_name || 'Cashier',
      call_center_user_id: o.call_center_user_id == null ? null : Number(o.call_center_user_id),
      call_center_user_name: o.call_center_user_name || '',
      order_type_name: orderTypeName,
      order_type_id: order_type_id,
      table_number: null,
      table_id: null,
      customer_name: parsed.customer_name || "",
      customer_phone: parsed.customer_phone || "",
      customer_address: parsed.customer_address || "",
      delivery_date: parsed.delivery_date || null,
      items: items.map(item => ({
        id: item.id,
        product_name: item.name || "Item",
        quantity: item.qty || 1,
        price_at_sale: item.price || 0,
        tax_rate: item.tax_rate || 0,
        note: item.note || ""
      })),
      receipt_display_v1: o.receipt_display_v1,
      receipt_display_error: o.receipt_display_error,
      receipt_display_legacy_reason: o.receipt_display_legacy_reason,
      tax_inclusive_at_hold: parsed.tax_inclusive_at_hold,
      raw_held_data: o
    };
  });
});

const isTableOrDineInName = (name) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes('dine') || lower.includes('طاولة') || lower.includes('صالة') || lower.includes('table');
};

// Search & Filter
const filteredOrders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  let list = showHistory.value ? orders.value : processedHeldOrders.value;

  // Filter out any table or Dine-In orders
  list = list.filter(o => {
    if (o.table_id || o.table_number) return false;
    if (isTableOrDineInName(o.order_type_name) && !o.call_center_user_id) return false;
    return true;
  });

  list = filterOrdersBySource(list, sourceFilter.value);

  if (!query) return list;
  return list.filter(o => {
    const invMatch = String(o.invoice_id).includes(query);
    const cashierMatch = String(o.cashier_name || '').toLowerCase().includes(query);
    const sourceMatch = String(o.call_center_user_name || '').toLowerCase().includes(query);
    const refMatch = o.isHeld && o.raw_held_data && String(o.raw_held_data.reference_name || '').toLowerCase().includes(query);
    const tableMatch = o.table_number && String(o.table_number).includes(query);
    const itemMatch = o.items && o.items.some(item =>
      String(item.product_name || '').toLowerCase().includes(query) ||
      String(item.note || '').toLowerCase().includes(query)
    );
    return invMatch || cashierMatch || sourceMatch || refMatch || tableMatch || itemMatch;
  });
});

const configuredOrderTypeColumns = computed(() => {
  const cols = [];

  for (const type of orderTypesList.value) {
    if (!isTableOrDineInName(type.name)) {
      cols.push(type.name);
    }
  }
  return cols;
});
const platformLaneType = (name) => orderTypesList.value.find(type => type.name === name && Number(type.is_deferred_settlement) === 1) || null;

const orderTypeBoard = computed(() => buildOrderTypeBoard(
  filteredOrders.value,
  configuredOrderTypeColumns.value,
  t('Unspecified'),
));
const orderTypeColumns = computed(() => orderTypeBoard.value.columns);
const groupedOrders = computed(() => orderTypeBoard.value.groups);
const platformLaneSummary = (name) => platformSettlementSummary(groupedOrders.value[name] || []);
const mobilePlatformLane = computed(() => {
  if (showHistory.value || activeChip.value === 'All') return null;
  const type = platformLaneType(activeChip.value);
  const laneOrders = groupedOrders.value[activeChip.value] || [];
  if (!type || !laneOrders.some(order => order.isHeld)) return null;
  return { type, summary: platformSettlementSummary(laneOrders) };
});

const selectedPresentation = computed(() => {
  return resolveReceiptPresentation(selectedOrder.value);
});

const openPreviewModal = (order) => {
  selectedOrder.value = order;
  showPreviewModal.value = true;
};

const reprintDirect = async (order, { quiet = false } = {}) => {
  if (!order) return false;
  try {
    const localPrinterId = localStorage.getItem("pos_receipt_printer_id");
    if (order.isHeld) {
      const operationId = getHeldOperationId('receipt', order.id, localStorage);
      const { response, data } = await fetchJsonResponseWithTimeout(`api/pos/held_orders/${order.id}/print_receipt`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({print_request_id:operationId,receipt_printer_id:localPrinterId || null})
      });
      if (!response.ok || !data.success) {
        if (response.status < 500 && response.status !== 409) clearHeldOperationId('receipt', order.id, localStorage);
        throw Object.assign(new Error(data.message || 'Unable to print the held order.'), {isHeldPrintError:true});
      }
      const printed = await printHeldCustomerReceipt(data.customer_receipt);
      clearHeldOperationId('receipt', order.id, localStorage);
      if (printed && !quiet) window.showPosToast?.(t('Receipt sent to printer.'), 'success');
      return printed;
    }

    if (!localPrinterId) {
      const message = t('No receipt printer assigned to this terminal. Please configure it in Settings.');
      if (!quiet && window.showPosAlert) {
        await window.showPosAlert(message);
      } else if (!quiet) {
        alert(message);
      }
      return false;
    }

    const printPayload = {
      print_type: "receipt",
      receipt_printer_id: localPrinterId,
      invoice_id: order.invoice_id,
      ...(order.print_request_id ? { print_request_id: order.print_request_id } : {})
    };

    const { data: printData } = await fetchJsonResponseWithTimeout('api/print/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(printPayload)
    });

    if (printData.success) {
      if (!quiet && window.showPosToast) {
        window.showPosToast(t('Receipt reprinted successfully!'), "success");
      }
      return true;
    } else {
      const errMsg = printData.message || "Unknown spooler error";
      const message = `${t('Print Bridge Error:')} ${t(errMsg)}`;
      if (!quiet && window.showPosAlert) {
        await window.showPosAlert(message);
      } else if (!quiet) {
        alert(message);
      }
      return false;
    }
  } catch (e) {
    console.error("Print Error:", e);
    // A lost answer may still have queued the job (a held retry replays the kept
    // print_request_id), so it is unconfirmed, never a failure, and never resent by itself.
    const message = e.isHeldPrintError ? t(e.message)
      : isUnansweredRequest(e) ? t('Printing was not confirmed. Check Printing before retrying.')
      : t('Failed to print. Is the printer service running?');
    if (!quiet && window.showPosAlert) {
      await window.showPosAlert(message);
    } else if (!quiet) {
      alert(message);
    }
    return false;
  }
};

// Per-ticket in-flight marks: the same ticket cannot double-send, others stay tappable.
// A retry after a lost answer replays the persisted operation_id, so no cooldown is needed.
const firingKitchenIds = reactive(new Set());
const kitchenFiring = id => firingKitchenIds.has(Number(id));
const platformSettlementTypeId = ref(null);

const fireToKitchen = async (order) => {
  if (!order?.isHeld || kitchenFiring(order.id) || heldClaimIsActive(order)) return;
  firingKitchenIds.add(Number(order.id));
  const operationId = getHeldOperationId('fire', order.id, localStorage);
  try {
    const { response: res, data } = await fetchJsonResponseWithTimeout('api/pos/held_orders/fire_kitchen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: order.id,
        operation_id: operationId,
        expected_version: Number(order.raw_held_data?.version || 1),
      })
    });
    if (!res.ok || !data.success) {
      if (res.status < 500) clearHeldOperationId('fire', order.id, localStorage);
      if (window.showPosToast) window.showPosToast(t(data.message || 'Failed to send to kitchen.'), "error");
      fetchOrders();
      return;
    }
    clearHeldOperationId('fire', order.id, localStorage);
    const count = Number(data.count) || 0;
    const msg = count > 0 ? `${t('Sent to kitchen')} (${count})` : t('No kitchen printers matched these items.');
    // The server's 'fired' held event re-reads this row (canonical snapshot and fired bit).
    if (window.showPosToast) window.showPosToast(msg, count > 0 ? "success" : "warning");
  } catch (e) {
    if (window.showPosToast) window.showPosToast(t('Could not confirm the kitchen send. Retry to finish the same send.'), "error");
    fetchOrders();
  } finally {
    firingKitchenIds.delete(Number(order.id));
  }
};

const settlePlatformLane = async (orderTypeName) => {
  const type = platformLaneType(orderTypeName);
  const { held, total } = platformLaneSummary(orderTypeName);
  if (!type || held.length === 0 || platformSettlementTypeId.value !== null) return;
  const confirmMessage = `${type.name}: ${held.length} ${t('orders')} · ${total.toFixed(2)} JD.\n${t('Finalize these sales outside the cash and card drawer?')}`;
  if (!(await window.showPosConfirm(confirmMessage, t('Close & print')))) return;

  platformSettlementTypeId.value = Number(type.id);
  try {
    const { response, data } = await fetchJsonResponseWithTimeout('api/pos/held_orders/settle-platform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_type_id: type.id, held_order_ids: held.map(order => order.id) })
    });
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Could not close platform orders.');
    }
    const successes = data.successes || [];
    const printResult = await printSettledReceipts(
      successes,
      order => reprintDirect(order, { quiet: true })
    );
    const failures = data.failures || [];
    if (window.showPosToast) {
      const parts = [`${t('Closed')} ${successes.length} ${t('platform orders')}`];
      if (failures.length) parts.push(`${failures.length} ${t('need attention')}`);
      if (printResult.failed) parts.push(`${printResult.failed} ${t('receipts failed to print')}`);
      window.showPosToast(parts.join(' · '), failures.length || printResult.failed ? 'warning' : 'success');
    }
    await fetchOrders();
  } catch (error) {
    // No operation id: a lost answer may have settled some sales. Re-read the
    // board to show what committed and never auto-retry.
    if (isUnansweredRequest(error)) {
      await fetchOrders();
      await window.showPosAlert?.(t('Closing platform orders was not confirmed. Check the board before retrying.'));
    } else if (window.showPosAlert) await window.showPosAlert(t(error.message || 'Could not close platform orders.'));
  } finally {
    platformSettlementTypeId.value = null;
  }
};

const cancelHeldOrder = async (order) => {
  if (!order?.isHeld || heldClaimIsActive(order)) return;
  const confirmed = await window.showPosConfirm?.(
    t('Cancel this suspended order? This cannot be undone.'),
    t('Cancel suspended order'),
  );
  if (!confirmed) return;
  const expectedVersion = Number(order.raw_held_data?.version || 1);
  let claimedVersion = null;
  const operationId = getHeldOperationId('cancel', order.id, localStorage);
  // The claim token is derived from the persisted cancellation operation. If the
  // claim commits but its response is lost, the next click replays the same lease
  // instead of locking this cashier out with a new token for ten minutes.
  const tokenSeed = operationId.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const claimToken = `${tokenSeed}${tokenSeed}${tokenSeed}`.slice(0, 64).padEnd(64, '0');
  const releaseClaimAfterFailedCancel = async () => {
    if (!claimedVersion) return;
    await fetchJsonResponseWithTimeout(`api/pos/held_orders/${encodeURIComponent(order.id)}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation_id: createRequestId(),
        claim_token: claimToken,
        expected_version: claimedVersion,
      }),
    }).catch(() => {});
  };
  try {
    const claim = await fetchJsonResponseWithTimeout(`api/pos/held_orders/${encodeURIComponent(order.id)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_token: claimToken, expected_version: expectedVersion }),
    });
    if (!claim.response.ok || !claim.data.success) {
      await window.showPosAlert?.(t(claim.data.message || 'This suspended ticket is being edited on another terminal.'));
      return;
    }
    claimedVersion = Number(claim.data.claim?.version || claim.data.order?.version || expectedVersion + 1);
    const result = await fetchJsonResponseWithTimeout(`api/pos/held_orders/${encodeURIComponent(order.id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation_id: operationId,
        claim_token: claimToken,
        expected_version: claimedVersion,
        reason_code: 'customer_changed_mind',
        confirmed: true,
      }),
    });
    if (!result.response.ok || !result.data.success) {
      if (result.response.status < 500) clearHeldOperationId('cancel', order.id, localStorage);
      await releaseClaimAfterFailedCancel();
      await fetchOrders();
      await window.showPosAlert?.(t(result.data.message || 'Could not cancel this suspended ticket.'));
      return;
    }
    clearHeldOperationId('cancel', order.id, localStorage);
    // The server's 'removed' held event drops the card.
    window.showPosToast?.(t('Suspended order cancelled.'), 'success');
  } catch (error) {
    console.error('Failed to cancel held order:', error);
    await releaseClaimAfterFailedCancel();
    await fetchOrders();
    await window.showPosAlert?.(t(isUnansweredRequest(error)
      ? 'Cancelling the suspended ticket was not confirmed. Check the board before retrying.'
      : 'Network error. The suspended ticket was not cancelled.'));
  }
};

// A claim whose answer was lost may have committed. Its handoff keeps the token so
// a retry replays the same claim instead of colliding with its own lease.
const resumableHeldOrderId = ref(Number(readHeldOrderHandoff(localStorage)?.heldOrderId) || null);
const restoringHeldIds = new Set();
const restoreHeldOrder = async (order) => {
  if (!order || !order.isHeld) return;
  const heldId = Number(order.id);
  if (restoringHeldIds.has(heldId)) return;
  restoringHeldIds.add(heldId);
  try {
    // Backup the cart payload BEFORE the network call so a lost response is recoverable.
    const rawCartData = order.raw_held_data.cart_data;
    const stored = readHeldOrderHandoff(localStorage);
    const claimToken = Number(stored?.heldOrderId) === heldId && stored?.claimToken
      ? stored.claimToken
      : `${createRequestId()}${createRequestId()}`.replace(/-/g, '').slice(0, 64);
    storeHeldOrderHandoff({
      heldOrderId: Number(order.id),
      expectedVersion: Number(order.raw_held_data.version || 1),
      claimToken,
      cartData: rawCartData,
    }, localStorage);

    // Lease the ticket without deleting it. Exactly one terminal wins; a loser gets 409.
    resumableHeldOrderId.value = heldId;
    const { response: res, data } = await fetchJsonResponseWithTimeout(`api/pos/held_orders/${encodeURIComponent(order.id)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claim_token: claimToken,
        expected_version: Number(order.raw_held_data.version || 1),
      })
    });

    if (!res.ok || !data.success || !data.order) {
      // A definitive client conflict means this recovery envelope cannot own the
      // row. Clear it so a later visit to POS does not unexpectedly retry it.
      if (res.status >= 400 && res.status < 500) {
        clearHeldOrderHandoff(localStorage);
        resumableHeldOrderId.value = null;
        await fetchOrders();
      }
      const msg = res.status === 409
        ? t('This suspended ticket is being edited on another terminal.')
        : t(data.message || 'Could not load this suspended ticket.');
      if (window.showPosAlert) await window.showPosAlert(msg); else alert(msg);
      return;
    }

    // Winner: use the authoritative row; fall back to the backed-up cart only if it lacks one.
    const claimed = data.order;
    const hasServerCartData = claimed.cart_data !== undefined
      && claimed.cart_data !== null
      && claimed.cart_data !== '';
    const claimedCartData = hasServerCartData ? claimed.cart_data : (rawCartData || '{}');
    const parsed = typeof claimedCartData === 'string' ? JSON.parse(claimedCartData) : claimedCartData;

    // Always sync the flag — stale '1' from a prior session must not survive into
    // a different (non-fired) hold restore.
    if (claimed.kitchen_fired) {
      setHeldKitchenFired(true, localStorage);
    } else {
      setHeldKitchenFired(false, localStorage);
    }

    // Clear active table session — canonical teardown invalidates any in-flight table
    // load/draft and clears the QR draft so it can't bleed into the restored hold.
    tablesStore.clearActiveTableSession();
    clearTablePrefill(localStorage);

    // Route through the single canonical restore action so edit residue is
    // cleared and numeric fields normalized (Task 1). A pre-migration array payload is
    // wrapped as { items }.
    const restorePayload = Array.isArray(parsed) ? { items: parsed } : parsed;
    // Preserve the reference the winner returned so the next Hold reuses it.
    if (!restorePayload.reference_name) restorePayload.reference_name = claimed.reference_name || '';
    restorePayload.service_charge_snapshot = claimed.service_charge_snapshot || null;
    restorePayload.held_order_context = {
      id: Number(claimed.id || order.id),
      reference: claimed.reference_name || '',
      version: Number(data.claim?.version || claimed.version || 1),
      claimToken: data.claim?.claimToken || claimToken,
      claimExpiresAt: data.claim?.claimExpiresAt || claimed.claim_expires_at || null,
      kitchenFired: claimed.kitchen_fired === 1 || claimed.kitchen_fired === true,
      baselineUnknown: (claimed.kitchen_fired === 1 || claimed.kitchen_fired === true) && !claimed.kitchen_baseline_known,
      kitchenDispatchVersion: Number(claimed.kitchen_dispatch_version || 0),
    };
    cartStore.restoreHeldOrder(restorePayload);
    if (hasServerCartData) cartStore.markServerCanonicalRestore();
    else cartStore.markLocalFallbackRestore();

    clearHeldOrderHandoff(localStorage);
    resumableHeldOrderId.value = null;
    if (data.pricing_context_changed && (data.pricing_context_changed.taxMode || data.pricing_context_changed.taxRates || data.pricing_context_changed.prices || data.pricing_context_changed.total)) {
        if (window.showPosToast) window.showPosToast(t('Pricing context changed. Totals updated.'), "warning");
    } else {
        if (window.showPosToast) window.showPosToast(t('Suspended ticket loaded successfully!'), "success");
    }
    router.push('/pos');
  } catch (e) {
    console.error("Failed to restore held order:", e);
    // Network failure: leave the backup in place for recovery (D5). The ticket may or may
    // not have been claimed; do not assume it loaded.
    if (window.showPosAlert) {
      await window.showPosAlert(t('Network error. Could not restore suspended ticket.'));
    } else {
      alert(t('Network error. Could not restore suspended ticket.'));
    }
  } finally {
    restoringHeldIds.delete(heldId);
  }
};
// The owner of a lost claim holds its token, so Restore stays usable for it.
const heldRestoreBlocked = order => heldClaimIsActive(order) && Number(order?.id) !== resumableHeldOrderId.value;

let socketUpdateTimeout = null;
const onSocketUpdate = () => {
  if (disposed) return;
  if (ordersRead) {
    fetchOrders();
    return;
  }
  if (socketUpdateTimeout) clearTimeout(socketUpdateTimeout);
  socketUpdateTimeout = setTimeout(() => {
    socketUpdateTimeout = null;
    fetchOrders();
  }, 250);
};

// The held list is register-only, so sales and table rows cannot change it; history lists paid orders.
const onHistorySocketUpdate = () => {
  if (showHistory.value) onSocketUpdate();
};

const heldPatchActions = new Set(['created', 'updated', 'claimed', 'released', 'fired', 'settled', 'removed']);
const heldOrderIdOf = (payload) => {
  const id = Number(payload?.held_order_id);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const removeHeldOrder = (id) => {
  const list = heldOrdersList.value;
  if (!list.some(o => Number(o.id) === id)) return;
  heldOrdersList.value = list.filter(o => Number(o.id) !== id);
};
const upsertHeldOrder = (row) => {
  const id = Number(row.id);
  const list = heldOrdersList.value;
  const index = list.findIndex(o => Number(o.id) === id);
  if (index >= 0) {
    const next = list.slice();
    next[index] = row;
    heldOrdersList.value = next;
    return;
  }
  heldOrdersList.value = [...list, row];
};
const onHeldOrdersChanged = (payload) => {
  if (disposed) return;
  const action = payload?.action;
  const id = heldOrderIdOf(payload);
  if (!heldPatchActions.has(action) || id === null || showHistory.value || !canViewHeldOrders.value || ordersRead) {
    onSocketUpdate();
    return;
  }
  if (action === 'removed' || action === 'settled') {
    removeHeldOrder(id);
    return;
  }
  const version = ordersReadVersion;
  const serial = heldSnapshotSerial;
  (async () => {
    let result = null;
    try {
      result = await fetchReadJsonResponse(`api/pos/held_orders/${encodeURIComponent(id)}`);
    } catch {
      result = null;
    }
    if (disposed || version !== ordersReadVersion || showHistory.value) return;
    if (ordersRead || serial !== heldSnapshotSerial) {
      onSocketUpdate();
      return;
    }
    const row = result?.data?.data;
    if (result?.response?.ok && result.data?.success && row && Number(row.id) === id) {
      upsertHeldOrder(row);
    } else if (result?.response?.status === 404) {
      removeHeldOrder(id);
    } else {
      onSocketUpdate();
    }
  })();
};

let metadataRequestId = 0;
const refreshMetadata = async (change) => {
  const requestId = ++metadataRequestId;
  if (change) void terminal.loadSettings({ force: true });
  else void terminal.ensureSettings();
  await fetchOrderTypes();
  if (!disposed && requestId === metadataRequestId) metadataLoading.value = false;
};
// Heartbeat/focus recovery for reads that failed while the socket stayed up.
// Flag tests only, so a healthy board sends nothing.
const retryFailedReads = () => {
  if (disposed) return;
  if (loadError.value && !ordersRead) fetchOrders();
  if (orderTypesFailed) fetchOrderTypes();
};
const onReconnect = () => {
  refreshMetadata(true);
  onSocketUpdate();
};

onMounted(async () => {
  mediaQuery = window.matchMedia('(max-width: 767px)');
  isMobile.value = mediaQuery.matches;
  mediaQuery.addEventListener('change', applyIsMobile);

  try {
    const s = initSocket();
    s.off('new_order', onHistorySocketUpdate);
    s.on('new_order', onHistorySocketUpdate);
    s.off('table_update', onHistorySocketUpdate);
    s.on('table_update', onHistorySocketUpdate);
    s.off('held_orders_changed', onHeldOrdersChanged);
    s.on('held_orders_changed', onHeldOrdersChanged);
    s.on('settings_changed', refreshMetadata);
    s.io?.off('ping', retryFailedReads);
    s.io?.on('ping', retryFailedReads);
  } catch (err) {
    console.error("Failed to initialize order notes socket:", err);
  }
  window.addEventListener('socket_reconnected', onReconnect);
  window.addEventListener('focus', retryFailedReads);
  await Promise.all([refreshMetadata(), fetchOrders()]);
});

onUnmounted(() => {
  disposed = true;
  cancelOrdersRead();
  lifetimeController.abort();
  window.removeEventListener('socket_reconnected', onReconnect);
  window.removeEventListener('focus', retryFailedReads);
  clearTimeout(claimExpiryTimer);
  if (mediaQuery) mediaQuery.removeEventListener('change', applyIsMobile);

  if (socketUpdateTimeout) clearTimeout(socketUpdateTimeout);
  if (socket.value) {
    socket.value.off('new_order', onHistorySocketUpdate);
    socket.value.off('table_update', onHistorySocketUpdate);
    socket.value.off('held_orders_changed', onHeldOrdersChanged);
    socket.value.off('settings_changed', refreshMetadata);
    socket.value.io?.off('ping', retryFailedReads);
  }
});
</script>

<style scoped>
.order-notes-page {
  --notes-teal: #24405e;
  --notes-teal-edge: #14263a;
  --notes-accent-line: rgb(36 64 94 / 0.45);
  --notes-canvas: #e3e6ea;
  --notes-surface: #f2f4f6;
  --notes-surface-muted: #e7eaef;
  --notes-card: #f9fafb;
  --notes-card-hover: #ffffff;
  --notes-paper: #fcfcfd;
  --notes-divider: rgb(17 24 39 / 0.09);
  --notes-error-card: #fbf1f2;
  --notes-error-line: #d7a6ad;
  --notes-error-ink: #9f1239;
  --notes-review-card: #f7eed6;
  --notes-review-line: #dcc88f;
  --notes-review-ink: #6b4e14;
  --notes-intake-edge: #d4a72c;
  --notes-line: #c2c8d0;
  --notes-ink: #111827;
  --notes-muted: #5b6675;
  --notes-tactile-edge: #a5b0b9;
  min-height: 100dvh;
  background: var(--notes-canvas);
  color: var(--notes-ink);
  font-family: 'Inter', 'IBM Plex Sans Arabic', sans-serif;
}

.order-notes-page.pos-theme-dark {
  color-scheme: dark;
  --notes-teal: #4b7199;
  --notes-teal-edge: #2b4561;
  --notes-accent-line: rgb(120 160 205 / 0.55);
  --notes-canvas: #15191e;
  --notes-surface: #20252b;
  --notes-surface-muted: #1b2026;
  --notes-card: #2a3038;
  --notes-card-hover: #313842;
  --notes-paper: #242a31;
  --notes-divider: rgb(255 255 255 / 0.08);
  --notes-error-card: #3a292f;
  --notes-error-line: #6b3d47;
  --notes-error-ink: #fecdd3;
  --notes-review-card: #3b3426;
  --notes-review-line: #806f3e;
  --notes-review-ink: #f2d78a;
  --notes-intake-edge: #b8902a;
  --notes-line: #3f4955;
  --notes-ink: #f1f4f7;
  --notes-muted: #b8c1cc;
  --notes-tactile-edge: #0d1014;
}

:global(html[dir='rtl']) .order-notes-page {
  font-family: 'IBM Plex Sans Arabic', 'Inter', sans-serif;
}

.notes-num,
.font-grotesk {
  font-family: inherit;
  font-feature-settings: 'tnum' 1;
  font-variant-numeric: tabular-nums;
}

.notes-header {
  position: relative;
  z-index: 30;
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px;
  border-bottom: 1px solid var(--notes-line);
  background: var(--notes-surface);
}

.notes-heading {
  min-width: 140px;
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: stretch;
  padding-inline: 6px;
}

.notes-heading__icon {
  width: 40px;
  height: 100%;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid var(--notes-line);
  border-radius: 3px;
  background: rgb(36 64 94 / 0.1);
  color: var(--notes-teal);
}

.notes-heading h1 {
  margin: 0;
  overflow: hidden;
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-heading p {
  margin: 2px 0 0;
  color: var(--notes-muted);
  font-size: 0.72rem;
  font-weight: 600;
}

.notes-header__spacer {
  flex: 1;
}

.notes-icon-action {
  width: 44px;
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--notes-line);
  border-radius: 3px;
  background: var(--notes-surface-muted);
  color: var(--notes-ink);
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
  box-shadow: inset 0 -2px 0 var(--notes-tactile-edge);
}

.notes-icon-action:hover:not(:disabled),
.notes-icon-action--active {
  border-color: rgb(36 64 94 / 0.38);
  background: rgb(36 64 94 / 0.09);
  color: var(--notes-teal);
}

.notes-icon-action:disabled {
  opacity: 0.45;
  cursor: wait;
}

.notes-icon-action:focus-visible,
.notes-search input:focus-visible,
.notes-search button:focus-visible,
.notes-mode button:focus-visible,
.notes-type-filter:focus-visible,
.notes-dialog__header button:focus-visible,
.notes-dialog-action:focus-visible {
  outline: 3px solid rgb(36 64 94 / 0.25);
  outline-offset: 2px;
}

.notes-search {
  position: relative;
  width: clamp(150px, 22vw, 240px);
  display: block;
}

.notes-search--desktop {
  display: block;
}

.notes-mobile-search-trigger {
  display: none;
}

.notes-search > i {
  position: absolute;
  inset-inline-start: 12px;
  top: 50%;
  color: #747c77;
  transform: translateY(-50%);
  pointer-events: none;
}

.notes-search input {
  width: 100%;
  min-height: 44px;
  padding-inline: 36px 42px;
  border: 1px solid var(--notes-line);
  border-radius: 3px;
  background: var(--notes-surface-muted);
  color: var(--notes-ink);
  font-size: 0.82rem;
  font-weight: 600;
  outline: none;
  transition: background-color 150ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out;
}

.notes-search input::placeholder {
  color: #59625d;
  opacity: 1;
}

.notes-search input::-webkit-search-cancel-button {
  display: none;
}

.notes-search input:focus {
  border-color: var(--notes-teal);
  background: var(--notes-card-hover);
  box-shadow: 0 0 0 3px rgb(36 64 94 / 0.1);
}

.notes-search button {
  position: absolute;
  inset-inline-end: 2px;
  top: 2px;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--notes-muted);
}

.notes-search button:hover {
  color: #9f1239;
}

.notes-mobile-search {
  display: none;
}

.notes-mobile-search .notes-search {
  width: 100%;
}

.notes-search-enter-active,
.notes-search-leave-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}

.notes-search-enter-from,
.notes-search-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.notes-mode {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border: 1px solid var(--notes-line);
  border-radius: 3px;
  background: var(--notes-surface-muted);
}

.notes-mode button {
  min-width: 96px;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 2px;
  color: var(--notes-muted);
  font-size: 0.82rem;
  font-weight: 700;
  transition: background-color 150ms ease-out, color 150ms ease-out;
  box-shadow: inset 0 -2px 0 var(--notes-tactile-edge);
}

.notes-mode button:hover:not(.notes-mode__button--active) {
  color: var(--notes-ink);
}

.notes-mode__button--active {
  background: var(--notes-teal);
  color: #fff !important;
}

.notes-load-error {
  min-height: 48px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 13px;
  border-bottom: 1px solid #d7a6ad;
  background: #fbf1f2;
  color: #831832;
  font-size: 0.82rem;
  font-weight: 600;
}

.notes-load-error button {
  min-height: 44px;
  flex: 0 0 auto;
  padding: 0 12px;
  border: 1px solid #bd7a88;
  border-radius: 7px;
  background: #fff;
  color: #831832;
  font-weight: 700;
}

/* Filter bars: joined tabs split by hairlines. The active tab is lifted to the card tone and
   carries an ink underline; no pills, no gaps. */
.notes-source-filter,
.notes-type-strip {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0;
  border-bottom: 1px solid var(--notes-line);
  background: var(--notes-surface);
}

.notes-source-filter button,
.notes-type-filter {
  position: relative;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 16px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--notes-muted);
  font-size: 0.82rem;
  font-weight: 700;
  white-space: nowrap;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}

.notes-source-filter button + button,
.notes-type-filter + .notes-type-filter {
  border-inline-start: 1px solid var(--notes-line);
}

.notes-source-filter button:hover,
.notes-type-filter:hover {
  background: var(--notes-surface-muted);
  color: var(--notes-ink);
}

.notes-source-filter__button--active,
.notes-type-filter--active {
  background: var(--notes-card) !important;
  color: var(--notes-ink) !important;
  box-shadow: inset 0 -3px 0 var(--notes-teal);
}

.notes-source-filter__button--active > i {
  color: var(--notes-teal);
}

.notes-type-strip {
  overflow-x: auto;
}

.notes-type-filter {
  flex: 1 0 auto;
  max-width: 220px;
}

.notes-type-filter span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-type-filter b {
  color: var(--notes-muted);
  font-size: 0.78rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.notes-type-filter--active b {
  color: var(--notes-teal);
}

.notes-type-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
}

.notes-loading {
  flex: 1;
  min-height: 0;
  padding: 16px;
}

.notes-loading > p {
  margin: 0 0 12px;
  color: var(--notes-muted);
  font-size: 0.82rem;
  font-weight: 700;
}

.notes-loading__grid {
  height: calc(100% - 32px);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  overflow: hidden;
}

.notes-loading__lane {
  padding: 12px;
  border: 1px solid var(--notes-line);
  border-radius: 8px;
  background: var(--notes-surface-muted);
}

.notes-loading__lane span {
  height: 112px;
  display: block;
  margin-bottom: 10px;
  border-radius: 7px;
  background: #d9ddd8;
  animation: notes-loading-pulse 1.2s ease-in-out infinite alternate;
}

.notes-board {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px;
  background: var(--notes-canvas);
}

.order-lane {
  flex: 1 1 320px;
  min-width: 290px;
  max-width: 440px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--notes-line);
  border-radius: 10px;
  background: var(--notes-surface);
}

.order-lane__header {
  min-height: 54px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--notes-line);
}

.order-lane__header > div {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.order-lane__header h2 {
  margin: 0;
  overflow: hidden;
  font-size: 0.95rem;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-lane-count {
  min-width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--notes-surface-muted);
  color: var(--notes-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.notes-platform-close {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 1px solid var(--notes-teal);
  border-radius: 6px;
  background: var(--notes-teal);
  color: #fff;
  font-size: 0.68rem;
  font-weight: 700;
  white-space: nowrap;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
  box-shadow: inset 0 -2px 0 #172a3c;
}

.notes-platform-close strong {
  padding-inline-start: 7px;
  border-inline-start: 1px solid rgb(255 255 255 / 0.28);
  font-size: 0.64rem;
  font-variant-numeric: tabular-nums;
}

.notes-platform-close:not(:disabled):hover { background: #1b344e; }

.notes-platform-close:disabled { opacity: 0.55; cursor: wait; }

.notes-platform-mobile {
  min-height: 60px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--notes-line);
  background: var(--notes-surface-muted);
}

.notes-platform-mobile > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.notes-platform-mobile strong {
  overflow: hidden;
  color: var(--notes-ink);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-platform-mobile span { color: var(--notes-muted); font-size: 0.7rem; font-weight: 600; }

.notes-platform-mobile button {
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border-radius: 8px;
  background: var(--notes-teal);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 700;
}

.notes-platform-mobile button:disabled { opacity: 0.5; cursor: wait; }

.order-lane__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--notes-surface-muted);
}

.notes-phone-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--notes-canvas);
}

.notes-empty {
  min-height: 100px;
  display: grid;
  place-items: center;
  padding: 16px;
  color: var(--notes-muted);
  font-size: 0.82rem;
  font-weight: 600;
  text-align: center;
}

.notes-empty--page {
  min-height: 180px;
}

.notes-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: rgb(25 29 27 / 0.72);
  animation: notes-backdrop-in 150ms ease-out;
}

.notes-dialog {
  width: min(100%, 520px);
  max-height: min(92dvh, 820px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--notes-line);
  border-radius: 10px;
  background: var(--notes-surface);
  box-shadow: 0 4px 8px rgb(17 24 39 / 0.24);
  animation: notes-dialog-in 150ms ease-out;
}

.notes-dialog__header {
  min-height: 56px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 6px 14px;
  border-bottom: 1px solid var(--notes-line);
  background: var(--notes-surface);
}

.notes-dialog__header > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notes-dialog__header h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
}

.notes-dialog__header button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--notes-muted);
}

.notes-dialog__header button:hover {
  background: var(--notes-surface-muted);
  color: var(--notes-ink);
}

.notes-dialog__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  background: var(--notes-surface-muted);
  color: var(--notes-ink);
  font-size: 0.875rem;
}

.notes-receipt {
  padding: 16px;
  border: 1px solid var(--notes-line);
  border-radius: 8px;
  background: var(--notes-paper);
}

.notes-receipt-store {
  padding-bottom: 12px;
  text-align: center;
}

.notes-receipt-store h4 {
  margin: 0;
  color: var(--notes-ink);
  font-size: 1rem;
  font-weight: 800;
}

.notes-receipt-store p {
  margin: 2px 0 0;
  color: var(--notes-muted);
  font-size: 0.8rem;
}

.notes-receipt-meta {
  margin: 0 0 14px;
  padding: 10px 0;
  border-block: 1px dashed var(--notes-line);
  display: grid;
  gap: 6px;
}

.notes-receipt-meta > div,
.notes-receipt-sums > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}

.notes-receipt-meta dt {
  flex: 0 0 auto;
  color: var(--notes-muted);
  font-weight: 600;
}

.notes-receipt-meta dd {
  min-width: 0;
  margin: 0;
  color: var(--notes-ink);
  font-weight: 600;
  text-align: end;
  overflow-wrap: anywhere;
}

.notes-receipt-meta dd.notes-receipt-meta__strong {
  font-weight: 800;
}

.notes-receipt-alert {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 8px;
}

.notes-receipt-alert > i {
  margin-top: 3px;
  font-size: 0.8rem;
}

.notes-receipt-alert strong {
  display: block;
  font-size: 0.85rem;
}

.notes-receipt-alert p {
  margin: 2px 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
}

.notes-receipt-alert--error {
  border-color: var(--notes-error-line);
  background: var(--notes-error-card);
  color: var(--notes-error-ink);
}

.notes-receipt-alert--legacy {
  border-color: var(--notes-review-line);
  background: var(--notes-review-card);
  color: var(--notes-review-ink);
}

.notes-receipt-items {
  width: 100%;
  margin-bottom: 12px;
  border-collapse: collapse;
}

.notes-receipt-items th {
  padding: 0 0 8px;
  border-bottom: 1px solid var(--notes-line);
  color: var(--notes-muted);
  font-size: 0.75rem;
  font-weight: 700;
  text-align: start;
}

.notes-receipt-items td {
  padding: 9px 0;
  border-bottom: 1px solid var(--notes-divider);
  color: var(--notes-ink);
  font-weight: 500;
  vertical-align: top;
}

.notes-receipt-items tr:last-child td {
  border-bottom: 0;
}

.notes-receipt-items .notes-receipt-items__qty {
  width: 48px;
  text-align: center;
}

.notes-receipt-items .notes-receipt-items__money {
  width: 72px;
  text-align: end;
}

.notes-receipt-items__name {
  font-weight: 600;
}

.notes-receipt-items td.notes-receipt-items__net {
  font-weight: 700;
}

.notes-receipt-items__child-name,
.notes-receipt-items__note,
.notes-receipt-items__discount {
  display: block;
  font-size: 0.78rem;
}

.notes-receipt-items__child-name {
  padding-inline-start: 10px;
  color: var(--notes-muted);
}

.notes-receipt-items__note {
  color: var(--notes-error-ink);
  font-weight: 600;
}

.notes-receipt-items__discount {
  color: var(--notes-muted);
}

.notes-receipt-sums {
  display: grid;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--notes-line);
  color: var(--notes-muted);
  font-weight: 600;
}

.notes-receipt-sums .notes-num {
  color: var(--notes-ink);
}

.notes-receipt-sums .notes-receipt-sums__discount,
.notes-receipt-sums .notes-receipt-sums__discount .notes-num {
  color: var(--notes-teal);
}

.notes-receipt-sums .notes-receipt-total {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px dashed var(--notes-line);
  align-items: center;
  color: var(--notes-ink);
  font-weight: 700;
}

.notes-receipt-total small {
  color: var(--notes-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.notes-receipt-total strong {
  font-size: 1.4rem;
  font-weight: 800;
}

.notes-receipt-total strong small {
  margin-inline-start: 4px;
}

.notes-dialog__footer {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(116px, 1fr));
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--notes-line);
  background: var(--notes-surface);
}

.notes-dialog-action {
  min-width: 44px;
  min-height: 44px;
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 12px;
  border: 1px solid var(--notes-line);
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 700;
  white-space: nowrap;
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
  box-shadow: 0 2px 0 var(--notes-tactile-edge);
}

.notes-dialog-action:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: none;
}

.notes-dialog-action--secondary {
  background: var(--notes-card);
  color: var(--notes-ink);
}

.notes-dialog-action--kitchen {
  border-color: var(--notes-review-line);
  background: var(--notes-review-card);
  color: var(--notes-review-ink);
}

.notes-dialog-action--primary {
  border-color: var(--notes-teal);
  background: var(--notes-teal);
  color: #fff;
  box-shadow: 0 2px 0 var(--notes-teal-edge);
}

.notes-dialog-action:hover:not(:disabled) {
  filter: brightness(0.96);
}

.notes-dialog-action:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.premium-scroll {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.premium-scroll::-webkit-scrollbar {
  width: 7px;
  height: 7px;
}

.premium-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.premium-scroll::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: rgb(79 90 84 / 0.28);
}

@keyframes notes-loading-pulse {
  from { opacity: 0.55; }
  to { opacity: 0.9; }
}

@keyframes notes-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes notes-dialog-in {
  from { opacity: 0; transform: translateY(8px) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 639px) {
  .notes-header {
    min-height: 60px;
    flex-wrap: wrap;
    gap: 7px;
    padding: 8px 10px;
  }

  .notes-heading {
    min-width: 0;
    gap: 7px;
  }

  .notes-heading__icon,
  .notes-search--desktop {
    display: none;
  }

  .notes-mobile-search-trigger {
    display: grid;
  }

  .notes-heading h1 {
    font-size: 0.98rem;
  }

  .notes-heading p {
    font-size: 0.72rem;
  }

  .notes-header .notes-mode {
    order: 10;
    width: 100%;
  }

  .notes-header .notes-mode button {
    min-width: 0;
    flex: 1;
  }

  .notes-mobile-search {
    order: 11;
    width: 100%;
    flex: 0 0 100%;
    display: block;
  }

  .notes-source-filter {
    overflow-x: auto;
  }

  .notes-source-filter button {
    flex: 1 0 auto;
    padding: 0 12px;
  }

  .notes-dialog {
    max-height: calc(100dvh - 16px);
  }

  .notes-dialog__body {
    padding: 8px;
    font-size: 0.875rem;
  }

  .notes-receipt {
    padding: 12px;
  }

  .notes-receipt-items .notes-receipt-items__qty {
    width: 34px;
  }

  .notes-receipt-items .notes-receipt-items__money {
    width: 58px;
  }

  .notes-dialog__footer {
    padding: 8px;
  }
}

@media (pointer: coarse) {
  .premium-scroll::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }

  .premium-scroll {
    scrollbar-width: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .notes-icon-action,
  .notes-search input,
  .notes-mode button,
  .notes-type-filter,
  .notes-dialog-action,
  .notes-search-enter-active,
  .notes-search-leave-active,
  .notes-dialog,
  .notes-modal-backdrop,
  .notes-loading__lane span {
    animation: none;
    transition-duration: 0.01ms;
  }
}
</style>

<template>
  <Transition name="pos-modal">
    <div
      v-if="showCheckoutModal"
      class="checkout-modal pos-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <section
        ref="checkoutDialog"
        class="checkout-dialog checkout-dialog--b modal-panel"
        :class="{
          'has-customer': showCustomerDrawer,
          'has-order-types': showOrderTypePanel,
          'is-call-center': isCallCenter
        }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        tabindex="-1"
      >
        <header class="checkout-header modal-header" :inert="phoneKeypadOpen">
          <h2 id="checkout-title">{{ $t(isCallCenter ? 'Send Order' : 'Complete Payment') }}</h2>

          <div class="checkout-header-actions">
            <button
              v-if="!pendingCheckout && !isCallCenter && !activeTable && canHoldOrder"
              type="button"
              class="checkout-hold"
              :disabled="isHolding || isProcessing"
              @click="handleHoldOrder"
            >
              <i
                :class="isHolding ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-circle-pause'"
                aria-hidden="true"
              ></i>
              <span>{{ restoredHeldOrder ? $t('Save changes') : $t('Hold') }}</span>
            </button>

            <button
              type="button"
              class="checkout-customer customer-button relative"
              v-if="!pendingCheckout"
              :class="{ 'is-active': showCustomerDrawer }"
              :aria-expanded="showCustomerDrawer"
              @click="setCustomerPanel(!showCustomerDrawer)"
            >
              <i class="fa-regular fa-user" aria-hidden="true"></i>
              <span>{{ $t('Customer') }}</span>
              <span
                v-if="!showCustomerDrawer && hasCustomerDetails"
                class="checkout-customer-indicator"
                aria-hidden="true"
              ></span>
            </button>

            <button
              type="button"
              class="checkout-close modal-close"
              :aria-label="$t('Close')"
              :disabled="isProcessing || isHolding"
              @click="requestCloseCheckout"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </header>

        <div v-if="pendingCheckout" class="modal-body p-5 space-y-4" role="status">
          <p>{{ $t("The last payment didn't get a reply from the server. Press the button to check it. The sale will not be recorded twice.") }}</p>
          <ul v-if="pendingLines.length" class="pending-lines space-y-1 font-arabic" data-testid="pending-lines" data-no-i18n>
            <li v-for="(line, index) in pendingLines" :key="index" class="flex justify-between gap-3">
              <span class="min-w-0 truncate">{{ line.name }}</span>
              <span class="tabular-nums shrink-0" dir="ltr">&times; {{ line.qty }}</span>
            </li>
            <li v-if="pendingMoreCount" class="text-on-surface-variant"><bdi>+{{ pendingMoreCount }}</bdi> {{ $t('more') }}</li>
          </ul>
          <p>
            <strong>{{ $t('Total') }}: {{ Number(pendingCheckout.frozen.totals.total).toFixed(2) }}</strong>
            <span v-if="pendingStartedAt" class="ms-3 text-on-surface-variant">{{ $t('Started at') }} <bdi>{{ pendingStartedAt }}</bdi></span>
          </p>
          <p v-if="checkoutError" role="alert">{{ $t(checkoutError) }}</p>
          <button type="button" class="checkout-confirm" :disabled="isProcessing || isHolding" @click="processCheckout">
            {{ $t(isProcessing ? 'Processing...' : 'Check last payment') }}
          </button>
          <button v-if="canDiscardPendingCheckout" type="button" class="font-bold underline" :disabled="isProcessing || isHolding" @click="discardPendingCheckout">
            {{ $t('Discard: this sale was not saved') }}
          </button>
        </div>
        <div v-else class="checkout-layout modal-body" :inert="phoneKeypadOpen">
          <aside v-if="showOrderTypePanel" class="checkout-order-types">
            <div class="order-type-heading">
              <h3>{{ $t('Order Type') }}</h3>
            </div>

            <div class="order-type-list" role="group" :aria-label="$t('Order Type')">
              <button
                v-for="type in orderTypes"
                :key="type.id"
                type="button"
                class="order-type-option"
                :class="{ 'is-selected': String(selectedOrderType) === String(type.id) }"
                :aria-pressed="String(selectedOrderType) === String(type.id)"
                @click="toggleOrderType(type)"
              >
                <span class="order-type-mark" aria-hidden="true">
                  <i class="fa-solid fa-check"></i>
                </span>
                <span data-no-i18n>{{ type.name }}</span>
              </button>
            </div>

            <div v-if="selectedOrderTypeRequiresHash" class="checkout-hash-field">
              <label for="checkout-hash">{{ $t('Hash Number') }}</label>
              <div class="checkout-input-with-icon">
                <i class="fa-solid fa-hashtag" aria-hidden="true"></i>
                <input
                  id="checkout-hash"
                  v-model="hashNumber"
                  type="text"
                  inputmode="text"
                  enterkeyhint="done"
                  :placeholder="$t('Enter #')"
                />
              </div>
            </div>
          </aside>

          <main v-if="isCallCenter" class="checkout-payment-pane call-center-checkout-pane">
            <div class="checkout-section-heading">
              <h3>{{ $t(restoredHeldOrder ? 'Phone order actions' : 'Send as Held') }}</h3>
            </div>
            <div class="call-center-checkout-summary">
              <span>{{ $t('No payment will be collected.') }}</span>
              <strong data-no-i18n>{{ cartTotal.toFixed(2) }} JD</strong>
            </div>
            <p v-if="checkoutError" class="checkout-error" role="alert">{{ $t(checkoutError) }}</p>
            <div class="call-center-checkout-actions">
              <button v-if="callCenterClaimExpired" type="button" class="checkout-confirm btn-3d" @click="handleReconnect">
                {{ $t('Reconnect to order') }}
              </button>
              <button v-if="callCenterCommands.includes('send_as_held')" type="button" class="checkout-confirm btn-3d"
                :disabled="isHolding || isProcessing || !selectedOrderType" @click="handleCallCenterSave">
                {{ $t('Send as Held') }}
              </button>
              <button v-if="!callCenterClaimExpired && callCenterCommands.includes('save_changes')" type="button" class="checkout-confirm btn-3d"
                :disabled="isHolding || isProcessing || !selectedOrderType" @click="handleCallCenterSave">
                {{ $t('Save changes') }}
              </button>
              <button v-if="!callCenterClaimExpired && callCenterCommands.includes('send_follow_up')" type="button" class="checkout-confirm call-center-follow-up btn-3d"
                :disabled="isHolding || isProcessing" @click="handleCallCenterFollowUp">
                {{ $t('Save & send FOLLOW UP') }}
              </button>
              <button v-if="callCenterCommands.includes('cancel_edits')" type="button" class="call-center-secondary" @click="handleCancelEdits">
                {{ $t('Cancel edits') }}
              </button>
              <button v-if="callCenterCommands.includes('cancel_order')" type="button" class="call-center-danger" @click="showCallCenterCancel = !showCallCenterCancel">
                {{ $t('Cancel order') }}
              </button>
            </div>
            <div v-if="showCallCenterCancel" class="call-center-cancel-box">
              <div class="call-center-cancel-context">
                <strong data-no-i18n>{{ restoredHeldReference || `Phone #${restoredHeldOrder?.id || ''}` }}</strong>
                <span>{{ callCenterCancelItemCount }} {{ $t('items') }}</span>
                <span>
                  {{ $t(restoredHeldOrder?.kitchenFired ? 'Kitchen sent' : 'Not sent') }}
                  <template v-if="Number(restoredHeldOrder?.kitchenDispatchVersion) > 1">
                    · {{ $t('FOLLOW UP') }} #{{ Number(restoredHeldOrder.kitchenDispatchVersion) - 1 }}
                  </template>
                </span>
              </div>
              <label for="call-center-cancel-reason">{{ $t('Cancellation reason') }}</label>
              <select id="call-center-cancel-reason" v-model="callCenterCancelReason">
                <option disabled value="">{{ $t('Choose a reason') }}</option>
                <option v-for="reason in callCenterCancelReasons" :key="reason.value" :value="reason.value">{{ $t(reason.label) }}</option>
              </select>
              <button type="button" class="call-center-danger" :disabled="!callCenterCancelReason" @click="handleCancelCallCenterOrder">
                {{ $t('Confirm cancellation') }}
              </button>
            </div>
          </main>

          <main v-else class="checkout-payment-pane">
            <div class="checkout-section-heading">
              <h3>{{ $t('Payment Method') }}</h3>
            </div>

            <div class="checkout-methods" role="group" :aria-label="$t('Payment Method')">
              <button
                v-if="isPlatformOrderType"
                type="button"
                class="payment-option is-selected"
                aria-pressed="true"
                disabled
              >
                <i class="fa-solid fa-building-columns" aria-hidden="true"></i>
                <span>{{ $t('Platform') }}</span>
              </button>
              <button
                v-else
                type="button"
                class="payment-option"
                :class="{ 'is-selected': paymentMethod === 'cash' }"
                :disabled="!canPay"
                :aria-pressed="paymentMethod === 'cash'"
                @click="paymentMethod = 'cash'"
              >
                <i class="fa-solid fa-money-bill-wave" aria-hidden="true"></i>
                <span>{{ $t('CASH') }}</span>
              </button>

              <button
                v-if="!isPlatformOrderType"
                type="button"
                class="payment-option"
                :class="{ 'is-selected': paymentMethod === 'card' }"
                :disabled="!canPay"
                :aria-pressed="paymentMethod === 'card'"
                @click="paymentMethod = 'card'"
              >
                <i class="fa-regular fa-credit-card" aria-hidden="true"></i>
                <span>{{ $t('CARD') }}</span>
              </button>

              <button
                v-if="!isPlatformOrderType"
                type="button"
                class="payment-option"
                :class="{ 'is-selected': paymentMethod === 'split' }"
                :disabled="!canPay"
                :aria-pressed="paymentMethod === 'split'"
                @click="paymentMethod = 'split'"
              >
                <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
                <span>{{ $t('SPLIT') }}</span>
              </button>
            </div>

            <p v-if="!canPay && !activeTable && canHoldOrder" class="checkout-permission-note">
              {{ $t('You can hold this order, but you do not have permission to take payment.') }}
            </p>

            <Transition name="checkout-state">
              <p v-if="isPlatformOrderType" key="platform" class="checkout-card-note">
                {{ $t('Platform sales are revenue, but they are not cash or card collected at the register.') }}
              </p>
              <div v-else-if="paymentMethod === 'cash' && canPay" key="cash" class="cash-payment-content">
                <label class="checkout-label" for="checkout-tendered">{{ $t('Amount Tendered') }}</label>
                <div class="checkout-tendered">
                  <span data-no-i18n>JD</span>
                  <input
                    id="checkout-tendered"
                    v-model.number="amountTendered"
                    type="text"
                    inputmode="decimal"
                    enterkeyhint="done"
                    placeholder="0.00"
                    data-no-i18n
                  />
                </div>

                <div class="checkout-change change-row">
                  <span>{{ $t('Change Due') }}</span>
                  <strong :class="{ 'is-short': changeDue < 0 }" data-no-i18n>
                    {{ changeDue.toFixed(2) }} JD
                  </strong>
                </div>

                <p v-if="cashShortfall > 0" class="checkout-error">
                  {{ $t('Amount tendered is less than the total due.') }}
                </p>
              </div>

              <p v-else-if="paymentMethod === 'card' && canPay" key="card" class="checkout-card-note">
                {{ $t('Confirm the card payment on the terminal, then complete the order.') }}
              </p>

              <div v-else-if="paymentMethod === 'split' && canPay" key="split" class="split-payment-content">
                <div class="split-payment-fields">
                  <div>
                    <label class="checkout-label" for="checkout-split-card">{{ $t('Charge Card') }}</label>
                    <div class="checkout-tendered checkout-tendered--split">
                      <span data-no-i18n>JD</span>
                      <input
                        id="checkout-split-card"
                        v-model.number="splitCardAmount"
                        type="text"
                        inputmode="decimal"
                        enterkeyhint="next"
                        placeholder="0.00"
                        data-no-i18n
                      />
                    </div>
                  </div>
                  <div>
                    <label class="checkout-label" for="checkout-split-cash">{{ $t('Cash Tender') }}</label>
                    <div class="checkout-tendered checkout-tendered--split">
                      <span data-no-i18n>JD</span>
                      <input
                        id="checkout-split-cash"
                        v-model.number="splitCashTendered"
                        type="text"
                        inputmode="decimal"
                        enterkeyhint="done"
                        placeholder="0.00"
                        data-no-i18n
                      />
                    </div>
                  </div>
                </div>

                <div class="split-payment-summary">
                  <span>{{ $t('Card Amount') }}</span><strong data-no-i18n>{{ splitCardApplied.toFixed(2) }} JD</strong>
                  <span>{{ $t('Cash Amount') }}</span><strong data-no-i18n>{{ splitCashDue.toFixed(2) }} JD</strong>
                  <span>{{ $t('Balance Due') }}</span><strong :class="{ 'is-short': splitBalanceDue > 0 }" data-no-i18n>{{ splitBalanceDue.toFixed(2) }} JD</strong>
                  <span>{{ $t('Change Due') }}</span><strong data-no-i18n>{{ changeDue.toFixed(2) }} JD</strong>
                </div>

                <p v-if="splitCardInvalid" class="checkout-error">
                  {{ $t('Enter a card amount greater than zero and less than the total.') }}
                </p>
                <p v-else-if="splitBalanceDue > 0" class="checkout-error">
                  {{ $t('Cash received is less than the cash amount due.') }}
                </p>
              </div>
            </Transition>

            <p v-if="checkoutError" class="checkout-error" role="alert">
              {{ $t(checkoutError) }}
            </p>

            <button
              type="button"
              class="checkout-confirm btn-3d"
              :disabled="!canPay || isProcessing || isHolding || paymentBlocked"
              @click="processCheckout"
            >
              <span>
                <i v-if="isProcessing" class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
                {{ isProcessing ? $t('PROCESSING...') : $t(isPlatformOrderType ? 'CONFIRM PLATFORM SALE' : 'CONFIRM PAYMENT') }}
              </span>
              <strong data-no-i18n>{{ cartTotal.toFixed(2) }} JD</strong>
            </button>

          </main>

          <div class="checkout-customer-slot">
            <Transition name="checkout-panel">
              <aside v-if="showCustomerDrawer" class="checkout-customer-panel">
              <label for="checkout-customer-phone">{{ $t('Mobile No.') }}</label>
              <div class="checkout-customer-phone">
                <input
                  id="checkout-customer-phone"
                  v-model="customerPhone"
                  type="tel"
                  inputmode="tel"
                  enterkeyhint="done"
                  placeholder="07..."
                  data-no-i18n
                  @blur="lookupCustomer"
                />
                <div class="checkout-customer-phone-actions">
                  <i
                    v-if="isCustomerLoading"
                    class="checkout-customer-loading fa-solid fa-circle-notch fa-spin"
                    aria-hidden="true"
                  ></i>
                  <button
                    ref="phoneKeypadToggle"
                    type="button"
                    class="checkout-phone-keypad-toggle"
                    :class="{ 'is-active': phoneKeypadOpen }"
                    :aria-label="$t(phoneKeypadOpen ? 'Hide phone keypad' : 'Show phone keypad')"
                    :aria-expanded="phoneKeypadOpen"
                    aria-controls="checkout-phone-keypad"
                    @click="togglePhoneKeypad"
                  >
                    <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              <label for="checkout-customer-name">{{ $t('Name') }}</label>
              <input id="checkout-customer-name" v-model="customerName" type="text" inputmode="text" enterkeyhint="next" autocomplete="name" placeholder="..." />

              <label for="checkout-customer-address">{{ $t('Address') }}</label>
              <textarea
                id="checkout-customer-address"
                v-model="customerAddress"
                inputmode="text"
                enterkeyhint="done"
                autocomplete="street-address"
                rows="2"
                :placeholder="$t('Street, Bldg...')"
              ></textarea>

              <label for="checkout-order-date">{{ $t('Scheduled Date & Time') }}</label>
              <input id="checkout-order-date" v-model="orderDate" type="datetime-local" />

              <button
                v-if="hasCustomerDetails"
                type="button"
                class="checkout-clear-customer"
                @click="clearCustomer"
              >
                {{ $t('Clear customer') }}
              </button>
              </aside>
            </Transition>
          </div>
        </div>

        <Transition name="checkout-phone-keypad">
          <div
            v-if="phoneKeypadOpen"
            class="checkout-phone-keypad-layer"
            @click.self="closePhoneKeypad"
          >
            <section
              id="checkout-phone-keypad"
              ref="phoneKeypadSheet"
              class="checkout-phone-keypad-sheet"
              role="region"
              :aria-label="$t('Phone keypad')"
              tabindex="-1"
              @keydown.esc.stop="closePhoneKeypad"
            >
              <header class="checkout-phone-keypad-header">
                <div>
                  <strong>{{ $t('Mobile No.') }}</strong>
                  <span>{{ $t('Phone keypad') }}</span>
                </div>
                <button type="button" :aria-label="$t('Close')" @click="closePhoneKeypad">
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </header>

              <output class="checkout-phone-keypad-value" aria-live="polite" dir="ltr" data-no-i18n>
                {{ customerPhone || '07...' }}
              </output>

              <div class="checkout-phone-keypad-grid" dir="ltr">
                <button
                  v-for="digit in phoneKeypadDigits"
                  :key="digit"
                  type="button"
                  class="checkout-phone-key"
                  @click="appendPhoneDigit(digit)"
                >
                  {{ digit }}
                </button>
                <button type="button" class="checkout-phone-key checkout-phone-key--clear" @click="clearPhoneNumber">
                  {{ $t('Clear') }}
                </button>
                <button type="button" class="checkout-phone-key" @click="appendPhoneDigit('0')">0</button>
                <button
                  type="button"
                  class="checkout-phone-key checkout-phone-key--delete"
                  :aria-label="$t('Delete last digit')"
                  @click="backspacePhoneDigit"
                >
                  <i class="fa-solid fa-delete-left" aria-hidden="true"></i>
                </button>
              </div>

              <button type="button" class="checkout-phone-keypad-done" @click="finishPhoneKeypad">
                {{ $t('Done') }}
              </button>
            </section>
          </div>
        </Transition>
      </section>
    </div>
  </Transition>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { currentBusinessDate, formatBusinessTimeShort, formatBusinessDateTimeShort, toBusinessDate } from '@/utils/businessDate.js';
import { useCart } from '@/pos/useCart.js';
import { useTables } from '@/pos/useTables.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

const {
  showCheckoutModal,
  closeCheckoutModal,
  cartTotal,
  paymentMethod,
  amountTendered,
  splitCardAmount,
  splitCashTendered,
  changeDue,
  cashShortfall,
  splitBalanceDue,
  checkoutError,
  isProcessing,
  isHolding,
  processCheckout,
  pendingCheckout,
  canDiscardPendingCheckout,
  discardPendingCheckout,
  cart,
  showCustomerDrawer,
  customerPhone,
  customerName,
  customerAddress,
  orderDate,
  lookupCustomer,
  isCustomerLoading,
  orderTypes,
  selectedOrderType,
  defaultOrderTypeId,
  selectedOrderTypeRequiresHash,
  isDirectPlatformCheckout: isPlatformOrderType,
  hashNumber,
  handleOrderTypeSelection,
  syncCheckoutPaymentForOrderType,
  canCheckout,
  canCheckoutTable,
  restoredHeldReference,
  restoredHeldOrder,
  isCallCenter,
  callCenterCommands,
  sendCallCenterOrder,
  sendHeldOrderFollowUp,
  cancelCallCenterEdits,
  cancelCallCenterOrder,
  reconnectHeldOrder,
} = useCart();

const { activeTable, holdCurrentOrder } = useTables();
const { can } = usePermissions();
const checkoutDialog = ref(null);
const phoneKeypadOpen = ref(false);
const requestCloseCheckout = () => {
  if (!isProcessing.value && !isHolding.value) closeCheckoutModal();
};

usePosDialogFocus({
  open: showCheckoutModal,
  dialog: checkoutDialog,
  onEscape: () => {
    if (!phoneKeypadOpen.value) requestCloseCheckout();
  }
});
const phoneKeypadSheet = ref(null);
const phoneKeypadToggle = ref(null);
const phoneKeypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const showCallCenterCancel = ref(false);
const callCenterCancelReason = ref('');
const callCenterCancelReasons = [
  { value: 'customer_changed_mind', label: 'Customer changed mind' },
  { value: 'duplicate_order', label: 'Duplicate order' },
  { value: 'entered_in_error', label: 'Order entered incorrectly' },
  { value: 'other_customer_request', label: 'Other customer request' },
];
const callCenterCancelItemCount = computed(() => cart.value.reduce(
  (sum, item) => sum + Math.max(0, Number(item.qty || 0)),
  0,
));
const callCenterClaimExpired = computed(() => Boolean(
  restoredHeldOrder.value?.claimExpiresAt
  && new Date(restoredHeldOrder.value.claimExpiresAt).getTime() <= Date.now()
));

// Today's sale shows the time only; an older one carries its date.
const pendingStartedAt = computed(() => {
  const savedAt = Number(pendingCheckout.value?.savedAt);
  if (!savedAt) return '';
  return toBusinessDate(savedAt) === currentBusinessDate() ? formatBusinessTimeShort(savedAt) : formatBusinessDateTimeShort(savedAt);
});
// The frozen sale's lines, read-only, so a cashier who cleared the register still sees what is recovered.
const PENDING_LINES_SHOWN = 6;
const pendingItems = computed(() => {
  const items = pendingCheckout.value?.frozen?.cartSnapshot;
  return Array.isArray(items) ? items : [];
});
const pendingLines = computed(() => pendingItems.value.slice(0, PENDING_LINES_SHOWN)
  .map(item => ({ name: item?.name ?? item?.item_name ?? '', qty: Number(item?.qty) || 0 })));
const pendingMoreCount = computed(() => Math.max(0, pendingItems.value.length - PENDING_LINES_SHOWN));
const canPay = computed(() => canCheckout.value || canCheckoutTable.value);
const canHoldOrder = computed(() => can('pos.hold_orders'));
const showOrderTypePanel = computed(() => orderTypes.value.length > 0 && (!activeTable.value || selectedOrderTypeRequiresHash.value));
const hasCustomerDetails = computed(() => Boolean(
  customerPhone.value || customerName.value || customerAddress.value || orderDate.value
));
const moneyCents = value => Math.round(((Number(value) || 0) + Number.EPSILON) * 100);
const splitCardCents = computed(() => moneyCents(splitCardAmount.value));
const splitTotalCents = computed(() => moneyCents(cartTotal.value));
const splitCashTenderedCents = computed(() => moneyCents(splitCashTendered.value));
const splitCardApplied = computed(() => Math.max(0, splitCardCents.value) / 100);
const splitCashDue = computed(() => Math.max(0, splitTotalCents.value - splitCardCents.value) / 100);
const splitCardInvalid = computed(() => (
  splitCardCents.value <= 0 || splitCardCents.value >= splitTotalCents.value
));
const splitPaymentInvalid = computed(() => (
  splitCardInvalid.value || splitCashTenderedCents.value < moneyCents(splitCashDue.value)
));
const paymentBlocked = computed(() => (
  paymentMethod.value === 'split' ? splitPaymentInvalid.value : cashShortfall.value > 0
));

const handleCallCenterSave = async () => {
  const success = await sendCallCenterOrder();
  if (success) closeCheckoutModal();
};

const handleCallCenterFollowUp = async () => {
  const success = await sendHeldOrderFollowUp();
  if (success) closeCheckoutModal();
};

const handleCancelEdits = async () => {
  const success = await cancelCallCenterEdits();
  if (success) closeCheckoutModal();
};

const handleCancelCallCenterOrder = async () => {
  const confirmed = await window.showPosConfirm?.(t('Cancel this phone order and notify the kitchen if needed?'));
  if (!confirmed) return;
  const success = await cancelCallCenterOrder(callCenterCancelReason.value);
  if (success) {
    showCallCenterCancel.value = false;
    callCenterCancelReason.value = '';
    closeCheckoutModal();
  }
};

const handleReconnect = async () => {
  await reconnectHeldOrder();
};

const setCustomerPanel = (open) => {
  showCustomerDrawer.value = open;
};

const closePhoneKeypad = async () => {
  phoneKeypadOpen.value = false;
  await nextTick();
  phoneKeypadToggle.value?.focus();
};

const togglePhoneKeypad = async () => {
  if (phoneKeypadOpen.value) return closePhoneKeypad();
  phoneKeypadOpen.value = true;
  document.activeElement?.blur?.();
  await nextTick();
  phoneKeypadSheet.value?.focus();
};

const appendPhoneDigit = (digit) => {
  customerPhone.value = `${customerPhone.value || ''}${digit}`;
};

const backspacePhoneDigit = () => {
  customerPhone.value = String(customerPhone.value || '').slice(0, -1);
};

const clearPhoneNumber = () => {
  customerPhone.value = '';
};

const finishPhoneKeypad = async () => {
  await closePhoneKeypad();
  await lookupCustomer();
};

watch([showCheckoutModal, showCustomerDrawer], ([checkoutOpen, customerOpen]) => {
  if (!checkoutOpen || !customerOpen) phoneKeypadOpen.value = false;
  if (!checkoutOpen) {
    showCallCenterCancel.value = false;
    callCenterCancelReason.value = '';
  }
});

const handleHoldOrder = async () => {
  await holdCurrentOrder();
  if (cart.value.length === 0) closeCheckoutModal();
};

const clearOrderType = () => {
  selectedOrderType.value = null;
  hashNumber.value = '';
  syncCheckoutPaymentForOrderType();
};

const applyOrderType = (type) => {
  handleOrderTypeSelection(type);
  syncCheckoutPaymentForOrderType();
};

const toggleOrderType = (type) => {
  if (String(selectedOrderType.value) === String(type.id)) {
    if (defaultOrderTypeId.value !== null) {
      const defaultType = orderTypes.value.find(item => String(item.id) === String(defaultOrderTypeId.value));
      if (defaultType && String(defaultType.id) !== String(type.id)) applyOrderType(defaultType);
      return;
    }
    clearOrderType();
    return;
  }
  applyOrderType(type);
};

const clearCustomer = () => {
  customerPhone.value = '';
  customerName.value = '';
  customerAddress.value = '';
  orderDate.value = '';
};
</script>

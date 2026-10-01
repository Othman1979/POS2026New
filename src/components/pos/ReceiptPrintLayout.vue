<template>
  <!-- Print-Only Teleported Thermal Receipt -->
  <teleport to="body">
    <div v-if="lastOrder && !presentationError" class="receipt-print-wrapper">
      <div class="thermal-text-center">
        <h1 class="thermal-title" data-no-i18n>{{ storeName }}</h1>
        <p class="thermal-bold" data-no-i18n>{{ storeAddress }}</p>
        <p class="thermal-bold" data-no-i18n>{{ storePhone }}</p>
        <p v-if="receiptConfig?.customHeaderText" class="thermal-bold" data-no-i18n>{{ receiptConfig.customHeaderText }}</p>
      </div>
      <div class="thermal-dashed-line"></div>

      <div v-if="lastOrder">
        <div v-if="lastOrder.provisional && !lastOrder.guest_check" style="text-align: center; font-weight: 800; font-size: 11px; border: 2px solid black; padding: 4px 0; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em;">
          &#9654; PROVISIONAL &#8212; TOTALS CONFIRMED AT SYNC &#9654;
        </div>
        <div v-if="lastOrder.guest_check" class="thermal-text-center thermal-black">{{ $t('Guest check — not paid') }}</div>
        <div v-if="lastOrder.hash_number" class="thermal-text-center thermal-black" style="font-size: 16px;">
          #<span data-no-i18n>{{ lastOrder.hash_number }}</span>
        </div>
        <div class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t(receiptIdentityKey(lastOrder)) }} <span data-no-i18n>{{ receiptIdentityValue(lastOrder) }}</span></span>
        </div>
        <div class="thermal-flex thermal-justify-between thermal-bold">
          <span v-if="lastOrder.order_id">{{ $t('Order:') }} #<span data-no-i18n>{{ lastOrder.order_display_no || lastOrder.order_id }}</span></span>
          <span v-else></span>
          <span>{{ $t('Taken At:') }} <span data-no-i18n>{{ formatBusinessDateTime(lastOrder.order_taken_at || lastOrder.date) }}</span></span>
        </div>
        <div v-if="lastOrder.table_number && !lastOrder.table_display_no" class="thermal-flex thermal-justify-between thermal-black">
          <span>{{ $t('Table:') }} #<span data-no-i18n>{{ lastOrder.table_number }}</span></span>
        </div>
        <div class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t('Cashier:') }} <span data-no-i18n>{{ lastOrder.cashier }}</span></span>
          <span data-no-i18n>{{ lastOrder.order_type_name || '' }}</span>
        </div>
        <div v-if="taxNumber" class="thermal-bold">{{ $t('Seller tax number') }}: <span data-no-i18n>{{ taxNumber }}</span></div>
        <div v-if="lastOrder.note || lastOrder.order_note" class="thermal-bold thermal-italic" style="margin-top: 4px; text-align: left; white-space: pre-line;">
          {{ $t('Note:') }} <span data-no-i18n>{{ lastOrder.note || lastOrder.order_note }}</span>
        </div>
        <div class="thermal-dashed-line"></div>

        <div v-if="lastOrder.customer_name" style="margin-bottom: 8px; font-weight: 700; font-size: 11px;">
          <div style="margin-bottom: 2px;">{{ $t('Customer:') }} <span data-no-i18n>{{ lastOrder.customer_name }}</span></div>
          <div v-if="lastOrder.customer_phone" style="margin-bottom: 2px;">{{ $t('Phone:') }} <span data-no-i18n>{{ lastOrder.customer_phone }}</span></div>
          <div v-if="lastOrder.customer_address">{{ $t('Address:') }} <span data-no-i18n>{{ lastOrder.customer_address }}</span></div>
          <div style="border-bottom: 2px dashed black; margin-top: 8px;"></div>
        </div>

        <!-- Items table -->
        <div class="thermal-item-header">
          <div class="thermal-col-qty">{{ $t('Qty') }}</div>
          <div class="thermal-col-name">{{ $t('Item') }}</div>
          <div class="thermal-col-total">{{ $t('Total') }}</div>
        </div>
        <div class="thermal-solid-line"></div>

        <div v-for="item in presentation.rows" :key="item.key" class="thermal-item-row" style="flex-direction: column;">
          <div v-if="item.kind === 'item'" class="thermal-flex" style="width: 100%;">
            <div class="thermal-col-qty">{{ item.qty }}x</div>
            <div :class="['thermal-col-name', { 'font-arabic': isArabic(serviceChargeDisplayName(item, t)) }]" data-no-i18n>{{ serviceChargeDisplayName(item, t) }}</div>
            <div class="thermal-col-total">{{ item.netAmount.toFixed(2) }} JD</div>
          </div>
          <div v-if="item.kind === 'item' && item.lineDiscountLabel" class="thermal-item-note" style="color: #ef4444; font-weight: bold; margin-left: 15% !important;">
            {{ item.lineDiscountLabel }} Off (-{{ item.lineDiscountAmount.toFixed(2) }} JD)
          </div>
          <div v-if="item.kind === 'bundle_child'" class="thermal-flex text-gray-700" style="width: 100%; padding-left: 15px;">
            <div class="thermal-col-name" data-no-i18n>&bull; {{ item.name }} &times; {{ item.qty }}</div>
          </div>
          <div v-if="item.note && item.note !== 'Auto-Gratuity'" :class="['thermal-item-note', { 'font-arabic': isArabic(item.note) }]" data-no-i18n>
            - {{ item.note }}
          </div>
        </div>
        <div class="thermal-dashed-line"></div>

        <!-- Totals -->
        <div v-if="presentation.taxMode !== 'inclusive'" class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t('Subtotal') }}</span>
          <span>{{ presentation.summary.subtotal.toFixed(2) }} JD</span>
        </div>
        <div v-if="presentation.summary.orderDiscountAmount > 0" class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t('Discount') }}<template v-if="presentation.summary.orderDiscountLabel"> (<span data-no-i18n>{{ presentation.summary.orderDiscountLabel }}</span>)</template></span>
          <span>-{{ presentation.summary.orderDiscountAmount.toFixed(2) }} JD</span>
        </div>
        <div v-if="presentation.taxMode !== 'inclusive'" class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t('Tax') }}</span>
          <span v-if="presentation.summary.taxLabel" class="thermal-italic" style="font-size: 11px;">{{ $t(presentation.summary.taxLabel) }}</span>
          <span v-else>{{ presentation.summary.taxAmount.toFixed(2) }} JD</span>
        </div>
        <div v-if="Math.abs(presentation.summary.roundingAdjustment) > 0" class="thermal-flex thermal-justify-between thermal-bold">
          <span>{{ $t('Rounding') }}</span>
          <span>{{ presentation.summary.roundingAdjustment.toFixed(2) }} JD</span>
        </div>
        <div class="thermal-total-box">
          <span>{{ $t('TOTAL') }}</span>
          <span>{{ presentation.summary.total.toFixed(2) }} JD</span>
        </div>

        <!-- Payment Info -->
        <template v-if="lastOrder.payment_method === 'split'">
          <div class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Cash') }}</span>
            <span>{{ Number(lastOrder.cash_amount || 0).toFixed(2) }} JD</span>
          </div>
          <div class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Card') }}</span>
            <span>{{ Number(lastOrder.card_amount || 0).toFixed(2) }} JD</span>
          </div>
          <div v-if="Number(lastOrder.change_due || 0) > 0" class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Change') }}</span>
            <span>{{ Number(lastOrder.change_due).toFixed(2) }} JD</span>
          </div>
        </template>
        <template v-if="lastOrder.payment_method === 'platform' || lastOrder.payment_method === 'receivable'">
          <div>{{ $t('No payment was collected.') }}</div>
        </template>
        <template v-if="!['split', 'platform', 'receivable'].includes(lastOrder.payment_method)">
          <div class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Payment') }}</span>
            <span class="thermal-uppercase">{{ lastOrder.payment_method }}</span>
          </div>
          <div class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Tendered') }}</span>
            <span>{{ parseFloat(lastOrder.amount_tendered || 0).toFixed(2) }} JD</span>
          </div>
          <div class="thermal-flex thermal-justify-between thermal-bold">
            <span>{{ $t('Change') }}</span>
            <span>{{ parseFloat(lastOrder.change_due || 0).toFixed(2) }} JD</span>
          </div>
        </template>
        <div class="thermal-dashed-line"></div>

        <!-- Footer -->
        <div class="thermal-text-center thermal-bold" style="white-space: pre-line; margin-top: 6px;" data-no-i18n>
          {{ receiptConfig?.customFooterText || 'Thank you for your visit!' }}
        </div>
      </div>
    </div>
  </teleport>
</template>

<script>
import { useReceiptView } from '@/pos/receiptView.js';

// Browser printing prints this teleported layout (body.printing-thermal-receipt,
// global rules in pos.css). Small and always mounted with the terminal, so the
// first sale on a slow link prints the receipt instead of the screen.
export default {
  setup() {
    return useReceiptView();
  }
}
</script>

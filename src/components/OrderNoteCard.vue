<template>
  <article
    class="note-card card-cv"
    :class="{ 'note-card--error': order.receipt_display_error, 'note-card--intake': fromOrderIntake }"
  >
    <button type="button" class="note-card__open-target"
      :aria-label="`${$t('Order Details')}: ${order.isHeld ? `${$t(order.order_id ? 'Order' : 'Suspended')} #${order.order_display_no || order.order_id || order.id}` : orderIdentityLabel(order, $t || ((v) => v))}`"
      @click="$emit('open', order)"></button>

    <span v-if="order.receipt_display_error" class="note-card__warning"
      :title="order.receipt_display_error" aria-hidden="true">
      <i class="fa-solid fa-triangle-exclamation"></i>
    </span>

    <div class="note-card__top">
      <div class="note-card__identity">
        <strong data-no-i18n>
          {{ order.isHeld
            ? (($t(order.order_id ? 'Order' : 'Suspended')) + ' #' + (order.order_display_no || order.order_id || order.id))
            : orderIdentityLabel(order, $t || ((v) => v)) }}
        </strong>
        <span v-if="fromOrderIntake" class="note-card__ai">
          <i class="fa-solid fa-robot" aria-hidden="true"></i>
          {{ $t('AI order') }}
        </span>
        <span v-if="!order.isHeld && order.order_id" data-no-i18n>{{ $t('Order') }} {{ order.order_display_no || order.order_id }}</span>
      </div>

      <span v-if="order.delivery_date" class="note-card__scheduled">
        <i class="fa-solid fa-clock" aria-hidden="true"></i>
        <span data-no-i18n>{{ formatScheduledTime(order.delivery_date) }}</span>
      </span>
      <time v-else class="note-card__time" data-no-i18n>{{ formatTimeOnly(order.created_at) }}</time>
    </div>

    <p class="note-card__who">
      <span v-if="cardName" class="note-card__name" data-no-i18n>{{ cardName }}</span>
      <span class="note-card__count"><span data-no-i18n>{{ itemCount }}</span> {{ $t('items') }}</span>
    </p>

    <div class="note-card__context">
      <span class="note-card__type" :class="[accent.tint, accent.text]" data-no-i18n>
        {{ order.order_type_name || $t('Unspecified') }}
      </span>
      <span v-if="order.isHeld && order.raw_held_data?.kitchen_fired && !order.raw_held_data?.kitchen_baseline_known"
        class="note-card__chip note-card__baseline" :title="$t('Kitchen review')">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        {{ $t('Kitchen review') }}
      </span>
      <span v-if="claimIsActive" class="note-card__chip note-card__claim" :title="$t('Being edited')">
        <i class="fa-solid fa-pen" aria-hidden="true"></i>
        <span>{{ $t('Being edited') }}<span v-if="order.raw_held_data?.claim_owner_name" data-no-i18n>: {{ order.raw_held_data.claim_owner_name }}</span></span>
      </span>
      <span v-if="callCenterSourceName && !fromOrderIntake" class="note-card__chip note-card__source"
        :class="{ 'note-card__source--history': !order.isHeld }" :title="$t('Original call-center worker')">
        <i class="fa-solid fa-headset" aria-hidden="true"></i>
        <span data-no-i18n>{{ callCenterSourceName }}</span>
      </span>
      <span v-if="order.isHeld && order.call_center_user_id" class="note-card__chip note-card__kitchen-state"
        :class="{ 'note-card__kitchen-state--sent': order.raw_held_data?.kitchen_fired }">
        <i :class="order.raw_held_data?.kitchen_fired ? 'fa-solid fa-fire-flame-curved' : 'fa-regular fa-clock'" aria-hidden="true"></i>
        <span>{{ $t(order.raw_held_data?.kitchen_fired ? 'Kitchen sent' : 'Not sent') }}<template v-if="followUpSequence > 0"> · {{ $t('FOLLOW UP') }} #{{ followUpSequence }}</template></span>
      </span>
    </div>

    <div class="note-card__footer">
      <div class="note-card__total" :class="{ 'note-card__total--error': order.receipt_display_error }">
        <strong data-no-i18n>{{ totalDisplay }}</strong>
        <span>JD</span>
        <small>{{ $t('incl. tax') }}</small>
      </div>

      <div class="note-card__actions">
        <template v-if="order.isHeld">
          <button type="button" class="note-card__action note-card__action--kitchen"
            :disabled="claimIsActive || order.raw_held_data?.kitchen_fired || firingKitchen || !!order.receipt_display_error"
            :title="order.raw_held_data?.kitchen_fired ? $t('Kitchen sent') : $t('Fire to Kitchen')"
            :aria-label="order.raw_held_data?.kitchen_fired ? $t('Kitchen sent') : $t('Fire to Kitchen')"
            @click.stop="$emit('fire', order)">
            <i :class="firingKitchen ? 'fa-solid fa-spinner fa-spin' : (order.raw_held_data?.kitchen_fired ? 'fa-solid fa-check' : 'fa-solid fa-fire')" aria-hidden="true"></i>
          </button>
          <button type="button" class="note-card__action note-card__action--restore"
            :title="$t('Restore Ticket')" :disabled="(claimIsActive && !restoreResumable) || !!order.receipt_display_error"
            @click.stop="$emit('restore', order)">
            <i class="fa-solid fa-file-import" aria-hidden="true"></i>
            <span>{{ $t('Restore') }}</span>
          </button>
          <button type="button" class="note-card__action note-card__action--cancel"
            :title="$t('Cancel suspended order')" :aria-label="$t('Cancel suspended order')"
            :disabled="claimIsActive || !!order.receipt_display_error"
            @click.stop="$emit('cancel', order)">
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
          </button>
        </template>
        <button v-if="order.isHeld || canReprint" type="button" class="note-card__action note-card__action--reprint"
          :title="$t(order.isHeld ? 'Print Receipt' : 'Reprint Receipt')" :aria-label="$t(order.isHeld ? 'Print Receipt' : 'Reprint Receipt')"
          :disabled="!!order.receipt_display_error" @click.stop="$emit('reprint', order)">
          <i class="fa-solid fa-print" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  </article>
</template>

<script setup>
import { computed } from 'vue';
import { getTypeAccent } from '../utils/orderTypeAccent.js';
import { orderIdentityLabel } from '../utils/orderIdentityDisplay.js';
import { formatTimeOnly, formatScheduledTime } from '../utils/orderNotesFormat.js';

const props = defineProps({
  order: { type: Object, required: true },
  firingKitchen: { type: Boolean, default: false },
  // Bumped by the board at the next lease expiry so claimIsActive re-evaluates.
  claimClock: { type: Number, default: 0 },
  restoreResumable: { type: Boolean, default: false },
  // A paid receipt's reprint needs pos.reprint_receipt (the server enforces it too).
  canReprint: { type: Boolean, default: false },
});
defineEmits(['open', 'fire', 'restore', 'cancel', 'reprint']);

const accent = computed(() => getTypeAccent(props.order.order_type_name || 'Unspecified'));
const claimIsActive = computed(() => {
  void props.claimClock;
  const expiresAt = props.order.raw_held_data?.claim_expires_at;
  return Boolean(props.order.raw_held_data?.claimed_by_user_id && expiresAt && new Date(expiresAt).getTime() > Date.now());
});
// Held by the automated order intake (the AI phone gateway): tinted so staff spot it at once.
const fromOrderIntake = computed(() => Boolean(props.order.isHeld && Number(props.order.raw_held_data?.from_order_intake) === 1));
const itemCount = computed(() => (props.order.items ? props.order.items.length : 0));
const callCenterSourceName = computed(() => (
  props.order.call_center_user_name || props.order.raw_held_data?.call_center_user_name || ''
));
const followUpSequence = computed(() => Math.max(0, Number(props.order.raw_held_data?.kitchen_dispatch_version || 0) - 1));
const cardName = computed(() => {
  const order = props.order;
  if (order.customer_name) return order.customer_name;
  const reference = ((order.raw_held_data && order.raw_held_data.reference_name) || '').toString().trim();
  return reference && !/^#?\d+$/.test(reference) ? reference : '';
});
const totalDisplay = computed(() => {
  const order = props.order;
  if (order.receipt_display_v1?.summary) return order.receipt_display_v1.summary.total.toFixed(2);
  return parseFloat(order.total || 0).toFixed(2);
});
</script>

<style scoped>
/* One order per row inside its lane: identity and time, who it is for, state chips, then the
   total and the actions. Rows sit edge to edge with a divider, not as cards in a card. The row is
   its own size container, so a narrow lane stacks the footer instead of squeezing it. */
.note-card {
  position: relative;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 0;
  background: var(--notes-card, #f9fafb);
  color: var(--notes-ink, #111827);
  cursor: pointer;
  transition: background-color 150ms ease-out;
}

/* Rows have fractional heights, so a divider can land between device pixels. Each divider is
   drawn as the top edge of the row below it: a row paints its own border after its own fill and
   after the row above, so no fill (resting, hover, error) can cover a divider. */
.note-card + .note-card {
  border-top: 1px solid var(--notes-line, #c2c8d0);
}

.note-card:last-child {
  border-bottom: 1px solid var(--notes-line, #c2c8d0);
}

.note-card:hover {
  background: var(--notes-card-hover, #ffffff);
}

.note-card:active {
  background: var(--notes-surface-muted, #e7eaef);
}

.note-card__open-target {
  position: absolute;
  inset: 0;
  z-index: 1;
  border: 0;
  border-radius: inherit;
  background: transparent;
}

.note-card__action:focus-visible {
  outline: 2px solid var(--notes-teal, #24405e);
  outline-offset: 2px;
}

/* Rows reach the edges of the lane's scrollport, so the row outline sits inside the row. */
.note-card__open-target:focus-visible {
  outline: 2px solid var(--notes-teal, #24405e);
  outline-offset: -3px;
}

/* AI-intake holds keep the neutral row (so every button reads the same) and carry an amber
   inline-start edge plus an "AI order" tag next to the number. */
.note-card--intake {
  border-inline-start: 4px solid var(--notes-intake-edge, #d4a72c);
}

.note-card__ai {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid var(--notes-review-line, #dcc88f);
  border-radius: 6px;
  background: var(--notes-review-card, #f7eed6);
  color: var(--notes-review-ink, #6b4e14);
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}

.note-card--error {
  background: var(--notes-error-card, #fbf1f2);
  border-inline-start: 3px solid var(--notes-error-ink, #9f1239);
}

.note-card__warning {
  position: absolute;
  inset-block-start: 12px;
  inset-inline-end: 12px;
  color: var(--notes-error-ink, #9f1239);
  font-size: 0.875rem;
}

.note-card__top,
.note-card__footer,
.note-card__identity,
.note-card__actions {
  display: flex;
  align-items: center;
}

.note-card__top {
  justify-content: space-between;
  gap: 10px;
}

.note-card--error .note-card__top {
  padding-inline-end: 22px;
}

.note-card__identity {
  min-width: 0;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  font-variant-numeric: tabular-nums;
}

.note-card__identity strong {
  color: var(--notes-ink, #111827);
  font-size: 1.02rem;
  font-weight: 800;
  line-height: 1.3;
}

.note-card__identity > span,
.note-card__time {
  flex: 0 0 auto;
  color: var(--notes-muted, #5b6675);
  font-size: 0.8rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.note-card__scheduled {
  flex: 0 0 auto;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--notes-review-line, #d9c58c);
  border-radius: 6px;
  background: var(--notes-review-card, #f5ecd3);
  color: var(--notes-review-ink, #6b4e14);
  font-size: 0.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.note-card__who {
  min-width: 0;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.4;
}

.note-card__name {
  min-width: 0;
  unicode-bidi: plaintext;
  overflow: hidden;
  color: var(--notes-ink, #111827);
  font-size: 0.9rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-card__count {
  flex: 0 0 auto;
  color: var(--notes-muted, #5b6675);
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
}

.note-card__context {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.note-card__type,
.note-card__chip {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 100%;
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
}

/* The source name is the chip that gives way (chips wrap, so every state stays visible). Its
   text takes its own direction, so an English name in an Arabic row is cut at its end. */
.note-card__source {
  flex: 0 1 auto;
}

.note-card__chip > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
}

.note-card__type {
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-card__source,
.note-card__kitchen-state {
  border-color: var(--notes-line, #c2c8d0);
  background: var(--notes-surface-muted, #e7eaef);
  color: var(--notes-muted, #4b5563);
}

.note-card__source {
  color: var(--notes-teal, #24405e);
}

.note-card__kitchen-state--sent {
  color: var(--notes-ink, #111827);
}

.note-card__baseline,
.note-card__claim {
  border-color: var(--notes-review-line, #d9c58c);
  background: var(--notes-review-card, #f5ecd3);
  color: var(--notes-review-ink, #6b4e14);
}

.note-card__footer {
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px;
  margin-top: 2px;
}

.note-card__total {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 4px;
  color: var(--notes-muted, #5b6675);
  white-space: nowrap;
}

.note-card__total strong {
  color: var(--notes-ink, #111827);
  font-size: 1.3rem;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.note-card__total > span {
  font-size: 0.8rem;
  font-weight: 700;
}

.note-card__total small {
  margin-inline-start: 2px;
  font-size: 0.72rem;
  font-weight: 600;
}

.note-card__total--error strong {
  color: var(--notes-error-ink, #9f1239);
}

.note-card__actions {
  position: relative;
  z-index: 2;
  flex: 0 1 auto;
  gap: 6px;
}

.note-card__action {
  min-width: 46px;
  min-height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0;
  border: 1px solid var(--notes-line, #c2c8d0);
  border-radius: 8px;
  background: var(--notes-surface-muted, #e7eaef);
  color: var(--notes-muted, #4b5563);
  font-size: 0.85rem;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 2px 0 var(--notes-tactile-edge, #a5b0b9);
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}

.note-card__action:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: none;
}

.note-card__action--restore {
  padding: 0 16px;
  border-color: var(--notes-teal, #24405e);
  background: var(--notes-teal, #24405e);
  color: #fff;
  box-shadow: 0 2px 0 var(--notes-teal-edge, #14263a);
}

.note-card__action--kitchen {
  border-color: var(--notes-review-line, #d9c58c);
  background: var(--notes-review-card, #f5ecd3);
  color: var(--notes-review-ink, #6b4e14);
}

.note-card__action--cancel {
  border-color: var(--notes-error-line, #d7a6ad);
  background: var(--notes-error-card, #fbf1f2);
  color: var(--notes-error-ink, #9f1239);
}

.note-card__action:hover:not(:disabled) {
  filter: brightness(0.96);
}

.note-card__action:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

/* Narrow card (phone, a thin lane): the total gets its own line and the actions share the
   full width, Restore taking the spare room. */
@container (max-width: 350px) {
  .note-card__footer {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  .note-card__actions {
    width: 100%;
  }

  .note-card__action {
    flex: 0 0 auto;
  }

  .note-card__action--restore {
    flex: 1 1 auto;
  }
}

.card-cv {
  content-visibility: auto;
  contain-intrinsic-size: auto 124px;
}

@media (prefers-reduced-motion: reduce) {
  .note-card,
  .note-card__action {
    transition-duration: 0.01ms;
  }
}
</style>

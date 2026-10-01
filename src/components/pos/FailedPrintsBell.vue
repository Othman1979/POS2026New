<template>
  <!--
    The count arrives over the `failed_print_jobs_count` socket event, so the trigger is
    live without polling. The list is fetched only when the modal opens - a till that never
    has a failure never issues the request.
  -->
  <template v-if="visible">
    <!--
      catalog-icon-action is the toolbar's existing icon-button class: 2.75rem wide, full
      toolbar height, square corners and the inset bottom edge, with dark, hover and active
      variants already written. It was defined in pos.css and unused. Using it makes this
      button identical to the user-initials trigger beside it for free - measured, the two
      now render at the same size and radius - and keeps the alert signal in the badge,
      where a notification count belongs, rather than recolouring a toolbar control.
    -->
    <button type="button" @click="open" class="catalog-icon-action failed-prints-trigger relative"
      :aria-label="$t('Failed prints')" :title="$t('Failed prints')">
      <i class="fa-solid fa-triangle-exclamation failed-prints-icon" aria-hidden="true"></i>
      <span class="failed-prints-count" data-no-i18n>{{ count > 9 ? '9+' : count }}</span>
    </button>

    <!--
      Teleported so no stacking context in the toolbar can trap it. That puts it outside
      the root element carrying `pos-theme-dark`, so the theme classes are re-applied here
      on the backdrop, exactly as ExpenseModal does - otherwise the modal renders light on
      a dark till.
    -->
    <Teleport to="body">
      <Transition name="pos-modal">
        <!--
          Two elements, not one: pos-modal-backdrop is styled by `.pos-polish
          .pos-modal-backdrop`, a descendant selector, so the theme wrapper has to be a
          separate parent or the rule never matches and the dimming falls back to whatever
          utility class is on the element. That shared backdrop is what CheckoutModal and
          SplitCheckModal use - 68% rather than an opaque sheet, so the till stays visible
          behind the dialog instead of looking like the app changed screens.
        -->
        <div v-if="isOpen" :class="['pos-polish', { 'pos-theme-dark': props.isDarkMode }]">
          <div class="pos-modal-backdrop fixed inset-0 z-[130] flex items-center justify-center no-select p-4"
            @click.self="close">
            <div ref="dialog" class="modal-panel bg-surface-container-lowest w-full max-w-md rounded-2xl shadow-xl flex flex-col overflow-hidden border border-outline-variant/30 max-h-[85vh]"
              role="dialog" aria-modal="true" :aria-label="$t('Failed prints')" tabindex="-1">

            <div class="modal-header px-5 sm:px-6 py-4 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0">
              <div class="min-w-0">
                <h3 class="font-headline font-bold text-on-surface text-base sm:text-lg tracking-tight">{{ $t('Failed prints') }}</h3>
                <p class="text-[10px] sm:text-[11px] text-on-surface-variant font-bold mt-0.5 uppercase tracking-widest">
                  {{ $t('Tickets that did not reach the printer') }}
                </p>
              </div>
              <button type="button" @click="close" :aria-label="$t('Close')"
                class="text-on-surface-variant hover:text-error transition-colors w-10 h-10 flex items-center justify-center rounded-full bg-surface-container-lowest shadow-sm border border-outline-variant/30 shrink-0">
                <i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
              </button>
            </div>

            <div class="modal-body flex-1 overflow-y-auto bg-surface premium-scroll">
              <div v-if="loading" class="flex flex-col items-center gap-3 py-12 px-5 text-center">
                <i class="fa-solid fa-circle-notch fa-spin text-2xl text-primary" aria-hidden="true"></i>
                <span class="text-xs font-bold text-on-surface-variant">{{ $t('Loading...') }}</span>
              </div>

              <div v-else-if="loadError" class="flex flex-col items-center gap-3 py-12 px-5 text-center">
                <i class="fa-solid fa-plug-circle-xmark text-2xl text-error" aria-hidden="true"></i>
                <span class="text-xs font-bold text-on-surface-variant">{{ $t('Could not load failed prints.') }}</span>
                <button type="button" @click="load"
                  class="btn-3d mt-1 px-5 py-3 bg-surface-container-low border border-outline-variant/40 text-on-surface font-black rounded-xl text-[11px] uppercase tracking-widest">
                  {{ $t('Retry') }}
                </button>
              </div>

              <div v-else-if="!jobs.length" class="flex flex-col items-center gap-3 py-12 px-5 text-center">
                <div class="w-16 h-16 bg-surface-container-lowest rounded-full flex items-center justify-center border border-outline-variant/30 shadow-sm">
                  <i class="fa-solid fa-check text-2xl text-primary" aria-hidden="true"></i>
                </div>
                <span class="text-xs font-bold text-on-surface-variant">{{ $t('Nothing failed to print.') }}</span>
              </div>

              <article v-for="job in jobs" :key="job.id"
                class="flex items-center gap-3 px-5 sm:px-6 py-3.5 border-b border-outline-variant/20 last:border-b-0">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span :class="['failed-prints-chip', job.print_type === 'kitchen' ? 'is-kitchen' : 'is-receipt']">
                      {{ $t(typeLabel(job.print_type)) }}
                    </span>
                    <span v-if="!job.reprintable" class="failed-prints-chip is-retrying">
                      <i class="fa-solid fa-rotate fa-spin text-[8px]" aria-hidden="true"></i>
                      {{ $t('Retrying') }}
                    </span>
                    <span class="text-sm font-black text-on-surface tabular-nums" data-no-i18n>{{ reference(job) }}</span>
                  </div>
                  <div class="flex items-center gap-1.5 flex-wrap mt-1 text-[10px] font-bold text-on-surface-variant">
                    <span data-no-i18n>{{ job.printer_name || $t('Unknown printer') }}</span>
                    <span aria-hidden="true">·</span>
                    <span data-no-i18n>{{ formatTime(job.created_at) }}</span>
                    <template v-if="job.last_error_code">
                      <span aria-hidden="true">·</span>
                      <span class="text-error" data-no-i18n>{{ job.last_error_code }}</span>
                    </template>
                  </div>
                </div>

                <button v-if="job.reprintable" type="button" @click="reprint(job)" :disabled="reprintingId === job.id"
                  class="btn-3d shrink-0 min-h-[44px] px-4 action-gradient text-on-primary font-black rounded-xl text-[11px] uppercase tracking-widest shadow-md disabled:opacity-50 inline-flex items-center gap-2"
                  style="--shadow-color: #2b4b71;" :aria-label="$t('Reprint')">
                  <i :class="['fa-solid', reprintingId === job.id ? 'fa-circle-notch fa-spin' : 'fa-print']" aria-hidden="true"></i>
                  <span>{{ $t('Reprint') }}</span>
                </button>
              </article>
            </div>

              <div v-if="actionError" class="modal-footer px-5 sm:px-6 py-3 border-t border-outline-variant/20 bg-surface-container-low shrink-0">
                <p class="text-[11px] font-bold text-error" role="alert">{{ $t(actionError) }}</p>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </template>
</template>

<script setup>
import { formatBusinessTimeShort } from '@/utils/businessDate.js';
import { ref, computed, watch } from 'vue';
import { fetchJsonResponseWithTimeout, fetchReadJsonResponse, isUnansweredRequest } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';
import { useSocket } from '@/pos/useSocket.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { useAuth } from '@/pos/useAuth.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

const props = defineProps({
    isDarkMode: { type: Boolean, default: false }
});

const { failedPrintJobsCount } = useSocket();
const { can } = usePermissions();
const auth = useAuth();

const isOpen = ref(false);
const loading = ref(false);
const loadError = ref(false);
const actionError = ref('');
const jobs = ref([]);
const reprintingId = ref(null);
const dialog = ref(null);

const count = computed(() => Number(failedPrintJobsCount.value) || 0);

// Call-center users never print, and a cashier without the reprint permission cannot act
// on anything in here - the backend rejects both the list and the reprint. Hiding it is
// cosmetic; the server remains authoritative.
const visible = computed(() =>
    auth.activeUser?.value?.role !== 'call_center'
    && can('pos.reprint_receipt')
    && count.value > 0
);

// A modal that stayed open while its count emptied would keep offering a reprint for a job
// that has since printed. Any other change re-reads the open list, so a job that finished
// retrying or a new failure shows without reopening. Not during a reprint: its own count
// tick would bring back the row being reprinted before the server answers.
watch(count, value => {
    if (value === 0) close();
    else if (isOpen.value && !reprintingId.value) load();
});

function open() {
    isOpen.value = true;
    actionError.value = '';
    load();
}

// Reopening must never show what the queue looked like last time.
function close() {
    isOpen.value = false;
    jobs.value = [];
    loadError.value = false;
}

usePosDialogFocus({ open: isOpen, dialog, onEscape: close });

// One read at a time; a change that lands mid-read queues exactly one follow-up.
let loadRun = null;
let reloadRequested = false;
function load() {
    if (loadRun) { reloadRequested = true; return loadRun; }
    loading.value = true;
    loadError.value = false;
    loadRun = (async () => {
        do {
            reloadRequested = false;
            try {
                const { response, data } = await fetchReadJsonResponse('api/admin/print-queue/failed');
                if (!response.ok || !data?.success) throw new Error('load failed');
                if (isOpen.value) { jobs.value = Array.isArray(data.jobs) ? data.jobs : []; loadError.value = false; }
            } catch {
                if (isOpen.value) { loadError.value = true; jobs.value = []; }
            }
        } while (reloadRequested && isOpen.value);
    })().finally(() => {
        loadRun = null;
        loading.value = false;
    });
    return loadRun;
}

async function reprint(job) {
    if (reprintingId.value) return;
    const uncertain = job.last_failure_class === 'uncertain';
    if (uncertain && !(await window.showPosConfirm(t('This ticket may already have printed. Check the paper and complete printer recovery first. Queue a reprint?')))) return;
    reprintingId.value = job.id;
    actionError.value = '';
    try {
        const { response, data } = await fetchJsonResponseWithTimeout(`api/admin/print-queue/${job.id}/reprint`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'pos_failed_print_bell', confirm_uncertain: uncertain })
        });
        if (!response.ok || !data?.success) {
            // The server owns the rule. A 409 means the job moved while the modal was
            // open, so re-read rather than leaving a button that cannot work.
            actionError.value = response.status === 409
                ? 'That job can no longer be reprinted.'
                : 'Reprint failed. Please try again.';
            await load();
            return;
        }
        // The reprint is a new queue row and the server now treats the original as
        // resolved, so drop it here too rather than waiting for the next socket tick.
        jobs.value = jobs.value.filter(row => row.id !== job.id);
    } catch (error) {
        // A lost answer may still have queued the reprint: say so, never resend by itself.
        actionError.value = isUnansweredRequest(error)
            ? 'Printing was not confirmed. Check Printing before retrying.'
            : 'Reprint failed. Please try again.';
    } finally {
        reprintingId.value = null;
    }
}

function typeLabel(printType) {
    if (printType === 'kitchen') return 'Kitchen';
    if (printType === 'receipt') return 'Receipt';
    return 'Report';
}

// Prefer the number a cashier can actually match to a paper ticket or a screen.
function reference(job) {
    const ref = job.invoice_display_no || job.order_display_no;
    if (ref) return `#${ref}`;
    if (job.table_number) return `#${job.table_number}`;
    return `#${job.id}`;
}

function formatTime(value) {
    if (!value) return '';
    return formatBusinessTimeShort(value);
}
</script>

<style scoped>
/*
  Only what the design system does not already provide. The modal itself is built from the
  shared modal-panel/modal-header/modal-body classes and semantic colour tokens, so it
  follows the dark theme without a single colour repeated here.
*/

/* Geometry, borders, hover and both themes come from catalog-icon-action. Only the badge
   anchor is added here. */
.failed-prints-trigger {
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
}

/* Tint the glyph rather than the button: the shared rule sets the button's own colour
   (with !important in the dark variant), so recolouring the control would either lose or
   need to fight it. A child element is not covered by that rule. */
/* Nudged down so the centred glyph clears the badge in the top corner. Vertical only, so
   it holds in both directions without an RTL variant. */
.failed-prints-icon {
    color: var(--color-error);
    font-size: 0.8125rem;
    transform: translateY(0.1875rem);
}

/* Wholly inside the button. A badge hung off the corner the usual way is clipped here:
   this toolbar is the first row on the screen, so a negative top has nothing above it to
   overflow into - measured at 3px above the viewport, with 4px past the button's right
   edge as well. The button is 44x45, which is roomy enough to hold the badge indoors. */
.failed-prints-count {
    position: absolute;
    top: 0.125rem;
    inset-inline-end: 0.125rem;
    min-width: 0.9375rem;
    height: 0.9375rem;
    padding: 0 0.1875rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: var(--color-error);
    color: #fff;
    font-size: 0.5625rem;
    font-weight: 900;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
}

.failed-prints-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.4375rem;
    border-radius: 0.3125rem;
    font-size: 0.5625rem;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
    border: 1px solid;
}
/* Tinted from the palette rather than fixed hexes, so both themes stay legible. */
.failed-prints-chip.is-kitchen {
    background: color-mix(in srgb, var(--color-tertiary, var(--color-primary)) 12%, transparent);
    color: var(--color-tertiary, var(--color-primary));
    border-color: color-mix(in srgb, var(--color-tertiary, var(--color-primary)) 30%, transparent);
}
.failed-prints-chip.is-receipt {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    color: var(--color-primary);
    border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.failed-prints-chip.is-retrying {
    background: color-mix(in srgb, var(--color-on-surface-variant) 10%, transparent);
    color: var(--color-on-surface-variant);
    border-color: color-mix(in srgb, var(--color-on-surface-variant) 25%, transparent);
}

@media (prefers-reduced-motion: reduce) {
    .failed-prints-trigger:active { transform: none; }
}
</style>

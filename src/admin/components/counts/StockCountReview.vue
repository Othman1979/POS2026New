<template>
    <section class="pi-pane pi-editor-pane lg-book ct-book" :class="{ 'lg-book--posted': posted }" :aria-busy="loading || posting">
        <div class="lg-toolbar">
            <button type="button" class="lg-btn pi-back" :disabled="pendingPost" @click="$emit('back')">
                <i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to list') }}
            </button>
            <span class="lg-state" :class="posted ? 'lg-state--posted' : 'lg-state--draft'">{{ posted ? $t('Posted count') : $t('Review differences') }}</span>
            <span class="lg-grow"></span>
            <button type="button" class="lg-btn" :aria-label="$t('New count')" :disabled="pendingPost" @click="$emit('request-new')">
                <i class="fa-solid fa-plus" aria-hidden="true"></i><span class="lg-btn-label">{{ $t('New count') }}</span>
            </button>
        </div>

        <div class="lg-desk">
            <div class="lg-page">
                <header class="lg-head">
                    <div class="lg-title">
                        <span class="lg-cap">{{ $t('Stock count') }}</span>
                        <h3 class="ct-title" data-no-i18n>{{ info.reference || titleFallback }}</h3>
                    </div>
                    <div class="lg-blanks">
                        <div class="lg-blank">
                            <span class="lg-cap">{{ $t('Date') }}</span>
                            <bdi class="pi-num ct-val" data-no-i18n>{{ String(info.count_date || '').slice(0, 10) }}</bdi>
                        </div>
                        <div v-if="posted && info.posted_by_name" class="lg-blank">
                            <span class="lg-cap">{{ $t('Posted by') }}</span>
                            <span class="ct-val" data-no-i18n>{{ info.posted_by_name }}</span>
                        </div>
                    </div>
                    <div v-if="posted && !loading" class="lg-stamp lg-stamp--posted" aria-hidden="true">{{ $t('Posted') }}</div>
                </header>

                <p v-if="loading" class="lg-note" role="status">{{ $t('Loading...') }}</p>
                <p v-else-if="posted" class="lg-note">{{ $t('Posted counts cannot be edited.') }}</p>
                <p v-else-if="!totals.counted_count" class="lg-note lg-note--warn">{{ $t('Nothing has been counted yet. Count at least one item before posting.') }}</p>

                <div v-if="!loading" class="ct-sheet ct-review" role="table" :aria-label="$t('Differences')">
                    <div class="ct-rrow ct-rrow--head" role="row">
                        <span class="ct-c-no" role="columnheader">#</span>
                        <span class="ct-r-item" role="columnheader">{{ $t('Item') }}</span>
                        <span class="ct-r-counted" role="columnheader">{{ $t('Counted') }}</span>
                        <span class="ct-r-expected" role="columnheader">{{ $t('Expected') }}</span>
                        <span class="ct-r-diff" role="columnheader">{{ $t('Difference') }}</span>
                        <span class="ct-r-value" role="columnheader">{{ $t('Value') }}</span>
                    </div>
                    <div v-for="(line, index) in counted" :key="line.id" class="ct-rrow" role="row">
                        <span class="ct-c-no pi-num" role="cell" data-no-i18n>{{ index + 1 }}</span>
                        <span class="ct-r-item" role="cell"><span data-no-i18n>{{ line.name }}</span><small class="ct-sub" data-no-i18n>{{ groupText(line) }}</small></span>
                        <span class="ct-r-counted" role="cell" :data-label="$t('Counted')"><bdi class="pi-num" data-no-i18n>{{ qtyText(line.counted_base_qty) }}</bdi> <small data-no-i18n>{{ unitName(line) }}</small></span>
                        <span class="ct-r-expected" role="cell" :data-label="$t('Expected')"><bdi class="pi-num" data-no-i18n>{{ qtyText(line.expected_qty) }}</bdi></span>
                        <span class="ct-r-diff" role="cell" :class="tone(line.variance_qty)" :data-label="$t('Difference')"><bdi class="pi-num" data-no-i18n>{{ signed(line.variance_qty, true) }}</bdi> <small data-no-i18n>{{ unitName(line) }}</small></span>
                        <span class="ct-r-value" role="cell" :class="tone(line.variance_value)" :data-label="$t('Value')"><bdi class="pi-num" data-no-i18n>{{ signed(line.variance_value) }}</bdi></span>
                    </div>
                    <p v-if="!counted.length" class="lg-note ct-empty">{{ $t('No counted items.') }}</p>

                    <template v-if="uncounted.length">
                        <div class="ct-group" role="row">
                            <span aria-hidden="true"></span>
                            <span class="ct-group-text" role="cell">{{ $t('Not counted — stays unchanged') }} <bdi class="pi-num" data-no-i18n>{{ uncounted.length }}</bdi></span>
                        </div>
                        <div v-for="line in uncounted" :key="line.id" class="ct-rrow ct-rrow--faint" role="row">
                            <span class="ct-c-no"></span>
                            <span class="ct-r-item" role="cell"><span data-no-i18n>{{ line.name }}</span><small class="ct-sub" data-no-i18n>{{ groupText(line) }}</small></span>
                            <span class="ct-r-expected" role="cell" :data-label="$t('Expected')"><bdi class="pi-num" data-no-i18n>{{ qtyText(line.expected_qty) }}</bdi></span>
                        </div>
                    </template>
                    <div class="lg-spare" aria-hidden="true"></div>
                </div>

                <div v-if="!loading" class="lg-sums">
                    <div class="lg-sum"><span class="lg-c-no"></span><span>{{ $t('Shortage value') }}</span><bdi class="pi-num ct-neg" data-no-i18n>{{ totals.shortage_value }}</bdi></div>
                    <div class="lg-sum"><span class="lg-c-no"></span><span>{{ $t('Surplus value') }}</span><bdi class="pi-num" data-no-i18n>{{ totals.surplus_value }}</bdi></div>
                    <div class="lg-sum lg-sum--total"><span class="lg-c-no"></span><span>{{ $t('Net difference') }}</span><bdi class="pi-num" :class="tone(totals.net_value)" data-no-i18n>{{ signed(totals.net_value) }} <small>JD</small></bdi></div>
                </div>
            </div>
        </div>

        <footer class="lg-foot">
            <div v-if="loadError || errorText || pendingPost" class="lg-messages">
                <p v-if="loadError" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ loadError }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" @click="load">{{ $t('Retry') }}</button>
                </p>
                <p v-if="pendingPost" class="lg-msg lg-msg--warn" role="alert">
                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>{{ $t('The result is unconfirmed. Check it before trying again.') }}</span>
                    <button type="button" class="lg-btn lg-btn--sm" :disabled="posting" @click="checkOutcome">{{ $t('Check result') }}</button>
                </p>
                <p v-if="errorText" class="lg-msg lg-msg--error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ errorText }}</span></p>
            </div>
            <div class="lg-actions">
                <template v-if="posted">
                    <button type="button" class="lg-btn" @click="$emit('back')"><i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to list') }}</button>
                </template>
                <template v-else>
                    <button type="button" class="lg-btn" :disabled="posting || pendingPost" @click="$emit('back-to-counting')"><i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to counting') }}</button>
                    <span class="lg-grow"></span>
                    <button type="button" class="lg-btn lg-btn--ink" :disabled="loading || !!loadError || posting || !totals.counted_count" @click="post">{{ pendingPost ? $t('Retry post') : $t('Post count') }}</button>
                </template>
            </div>
        </footer>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { t } from '@/shared/i18n.js';
import { isUnansweredRequest } from '@/shared/http.js';
import { createRequestId } from '@/shared/requestId.js';
import { countsApi, describeError } from './countsApi.js';
import { groupName, isShortage, isZero, sortByAbsValue, sumValues, toThousandths, trimQty } from './countMath.js';
import './counts.css';

const props = defineProps({
    countId: { type: [Number, String], required: true },
    // What the list already knows (reference, date), shown while the lines load.
    meta: { type: Object, default: () => ({}) },
    startPosted: { type: Boolean, default: false },
});
const emit = defineEmits(['back', 'back-to-counting', 'request-new', 'posted', 'active']);

const info = reactive({ reference: props.meta.reference || '', count_date: props.meta.count_date || '', posted_by_name: '' });
const rows = ref([]);
const totals = reactive({ counted_count: 0, uncounted_count: 0, shortage_value: '0.000', surplus_value: '0.000', net_value: '0.000' });
const posted = ref(props.startPosted);
const loading = ref(true);
const loadError = ref('');
const errorText = ref('');
const posting = ref(false);
// The post reply was lost: the count may be posted. The key stays the same for every retry and the
// screen leaves counting frozen until the outcome is known.
const pendingPost = ref(false);
const postKey = createRequestId();

let loadSequence = 0;
const BASE_UNIT_NAMES = { g: 'gram', ml: 'millilitre', unit: 'piece' };
const ask = async (message, heading) => (window.showAdminConfirm ? window.showAdminConfirm(message, heading) : window.confirm(message));

const counted = computed(() => sortByAbsValue(rows.value.filter(line => line.counted_base_qty !== null && line.counted_base_qty !== undefined)));
const uncounted = computed(() => rows.value.filter(line => line.counted_base_qty === null || line.counted_base_qty === undefined));

const qtyText = (value) => (value === null || value === undefined ? '—' : trimQty(value) || '0');
const groupText = (line) => groupName(line, t);
const titleFallback = computed(() => `${t('Stock count')} ${String(info.count_date || '').slice(0, 10)}`.trim());
const unitName = (line) => (BASE_UNIT_NAMES[line.base_unit] ? t(BASE_UNIT_NAMES[line.base_unit]) : '');
const tone = (value) => (isShortage(value) ? 'ct-neg' : (isZero(value) ? 'ct-zero' : ''));
// Surpluses carry a plus sign so a difference never reads as a plain number.
function signed(value, trim = false) {
    if (value === null || value === undefined) return '—';
    const units = toThousandths(value);
    if (units === null) return '—';
    const text = trim ? trimQty(value) || '0' : String(value);
    return units > 0n ? `+${text}` : text;
}

function applyRows(list, fromTotals) {
    rows.value = list;
    Object.assign(totals, fromTotals);
}
function applyPosted(data) {
    const list = data.lines || [];
    const values = list.filter(line => line.counted_base_qty !== null && line.counted_base_qty !== undefined);
    applyRows(list, {
        counted_count: values.length,
        uncounted_count: list.length - values.length,
        shortage_value: sumValues(values.map(line => line.variance_value).filter(isShortage)),
        surplus_value: sumValues(values.map(line => line.variance_value).filter(value => !isShortage(value) && !isZero(value))),
        net_value: sumValues(values.map(line => line.variance_value)),
    });
    Object.assign(info, { reference: data.reference || '', count_date: data.count_date, posted_by_name: data.posted_by_name || '' });
    posted.value = true;
}

async function load() {
    const current = ++loadSequence;
    loading.value = true;
    loadError.value = '';
    try {
        if (posted.value) {
            const data = await countsApi.getCount(props.countId);
            if (current === loadSequence) applyPosted(data);
        } else {
            const data = await countsApi.getReview(props.countId);
            if (current === loadSequence) applyRows(data.lines || [], data.totals || {});
        }
        if (current === loadSequence) emit('active', props.countId);
    } catch (error) {
        if (current === loadSequence) loadError.value = describeError(error);
    } finally {
        if (current === loadSequence) loading.value = false;
    }
}

function finishPosted(data) {
    pendingPost.value = false;
    errorText.value = '';
    loadSequence += 1;
    applyPosted(data);
    loading.value = false;
    emit('posted', data);
}

async function post() {
    // Everything counted is posted, whether or not its difference is zero.
    const changed = counted.value.length;
    const message = t('Post this count? {changed} items will be set to the counted quantity. {uncounted} items were not counted and stay as they are.')
        .replace('{changed}', String(changed))
        .replace('{uncounted}', String(totals.uncounted_count));
    if (!await ask(message, t('Post count'))) return;
    posting.value = true;
    errorText.value = '';
    try {
        finishPosted(await countsApi.postCount(props.countId, postKey));
    } catch (error) {
        if (isUnansweredRequest(error)) {
            pendingPost.value = true;
            await checkOutcome();
        } else {
            errorText.value = describeError(error);
            if (error?.code === 'STOCK_COUNT_NOT_DRAFT') await checkOutcome();
        }
    } finally {
        posting.value = false;
    }
}

// The reply may have been lost after the count posted: read it back. Posted means success;
// otherwise the same key is sent again on the next Post.
async function checkOutcome() {
    posting.value = true;
    try {
        const data = await countsApi.getCount(props.countId);
        if (data.status === 'posted') finishPosted(data);
        else errorText.value = t('The count is not posted yet. You can post it again.');
    } catch (error) {
        errorText.value = describeError(error);
    } finally {
        posting.value = false;
    }
}

onMounted(load);
onBeforeUnmount(() => { loadSequence += 1; });

// Leaving while a post is unconfirmed hides the outcome from the person who has to act on it.
const confirmDiscard = async () => !pendingPost.value || ask(t('The result of the last post is unconfirmed. Leave anyway?'), t('Unsaved changes'));

// A post in flight counts as open work too: a lost reply records its outcome on this pane.
defineExpose({ unsaved: computed(() => pendingPost.value || posting.value), pendingPost, post, checkOutcome, confirmDiscard });
</script>

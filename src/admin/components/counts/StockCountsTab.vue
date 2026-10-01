<template>
    <div class="pi-shell ct-shell" :data-view="view" style="padding: 16px">
        <StockCountList
            :counts="counts"
            :status="status"
            :active-id="activeId"
            :loading="listLoading"
            :error="listError"
            :has-more="nextBeforeId !== null"
            @select="openCount"
            @refresh="loadCounts(true)"
            @load-more="loadCounts(false)"
            @update-status="updateStatus"
            @new="requestNew"
        />
        <div class="pi-editor-column">
            <StockCountNew
                v-if="pane === 'new'"
                ref="paneRef"
                :key="paneKey"
                @back="backToList"
                @created="onCreated"
                @open="openById"
            />
            <StockCountSheet
                v-else-if="pane === 'sheet'"
                ref="paneRef"
                :key="paneKey"
                :count-id="openId"
                @saved="upsertCount"
                @deleted="onDeleted"
                @active="activeId = $event"
                @back="backToList"
                @request-new="requestNew"
                @review="showReview"
                @already-posted="showPosted"
            />
            <StockCountReview
                v-else-if="pane === 'review'"
                ref="paneRef"
                :key="paneKey"
                :count-id="openId"
                :meta="openMeta"
                :start-posted="openPosted"
                @back="backToList"
                @back-to-counting="backToCounting"
                @request-new="requestNew"
                @posted="onPosted"
                @active="activeId = $event"
            />
            <section v-else class="pi-pane pi-editor-pane">
                <p class="pi-empty">{{ $t('Choose a count from the list, or start a new one.') }}</p>
            </section>
        </div>
    </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import '../purchases/purchases.css';
import './counts.css';
import StockCountList from './StockCountList.vue';
import StockCountNew from './StockCountNew.vue';
import StockCountSheet from './StockCountSheet.vue';
import StockCountReview from './StockCountReview.vue';
import { countsApi, describeError } from './countsApi.js';
import { sumValues } from './countMath.js';

const paneRef = ref(null);
const pane = ref('empty');
const paneKey = ref(0);
const openId = ref(null);
const openMeta = ref({});
const openPosted = ref(false);
const activeId = ref(null);
const view = ref('list');

const counts = ref([]);
const nextBeforeId = ref(null);
const listLoading = ref(false);
const listError = ref('');
const status = ref('');
let listSequence = 0;

async function loadCounts(reset = true) {
    const current = ++listSequence;
    listLoading.value = true;
    listError.value = '';
    try {
        const page = await countsApi.listCounts({ status: status.value, beforeId: reset ? null : nextBeforeId.value });
        if (current !== listSequence) return;
        counts.value = reset ? page.counts : [...counts.value, ...page.counts.filter(row => !counts.value.some(known => known.id === row.id))];
        nextBeforeId.value = page.nextBeforeId;
    } catch (error) {
        if (current === listSequence) listError.value = describeError(error);
    } finally {
        if (current === listSequence) listLoading.value = false;
    }
}
function updateStatus(value) {
    status.value = value;
    loadCounts(true);
}

// Newest first. A count outside the active status filter leaves the list.
function upsertCount(count) {
    const summary = {
        id: count.id, reference: count.reference, count_date: count.count_date, status: count.status,
        line_count: count.line_count, counted_count: count.counted_count,
        variance_value: count.variance_value ?? counts.value.find(row => row.id === count.id)?.variance_value ?? null,
        created_by_name: count.created_by_name, posted_at: count.posted_at ?? null,
    };
    const rest = counts.value.filter(row => row.id !== summary.id);
    if (status.value && status.value !== summary.status) { counts.value = rest; return; }
    rest.push(summary);
    rest.sort((a, b) => b.id - a.id);
    counts.value = rest;
}

const canLeavePane = async () => (paneRef.value?.confirmDiscard ? paneRef.value.confirmDiscard() : true);

function showPane(kind, id = null, { meta = {}, posted = false } = {}) {
    openId.value = id;
    openMeta.value = meta;
    openPosted.value = posted;
    activeId.value = id;
    pane.value = kind;
    paneKey.value += 1;
    view.value = 'editor';
}

async function openCount(row) {
    if (row.id === activeId.value && pane.value !== 'new') { view.value = 'editor'; return; }
    if (!await canLeavePane()) return;
    showPane(row.status === 'posted' ? 'review' : 'sheet', row.id, { meta: row, posted: row.status === 'posted' });
}
async function openById(id) {
    if (!await canLeavePane()) return;
    const known = counts.value.find(row => row.id === id);
    showPane(known?.status === 'posted' ? 'review' : 'sheet', id, { meta: known || {}, posted: known?.status === 'posted' });
    if (!known) loadCounts(true);
}
async function requestNew() {
    if (!await canLeavePane()) return;
    pane.value = 'new';
    openId.value = null;
    activeId.value = null;
    paneKey.value += 1;
    view.value = 'editor';
}
async function backToList() {
    if (!await canLeavePane()) return;
    view.value = 'list';
}
function onCreated(count) {
    upsertCount(count);
    showPane('sheet', count.id, { meta: count });
}
function showReview() {
    // The sheet has just saved everything; nothing is left to guard.
    openMeta.value = counts.value.find(row => row.id === openId.value) || openMeta.value;
    pane.value = 'review';
    openPosted.value = false;
    paneKey.value += 1;
}
function showPosted(id) {
    pane.value = 'review';
    openPosted.value = true;
    openId.value = id;
    paneKey.value += 1;
    loadCounts(true);
}
function backToCounting() {
    pane.value = 'sheet';
    paneKey.value += 1;
}
function onPosted(count) {
    const lines = count.lines || [];
    upsertCount({ ...count, variance_value: sumValues(lines.map(line => line.variance_value)) });
    openPosted.value = true;
}
function onDeleted(id) {
    counts.value = counts.value.filter(row => row.id !== id);
    pane.value = 'empty';
    openId.value = null;
    activeId.value = null;
    view.value = 'list';
}

// Leaving the page (another admin route, refresh, closing the tab) must not silently drop
// uncounted-for typing or an unconfirmed post.
onBeforeRouteLeave(() => canLeavePane());
function onBeforeUnload(event) {
    if (!paneRef.value?.unsaved) return;
    event.preventDefault();
    event.returnValue = '';
}

let attached = false;
function attach() {
    if (attached) return;
    attached = true;
    window.addEventListener('beforeunload', onBeforeUnload);
}
function detach() {
    attached = false;
    window.removeEventListener('beforeunload', onBeforeUnload);
}

onMounted(() => {
    attach();
    loadCounts(true);
});
onActivated(attach);
onDeactivated(detach);
onBeforeUnmount(() => {
    detach();
    listSequence += 1;
});

const unsaved = computed(() => !!paneRef.value?.unsaved);
defineExpose({ confirmDiscard: canLeavePane, canLeave: canLeavePane, unsaved });
</script>

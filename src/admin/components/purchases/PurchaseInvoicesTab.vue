<template>
    <div class="pi-shell" :data-view="view" style="padding: 16px">
        <PurchaseInvoiceList
            :invoices="invoices"
            :suppliers="suppliers"
            :filters="filters"
            :active-id="activeId"
            :loading="listLoading"
            :error="listError"
            :has-more="nextBeforeId !== null"
            @select="openInvoice"
            @refresh="loadInvoices(true)"
            @load-more="loadInvoices(false)"
            @update-filter="updateFilter"
            @new="requestNew"
        />
        <div class="pi-editor-column">
            <p v-if="suppliersError" class="pi-note pi-note--error" role="alert">
                <span>{{ suppliersError }}</span>
                <button type="button" class="pi-btn" @click="loadSuppliers">{{ $t('Retry') }}</button>
            </p>
            <PurchaseInvoiceEditor
                ref="editorRef"
                :key="editorKey"
                :open-id="openId"
                :item-kind="itemKind"
                :suppliers="suppliers"
                @saved="upsertInvoice"
                @deleted="removeInvoice"
                @active="activeId = $event"
                @back="backToList"
                @request-new="requestNew"
                @supplier-created="addSupplier"
            />
        </div>
    </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import './purchases.css';
import PurchaseInvoiceList from './PurchaseInvoiceList.vue';
import PurchaseInvoiceEditor from './PurchaseInvoiceEditor.vue';
import { purchasesApi, describeError } from './purchasesApi.js';

// A purchase invoice holds one kind of item: Inventory opens 'product', Ingredients opens 'ingredient'.
const props = defineProps({
    itemKind: { type: String, required: true, validator: (value) => value === 'product' || value === 'ingredient' },
});

const editorRef = ref(null);
const editorKey = ref(0);
const openId = ref(null);
const activeId = ref(null);
const view = ref('list');

const suppliers = ref([]);
const suppliersError = ref('');
const invoices = ref([]);
const nextBeforeId = ref(null);
const nextBeforeGroup = ref(null);
const listLoading = ref(false);
const listError = ref('');
const filters = reactive({ q: '', status: '', supplierId: '' });

let listSequence = 0;
let searchTimer = null;

async function loadSuppliers() {
    suppliersError.value = '';
    try {
        suppliers.value = await purchasesApi.listSuppliers();
    } catch (error) {
        suppliersError.value = describeError(error);
    }
}

async function loadInvoices(reset = true) {
    const current = ++listSequence;
    listLoading.value = true;
    listError.value = '';
    try {
        const page = await purchasesApi.listInvoices({
            kind: props.itemKind,
            status: filters.status,
            supplierId: filters.supplierId,
            q: filters.q.trim(),
            beforeId: reset ? null : nextBeforeId.value,
            beforeGroup: reset ? null : nextBeforeGroup.value,
        });
        if (current !== listSequence) return;
        invoices.value = reset ? page.invoices : [...invoices.value, ...page.invoices.filter(row => !invoices.value.some(known => known.id === row.id))];
        nextBeforeId.value = page.nextBeforeId;
        nextBeforeGroup.value = page.nextBeforeGroup;
    } catch (error) {
        if (current === listSequence) listError.value = describeError(error);
    } finally {
        if (current === listSequence) listLoading.value = false;
    }
}

function updateFilter(patch) {
    Object.assign(filters, patch);
    clearTimeout(searchTimer);
    if ('q' in patch) searchTimer = setTimeout(() => loadInvoices(true), 300);
    else loadInvoices(true);
}

// Drafts first, then newest; an invoice outside the active filter leaves the list.
function upsertInvoice(invoice) {
    const summary = {
        id: invoice.id, supplier_id: invoice.supplier_id, supplier_name: invoice.supplier_name, supplier_invoice_no: invoice.supplier_invoice_no,
        invoice_date: invoice.invoice_date, status: invoice.status, payment_status: invoice.payment_status, total: invoice.total,
        line_count: invoice.line_count, updated_at: invoice.updated_at,
    };
    const rest = invoices.value.filter(row => row.id !== summary.id);
    // Same predicates as the server list: status, supplier, and the text search over the
    // invoice number or supplier name (case-insensitive contains).
    const term = filters.q.trim().toLocaleLowerCase();
    const textMatches = !term || [summary.supplier_invoice_no, summary.supplier_name].some(value => String(value || '').toLocaleLowerCase().includes(term));
    const matches = (!filters.status || filters.status === summary.status) && (!filters.supplierId || String(summary.supplier_id) === filters.supplierId) && textMatches;
    if (!matches) { invoices.value = rest; return; }
    rest.push(summary);
    rest.sort((a, b) => (a.status === 'draft' ? 0 : 1) - (b.status === 'draft' ? 0 : 1) || b.id - a.id);
    invoices.value = rest;
}
function removeInvoice(id) {
    invoices.value = invoices.value.filter(row => row.id !== id);
}
function addSupplier(supplier) {
    suppliers.value = [...suppliers.value.filter(s => s.id !== supplier.id), supplier].sort((a, b) => a.name.localeCompare(b.name));
}

const canLeaveEditor = async () => (editorRef.value ? editorRef.value.confirmDiscard() : true);

async function openInvoice(id) {
    if (id !== activeId.value || editorRef.value?.dirty) {
        if (!await canLeaveEditor()) return;
        openId.value = id;
        editorKey.value += 1;
    }
    view.value = 'editor';
}
async function requestNew() {
    if (!await canLeaveEditor()) return;
    openId.value = null;
    editorKey.value += 1;
    view.value = 'editor';
}
async function backToList() {
    if (!await canLeaveEditor()) return;
    view.value = 'list';
}

const isTypingTarget = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);

function onKeydown(event) {
    const editor = editorRef.value;
    if (!editor || editor.busy || event.isComposing) return;
    const command = event.ctrlKey || event.metaKey;
    if (event.altKey && !command && event.code === 'KeyN') {
        event.preventDefault();
        requestNew();
    } else if (command && !event.altKey && event.code === 'KeyS') {
        event.preventDefault();
        editor.saveDraft();
    } else if (command && !event.altKey && event.key === 'Enter') {
        event.preventDefault();
        editor.requestPost('new');
    } else if (!command && !event.altKey && (event.key === 'F2' || (event.key === '/' && !isTypingTarget(event.target)))) {
        event.preventDefault();
        editor.focusNewLine();
    }
}

// Leaving the page (another admin route, refresh, closing the tab) must not silently drop an
// unsaved invoice or an unconfirmed write.
onBeforeRouteLeave(() => canLeaveEditor());
function onBeforeUnload(event) {
    if (!editorRef.value?.unsaved) return;
    event.preventDefault();
    event.returnValue = '';
}

let attached = false;
function attach() {
    if (attached) return;
    attached = true;
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', onBeforeUnload);
}
function detach() {
    attached = false;
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('beforeunload', onBeforeUnload);
}

onMounted(() => {
    attach();
    loadSuppliers();
    loadInvoices(true);
});
onActivated(attach);
onDeactivated(detach);
onBeforeUnmount(() => {
    detach();
    listSequence += 1;
    clearTimeout(searchTimer);
});

// unsaved: open work the page must not drop when a settings change closes this tab, an unsaved invoice or a
// save or post still in flight (its outcome is recorded here when the reply is lost).
const unsaved = computed(() => !!(editorRef.value?.unsaved || editorRef.value?.busy));
defineExpose({ confirmDiscard: canLeaveEditor, unsaved });
</script>

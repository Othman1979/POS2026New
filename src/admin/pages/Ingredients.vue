<template>
    <div class="ingredients-page flex flex-col h-full min-h-0">
        <IngredientRecipes v-if="showRecipes" @close="showRecipes = false" />
        <template v-else-if="showPurchases">
            <header class="purchases-head">
                <button type="button" class="control" @click="closePurchases">{{ $t('Back to ingredients') }}</button>
                <h2>{{ $t('Ingredient purchase invoices') }}</h2>
            </header>
            <div class="purchases-view">
                <component :is="PurchaseInvoicesTab" ref="purchasesTab" item-kind="ingredient" />
            </div>
        </template>
        <template v-else>
            <header class="ingredients-heading">
                <div>
                    <div class="ingredients-title"><h2>{{ $t('Ingredients') }}</h2></div>
                    <p>{{ $t('Track ingredient deliveries, usage and remaining stock.') }}</p>
                </div>
                <div class="heading-actions">
                    <router-link class="control" :to="{ name: 'reports-ingredients' }">{{ $t('Ingredient usage and costs') }}</router-link>
                    <button type="button" class="control" @click="showRecipes = true"><i class="fa-solid fa-book-open" aria-hidden="true"></i>{{ $t('Product recipes') }}</button>
                    <button type="button" class="control" @click="editRow = null; showForm = true"><i class="fa-solid fa-plus" aria-hidden="true"></i>{{ $t('Add ingredient') }}</button>
                </div>
            </header>

            <section class="daily-work" :aria-label="$t('Stock actions')">
                <button type="button" class="stock-action stock-action-primary" @click="showPurchases = true"><span class="action-symbol"><SidebarIcon name="inventory" /></span><span><strong>{{ $t('Purchase invoice') }}</strong><small>{{ $t('Add received quantities to stock') }}</small></span></button>
                <button type="button" class="stock-action" @click="openInventoryTab('counts')"><span class="action-symbol"><SidebarIcon name="reports-summary" /></span><span><strong>{{ $t('Stock count') }}</strong><small>{{ $t('Record the quantity you have on hand') }}</small></span></button>
                <button type="button" class="stock-action" :disabled="loading" @click="wasteSearch = ''; showWastePicker = true"><span class="action-symbol"><SidebarIcon name="ingredients" /></span><span><strong>{{ $t('Record waste') }}</strong><small>{{ $t('Enter the wasted quantity and reason') }}</small></span></button>
            </section>
            <div v-if="successNotice" class="stock-success" role="status"><span>{{ $t(successNotice) }}</span><button @click="successNotice=''" :aria-label="$t('Close')">×</button></div>

            <p v-if="showDetails && dailyProjectionState !== 'current'" role="status">{{ $t('Today’s movement totals are updating. Current balances are up to date.') }}</p>
            <div v-if="error" role="alert" class="page-error"><span>{{ $t(error) }}</span><button type="button" class="control" @click="retryAction">{{ $t('Retry') }}</button></div>

            <section class="ingredient-ledger" :aria-label="$t('Ingredient balances')" :aria-busy="loading">
                <div class="ledger-views" :aria-label="$t('Quick filters')">
                    <div class="view-buttons">
                        <button type="button" :class="{selected: stockFilter === 'all'}" :aria-pressed="stockFilter === 'all'" @click="stockFilter = 'all'">{{ $t('All ingredients') }}</button>
                        <button type="button" :class="{selected: stockFilter === 'attention'}" :aria-pressed="stockFilter === 'attention'" @click="stockFilter = 'attention'">{{ $t('Stock shortages') }}</button>
                        <button v-if="showDetails || stockFilter === 'uncounted'" type="button" :class="{selected: stockFilter === 'uncounted'}" :aria-pressed="stockFilter === 'uncounted'" @click="stockFilter = 'uncounted'">{{ $t('No stock count yet') }}</button>
                        <button type="button" :class="{selected:stockFilter === 'missing-price'}" :aria-pressed="stockFilter === 'missing-price'" @click="stockFilter='missing-price'">{{ $t('No reference price') }}</button>
                        <button v-if="showDetails || stockFilter === 'variance'" type="button" :class="{selected: stockFilter === 'variance'}" :aria-pressed="stockFilter === 'variance'" @click="stockFilter = 'variance'">{{ $t('Count discrepancies') }}</button>
                    </div>
                    <button type="button" class="guide-button" @click="showDetails = !showDetails">{{ $t(showDetails ? 'Simple stock view' : 'Movement details') }}</button>
                </div>
                <dl v-if="showDetails && showGuide" id="ingredient-guide" class="ledger-guide">
                    <div v-for="column in quantityColumns" :key="column.key"><dt>{{ $t(column.label) }}</dt><dd>{{ $t(column.explanation) }}</dd></div>
                    <div><dt>{{ $t('Expected stock') }}</dt><dd>{{ $t('Calculated from the latest stock count, plus deliveries, minus usage and waste, with corrections included. This balance carries forward between days.') }}</dd></div>
                    <div><dt>{{ $t('Count difference') }}</dt><dd>{{ $t('The counted quantity minus the expected stock at the latest count. The percentage compares this difference with usage since the previous count.') }}</dd></div>
                </dl>
                <div class="ledger-toolbar">
                    <label class="ledger-search"><span>{{ $t('Search ingredients') }}</span><input v-model="searchQuery" type="search" :placeholder="$t('Search ingredients by name...')"></label>
                    <button type="button" class="control" :aria-expanded="showFilters" aria-controls="ingredient-extra-filters" @click="showFilters = !showFilters">{{ $t('Additional filters') }}<span v-if="measureFilter !== 'all' || statusFilter !== 'active'">•</span></button>
                    <button v-if="hasFilters" type="button" class="clear-filters" @click="clearFilters">{{ $t('Clear filters') }}</button>
                    <button type="button" class="control refresh" :disabled="loading" :aria-label="$t('Refresh')" :title="$t('Refresh')" @click="loadRows"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>
                </div>
                <div v-if="showFilters" id="ingredient-extra-filters" class="ledger-filters">
                    <label class="sort-field"><span>{{ $t('Sort') }}</span><select v-model="sortBy"><option value="name">{{ $t('Name (A–Z)') }}</option><option value="attention">{{ $t('Shortages first') }}</option><option value="variance">{{ $t('Count discrepancies first') }}</option></select></label>
                    <label><span>{{ $t('Measure') }}</span><select v-model="measureFilter"><option value="all">{{ $t('All measures') }}</option><option value="weight">{{ $t('Weight') }}</option><option value="volume">{{ $t('Volume') }}</option><option value="count">{{ $t('By piece') }}</option></select></label>
                    <label><span>{{ $t('Status') }}</span><select v-model="statusFilter"><option value="active">{{ $t('Active') }}</option><option value="all">{{ $t('All statuses') }}</option><option value="inactive">{{ $t('Inactive') }}</option></select></label>
                </div>
                <div v-if="showDetails" class="detail-tools"><button @click="showGuide = !showGuide" :aria-expanded="showGuide">{{ $t('What do these numbers mean?') }}</button><button @click="loadPortions">{{ $t('Portions you can make') }}</button></div>
                <div class="ledger-table-scroll">
                    <table class="ingredient-table" :class="{'simple-table': !showDetails}">
                        <caption class="sr-only">{{ $t('Ingredient balances for the current business day') }}</caption>
                        <thead>
                        <tr v-if="showDetails" class="period-groups">
                            <td></td>
                            <th scope="colgroup" colspan="3">{{ $t('Current business day activity') }}</th>
                            <th scope="colgroup" colspan="2" class="stock-period">{{ $t('Current balance and latest count') }}</th>
                            <td></td>
                        </tr>
                        <tr>
                            <th scope="col" class="ingredient-name-column">{{ $t('Ingredient') }}<small>{{ $t('Name and unit') }}</small></th>
                            <th v-for="column in (showDetails ? quantityColumns : [])" :key="column.key" scope="col">{{ $t(column.label) }}<small>{{ $t(column.hint) }}</small></th>
                            <th scope="col" class="balance-column">{{ $t('Expected stock') }}<small>{{ $t('After recorded movements') }}</small></th>
                            <th v-if="showDetails" scope="col">{{ $t('Count difference') }}<small>{{ $t('At the last stock count') }}</small></th>
                            <th scope="col" class="actions-column">{{ $t('Actions') }}</th>
                        </tr></thead>
                        <tbody>
                            <tr v-if="!hasLoaded && !error"><td :colspan="showDetails ? 7 : 3" class="ledger-empty" role="status">{{ $t('Loading ingredients...') }}</td></tr>
                            <tr v-else-if="!filteredRows.length"><td :colspan="showDetails ? 7 : 3" class="ledger-empty"><strong>{{ $t(error ? 'Unable to load ingredients.' : (hasFilters ? 'No ingredients match these filters.' : 'Start with your first ingredient.')) }}</strong><p>{{ $t(hasFilters ? 'Try a different name or clear the filters.' : 'Add the ingredients you buy, then connect them to your product recipes.') }}</p><button v-if="hasFilters" class="control" @click="clearFilters">{{ $t('Clear filters') }}</button><button v-else-if="!error" class="control primary" @click="editRow = null; showForm = true">{{ $t('Add ingredient') }}</button></td></tr>
                            <tr v-for="row in pagedRows" :key="row.id" :class="{'row-inactive': !row.is_active}">
                                <td class="ingredient-name"><strong data-no-i18n>{{ row.name }}</strong><div class="ingredient-meta"><span class="unit-label" data-no-i18n>{{ row.display_unit }}</span><span v-if="row.stock_item_id" class="stock-tag">{{ $t('Stock movement log') }}</span><span v-if="!row.is_active" class="stock-tag">{{ $t('Inactive') }}</span><span v-else-if="Number(row.expected_remaining) < 0" class="stock-tag danger">{{ $t('Negative balance') }}</span><span v-else-if="row.below_par" class="stock-tag warning">{{ $t('Below minimum') }}</span><span v-else-if="row.expected_remaining == null" class="stock-tag">{{ $t('No stock count yet') }}</span></div></td>
                                <td v-for="column in (showDetails ? quantityColumns : [])" :key="column.key" :data-label="`${$t(column.label)} — ${$t(column.hint)}`" class="quantity-cell"><span data-no-i18n>{{ formatQty(row.today?.[column.key], row.display_unit) }}</span></td>
                                <td class="balance-column" :class="expectedClass(row)" :data-label="$t('Expected stock')"><strong data-no-i18n>{{ expectedLabel(row) }}</strong><small v-if="row.expected_remaining == null">{{ $t('Record a first count') }}</small></td>
                                <td v-if="showDetails" :data-label="`${$t('Count difference')} — ${$t('At the last stock count')}`"><span class="variance-value" :class="Number(row.last_count?.variance_qty) !== 0 ? 'text-amber-700 font-semibold' : ''" data-no-i18n><bdi dir="ltr">{{ varianceLabel(row) }}</bdi></span><small v-if="row.last_count?.variance_qty == null">{{ $t('No comparison yet') }}</small></td>
                                <td class="row-actions"><button type="button" class="control" @click="historyRow = row; showHistory = true">{{ $t('History') }}</button><button v-if="showDetails" type="button" class="control" @click="editRow = row; showForm = true">{{ $t('Edit ingredient') }}</button></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <footer class="ledger-pagination">
                    <span class="page-range"><span data-no-i18n>{{ rangeStart }}–{{ rangeEnd }}</span> {{ $t('of') }} <strong data-no-i18n>{{ filteredRows.length }}</strong> {{ $t('ingredients') }}</span>
                    <label class="page-size">{{ $t('Rows per page') }}<select v-model.number="pageSize"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option></select></label>
                    <nav :aria-label="$t('Ingredient pages')"><button type="button" class="control" :disabled="page <= 1" @click="page--">{{ $t('Previous') }}</button><span>{{ $t('Page') }} <strong data-no-i18n>{{ page }}</strong> / <span data-no-i18n>{{ totalPages }}</span></span><button type="button" class="control" :disabled="page >= totalPages" @click="page++">{{ $t('Next') }}</button></nav>
                    <button v-if="hasMore" type="button" class="control" :disabled="loading" @click="loadMoreRows">{{ $t('Load more') }}</button>
                </footer>
            </section>
            <div class="ledger-note"><p>{{ $t('Balances carry forward automatically. You do not need to count stock every morning.') }}</p><p>{{ $t('A dash (—) means there is no recorded count or comparison, not that stock is zero.') }}</p></div>
        </template>

        <ModalShell :show="showWastePicker" :title="$t('Choose the wasted ingredient')" width-class="max-w-md" @close="showWastePicker = false">
            <div class="waste-picker"><label>{{ $t('Search ingredients') }}<input v-model="wasteSearch" type="search" :placeholder="$t('Search ingredients by name...')"></label><button v-for="row in wasteOptions" :key="row.id" type="button" @click="showWastePicker = false; openMovement(row)"><span data-no-i18n>{{ row.name }}</span><span aria-hidden="true">←</span></button><p v-if="wasteError" role="alert">{{ $t(wasteError) }} <button @click="loadWaste()">{{ $t('Retry') }}</button></p><button v-if="wasteCursor" :disabled="wasteLoading" @click="loadWaste(true)">{{ $t('Load more') }}</button><p v-if="!wasteLoading && !wasteError && !wasteOptions.length">{{ $t('No ingredients match these filters.') }}</p></div>
        </ModalShell>
        <IngredientFormModal :show="showForm" :ingredient="editRow" @close="showForm = false" @saved="loadRows" />
        <IngredientMovementModal :show="showMovement" :ingredient="movementRow" @close="showMovement = false" @saved="loadRows" />
        <IngredientHistoryDrawer :show="showHistory" :ingredient="historyRow" @close="showHistory = false" @changed="loadRows" />

        <ModalShell :show="showPortions" :title="$t('Possible portions')" width-class="max-w-lg" @close="showPortions = false">
            <div class="p-6 space-y-2 text-xs">
                <div v-for="item in portionItems" :key="item.product_id" class="flex justify-between gap-3">
                    <span data-no-i18n>{{ item.name }}</span>
                    <span data-no-i18n>{{ item.portions_possible ?? '—' }}</span>
                </div>
            </div>
        </ModalShell>
    </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { fetchJson } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';
import { lazyPosComponent } from '../../pos/lazyPosComponent.js';
import IngredientFormModal from '../components/IngredientFormModal.vue';
import IngredientMovementModal from '../components/IngredientMovementModal.vue';
import IngredientHistoryDrawer from '../components/IngredientHistoryDrawer.vue';
import ModalShell from '../components/ModalShell.vue';
import SidebarIcon from '../components/SidebarIcon.vue';
import IngredientRecipes from '../components/IngredientRecipes.vue';

import { fromBaseQty as fromBase } from '@/shared/ingredientUnits.js';

const rows = ref([]);
const loading = ref(false);
const hasLoaded = ref(false);
const error = ref('');
const retryAction = ref(loadRows);
const searchQuery = ref('');
const statusFilter = ref('active');
const measureFilter = ref('all');
const stockFilter = ref('all');
const sortBy = ref('name');
const page = ref(1);
const pageSize = ref(10);
const nextCursor = ref(null);
const hasMore = ref(false);
const showGuide = ref(false);
const showDetails = ref(true);
const showWastePicker = ref(false);
const wasteSearch = ref('');
const wasteOptions=ref([]),wasteCursor=ref(null),wasteLoading=ref(false),wasteError=ref('');
let wasteSequence=0,wasteTimer;
async function loadWaste(append=false){
    clearTimeout(wasteTimer);
    const seq=++wasteSequence;wasteLoading.value=true;wasteError.value='';
    if(!append){wasteOptions.value=[];wasteCursor.value=null;}
    const params=new URLSearchParams({view:'picker',status:'active',limit:'20',q:wasteSearch.value.trim()});
    if(append&&wasteCursor.value)params.set('cursor',wasteCursor.value);
    try{const data=await fetchJson(`api/admin/ingredients?${params}`);if(seq!==wasteSequence||!showWastePicker.value)return;
        if(!data.success)throw new Error(data.message||'Load failed.');wasteOptions.value=append?[...wasteOptions.value,...data.ingredients]:data.ingredients;wasteCursor.value=data.next_cursor||null;
    }catch(e){if(seq===wasteSequence)wasteError.value=e.message||'Load failed.';}
    finally{if(seq===wasteSequence)wasteLoading.value=false;}
}
watch(showWastePicker,open=>{clearTimeout(wasteTimer);wasteSequence++;if(open)loadWaste();});
watch(wasteSearch,()=>{clearTimeout(wasteTimer);wasteSequence++;wasteOptions.value=[];wasteCursor.value=null;if(showWastePicker.value)wasteTimer=setTimeout(()=>loadWaste(),250);},{flush:'sync'});

const quantityColumns = [
    { key: 'received', label: 'Received today', hint: 'Added to stock', explanation: 'Quantities added through stock receipts during the current business day.' },
    { key: 'used', label: 'Consumed today', hint: 'Used in recipes', explanation: 'Recipe quantities used during this business day, less quantities restored by refunds or cancellations.' },
    { key: 'waste', label: 'Waste today', hint: 'Recorded losses', explanation: 'Quantities recorded as waste today, such as spoiled food or preparation losses.' }
];
const showForm = ref(false);
const showMovement = ref(false);
const showFilters = ref(false);
const router = useRouter();
const openInventoryTab = tab => router.push({ name: 'inventory', query: { tab } });
const showHistory = ref(false);
const showPortions = ref(false);
const showRecipes = ref(false);
// Ingredient purchase invoices open in place of the list. The editor is fetched only when first opened.
const showPurchases = ref(false);
const purchasesTab = ref(null);
const PurchaseInvoicesTab = lazyPosComponent(() => import('../components/purchases/PurchaseInvoicesTab.vue'), () => {
    window.showAdminAlert?.(t('Purchase invoices could not be loaded. Check the connection and try again.'));
    showPurchases.value = false;
});
// An unsaved draft asks first; after closing, balances and "Received today" are read again.
async function closePurchases() {
    if (purchasesTab.value && !await purchasesTab.value.confirmDiscard()) return;
    showPurchases.value = false;
    loadRows();
}
const editRow = ref(null);
const movementRow = ref(null);
const historyRow = ref(null);
const portionItems = ref([]);
let fetchSeq = 0;
let refreshTimer = null;
let refreshPending = false;
let disposed = false;

const projectionState=ref('current');
const dailyProjectionState=ref('current');
const successNotice = ref('');
const hasFilters = computed(() => !!searchQuery.value.trim() || statusFilter.value !== 'active' || measureFilter.value !== 'all' || stockFilter.value !== 'all' || sortBy.value !== 'name');
// Search, attention and ordering are applied to the complete data on the server.
const filteredRows = computed(() => rows.value);
const totalPages = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value)));
const pagedRows = computed(() => filteredRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const rangeStart = computed(() => filteredRows.value.length ? (page.value - 1) * pageSize.value + 1 : 0);
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, filteredRows.value.length));
watch([searchQuery, statusFilter, measureFilter, stockFilter, sortBy, pageSize], () => { page.value = 1; }, { flush: 'sync' });
watch(totalPages, total => { page.value = Math.min(page.value, total); }, { flush: 'sync' });
let searchDebounce = null;
watch([searchQuery,statusFilter,measureFilter,stockFilter,sortBy], () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { if (!disposed) loadRows(); }, 300);
});
function clearFilters() {
    searchQuery.value = ''; statusFilter.value = 'active'; measureFilter.value = 'all'; stockFilter.value = 'all'; sortBy.value = 'name'; page.value = 1;
}
function formatQty(qty, unit) {
    const value = fromBase(qty, unit);
    return value == null ? '—' : String(value);
}

function expectedLabel(row) {
    if (row.expected_remaining == null) return '—';
    return formatQty(row.expected_remaining, row.display_unit);
}

function expectedClass(row) {
    if (row.expected_remaining == null) return '';
    if (Number(row.expected_remaining) < 0) return 'text-red-600 font-semibold';
    if (row.below_par) return 'text-amber-600 font-semibold';
    return '';
}

function varianceLabel(row) {
    const qty = row.last_count?.variance_qty;
    if (qty == null) return '—';
    return `${Number(qty) > 0 ? '+' : ''}${formatQty(qty, row.display_unit)} ${row.display_unit}`;
}

function loadRows() {
    retryAction.value = loadRows;
    fetchSeq++;
    refreshPending = true;
    nextCursor.value = null;
    if (disposed || loading.value || refreshTimer != null) return;
    refreshTimer = setTimeout(refreshRows, 50);
}

function loadMoreRows() {
    if (!hasMore.value || !nextCursor.value || loading.value) return;
    fetchSeq++;
    refreshPending = true;
    if (disposed || refreshTimer != null) return;
    refreshTimer = setTimeout(refreshRows, 50);
}

async function refreshRows() {
    refreshTimer = null;
    if (disposed) return;
    refreshPending = false;
    const seq = fetchSeq;
    const append = Boolean(nextCursor.value);
    loading.value = true;
    error.value = '';
    try {
        const params = { status:statusFilter.value, measure:measureFilter.value, attention:stockFilter.value,sort:sortBy.value,limit:'50' };
        if (searchQuery.value.trim()) params.q = searchQuery.value.trim();
        if (nextCursor.value) params.cursor = nextCursor.value;
        const data = await fetchJson(`api/admin/ingredients?${new URLSearchParams(params)}`);
        if (seq !== fetchSeq) return;
        if (!data.success) throw new Error(data.message || 'Load failed.');
        rows.value = append ? [...rows.value, ...(data.ingredients || [])] : (data.ingredients || []);
        nextCursor.value = data.next_cursor || null;
        hasMore.value = Boolean(data.has_more);
        projectionState.value=data.freshness?.state||'current';
        dailyProjectionState.value=data.daily_freshness?.state||'current';
        hasLoaded.value = true;
    } catch (caught) {
        if (seq === fetchSeq) error.value = caught.message || 'Load failed.';
    } finally {
        loading.value = false;
        if (refreshPending) loadRows();
    }
}

function openMovement(row) {
    movementRow.value = row;
    showMovement.value = true;
}

async function loadPortions() {
    retryAction.value = loadPortions;
    error.value = '';
    try {
        const data = await fetchJson('api/admin/ingredients/portions');
        if (!data.success) throw new Error(data.message || 'Load failed.');
        portionItems.value = data.portions || [];
        showPortions.value = true;
    } catch (caught) { error.value = caught.message || 'Load failed.'; }
}

// Bursts of ingredient changes during service become one read about a second later.
// While the list is out of sight (hidden tab, or purchase invoices or recipes open in its place)
// nothing is read; the list refreshes once when it is shown again.
let changeTimer = null;
let changedWhileHidden = false;
const listHidden = () => document.hidden || showPurchases.value || showRecipes.value;
const handleIngredientsChanged = () => {
    if (listHidden()) { changedWhileHidden = true; return; }
    if (changeTimer != null) return;
    changeTimer = setTimeout(() => {
        changeTimer = null;
        if (disposed) return;
        if (listHidden()) changedWhileHidden = true;
        else loadRows();
    }, 1000);
};
const refreshIfChangedWhileHidden = () => {
    if (!changedWhileHidden || listHidden()) return;
    changedWhileHidden = false;
    loadRows();
};
const handleVisibilityChange = refreshIfChangedWhileHidden;
watch([showPurchases, showRecipes], refreshIfChangedWhileHidden);

onMounted(() => {
    loadRows();
    window.addEventListener('ingredients_changed', handleIngredientsChanged);
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
onUnmounted(() => {
    clearTimeout(wasteTimer);wasteSequence++;
    disposed = true;
    fetchSeq++;
    clearTimeout(refreshTimer);
    clearTimeout(searchDebounce);
    clearTimeout(changeTimer);
    window.removeEventListener('ingredients_changed', handleIngredientsChanged);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<style scoped>
.ingredients-page { gap: 18px; color: #18181b; font-size: 13px; padding-bottom: 12px; }
.ingredients-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-shrink: 0; }
.ingredients-title { display: flex; align-items: center; gap: 10px; }
.ingredients-title h2 { font-size: 21px; font-weight: 700; line-height: 1.4; }
.record-count { background: #e8edf3; color: #24405e; border-radius: 5px; padding: 2px 8px; font-size: 12px; font-weight: 700; }
.ingredients-heading p { color: #62626c; margin-top: 4px; font-size: 13px; }
.heading-actions { display: flex; align-items: center; gap: 8px; }
.control { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; border: 1px solid #cbd0d7; border-radius: 6px; padding: 8px 12px; background: #fff; color: #263342; font-size: 12px; font-weight: 650; white-space: nowrap; cursor: pointer; }
.control:hover:not(:disabled) { background: #f0f3f6; border-color: #8c9cab; }
.control.primary { color: white; background: #24405e; border-color: #24405e; }
.control.primary:hover:not(:disabled) { background: #1d3450; }
button:disabled, select:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #3a5c85; outline-offset: 3px; }
.daily-work { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 10px; flex-shrink: 0; }
.ingredient-ledger { display: flex; flex-direction: column; min-height: 260px; flex: 1; border: 1px solid #d5d8dd; border-radius: 8px; background: #fff; overflow: hidden; }
.ledger-views { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e4e7eb; padding: 0 16px; gap: 12px; flex-shrink: 0; }
.view-buttons { display: flex; gap: 20px; }
.view-buttons button { display: flex; align-items: center; gap: 8px; min-height: 52px; border-bottom: 2px solid transparent; font-size: 12px; color: #666976; font-weight: 600; cursor: pointer; }
.view-buttons button.selected { border-bottom-color: #24405e; color: #24405e; }
.view-buttons button > span { padding: 1px 6px; background: #f0f1f3; color: #626974; border-radius: 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
.view-buttons button > span.attention-count { color: #9a4a10; background: #fff0d4; }
.guide-button { display: flex; align-items: center; gap: 6px; min-height: 38px; color: #536476; font-size: 12px; cursor: pointer; }
.guide-button:hover { color: #24405e; text-decoration: underline; }
.ledger-guide { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px 28px; padding: 20px; background: #f7f9fc; border-bottom: 1px solid #dce3eb; max-height: 280px; overflow-y: auto; flex-shrink: 0; }
.ledger-guide dt { font-weight: 700; color: #24405e; margin-bottom: 5px; }
.ledger-guide dd { color: #53606f; font-size: 12px; line-height: 1.8; }
.ledger-toolbar { display: flex; align-items: end; justify-content: flex-start; gap: 12px; padding: 16px; border-bottom: 1px solid #e4e7eb; flex-shrink: 0; flex-wrap: wrap; }
.ledger-toolbar label, .ledger-filters label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #53606f; }
.ledger-search { flex: 0 1 320px; min-width: 180px; }
.sort-field { width: 185px; }
.ledger-toolbar input, .ledger-toolbar select, .ledger-filters select { width: 100%; min-width: 0; height: 42px; padding: 8px 12px; background: white; border: 1px solid #cbd0d7; border-radius: 6px; color: #263342; font-size: 13px; }
.ledger-toolbar .control { min-height: 42px; }
.ledger-filters { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; padding: 0 16px 16px; border-bottom: 1px solid #e4e7eb; }
.ledger-filters label { width: 185px; }
.clear-filters { font-size: 12px; color: #24405e; text-decoration: underline; min-height: 42px; cursor: pointer; }
.refresh { width: 42px; padding: 8px; }
.ledger-table-scroll { flex: 1; overflow: auto; min-height: 0; }
.ingredient-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 900px; }
.ingredient-table thead { position: sticky; top: 0; z-index: 1; }
.ingredient-table th { padding: 13px 16px; background: #f7f8fa; border-bottom: 1px solid #dce0e5; text-align: start; font-size: 12px; font-weight: 650; white-space: nowrap; }
.ingredient-table .period-groups th, .ingredient-table .period-groups td { padding-block: 9px; background: #f7f8fa; border-bottom: 1px solid #dce0e5; }
.ingredient-table .period-groups th { text-align: center; }
.ingredient-table .period-groups .stock-period { background: #eaf0f6; color: #24405e; }
.ingredient-table th small { display: block; margin-top: 4px; color: #697481; font-size: 11px; font-weight: 400; }
.ingredient-table td { padding: 15px 16px; border-bottom: 1px solid #eceef1; vertical-align: middle; font-size: 13px; font-variant-numeric: tabular-nums; }
.ingredient-table td small { display: block; color: #757983; font-size: 11px; margin-top: 4px; }
.ingredient-name-column { width: 22%; }
.ingredient-name strong { font-size: 13px; font-weight: 650; display: block; overflow-wrap: anywhere; }
.ingredient-meta { display: flex; align-items: center; gap: 8px; margin-top: 7px; flex-wrap: wrap; }
.unit-label { color: #525965; font-size: 11px; }
.stock-tag { padding: 2px 6px; border-radius: 4px; background: #f0f1f3; font-size: 10px; color: #626772; }
.stock-tag.warning { background: #fff3df; color: #925014; }
.stock-tag.danger { background: #fff0f0; color: #ae3333; }
.ingredient-table .balance-column { background: #f1f5f9; }
.ingredient-table th.balance-column { background: #eaf0f6; color: #24405e; }
.ingredient-table tbody tr:hover td { background: #f7f9fc; }
.ingredient-table tbody tr:hover .balance-column { background: #eaf0f6; }
.ingredient-table .row-inactive .ingredient-name { color: #777; }
.actions-column { width: 255px; }
.row-actions { white-space: nowrap; }
.row-actions > button + button { margin-inline-start: 6px; }
.row-actions .control { min-height: 34px; font-size: 11px; padding: 6px 10px; }
.ledger-empty { text-align: center; height: 240px; white-space: normal; }
.ledger-empty strong { font-size: 15px; }
.ledger-empty p { font-size: 13px; color: #626976; margin-block: 8px 16px; }
.ledger-pagination { display: flex; gap: 20px; align-items: center; padding: 12px 16px; border-top: 1px solid #e1e5ea; background: #fafbfc; flex-shrink: 0; font-size: 12px; color: #5c6370; }
.page-range { margin-inline-end: auto; }
.page-size { display: flex; gap: 8px; align-items: center; }
.page-size select { border: 1px solid #d3d7dc; padding: 6px; border-radius: 5px; color: #263342; background: white; }
.ledger-pagination nav { display: flex; align-items: center; gap: 12px; }
.ledger-pagination .control { min-height: 32px; padding: 6px 10px; font-size: 11px; }
.ledger-note { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: #70757e; font-size: 11px; flex-shrink: 0; }
.page-error { padding: 10px 14px; background: #fff1f1; color: #a32626; border: 1px solid #f0cccc; display: flex; align-items: center; justify-content: space-between; }
@media (max-width: 1400px) {
    .ingredient-table th, .ingredient-table td { padding-inline: 10px; }
    .ingredient-table th small { white-space: normal; }


}
@media (max-width: 1250px) {
    .ledger-toolbar { flex-wrap: wrap; }
    .ledger-search { max-width: none; }
    .daily-work { flex-wrap: wrap; }
    .ledger-views { flex-wrap: wrap; gap: 0; }
}
@media (max-width: 767px) {
    .ingredients-page { display: block; height: auto; overflow: visible; }
    .ingredients-heading { display: block; margin-bottom: 16px; }
    .heading-actions { margin-top: 12px; }
    .heading-actions button { flex: 1; }
    .control { min-height: 44px; }
    .daily-work { margin-bottom: 16px; }
    .ledger-views { padding: 0 12px; }
    .view-buttons { width: 100%; gap: 12px; flex-wrap: wrap; }
    .view-buttons button { font-size: 11px; gap: 5px; min-height: 44px; }
    .ledger-guide { grid-template-columns: 1fr; max-height: 300px; }
    .ledger-toolbar { padding: 12px; }
    .ledger-search { flex-basis: 100%; }
    .ledger-search input { height: 44px; }
    .ledger-filters { width: 100%; }
    .ledger-filters label { flex: 1; min-width: 130px; }
    .ledger-filters select { min-height: 44px; }
    .ingredient-table { min-width: 0; display: block; }
    .ingredient-table thead { display: none; }
    .ingredient-table tbody { display: block; }
    .ingredient-table tr { display: grid; grid-template-columns: 1fr 1fr; padding: 16px; gap: 12px 18px; border-bottom: 1px solid #dce0e5; }
    .ingredient-table td { border: 0; padding: 0; min-width: 0; }
    .ingredient-name, .row-actions, .ingredient-table .ledger-empty { grid-column: 1 / -1; }
    .ingredient-table td[data-label]::before { content: attr(data-label); display: block; font-size: 11px; color: #646c77; margin-bottom: 5px; font-weight: 400; }
    .ingredient-table td.balance-column { padding: 8px; margin: -4px; border-radius: 5px; }
    .row-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px !important; }
    .row-actions > button + button { margin: 0; }
    .row-actions .control { min-height: 44px; font-size: 12px; flex: 1; max-width: none; margin: 0; }
    .ledger-pagination { flex-wrap: wrap; padding: 12px; gap: 12px; }
    .ledger-pagination nav { width: 100%; justify-content: space-between; }
    .ledger-pagination .control { min-height: 44px; }
    .ledger-note { margin-top: 12px; line-height: 1.7; }
}

.daily-work > .control { min-height: 46px; padding-inline: 18px; }
.simple-table { min-width: 0; }
.simple-table .ingredient-name-column { width: 55%; }
.simple-table .balance-column { background: transparent; }
.simple-table .balance-column strong { font-size: 16px; }
.simple-table .actions-column { width: 120px; }
.simple-table td, .simple-table th { padding: 16px 20px; }
.detail-tools { display: flex; gap: 20px; padding: 10px 16px; border-bottom: 1px solid #e4e7eb; color: #24405e; font-size: 12px; }
.detail-tools button { min-height: 36px; text-decoration: underline; }
.waste-picker { padding: 20px 24px; overflow-y: auto; }
.waste-picker label { font-size: 12px; color: #53606f; }
.waste-picker input { display: block; width: 100%; height: 44px; padding: 8px 12px; border: 1px solid #cbd0d7; border-radius: 6px; margin-block: 6px 16px; }
.waste-picker > button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 48px; padding-block: 12px; border-bottom: 1px solid #e4e7eb; text-align: start; }
@media(max-width:767px) { .daily-work > .control { width: calc(50% - 5px); padding-inline: 8px; font-size: 12px; } .simple-table .ingredient-name { grid-column: 1/-1; } .simple-table td { padding: 0; } }

.ingredients-page { gap: 16px; color: var(--color-foreground); }
.ingredients-title h2 { font-size: 27px; letter-spacing: -.02em; }
.heading-actions .control { border-color: var(--color-border); font-weight: 500; }
.daily-work { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 12px; }
.stock-action { display: flex; align-items: center; gap: 14px; min-height: 96px; padding: 20px; border: 1px solid var(--color-border); border-radius: 12px; background: #fff; text-align: start; color: var(--color-foreground); }
.stock-action strong, .stock-action small { display: block; }
.stock-action strong { font-size: 15px; font-weight: 650; }
.stock-action small { font-size: 12px; margin-top: 5px; color: var(--color-muted-foreground); line-height: 1.6; }
.action-symbol { display: grid; place-items: center; flex: none; width: 42px; height: 42px; border-radius: 10px; background: var(--color-brand-50); color: var(--color-primary); }
.stock-action-primary { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
.stock-action-primary small { color: var(--color-brand-100); }
.stock-action-primary .action-symbol { background: var(--color-brand-600); color: var(--color-brand-100); }
.purchases-head { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; flex-shrink: 0; }
.purchases-head h2 { font-size: 1.25rem; font-weight: 800; line-height: 1.3; }
/* The purchase screen insets itself for Inventory; here the header and the ledger share the page edge. */
.purchases-view :deep(.pi-shell) { padding-inline: 0 !important; }
.stock-action:hover:not(:disabled) { border-color: var(--color-brand-500); box-shadow: 0 3px 9px color-mix(in srgb, var(--color-primary) 6%, transparent); }
.stock-attention { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 9px 14px; border: 1px solid #ecdcbf; border-radius: 8px; background: #fffbf3; font-size: 12px; color: #896223; }
.stock-attention button { display: flex; align-items: center; gap: 7px; min-height: 32px; text-decoration: underline; text-underline-offset: 3px; }
.stock-attention button > span:first-child { font-weight: 750; }
.stock-success { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--color-brand-50); border: 1px solid var(--color-brand-100); color: var(--color-primary); border-radius: 8px; }
.stock-success button { width: 36px; height: 36px; }
.ingredient-ledger { border-color: var(--color-border); border-radius: 12px; }
.ingredient-table th { background: var(--color-background); color: var(--color-muted-foreground); }
.ingredient-table td { padding-block: 19px; }
.ingredient-name strong { font-size: 14px; color: var(--color-foreground); }
.ingredient-table .balance-column { background: var(--color-brand-50); }
.balance-column strong { font-size: 17px; color: var(--color-primary); }
.balance-column.text-red-600 strong { color: #b52c35; }
.balance-column.text-amber-600 strong { color: #926018; }
.ingredient-table tbody tr:hover .balance-column { background: var(--color-brand-100); }
.ingredient-table th.balance-column { background: var(--color-brand-50); color: var(--color-primary); }
.view-buttons button.selected { color: var(--color-primary); border-bottom-color: var(--color-primary); }
.stock-tag { border-radius: 20px; padding: 3px 8px; }
.unit-label { padding: 2px 7px; border: 1px solid var(--color-border); border-radius: 5px; font-variant-numeric: tabular-nums; }
.row-actions .control { background: transparent; border-color: var(--color-border); color: var(--color-primary); }
@media(max-width:1050px) { .daily-work { grid-template-columns: 1fr 1fr; }.stock-action-primary { grid-column: 1/-1; }.heading-actions { flex-wrap: wrap; } }
@media(max-width:767px) { .stock-action { padding: 14px; min-height: 90px; gap: 10px; }.stock-action small { font-size: 11px; }.stock-action:not(.stock-action-primary) .action-symbol { display:none; }.stock-attention { margin-bottom: 16px; }.ingredient-table td { padding: 0; }.heading-actions a { flex: 1; } }
</style>

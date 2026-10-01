<template>
    <section class="analysis-workspace" :aria-busy="loading">
        <p v-if="error" role="alert">{{ $t(error) }} <button type="button" @click="load">{{ $t('Retry') }}</button></p>
        <p v-if="loading" role="status">{{ $t('Loading analysis...') }}</p>
        <template v-if="report">
            <p v-if="report.freshness && report.freshness.state !== 'current'" class="coverage" role="status">{{ $t(freshnessLabel) }} <bdi v-if="report.freshness.as_of" dir="ltr" data-no-i18n>{{ report.freshness.as_of }}</bdi></p>
            <p v-if="report.period.start_date !== from || report.period.end_date !== to" class="coverage" role="status">{{ $t('Showing the previous result while the selected period loads.') }} <bdi dir="ltr" data-no-i18n>{{ report.period.start_date }} — {{ report.period.end_date }}</bdi></p>
            <div v-if="report.totals" class="metric-grid" :class="{ incomplete: report.totals.incomplete }">
                <article><span>{{ $t('Net meal revenue') }}</span><strong data-no-i18n><bdi dir="ltr">{{ money(report.totals.net_revenue) }}</bdi></strong><small>{{ $t('After discounts and refunds, before tax') }}</small></article>
                <article><span>{{ $t(report.totals.incomplete ? 'Recorded ingredient cost (partial)' : 'Estimated ingredient cost') }}</span><strong data-no-i18n><bdi dir="ltr">{{ money(report.totals.known_cost) }}</bdi></strong><small>{{ $t('Based on recipes and costs recorded at the time') }}</small></article>
                <article class="margin-card" :class="{ negative: report.totals.estimated_margin != null && Number(report.totals.estimated_margin) < 0 }"><span>{{ $t('Sales less ingredient cost') }}</span><strong data-no-i18n><bdi dir="ltr">{{ money(report.totals.estimated_margin) }}</bdi></strong><p v-if="report.totals.estimated_margin != null && Number(report.totals.estimated_margin) < 0" class="outcome">{{ $t('Ingredient costs exceed sales') }}</p><small>{{ $t('Before wages, rent, commissions and other overhead') }}</small></article>
            </div>
            <div v-if="report.totals" class="cost-readiness" :class="{ 'needs-costs': report.totals.incomplete }">
                <div class="readiness-heading"><span class="status-dot" aria-hidden="true"></span><strong>{{ $t(report.totals.incomplete ? 'Some costs are missing' : 'Cost completeness') }}</strong><span class="readiness-count" dir="ltr" data-no-i18n>{{ report.totals.complete_meals }} / {{ report.totals.total_meals }}</span></div>
                <div class="coverage-track" role="progressbar" :aria-label="$t('Cost completeness')" :aria-valuenow="coveragePercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: coveragePercent + '%' }"></span></div>
                <div class="readiness-footer"><span>{{ $t('meals with complete costs') }}</span><router-link v-if="report.totals.incomplete" :to="{name:'ingredients'}">{{ $t('Review recipes and prices') }} <span aria-hidden="true">←</span></router-link></div>
                <p v-if="report.totals.incomplete" class="missing-cost-note">{{ $t('Some costs are unknown, so the sales margin cannot be calculated in full.') }}</p>
            </div>
            <details v-if="report.totals" class="method-notes"><summary>{{ $t('How these numbers are calculated') }}</summary>
            <p v-if="report.totals.legacy_lines" class="period-note">{{ $t('For older invoices, costs come from recorded ingredient usage. Newer invoices keep the cost recorded at payment.') }}</p>
            <p v-if="report.totals.incomplete">{{ $t('Add missing recipes and prices, and check recipes for modified meals. These changes do not fill in missing costs on past sales.') }} <span data-no-i18n>{{ report.totals.complete_meals }} / {{ report.totals.total_meals }}</span> {{ $t('meals with complete costs') }}</p>
            <p v-if="report.totals.unallocated_records" class="coverage">{{ $t('Sales with missing item details') }}: <span data-no-i18n><bdi dir="ltr">{{ money(report.totals.unallocated_revenue) }}</bdi></span></p>
            <p v-if="report.totals.excluded_revenue" class="period-note">{{ $t('Service charges and other non-product sales are excluded') }}: <span data-no-i18n><bdi dir="ltr">{{ money(report.totals.excluded_revenue) }}</bdi></span></p>
            <p class="period-note">{{ $t('Each operation uses the quantity-weighted average purchase price over its 30-day cost window, or the reference price when no priced deliveries are available. Recorded costs stay unchanged when you select a different report period.') }}</p>
            </details>
            <div class="analysis-views"><h3>{{ $t('Report details') }}</h3>
                <div class="view-switch" role="group" :aria-label="$t('Report detail view')">
                    <button v-for="option in detailViews" :key="option.value" type="button" :aria-pressed="view === option.value" @click="view=option.value">{{ $t(option.label) }}</button>
                </div>
                <label v-if="view !== 'stock'">{{ $t('Search') }}<input v-model="search" type="search"></label>
            </div>
            <slot v-if="view === 'stock'" name="stock" />
            <template v-else>
            <div class="analysis-table-scroll"><table v-if="view === 'meal'" class="meal-table"><colgroup><col class="name-col"><col class="quantity-col"><col><col><col><col class="action-col"></colgroup><thead><tr><th>{{ $t('Meal') }}</th><th class="logical-text-start">{{ $t('Sold / refunded') }}</th><th class="logical-text-start">{{ $t('Net meal revenue') }}</th><th class="logical-text-start">{{ $t('Ingredient cost') }}</th><th class="logical-text-start">{{ $t('Sales less ingredient cost') }}</th><th class="logical-text-start">{{ $t('Details') }}</th></tr></thead><tbody><tr v-for="row in pagedRows" :key="row.product_id"><th scope="row"><bdi data-no-i18n>{{ row.name }}</bdi></th><td class="quantity-cell logical-text-start"><bdi dir="ltr" data-no-i18n>{{ row.sold }} <span class="muted">/ {{ row.refunded }}</span></bdi></td><td class="logical-text-start" data-no-i18n><bdi dir="ltr">{{ money(row.net_revenue) }}</bdi></td><td class="logical-text-start"><span data-no-i18n><bdi dir="ltr">{{ money(row.known_cost) }}</bdi></span><small v-if="row.incomplete_lines">{{ $t('Incomplete') }}</small></td><td class="logical-text-start" data-no-i18n><bdi dir="ltr">{{ money(row.estimated_margin) }}</bdi></td><td class="logical-text-start"><button type="button" @click="openMeal(row)">{{ $t('View calculation') }}</button></td></tr></tbody></table>
            <table v-else-if="view === 'ingredient'" class="ingredient-table"><colgroup><col class="ingredient-name-col"><col><col><col class="action-col"></colgroup><thead><tr><th>{{ $t('Ingredient') }}</th><th class="logical-text-start">{{ $t('Usage from net sales') }}</th><th class="logical-text-start">{{ $t('Ingredient cost') }}</th><th class="logical-text-start">{{ $t('Details') }}</th></tr></thead><tbody><tr v-for="row in pagedRows" :key="row.ingredient_id"><th scope="row"><bdi data-no-i18n>{{ row.name }}</bdi></th><td class="quantity-cell logical-text-start"><bdi dir="ltr" data-no-i18n>{{ quantity(row.qty,row.display_unit) }}</bdi></td><td class="logical-text-start"><span data-no-i18n><bdi dir="ltr">{{ money(row.known_cost) }}</bdi></span><small v-if="row.incomplete">{{ $t('Incomplete') }}</small></td><td class="logical-text-start"><button type="button" @click="openIngredient(row)">{{ $t('View meals using this ingredient') }}</button></td></tr></tbody></table>
            <table v-else-if="view === 'preparation'" class="preparation-table">
                <thead><tr><th>{{ $t('Ingredient') }}</th><th class="logical-text-start">{{ $t('Recipe usage') }}</th></tr></thead>
                <tbody><tr v-for="row in pagedRows" :key="row.ingredient_id"><th scope="row"><bdi data-no-i18n>{{ row.name }}</bdi></th><td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ quantity(row.qty,row.display_unit) }}</bdi></td></tr></tbody>
            </table>
            <table v-else class="comparison-table">
                <thead><tr><th>{{ $t('Ingredient') }}</th><th>{{ $t('Between stock counts') }}</th><th class="logical-text-start">{{ $t('Actual usage') }}</th><th class="logical-text-start">{{ $t('Recipe usage') }}</th><th class="logical-text-start">{{ $t('Recorded waste') }}</th><th class="logical-text-start">{{ $t('Unaccounted usage') }}</th></tr></thead>
                <tbody><tr v-for="row in pagedRows" :key="row.ingredient_id"><th scope="row"><bdi data-no-i18n>{{ row.name }}</bdi></th><td class="count-interval"><time><bdi dir="ltr" data-no-i18n>{{ formatBusinessDateTime(row.from_at) }}</bdi></time><time><bdi dir="ltr" data-no-i18n>{{ formatBusinessDateTime(row.to_at) }}</bdi></time></td><td v-for="field in ['actual_usage','theoretical','waste','unexplained']" :key="field" class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ quantity(row[field],row.display_unit) }}</bdi></td></tr></tbody>
            </table>
            </div>
            <p v-if="view === 'preparation'" class="period-note">{{ $t('Usage is grouped by movement date and includes open orders. It may differ from paid sales. Refunds restore ingredients according to your POS settings.') }}</p>
            <p v-if="view === 'counts'" class="period-note">{{ $t('Actual usage is measured between two counts. These intervals may cover only part of the selected period.') }}</p>

            <p v-if="!filteredRows.length" class="empty">{{ $t('No matching activity in this period.') }}</p>
            <nav v-if="page > 1 || hasNext" class="pagination" :aria-label="$t('Analysis pages')"><button :disabled="loading || page<=1" @click="changePage(-1)">{{ $t('Previous') }}</button><span data-no-i18n>{{ page }}</span><button :disabled="loading || !hasNext" @click="changePage(1)">{{ $t('Next') }}</button></nav>
            <section v-if="selectedIngredient" class="calculation"><div class="calculation-title"><h3 data-no-i18n>{{ selectedIngredient.name }}</h3><button @click="selectedIngredient=null">{{ $t('Close') }}</button></div><p>{{ $t('These are sales of meals that use this ingredient. Do not add these sales across ingredients: a meal can appear under several ingredients.') }}</p><p v-if="ingredientLoading" role="status">{{ $t('Loading analysis...') }}</p><p v-if="ingredientError" role="alert">{{ $t(ingredientError) }} <button @click="openIngredient(selectedIngredient)">{{ $t('Retry') }}</button></p><button v-for="meal in ingredientMeals" :key="meal.product_id" class="drill-row" @click="openMeal(meal)"><span data-no-i18n>{{ meal.name }}</span><strong data-no-i18n><bdi dir="ltr">{{ money(meal.net_revenue) }}</bdi></strong></button><nav v-if="ingredientPage > 1 || ingredientCursor" class="pagination"><button :disabled="ingredientLoading || ingredientPage<=1" @click="loadIngredient(ingredientPage-1)">{{ $t('Previous') }}</button><span data-no-i18n>{{ ingredientPage }}</span><button :disabled="ingredientLoading || !ingredientCursor" @click="loadIngredient(ingredientPage+1)">{{ $t('Next') }}</button></nav></section>
            <section v-if="selectedMeal" class="calculation"><div class="calculation-title"><h3 data-no-i18n>{{ selectedMeal.name }}</h3><button @click="selectedMeal=null">{{ $t('Close') }}</button></div><p>{{ $t('These are stock quantities, adjusted for the preparation yield set in the recipe.') }}</p><div v-for="part in selectedMeal.ingredients" :key="part.ingredient_id" class="drill-row"><span data-no-i18n>{{ part.name }}</span><span dir="ltr" data-no-i18n>{{ quantity(part.qty,part.display_unit) }}</span><strong data-no-i18n><bdi dir="ltr">{{ part.incomplete ? '—' : money(part.known_cost) }}</bdi></strong></div><nav v-if="partsPage > 1 || partsNext" class="pagination"><button :disabled="detailsLoading || partsPage<=1" @click="changeDetails('parts',-1)">{{ $t('Previous') }}</button><span data-no-i18n>{{ partsPage }}</span><button :disabled="detailsLoading || !partsNext" @click="changeDetails('parts',1)">{{ $t('Next') }}</button></nav><p v-if="detailsLoading" role="status">{{ $t('Loading history...') }}</p><p v-if="detailsError" role="alert">{{ $t(detailsError) }} <button @click="openMeal(selectedMeal)">{{ $t('Retry') }}</button></p><div v-for="event in events" :key="event.id" class="source-event"><span>{{ $t(event.kind==='refund'?'Refund':'Sale') }} <span data-no-i18n>#{{ event.invoice_id }}</span></span><time data-no-i18n>{{ formatBusinessDateTime(event.at) }}</time><span>{{ $t('Quantity') }}: <b data-no-i18n>{{ event.quantity }}</b></span><span>{{ $t('Net meal revenue') }}: <b data-no-i18n><bdi dir="ltr">{{ money(event.net_revenue) }}</bdi></b></span><span>{{ $t('Ingredient cost') }}: <b data-no-i18n><bdi dir="ltr">{{ event.incomplete ? '—' : money(event.known_cost) }}</bdi></b></span></div><div class="pagination"><button :disabled="detailsLoading || detailPage<=1" @click="changeDetails('events',-1)">{{ $t('Previous') }}</button><span data-no-i18n>{{ detailPage }}</span><button :disabled="detailsLoading || !detailsHasMore" @click="changeDetails('events',1)">{{ $t('Next') }}</button></div></section>
            </template>
        </template>
    </section>
</template>

<script setup>
import {computed,inject,onMounted,onUnmounted,ref,watch} from 'vue';
import {fetchJson} from '@/shared/http.js';
import {fromBaseQty} from '@/shared/ingredientUnits.js';
import {formatBusinessDateTime} from '../../utils/businessDate.js';
const period=inject('dailyReportPeriod');
const from=period.startDate,to=period.endDate;
const report=ref(null),loading=ref(false),error=ref(''),view=ref('meal'),search=ref(''),page=ref(1);
const selectedMeal=ref(null),selectedIngredient=ref(null),events=ref([]),detailPage=ref(1),detailsHasMore=ref(false),detailsLoading=ref(false),detailsError=ref('');
const pageCursors=ref(['']),ingredientMeals=ref([]),ingredientCursor=ref(null),ingredientCursors=ref(['']),ingredientPage=ref(1),ingredientLoading=ref(false),ingredientError=ref('');
const eventCursors=ref(['']),eventNext=ref(null),partsCursors=ref(['']),partsPage=ref(1),partsNext=ref(null);
let controller,detailsController,ingredientController,searchTimer,sequence=0,detailsSequence=0,ingredientSequence=0;
const money=value=>value==null?'—':Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const quantity=(qty,unit)=>qty==null?'—':`${fromBaseQty(qty,unit)} ${unit}`;
const detailViews=[{value:'meal',label:'By meal'},{value:'ingredient',label:'By ingredient'},{value:'preparation',label:'Usage by movement date'},{value:'counts',label:'Count comparison'},{value:'stock',label:'Daily stock movement'}];
const filteredRows=computed(()=>((report.value?.[{meal:'meals',ingredient:'ingredients',preparation:'operations',counts:'comparisons'}[view.value]])||[]));
const coveragePercent=computed(()=>{const total=Number(report.value?.totals?.total_meals)||0;return total?Math.max(0,Math.min(100,Math.round((Number(report.value.totals.complete_meals)||0)/total*100))):0;});
const hasNext=computed(()=>Boolean(report.value?.next_cursor));
const pagedRows=filteredRows;
const freshnessLabel=computed(()=>({unavailable:'Totals will appear when this report is ready.',rebuilding:'Updating the report for this period...',stale:'Showing the latest available totals. Recent activity is still being processed.'}[report.value?.freshness?.state]||''));
watch(search,()=>{
    clearTimeout(searchTimer);controller?.abort();sequence++;loading.value=true;
    searchTimer=setTimeout(()=>{void load();},300);
});
watch(view,()=>{clearTimeout(searchTimer);selectedMeal.value=null;selectedIngredient.value=null;if(view.value!=='stock')void load();});
async function load({cursor:requestedCursor='',targetPage=1}={}){
    if(view.value==='stock')return;
    controller?.abort(); detailsController?.abort(); detailsSequence++;
    ingredientController?.abort();ingredientSequence++;
    detailsLoading.value=false;
    const seq=++sequence; controller=new AbortController(); error.value='';
    if(from.value>to.value){error.value='From date must be on or before To date.';loading.value=false;return;}
    loading.value=true; selectedMeal.value=null;selectedIngredient.value=null;
    try{
        const data=await fetchJson(`api/admin/ingredients/analysis?${new URLSearchParams({from:from.value,to:to.value,view:view.value,q:search.value.trim(),...(requestedCursor?{cursor:requestedCursor}:{})})}`,{signal:controller.signal});
        if(seq!==sequence)return;
        if(!data.success)throw new Error(data.message||'Load failed.');
        report.value=data;page.value=targetPage;
        if(targetPage===1)pageCursors.value=[''];
        pageCursors.value[targetPage-1]=requestedCursor;
    }catch(caught){if(seq===sequence&&caught.name!=='AbortError')error.value=caught.message||'Load failed.';}
    finally{if(seq===sequence)loading.value=false;}
}
function changePage(delta){
    const targetPage=page.value+delta;
    if(loading.value||targetPage<1||delta>0&&!hasNext.value)return;
    void load({cursor:delta>0?report.value.next_cursor:pageCursors.value[targetPage-1],targetPage});
}
function openIngredient(row){selectedIngredient.value=row;ingredientMeals.value=[];ingredientCursor.value=null;ingredientCursors.value=[''];ingredientPage.value=1;void loadIngredient();}
async function loadIngredient(targetPage=ingredientPage.value){
    if(!selectedIngredient.value)return;
    ingredientController?.abort();ingredientController=new AbortController();const seq=++ingredientSequence;
    ingredientLoading.value=true;ingredientError.value='';
    const cursor=targetPage>ingredientPage.value?ingredientCursor.value:ingredientCursors.value[targetPage-1];
    try{
        const data=await fetchJson(`api/admin/ingredients/analysis?${new URLSearchParams({from:report.value.period.start_date,to:report.value.period.end_date,view:'meal',ingredient_id:selectedIngredient.value.ingredient_id,...(cursor?{cursor}:{})})}`,{signal:ingredientController.signal});
        if(seq!==ingredientSequence||!selectedIngredient.value)return;
        if(!data.success)throw new Error(data.message||'Load failed.');
        ingredientMeals.value=data.meals;ingredientCursor.value=data.next_cursor;
        ingredientPage.value=targetPage;ingredientCursors.value[targetPage-1]=cursor||'';
    }catch(caught){if(seq===ingredientSequence&&caught.name!=='AbortError')ingredientError.value=caught.message||'Load failed.';}
    finally{if(seq===ingredientSequence)ingredientLoading.value=false;}
}
function openMeal(row){selectedMeal.value=row;detailPage.value=1;partsPage.value=1;eventCursors.value=[''];partsCursors.value=[''];eventNext.value=null;partsNext.value=null;void loadDetails();}
function changeDetails(kind,delta){
    if(detailsLoading.value)return;
    void loadDetails({eventPage:detailPage.value+(kind==='events'?delta:0),partPage:partsPage.value+(kind==='parts'?delta:0)});
}
async function loadDetails({eventPage=detailPage.value,partPage=partsPage.value}={}){
    detailsController?.abort();detailsController=new AbortController();const seq=++detailsSequence;
    events.value=[];detailsLoading.value=true;detailsError.value='';
    const eventCursor=eventPage>detailPage.value?eventNext.value:eventCursors.value[eventPage-1];
    const partsCursor=partPage>partsPage.value?partsNext.value:partsCursors.value[partPage-1];
    try{
        const data=await fetchJson(`api/admin/ingredients/analysis?${new URLSearchParams({from:report.value.period.start_date,to:report.value.period.end_date,view:'meal',product_id:selectedMeal.value.product_id,...(eventCursor?{event_cursor:eventCursor}:{}),...(partsCursor?{parts_cursor:partsCursor}:{})})}`,{signal:detailsController.signal});
        if(seq!==detailsSequence)return;
        if(!data.success)throw new Error(data.message||'Load failed.');
        events.value=data.events;detailsHasMore.value=data.events_has_more;
        eventNext.value=data.events_next_cursor;partsNext.value=data.parts_next_cursor;
        detailPage.value=eventPage;partsPage.value=partPage;
        eventCursors.value[eventPage-1]=eventCursor||'';partsCursors.value[partPage-1]=partsCursor||'';
        const meal=(data.meals||[]).find(row=>row.product_id===selectedMeal.value?.product_id);
        if(meal?.ingredients) selectedMeal.value={...selectedMeal.value,ingredients:meal.ingredients};
    }catch(caught){if(seq===detailsSequence&&caught.name!=='AbortError')detailsError.value=caught.message||'Load failed.';}
    finally{if(seq===detailsSequence)detailsLoading.value=false;}
}
onMounted(load);
watch([from,to],load);
onUnmounted(()=>{clearTimeout(searchTimer);controller?.abort();detailsController?.abort();ingredientController?.abort();sequence++;detailsSequence++;ingredientSequence++;});
</script>

<style scoped>
.analysis-workspace{padding:0;min-height:0;color:#273544;font-size:13px;line-height:1.6}
.period-note,.calculation>p{color:#66717f;margin-block:8px}
button,select,input{min-height:44px;border:1px solid #cbd2dc;border-radius:6px;padding:8px 12px;background:white;color:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #315d86;outline-offset:2px}

.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-block:20px}.metric-grid article{background:#fff;border:1px solid #dce3ea;border-radius:8px;padding:20px}.metric-grid strong{display:block;font-size:clamp(28px,3vw,42px);font-variant-numeric:tabular-nums;margin-block:8px}.metric-grid small{display:block;color:#66717f}
.coverage{padding:14px 18px;background:#fff6df;border:1px solid #ead8a8;border-radius:6px;margin-block:12px}.analysis-views{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:24px}.analysis-views button[aria-pressed=true]{background:#24405e;color:white}.analysis-views label{margin-inline-start:auto;display:flex;gap:8px;align-items:center}
.analysis-table-scroll{overflow-x:auto;margin-top:16px;border:1px solid #dce3ea;border-radius:8px}table{border-collapse:collapse;width:100%;min-width:650px}th,td{text-align:start;padding:14px;border-bottom:1px solid #e5e9ef}thead{background:#f4f6f8}td small{display:block;color:#986215}.pagination{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-block:14px}.empty{padding:24px;text-align:center}
.calculation{border:1px solid #dce3ea;border-radius:8px;padding:20px;margin-block:20px;background:white}.calculation-title,.drill-row,.source-event{display:flex;gap:14px;align-items:center;justify-content:space-between}.drill-row{width:100%;padding-block:12px;border-bottom:1px solid #e5e9ef;flex-wrap:wrap}.source-event{font-size:12px;padding-block:12px;border-bottom:1px solid #e5e9ef;flex-wrap:wrap}summary{cursor:pointer;font-weight:600;min-height:44px}h3{font-weight:700}.count-comparison{padding-block:14px}.count-comparison dl{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.count-comparison dd{font-weight:600}[role=alert]{color:#a22a2a}
@media(max-width:767px){.analysis-workspace{padding:0}.metric-grid{grid-template-columns:1fr;gap:10px}.metric-grid article{padding:14px}.metric-grid strong{font-size:24px}.analysis-views label{width:100%;margin:8px 0}.analysis-views input{flex:1;min-width:0}.count-comparison dl{grid-template-columns:1fr 1fr}}

.metric-grid { gap: 0; border: 1px solid #d5dfe7; border-radius: 12px; overflow: hidden; margin-block: 0 16px; }
.metric-grid article { border: 0; border-radius: 0; padding: 24px; border-inline-end: 1px solid #d5dfe7; position: relative; }
.metric-grid article > span { font-weight: 650; }
.metric-grid article:last-child { border: 0; background: var(--color-brand-800); color: #fff; }
.metric-grid article:last-child small { color: var(--color-brand-100); }
.metric-grid.incomplete article:last-child { background: #263749; }
.metric-grid article small { line-height: 1.6; max-width: 30ch; }
.cost-readiness { padding: 16px 20px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-brand-50); }
.cost-readiness.needs-costs { border-color: #ead9b5; background: #fffaf0; }
.readiness-heading, .readiness-footer { display: flex; align-items: center; gap: 9px; }
.readiness-count { margin-inline-start: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-primary); }
.needs-costs .status-dot { background: #b3781c; }
.coverage-track { height: 6px; background: var(--color-border); border-radius: 4px; overflow: hidden; margin-block: 12px 8px; }
.coverage-track span { display: block; height: 100%; background: var(--color-primary); }
.readiness-footer { justify-content: space-between; color: var(--color-muted-foreground); font-size: 12px; flex-wrap: wrap; }
.readiness-footer a { color: #805618; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.missing-cost-note { margin-top: 8px; font-size: 12px; color: #805618; }
.method-notes { margin-block: 8px 28px; font-size: 12px; color: #64717d; }
.method-notes summary { display: list-item; min-height: 36px; align-content: center; }
.method-notes[open] { padding: 12px 16px; background: #f6f8fa; border-radius: 8px; }
.analysis-views { gap: 16px; border-bottom: 1px solid #dce3ea; padding-bottom: 14px; }
.analysis-views h3 { margin-inline-end: auto; font-size: 16px; }
.view-switch { display: flex; padding: 3px; border: 1px solid #dce3ea; border-radius: 8px; background: #f5f7f9; }
.view-switch button { min-height: 36px; border: 0; background: transparent; padding: 5px 12px; }
.analysis-views label { margin-inline-start: 0; }
.analysis-views input { width: 180px; }
.analysis-table-scroll { border: 0; border-radius: 0; margin-top: 0; }
table { table-layout: fixed; min-width: 800px; }
.name-col { width: 30%; }.quantity-col { width: 13%; }.action-col { width: 150px; }.ingredient-name-col { width: 38%; }
th,td { padding: 16px 12px; vertical-align: middle; }
thead th { font-size: 11px; color: #62717f; font-weight: 650; line-height: 1.6; }
tbody th { font-weight: 600; line-height: 1.65; overflow-wrap: anywhere; }
thead th:not(:first-child),td { text-align: start; }
thead th:last-child,td:last-child { text-align: start; }
td { font-variant-numeric: tabular-nums; white-space: nowrap; }
td bdi { display: inline-block; }
td small { display: block; font-size: 10px; color: #99651a; }
tbody tr:hover { background: #f7fafb; }
td button { font-size: 11px; min-height: 36px; padding: 6px 9px; border-color: #dce3ea; color: #244b65; background: #f7fafc; }
.muted { color: #8995a0; }
@media(max-width:767px) {
 .metric-grid { grid-template-columns: 1fr 1fr; gap: 0; }
 .metric-grid article { padding: 16px; }
 .metric-grid article:last-child { grid-column: 1/-1; }
 .metric-grid article strong { font-size: 28px; }
 .cost-readiness { padding: 14px; }
 .analysis-views h3 { width: 100%; }
 .analysis-views label { width: 100%; }
 .analysis-views input { width: 100%; }
}
.metric-grid article.negative { background: #682e3b; }
.metric-grid article.negative small { color: #eed4da; }
.outcome { font-size: 12px; font-weight: 650; margin-bottom: 8px; }
.analysis-workspace table th { white-space: normal !important; }
.view-switch { flex-wrap: wrap; gap: 3px; }
.count-interval time { display: block; font-size: 11px; white-space: normal; }
.comparison-table th:last-child,.comparison-table td:last-child,.preparation-table th:last-child,.preparation-table td:last-child { text-align: start; }
</style>

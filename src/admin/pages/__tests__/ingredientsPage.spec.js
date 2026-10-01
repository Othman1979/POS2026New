import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
const routerPush=vi.hoisted(()=>vi.fn());
vi.mock('vue-router',()=>({useRouter:()=>({push:routerPush})}));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('../../components/IngredientRecipes.vue', () => ({ default: {} }));
// Dialogs bind to the browser document when created; the page tests only need them present.
vi.mock('../../components/ModalShell.vue', () => ({ default: { render: () => null } }));
vi.mock('../../components/IngredientFormModal.vue', () => ({ default: { render: () => null } }));
vi.mock('../../components/IngredientMovementModal.vue', () => ({ default: { render: () => null } }));
vi.mock('../../components/IngredientHistoryDrawer.vue', () => ({ default: { render: () => null } }));
// The real purchase screen is lazy; this stand-in shows which kind the page opened it with.
vi.mock('../../components/purchases/PurchaseInvoicesTab.vue', () => ({
 __esModule: true,
 default: { props: { itemKind: { type: String, required: true } }, render() { return h('div', { class: 'purchases-tab', 'data-kind': this.itemKind }); } },
}));
import Ingredients from '../Ingredients.vue';
import { fetchJson } from '@/shared/http.js';

let scope, state;
const ingredient = (id, extra = {}) => ({ id, name: `Ingredient ${String(id).padStart(2, '0')}`, measure: 'weight', display_unit: 'kg', is_active: true, expected_remaining: 1000, below_par: false, today: { opening: 1000, received: 0, used: 0, waste: 0 }, last_count: null, ...extra });
beforeEach(() => {vi.useFakeTimers();scope=effectScope();state=scope.run(()=>Ingredients.setup({}, {expose(){}}));fetchJson.mockReset();routerPush.mockClear();});
afterEach(()=>{scope.stop();vi.clearAllTimers();vi.useRealTimers();});

describe('ingredient working list server paging',()=>{
 it('keeps earlier waste choices when the operator loads another page',async()=>{
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[ingredient(1)],next_cursor:'waste2'});
  state.showWastePicker.value=true;await vi.advanceTimersByTimeAsync(0);
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[ingredient(21)],next_cursor:null});
  await state.loadWaste(true);
  expect(fetchJson.mock.lastCall[0]).toContain('cursor=waste2');
  expect(state.wasteOptions.value.map(row=>row.id)).toEqual([1,21]);
 });
 it('sends combined filters once after debounce and preserves the server order',async()=>{
  fetchJson.mockResolvedValue({success:true,ingredients:[ingredient(3),ingredient(1)],daily_freshness:{state:'stale'}});
  state.searchQuery.value=' chicken ';state.measureFilter.value='weight';state.statusFilter.value='all';state.stockFilter.value='variance';state.sortBy.value='variance';
  await vi.advanceTimersByTimeAsync(299);expect(fetchJson).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetchJson).toHaveBeenCalledTimes(1);
  const query=new URL(fetchJson.mock.calls[0][0],'http://localhost/').searchParams;
  expect(Object.fromEntries(query)).toMatchObject({q:'chicken',measure:'weight',status:'all',attention:'variance',sort:'variance',limit:'50'});
  expect(state.pagedRows.value.map(row=>row.id)).toEqual([3,1]);expect(state.dailyProjectionState.value).toBe('stale');
 });
 it('loads the next server cursor and resets it when filters change',async()=>{
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[ingredient(1)],next_cursor:'cursor1',has_more:true});
  await state.refreshRows();
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[ingredient(2)],next_cursor:null,has_more:false});
  state.loadMoreRows();await vi.advanceTimersByTimeAsync(60);
  expect(fetchJson.mock.calls[1][0]).toContain('cursor=cursor1');expect(state.rows.value.map(row=>row.id)).toEqual([1,2]);
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[ingredient(8)]});state.stockFilter.value='uncounted';await vi.advanceTimersByTimeAsync(400);
  expect(fetchJson.mock.calls[2][0]).not.toContain('cursor=');expect(state.rows.value.map(row=>row.id)).toEqual([8]);
 });
 it('opens the stock-count tab of the inventory page',()=>{
  state.openInventoryTab('counts');
  expect(routerPush.mock.calls).toEqual([[{name:'inventory',query:{tab:'counts'}}]]);
 });
 describe('ingredient purchase invoices',()=>{
  const render=async(show)=>{
   const app=createSSRApp({...Ingredients,setup(props,ctx){const bindings=Ingredients.setup(props,ctx);bindings.showPurchases.value=show;return bindings;}});
   app.config.globalProperties.$t=key=>key;
   return renderToString(app);
  };
  it('opens in place of the list with the ingredient kind, and the list is not shown beside it',async()=>{
   const open=await render(true);
   expect(open).toContain('data-kind="ingredient"');
   expect(open).toContain('Ingredient purchase invoices');
   expect(open).not.toContain('ingredient-ledger');
   const list=await render(false);
   expect(list).not.toContain('purchases-tab');
   expect(list).toContain('ingredient-ledger');
  });
  it('stays open when the unsaved draft is kept, and closes then refreshes the balances when it is not',async()=>{
   fetchJson.mockResolvedValue({success:true,ingredients:[ingredient(1)]});
   state.showPurchases.value=true;
   const confirmDiscard=vi.fn().mockResolvedValue(false);
   state.purchasesTab.value={confirmDiscard};
   await state.closePurchases();
   expect(confirmDiscard).toHaveBeenCalledTimes(1);
   expect(state.showPurchases.value).toBe(true);
   await vi.advanceTimersByTimeAsync(200);
   expect(fetchJson).not.toHaveBeenCalled();
   confirmDiscard.mockResolvedValue(true);
   await state.closePurchases();
   expect(state.showPurchases.value).toBe(false);
   await vi.advanceTimersByTimeAsync(200);
   expect(fetchJson).toHaveBeenCalledTimes(1);
   expect(fetchJson.mock.calls[0][0]).toContain('api/admin/ingredients?');
   expect(state.rows.value.map(row=>row.id)).toEqual([1]);
  });
  it('closes without asking when the screen has not loaded yet',async()=>{
   fetchJson.mockResolvedValue({success:true,ingredients:[]});
   state.showPurchases.value=true;
   await state.closePurchases();
   expect(state.showPurchases.value).toBe(false);
  });
 });
 it('keeps previous rows on a failed refresh and recovers on retry',async()=>{
  state.rows.value=[ingredient(1)];fetchJson.mockRejectedValueOnce(new Error('Network unavailable'));await state.refreshRows();
  expect(state.rows.value).toHaveLength(1);expect(state.error.value).toBe('Network unavailable');
  fetchJson.mockResolvedValueOnce({success:true,ingredients:[]});state.loadRows();await vi.runAllTimersAsync();
  expect(state.error.value).toBe('');expect([state.rangeStart.value,state.rangeEnd.value]).toEqual([0,0]);
 });
 it('distinguishes unknown quantities from zero and paginates without reordering',()=>{
  state.rows.value=Array.from({length:26},(_,i)=>ingredient(i+1));const ids=[];
  for(let page=1;page<=3;page++){state.page.value=page;ids.push(...state.pagedRows.value.map(row=>row.id));}
  expect(ids).toEqual(Array.from({length:26},(_,i)=>i+1));expect([state.rangeStart.value,state.rangeEnd.value]).toEqual([21,26]);
  expect(state.formatQty(1500,'kg')).toBe('1.5');expect(state.formatQty(0,'kg')).toBe('0');expect(state.formatQty(null,'kg')).toBe('—');
 });
});

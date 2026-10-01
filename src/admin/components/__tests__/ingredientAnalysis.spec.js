import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {effectScope,nextTick,ref} from 'vue';
const shared = vi.hoisted(() => ({ period: null }));
vi.mock('vue',async original=>({...await original(),useSSRContext:()=>({modules:new Set()}),inject:()=>shared.period,onMounted:vi.fn(),onUnmounted:vi.fn()}));
vi.mock('@/shared/http.js',()=>({fetchJson:vi.fn()}));
vi.mock('../../../utils/businessDate.js',()=>({currentBusinessDate:()=> '2026-09-07',addBusinessDateDays:(day,n)=>new Date(Date.parse(day)+n*86400000).toISOString().slice(0,10),formatBusinessDateTime:value=>value}));
import Analysis from '../IngredientAnalysis.vue';
import {fetchJson} from '@/shared/http.js';
let scope,state;
const response=(names=['Chicken'])=>({success:true,period:{start_date:'2026-09-07',end_date:'2026-09-07'},meals:names.map((name,i)=>({product_id:i+1,name,ingredients:[]})),ingredients:[],events:[],events_has_more:false});
beforeEach(()=>{fetchJson.mockReset();shared.period={startDate:ref('2026-09-07'),endDate:ref('2026-09-07')};scope=effectScope();state=scope.run(()=>Analysis.setup({}, {expose:()=>{}}));});
afterEach(()=>scope.stop());
describe('ingredient sales analysis workflow',()=>{
    it('reloads once when the shared report period changes and sends both business dates',async()=>{
        fetchJson.mockResolvedValue(response());
        shared.period.startDate.value='2026-09-01';shared.period.endDate.value='2026-09-06';
        await nextTick();await vi.waitFor(()=>expect(state.loading.value).toBe(false));
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(fetchJson.mock.calls[0][0]).toContain('from=2026-09-01&to=2026-09-06');
    });
    it('shows coverage from complete meals without treating empty or missing costs as full coverage',()=>{
        state.report.value={totals:{complete_meals:0,total_meals:0}};expect(state.coveragePercent.value).toBe(0);
        state.report.value={totals:{complete_meals:1,total_meals:4}};expect(state.coveragePercent.value).toBe(25);
        state.report.value={totals:{complete_meals:0,total_meals:4,incomplete:true}};expect(state.coveragePercent.value).toBe(0);
    });
    it('requests continuation pages and searches the complete server dataset',async()=>{
        fetchJson.mockResolvedValueOnce({...response(Array.from({length:50},(_,i)=>`Meal ${i}`)),next_cursor:'next-page'})
            .mockResolvedValueOnce({...response(['Meal 50']),next_cursor:null})
            .mockResolvedValueOnce({...response(['Meal 204']),next_cursor:null});
        await state.load();expect(state.pagedRows.value).toHaveLength(50);expect(state.hasNext.value).toBe(true);
        state.changePage(1);await vi.waitFor(()=>expect(state.page.value).toBe(2));
        expect(fetchJson.mock.calls[1][0]).toContain('cursor=next-page');
        expect(state.pagedRows.value[0].name).toBe('Meal 50');
        state.search.value='Meal 204';await nextTick();await vi.waitFor(()=>expect(state.page.value).toBe(1));
        expect(fetchJson.mock.calls[2][0]).toContain('q=Meal+204');
        expect(fetchJson.mock.calls[2][0]).not.toContain('cursor=');
        expect(state.pagedRows.value[0].name).toBe('Meal 204');
    });
    it('requests the selected table dataset and clears old drilldowns',async()=>{
        fetchJson.mockResolvedValue({...response(),operations:[{ingredient_id:1,name:'Chicken',qty:200}],comparisons:[{ingredient_id:2,name:'Potato',actual_usage:90}]});await state.load();
        state.selectedMeal.value={name:'Old meal'};state.page.value=3;state.view.value='preparation';await nextTick();await vi.waitFor(()=>expect(state.loading.value).toBe(false));
        expect(state.selectedMeal.value).toBe(null);expect(state.page.value).toBe(1);expect(state.pagedRows.value[0].qty).toBe(200);
        state.view.value='counts';await nextTick();await vi.waitFor(()=>expect(state.loading.value).toBe(false));expect(state.pagedRows.value[0].actual_usage).toBe(90);
        expect(fetchJson).toHaveBeenCalledTimes(3);
        expect(fetchJson.mock.calls[2][0]).toContain('view=counts');
    });
    it('ignores late report responses even if cancellation is not honored',async()=>{
        let first;fetchJson.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValueOnce(response(['New result']));
        const old=state.load();await state.load();first(response(['Old result']));await old;
        expect(state.report.value.meals[0].name).toBe('New result');expect(state.loading.value).toBe(false);
    });
    it('retains the labelled previous report on failure and can retry',async()=>{
        fetchJson.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(response(['Recovered']));
        await state.load();await state.load();expect(state.report.value.meals[0].name).toBe('Chicken');expect(state.error.value).toBe('Connection lost');
        await state.load();expect(state.error.value).toBe('');expect(state.report.value.meals[0].name).toBe('Recovered');
        expect(state.money(null)).toBe('—');expect(state.money(0)).not.toBe('—');
        expect(state.quantity(null,'kg')).toBe('—');expect(state.quantity(0,'kg')).toBe('0 kg');
    });
    it('keeps a late meal drilldown from replacing the newly selected meal',async()=>{
        fetchJson.mockResolvedValueOnce(response(['First','Second']));await state.load();
        let first;fetchJson.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValueOnce({...response(),events:[{id:'sale:2'}]});
        state.openMeal(state.report.value.meals[0]);state.openMeal(state.report.value.meals[1]);
        await vi.waitFor(()=>expect(state.events.value).toEqual([{id:'sale:2'}]));first({...response(),events:[{id:'sale:1'}]});
        await nextTick();expect(state.events.value).toEqual([{id:'sale:2'}]);
    });
    it('uses independent continuation tokens for events and recipe parts',async()=>{
        fetchJson.mockResolvedValueOnce(response());await state.load();
        fetchJson.mockResolvedValueOnce({...response(),events:[{id:'sale:1'}],events_has_more:true,events_next_cursor:'events-2',parts_next_cursor:'parts-2'})
            .mockResolvedValueOnce({...response(),events:[{id:'sale:2'}],events_has_more:false,events_next_cursor:null,parts_next_cursor:'parts-2'})
            .mockResolvedValueOnce({...response(),meals:[{product_id:1,ingredients:[{ingredient_id:51,name:'Later ingredient'}]}],events:[{id:'sale:2'}],parts_next_cursor:null});
        state.openMeal(state.report.value.meals[0]);await vi.waitFor(()=>expect(state.detailsLoading.value).toBe(false));
        state.changeDetails('events',1);await vi.waitFor(()=>expect(state.detailPage.value).toBe(2));
        expect(fetchJson.mock.calls[2][0]).toContain('event_cursor=events-2');
        state.changeDetails('parts',1);await vi.waitFor(()=>expect(state.partsPage.value).toBe(2));
        expect(fetchJson.mock.calls[3][0]).toContain('event_cursor=events-2');
        expect(fetchJson.mock.calls[3][0]).toContain('parts_cursor=parts-2');
        expect(state.selectedMeal.value.ingredients[0].name).toBe('Later ingredient');
    });
    it('hides metric zeros when published totals are unavailable and labels stale rebuilds',async()=>{
        fetchJson.mockResolvedValue({success:true,period:{start_date:'2026-09-07',end_date:'2026-09-07'},totals:null,freshness:{state:'unavailable',source:'none'},meals:[],ingredients:[],events:[],events_has_more:false});
        await state.load();
        expect(state.report.value.totals).toBeNull();
        expect(state.freshnessLabel.value).toBe('Totals will appear when this report is ready.');
        state.report.value={...state.report.value,totals:{net_revenue:8,known_cost:1,complete_meals:1,total_meals:1},freshness:{state:'stale',source:'published',as_of:'2026-09-07T10:00:00.000Z'}};
        expect(state.freshnessLabel.value).toBe('Showing the latest available totals. Recent activity is still being processed.');
        expect(state.coveragePercent.value).toBe(100);
        state.report.value={...state.report.value,freshness:{state:'rebuilding',source:'none'}};
        expect(state.freshnessLabel.value).toBe('Updating the report for this period...');
    });
    it('fetches ingredient meal associations independently of the loaded meal page',async()=>{
        fetchJson.mockResolvedValueOnce({...response(['Soup','Salad']),ingredients:[{ingredient_id:9,name:'Stock'}]})
            .mockResolvedValueOnce({...response(['Meal outside the main page']),next_cursor:null});
        await state.load();
        state.openIngredient(state.report.value.ingredients[0]);
        await vi.waitFor(()=>expect(state.ingredientLoading.value).toBe(false));
        expect(fetchJson.mock.calls[1][0]).toContain('ingredient_id=9');
        expect(state.ingredientMeals.value.map(row=>row.name)).toEqual(['Meal outside the main page']);
    });
});

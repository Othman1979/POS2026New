import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const auth = { activeUser: ref(null), activeShift: ref(null), isTempAdmin: ref(false) };
vi.mock('./useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('./useTerminal.js', () => ({ useTerminal: () => ({ lastOrder: ref(null), taxInclusivePricing: ref(false) }) }));
vi.mock('./useProducts.js', () => ({ useProducts: () => ({ products: ref([]), settings: ref({}) }) }));
vi.mock('./stores/orderSession/orderSessionApi.js', () => ({ saveTableOrder: vi.fn() }));
const { useOrderSessionStore } = await import('./stores/orderSessionStore.js');

beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', {getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
    vi.stubGlobal('window',{showPosAlert:vi.fn()});
});

it.each([
    ['cashier',['waiter.checkout'],false,false],
    ['waiter',['waiter.checkout'],false,true],
    ['waiter',['pos.checkout'],true,true],
    ['cashier',['pos.checkout'],true,true],
    ['waiter',[],false,false],
])('keeps counter and saved-table payment controls consistent for %s with %j', (role,permissions,counterAllowed,tableAllowed) => {
    auth.activeUser.value={id:7,role,permissions};
    const store=useOrderSessionStore();
    expect(store.canCheckout || store.canCheckoutTable).toBe(counterAllowed);
    store.activeTable={id:1,current_order_id:88};
    expect(store.canCheckout || store.canCheckoutTable).toBe(tableAllowed);
    store.activeTable={id:1,split_check_id:99,is_split:true};
    expect(store.canCheckout || store.canCheckoutTable).toBe(tableAllowed);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
    ['cashier',[],false,false],
    ['cashier',['tables.access'],false,false],
    ['cashier',['tables.save'],false,false],
    ['cashier',['tables.access','tables.save'],true,false],
    ['cashier',['tables.access','waiter.edit_locked'],false,true],
    ['cashier',['tables.access','tables.save','waiter.edit_locked'],true,true],
    ['waiter',['waiter.edit_locked'],true,true],
    ['admin',[],true,true],
    ['call_center',['tables.access','tables.save','waiter.edit_locked'],false,false],
])('reacts to first save and existing order for %s with %j', (role,permissions,createAllowed,editAllowed) => {
    auth.activeUser.value={id:7,role,permissions};
    const store=useOrderSessionStore();
    store.activeTable={id:1,current_order_id:null};
    expect(store.canUpdateTable).toBe(createAllowed);
    store.activeTable.current_order_id=88;
    expect(store.canUpdateTable).toBe(editAllowed);
    auth.activeUser.value={id:7,role:'cashier',permissions:[]};
    expect(store.canUpdateTable).toBe(false);
});

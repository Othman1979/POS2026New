import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const auth = { activeUser: ref({ id: 1, role: 'cashier', permissions: [] }), activeShift: ref({ id: 9 }), isTempAdmin: ref(false) };
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('./useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('./useTerminal.js', () => ({ useTerminal: () => ({ lastOrder: ref(null), taxInclusivePricing: ref(false) }) }));
vi.mock('./useProducts.js', () => ({ useProducts: () => ({ products: ref([]), settings: ref({}) }) }));
vi.mock('vue-router', () => ({ useRouter: () => null }));
const { useOrderSessionStore } = await import('./stores/orderSessionStore.js');
const { useOrderUiStore } = await import('./stores/orderUiStore.js');
const { useCart } = await import('./useCart.js');

const answer = body => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

beforeEach(() => {
    setActivePinia(createPinia());
    auth.activeUser.value = { id: 1, role: 'cashier', permissions: [] };
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('window', {
        showPosAlert: vi.fn(async () => {}), showPosToast: vi.fn(), showPosPrompt: vi.fn(),
        location: { pathname: '/pos' }, history: { replaceState: vi.fn() },
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('no-sale cash drawer open', () => {
    it('sends the given receipt printer id without asking for a manager PIN', async () => {
        vi.stubGlobal('fetch', answer({ success: true }));
        const ui = useOrderUiStore();
        ui.showMoreActionsModal = true;
        expect(await useOrderSessionStore().openCashDrawer(7)).toBe(true);
        const [[url, init]] = fetch.mock.calls;
        expect(url).toBe('api/pos/log_drawer_pop');
        expect(JSON.parse(init.body)).toEqual({ receipt_printer_id: 7, reason: 'No sale / Manual drawer open' });
        expect(window.showPosPrompt).not.toHaveBeenCalled();
        expect(ui.showMoreActionsModal).toBe(false);
    });

    it('keeps More Actions open and reports the refusal when the server declines', async () => {
        vi.stubGlobal('fetch', answer({ success: false, message: 'No receipt printer configured.' }));
        const ui = useOrderUiStore();
        ui.showMoreActionsModal = true;
        expect(await useOrderSessionStore().openCashDrawer(7)).toBe(false);
        expect(window.showPosAlert).toHaveBeenCalledWith('No receipt printer configured.');
        expect(ui.showMoreActionsModal).toBe(true);
    });

    it('never sends a drawer command for a waiter', async () => {
        vi.stubGlobal('fetch', answer({ success: true }));
        auth.activeUser.value = { id: 3, role: 'waiter', permissions: [] };
        expect(await useOrderSessionStore().openCashDrawer(7)).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
});

// Run PosTerminal's real click handler with the store action replaced by a controllable promise.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const body = parseScript(source, { sourceType: 'module' }).program.body;
const decl = name => { const n = body.find(x => x.declarations?.some(d => d.id.name === name)); return source.slice(n.start, n.end); };
const buildHandler = new Function('isOpeningCashDrawer', 'openCashDrawer', 'localPrinterId',
    `${decl('handleOpenCashDrawer')}\nreturn handleOpenCashDrawer;`);

describe('PosTerminal open drawer button', () => {
    it('sends one drawer command on the terminal receipt printer however often it is tapped', async () => {
        const pending = [];
        const openCashDrawer = vi.fn(() => new Promise(r => { pending.push(r); }));
        const tap = buildHandler(ref(false), openCashDrawer, { value: '7' });
        const taps = [tap(), tap()];
        expect(openCashDrawer.mock.calls).toEqual([['7']]);
        pending.forEach(settle => settle(true));
        await Promise.all(taps);
        void tap();
        expect(openCashDrawer).toHaveBeenCalledTimes(2);
    });

    it('drives the real useCart() drawer action from the button handler', async () => {
        vi.stubGlobal('fetch', answer({ success: true }));
        const tap = buildHandler(ref(false), useCart().openCashDrawer, { value: '7' });
        await tap();
        const [[url, init]] = fetch.mock.calls;
        expect(url).toBe('api/pos/log_drawer_pop');
        expect(JSON.parse(init.body)).toEqual({ receipt_printer_id: '7', reason: 'No sale / Manual drawer open' });
        expect(window.showPosPrompt).not.toHaveBeenCalled();
    });
});
// Render PosTerminal's real More Actions drawer tile from its template markup.
const template = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.template.ast;
const findTile = n => (n.tag === 'button' && n.loc.source.includes('No Sale (Open Drawer)') ? n : (n.children || []).map(findTile).find(Boolean));
const renderTile = new Function('Vue', compile(findTile(template).loc.source, { mode: 'function', prefixIdentifiers: true }).code)(Vue);
const tile = (role, opening = false, handleOpenCashDrawer = vi.fn()) =>
    renderTile({ activeUser: { role }, isOpeningCashDrawer: opening, handleOpenCashDrawer, $t: key => key }, []);

describe('PosTerminal More Actions drawer tile', () => {
    it.each(['cashier', 'admin', 'programmer'])('shows the tile to a %s and taps it into the drawer handler', role => {
        const handleOpenCashDrawer = vi.fn();
        const vnode = tile(role, false, handleOpenCashDrawer);
        expect(vnode.type).toBe('button');
        expect(vnode.props.disabled).toBe(false);
        vnode.props.onClick();
        expect(handleOpenCashDrawer).toHaveBeenCalledTimes(1);
    });

    it('hides the tile from a waiter', () => {
        expect(tile('waiter').type).not.toBe('button');
    });

    it('disables the tile while a drawer command is in flight', () => {
        expect(tile('cashier', true).props.disabled).toBe(true);
    });
});

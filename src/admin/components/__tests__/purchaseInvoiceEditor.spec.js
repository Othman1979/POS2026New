import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onBeforeUnmount: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/utils/businessDate.js', () => ({ currentBusinessDate: () => '2026-09-30' }));
vi.mock('../purchases/purchasesApi.js', () => ({
    describeError: error => error.message,
    purchasesApi: {
        createInvoice: vi.fn(), updateInvoice: vi.fn(), postInvoice: vi.fn(), getInvoice: vi.fn(),
        reverseInvoice: vi.fn(), deleteInvoice: vi.fn(), lastInvoice: vi.fn(), listCategories: vi.fn(), searchItems: vi.fn(), createSupplier: vi.fn(),
    },
}));
import Editor from '../purchases/PurchaseInvoiceEditor.vue';
import { purchasesApi } from '../purchases/purchasesApi.js';
import { applyItem, newRow } from '../purchases/purchaseMath.js';

const milk = { item_key: 'product:11', name: 'Milk', base_unit: 'ml', packs: [{ label: 'ml', factor: 1 }, { label: 'box', factor: 12000 }], last: null };
const flour = { item_key: 'product:12', name: 'Flour', base_unit: 'g', packs: [{ label: 'g', factor: 1 }], last: null };
const lostReply = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const serverInvoice = (extra = {}) => ({ id: 5, version: 1, status: 'draft', supplier_id: 3, supplier_name: 'Dairy Co', supplier_invoice_no: 'A-1', invoice_date: '2026-09-30', payment_status: 'credit', total: 23.2, lines: [], ...extra });

let scope, editor, emitted, confirm;
const makeEditor = (itemKind) => scope.run(() => Editor.setup({ itemKind, openId: null, suppliers: [{ id: 3, name: 'Dairy Co' }] }, { expose: () => {}, emit: (name, payload) => emitted.push([name, payload]) }));
beforeEach(() => {
    Object.values(purchasesApi).forEach(fn => fn.mockReset());
    confirm = vi.fn(async () => true);
    vi.stubGlobal('window', { showAdminConfirm: confirm });
    emitted = [];
    scope = effectScope();
    editor = makeEditor('product');
    Object.assign(editor.form, { supplier_id: 3, supplier_invoice_no: 'A-1' });
    const first = applyItem(newRow(), milk, { qty: 2 });
    Object.assign(first, { unit_price: 10, tax_rate: 16 });
    const empty = applyItem(newRow(), flour);
    editor.rows.value = [first, empty, newRow()];
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

const events = name => emitted.filter(([event]) => event === name).map(([, payload]) => payload);

describe('purchase invoice editor save and post', () => {
    it('saves only entered lines under a stable key, posts, and resets for the next invoice', async () => {
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        purchasesApi.postInvoice.mockResolvedValue(serverInvoice({ status: 'posted', version: 2 }));
        const postKey = editor.meta.post_key;
        await editor.requestPost('new');
        const body = purchasesApi.createInvoice.mock.calls[0][0];
        expect(body.client_key).toBeTruthy();
        expect(body.lines).toEqual([{ item_key: 'product:11', qty: 2, unit_label: 'box', unit_factor: 12000, unit_price: 10, tax_rate: 16 }]);
        expect(purchasesApi.postInvoice).toHaveBeenCalledWith(5, 1, postKey);
        expect(events('saved').map(invoice => invoice.status)).toEqual(['draft', 'posted']);
        expect(editor.meta.id).toBeNull();
        expect(editor.rows.value.length).toBe(1);
        expect(editor.form.supplier_invoice_no).toBe('');
        expect(editor.note.value).toContain('Posted invoice');
    });

    it('asks before posting a total that differs from the paper and posts nothing when declined', async () => {
        editor.form.paper_total = 99;
        confirm.mockResolvedValue(false);
        await editor.requestPost('new');
        expect(confirm.mock.calls[0][0]).toContain('The total does not match the paper total.');
        expect(purchasesApi.createInvoice).not.toHaveBeenCalled();
        expect(purchasesApi.postInvoice).not.toHaveBeenCalled();
    });

    it('refuses to save without a supplier invoice number', async () => {
        editor.form.supplier_invoice_no = '  ';
        await editor.saveDraft();
        expect(purchasesApi.createInvoice).not.toHaveBeenCalled();
        expect(editor.errorText.value).toBe('Enter the supplier invoice number.');
    });
});

describe('purchase invoice editor lost replies', () => {
    it('keeps the post key and blocks other attempts until the invoice is re-read', async () => {
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        purchasesApi.postInvoice.mockRejectedValueOnce(lostReply());
        await editor.requestPost('new');
        const key = editor.meta.post_key;
        expect(editor.pending.value).toMatchObject({ op: 'post' });
        expect(editor.meta.id).toBe(5);

        await editor.requestPost('new');
        await editor.saveDraft();
        expect(purchasesApi.postInvoice).toHaveBeenCalledTimes(1);
        expect(purchasesApi.updateInvoice).not.toHaveBeenCalled();

        purchasesApi.getInvoice.mockResolvedValue(serverInvoice({ status: 'draft', version: 1 }));
        await editor.checkOutcome();
        expect(purchasesApi.getInvoice).toHaveBeenCalledWith(5);
        expect(editor.pending.value).toBeNull();
        expect(editor.meta.post_key).toBe(key);

        purchasesApi.postInvoice.mockResolvedValue(serverInvoice({ status: 'posted', version: 2 }));
        await editor.requestPost('new');
        expect(purchasesApi.postInvoice).toHaveBeenLastCalledWith(5, 1, key);
    });

    it('treats a post that committed behind a lost reply as done without posting twice', async () => {
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        purchasesApi.postInvoice.mockRejectedValue(lostReply());
        await editor.requestPost('new');
        purchasesApi.getInvoice.mockResolvedValue(serverInvoice({ status: 'posted', version: 2, total: 23.2 }));
        await editor.checkOutcome();
        expect(purchasesApi.postInvoice).toHaveBeenCalledTimes(1);
        expect(events('saved').at(-1).status).toBe('posted');
        expect(editor.meta.id).toBeNull();
        expect(editor.note.value).toContain('Posted invoice');
    });

    it('replays a lost create with the same key and the original lines', async () => {
        purchasesApi.createInvoice.mockRejectedValueOnce(lostReply());
        await editor.saveDraft();
        const first = purchasesApi.createInvoice.mock.calls[0][0];
        expect(editor.pending.value).toMatchObject({ op: 'save', create: true });
        // Edits are locked while the outcome is unknown, so the replay is the original intent.
        expect(editor.locked.value).toBe(true);
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        await editor.checkOutcome();
        expect(purchasesApi.createInvoice).toHaveBeenCalledTimes(2);
        expect(purchasesApi.createInvoice.mock.calls[1][0]).toEqual(first);
        expect(editor.meta.id).toBe(5);
        expect(editor.pending.value).toBeNull();
    });

    it('takes a new create key after a definite failure', async () => {
        purchasesApi.createInvoice.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'PURCHASE_INVOICE_DUPLICATE', status: 409 }));
        const before = editor.meta.create_key;
        await editor.saveDraft();
        expect(editor.meta.create_key).not.toBe(before);
        expect(editor.errorText.value).toBe('duplicate');
        expect(editor.pending.value).toBeNull();
    });
});

// Renders the real editor template around the given rows (the SSR build drops event bindings, so this checks what is shown).
async function renderEditor(itemKind, rows) {
    const app = createSSRApp({
        ...Editor,
        setup(props, ctx) { const bindings = Editor.setup(props, ctx); bindings.rows.value = rows; return bindings; },
    }, { itemKind, suppliers: [{ id: 3, name: 'Dairy Co' }] });
    app.config.globalProperties.$t = key => key;
    return renderToString(app);
}

describe('purchase invoice kinds', () => {
    // An ingredient invoice: same screen, ingredient items only.
    const ingredientEditor = () => {
        const kind = makeEditor('ingredient');
        Object.assign(kind.form, { supplier_id: 3, supplier_invoice_no: 'A-1' });
        const row = applyItem(newRow(), { ...flour, item_key: 'ingredient:2' }, { qty: 5 });
        row.unit_price = 2;
        kind.rows.value = [row, newRow()];
        return kind;
    };

    it('creates the invoice with the kind of the page that opened it', async () => {
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        await editor.saveDraft();
        expect(purchasesApi.createInvoice.mock.calls[0][0].kind).toBe('product');

        const kind = ingredientEditor();
        await kind.saveDraft();
        expect(purchasesApi.createInvoice.mock.calls[1][0].kind).toBe('ingredient');
    });

    it('keeps the kind when a lost create is replayed', async () => {
        const kind = ingredientEditor();
        purchasesApi.createInvoice.mockRejectedValueOnce(lostReply());
        await kind.saveDraft();
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        await kind.checkOutcome();
        expect(purchasesApi.createInvoice.mock.calls.map(([body]) => body.kind)).toEqual(['ingredient', 'ingredient']);
    });

    it('reads the last invoice and the category items of its own kind', async () => {
        purchasesApi.lastInvoice.mockResolvedValue([]);
        const kind = makeEditor('ingredient');
        kind.form.supplier_id = 3;
        await kind.repeatLast();
        expect(purchasesApi.lastInvoice).toHaveBeenCalledWith(3, 'ingredient');

        purchasesApi.searchItems.mockResolvedValue([]);
        editor.categoryId.value = '4';
        await editor.addCategory();
        expect(purchasesApi.searchItems).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product', categoryId: '4' }));
    });

    it('offers the category picker for products only', async () => {
        expect(await renderEditor('product', [newRow()])).toContain('Add category');
        expect(await renderEditor('ingredient', [newRow()])).not.toContain('Add category');
    });
});

describe('purchase invoice starts-tracking cue', () => {
    const unlimited = { ...milk, starts_tracking: true };
    const tagged = html => html.match(/class="pi-track"/g)?.length || 0;

    it('tags a draft line only when its item starts being tracked, with the reason as its title', async () => {
        const rows = [applyItem(newRow(), unlimited, { qty: 1 }), applyItem(newRow(), { ...flour, starts_tracking: false }, { qty: 1 }), newRow()];
        const html = await renderEditor('product', rows);
        expect(tagged(html)).toBe(1);
        expect(html).toContain('Stock is unlimited now. Receiving it starts counting its stock.');
        expect(tagged(await renderEditor('product', [applyItem(newRow(), flour, { qty: 1 }), newRow()]))).toBe(0);
    });

    it('keeps the flag of a loaded invoice line, and shows no cue once the invoice is posted', async () => {
        const line = { item_key: 'product:11', name: 'Milk', base_unit: 'ml', qty: 2, unit_label: 'ml', unit_factor: 1, unit_price: 1, tax_rate: 0, starts_tracking: true };
        purchasesApi.getInvoice.mockResolvedValue(serverInvoice({ lines: [line] }));
        await editor.loadInvoice(5);
        const row = editor.rows.value[0];
        expect(row.item.starts_tracking).toBe(true);
        expect(editor.startsTracking(row)).toBe(true);

        editor.meta.status = 'posted';
        expect(editor.startsTracking(row)).toBe(false);
    });
});

describe('purchase invoice editor corrections and recovery', () => {
    const storage = () => {
        const data = new Map();
        return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
    };

    it('reopens a posted invoice as a draft through one keyed request and lists both', async () => {
        editor.meta.id = 5;
        editor.meta.status = 'posted';
        const { reverse_key: reverseKey, revise_key: reviseKey } = editor.meta;
        purchasesApi.reviseInvoice = vi.fn().mockResolvedValue({
            reversed: serverInvoice({ status: 'reversed', supplier_invoice_no: 'A-1-R5' }),
            invoice: serverInvoice({ id: 9, lines: [{ item_key: 'product:11', name: 'Milk', base_unit: 'ml', qty: 2, unit_label: 'box', unit_factor: 12000, unit_price: 10, tax_rate: 16 }] }),
        });
        await editor.reviseInvoice();
        expect(purchasesApi.reviseInvoice).toHaveBeenCalledWith(5, reverseKey, reviseKey);
        expect(events('saved').map(invoice => [invoice.id, invoice.status])).toEqual([[5, 'reversed'], [9, 'draft']]);
        expect(editor.meta).toMatchObject({ id: 9, status: 'draft' });
        expect(editor.rows.value.filter(row => row.item).map(row => row.item.item_key)).toEqual(['product:11']);
        expect(editor.meta.revise_key).not.toBe(reviseKey);
    });

    it('does not reopen when the manager declines', async () => {
        editor.meta.id = 5;
        editor.meta.status = 'posted';
        confirm.mockResolvedValue(false);
        purchasesApi.reviseInvoice = vi.fn();
        await editor.reviseInvoice();
        expect(purchasesApi.reviseInvoice).not.toHaveBeenCalled();
    });

    it('mirrors unsaved lines to the device, offers them to a new editor, and restores them', async () => {
        const local = storage();
        vi.stubGlobal('localStorage', local);
        editor.writeBackup();
        const saved = JSON.parse(local.data.get('pos_purchase_backup_product'));
        expect(saved.form).toMatchObject({ supplier_id: 3, supplier_invoice_no: 'A-1' });
        expect(saved.rows.map(row => row.item?.item_key)).toEqual(['product:11', 'product:12']);

        scope.stop();
        scope = effectScope();
        editor = makeEditor('product');
        editor.offerBackup();
        expect(editor.backupOffer.value).toMatchObject({ id: null, lines: 2 });
        await editor.restoreBackup();
        expect(editor.form.supplier_invoice_no).toBe('A-1');
        expect(editor.rows.value.filter(row => row.item).map(row => [row.item.item_key, row.qty, row.unit_price])).toEqual([['product:11', 2, 10], ['product:12', '', '']]);
        expect(editor.backupOffer.value).toBeNull();
        expect(editor.dirty.value).toBe(true);
    });

    it('drops the device copy once the invoice is saved', async () => {
        const local = storage();
        vi.stubGlobal('localStorage', local);
        editor.writeBackup();
        expect(local.data.has('pos_purchase_backup_product')).toBe(true);
        purchasesApi.createInvoice.mockResolvedValue(serverInvoice());
        editor.rows.value = editor.rows.value.slice(0, 1);
        await editor.saveDraft();
        expect(local.data.has('pos_purchase_backup_product')).toBe(false);
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJsonResponseWithTimeout: http.send, isUnansweredRequest: () => false }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
import { purchasesApi } from '../purchases/purchasesApi.js';

const sent = (index = 0) => {
    const [url, options] = http.send.mock.calls[index];
    const parsed = new URL(url, 'http://pos.test/');
    return { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), options };
};

beforeEach(() => {
    http.send.mockReset();
    http.send.mockResolvedValue({ response: { ok: true }, data: { success: true, data: [] } });
});

describe('purchase API carries the invoice kind', () => {
    it.each(['product', 'ingredient'])('asks for %s items, invoices and the last invoice of that kind', async kind => {
        await purchasesApi.searchItems({ kind, q: 'flour', supplierId: 3 });
        await purchasesApi.searchItems({ kind, barcode: '6281', limit: 1 });
        await purchasesApi.listInvoices({ kind, status: 'posted', beforeId: 40 });
        await purchasesApi.lastInvoice(3, kind);

        expect(sent(0)).toMatchObject({ path: '/api/admin/purchases/items', params: { kind, q: 'flour', supplier_id: '3' } });
        expect(sent(1).params).toMatchObject({ kind, barcode: '6281', limit: '1' });
        expect(sent(2)).toMatchObject({ path: '/api/admin/purchases/invoices', params: { kind, status: 'posted', before_id: '40' } });
        expect(sent(3)).toMatchObject({ path: '/api/admin/purchases/invoices/last', params: { kind, supplier_id: '3' } });
    });

    it('sends the kind in the body of a new invoice', async () => {
        await purchasesApi.createInvoice({ kind: 'ingredient', client_key: 'k', lines: [] });
        expect(sent(0).options).toMatchObject({ method: 'POST' });
        expect(JSON.parse(sent(0).options.body)).toMatchObject({ kind: 'ingredient', client_key: 'k' });
    });

    it('lists categories without a kind: categories belong to products', async () => {
        await purchasesApi.listCategories();
        expect(sent(0)).toMatchObject({ path: '/api/admin/purchases/categories', params: {} });
    });
});

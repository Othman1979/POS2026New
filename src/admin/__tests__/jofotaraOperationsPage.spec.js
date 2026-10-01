import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('JoFotara operations admin boundary', () => {
    it('registers one responsive operations page and a visible navigation alert', () => {
        const registry = read('src/admin/pageRegistry.js');
        const sidebar = read('src/admin/components/Sidebar.vue');
        const page = read('src/admin/pages/JofotaraOperations.vue');

        expect(registry).toContain("jofotara: () => import('./pages/JofotaraOperations.vue')");
        expect(sidebar).toContain("page: 'jofotara'");
        expect(sidebar).toContain('jofotaraCount');
        expect(page).toContain("fetchJsonResponse('api/admin/jofotara/operations");
        expect(page).toContain('jofotara_operations_changed');
        expect(page).toContain('waiting_for_original');
        expect(page).toContain('Waiting for original');
        expect(page).toContain('openResponse(item)');
        expect(page).toContain('responseModal');
        expect(page).toContain('operations/documents/${item.document_id}/response');
        expect(page).not.toMatch(/request_xml|legal_snapshot_json|response_body|secret_key/);
    });

    it('keeps automation opt-in in settings and the cutoff server-owned', () => {
        const settings = read('src/admin/pages/Settings.vue');
        expect(settings).toContain('jofotaraForm.auto_submit');
        expect(settings).toContain('jofotaraForm.archive_xml');
        expect(settings).not.toContain('v-model="jofotaraForm.auto_submit_since"');
    });

    it('keeps manual Operations filtering and selected submission client-driven', () => {
        const page = read('src/admin/pages/JofotaraOperations.vue');
        expect(page).toContain('source_kind');
        expect(page).toContain('order_type_id');
        expect(page).toContain('issued_from');
        expect(page).toContain('issued_to');
        expect(page).toContain('source_kind');
        expect(page).toContain('gross_total');
        expect(page).toContain('order_type_name');
        expect(page).toContain('v-if="item.can_submit"');
        expect(page).toContain('selectedKeys');
        expect(page).toContain('const items = [...selectedItems.value]');
        expect(page).toContain('for (const item of items)');
        expect(page).toContain('operations/invoices/${item.source_id}/submit');
        expect(page).toContain('operations/refunds/${item.source_id}/submit');
        expect(page).toContain("payload.document?.status === 'accepted'");
        expect(page).toContain("payload.document?.status === 'rejected'");
        expect(page).toContain('else results.failed += 1');
        expect(page).toContain('Recover automatic sales');
        expect(page).not.toMatch(/setInterval|setTimeout|scheduler|request_xml|legal_snapshot|secret_key/i);
    });

    it('honours an Operations deep link without hiding the active invoice filter', () => {
        const page = read('src/admin/pages/JofotaraOperations.vue');
        expect(page).toContain('useRoute');
        expect(page).toContain('route.query.source_kind');
        expect(page).toContain('route.query.invoice_id');
        expect(page).toContain('filters.invoice_id');
        expect(page).toContain('clearInvoiceFocus');
    });
});

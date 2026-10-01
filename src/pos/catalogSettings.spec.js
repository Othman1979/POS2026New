import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('catalog settings source', () => {
    let mod;
    beforeEach(async () => {
        vi.resetModules();
        mod = await import('./catalogSettings.js');
    });

    it('takes the POS keys from the terminal settings read, normalized to strings', () => {
        mod.applyCatalogSettings({ stock_enabled: true, service_charge_percentage: 12, store_name: 'POS' });
        expect(mod.catalogSettings.value).toEqual({ stock_enabled: '1', service_charge_percentage: '12' });
    });

    it('lets each settings read replace the previous one entirely', () => {
        mod.applyCatalogSettings({ stock_enabled: '1', recipe_ledger_enabled: '1' });
        mod.applyCatalogSettings({ stock_enabled: '0' });
        expect(mod.catalogSettings.value).toEqual({ stock_enabled: '0' });
    });
});

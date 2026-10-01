const { validateJofotaraCatalogRates } = require('../../services/JofotaraService');

describe('JoFotara catalog validation diagnostics', () => {
    const products = [{ tax_rate: 16, jofotara_tax_category: 'S' }];
    const connection = { query: vi.fn(async () => [products]) };

    it('identifies a stale positive-rate service-charge category explicitly', async () => {
        await expect(validateJofotaraCatalogRates(connection, {
            jofotara_enabled: '1',
            tax_registration_type: 'sales_tax',
            service_charge_enabled: '1',
            service_charge_tax_rate: '8',
            service_charge_jofotara_tax_category: 'O'
        })).rejects.toThrow('Service charge');
    });
});

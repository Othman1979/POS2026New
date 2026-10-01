import { ref } from 'vue';

// Settings the catalog UI and cart rules read (stock gating, service charge).
// The terminal settings read (GET /api/system/settings, every role) is the only
// writer, so a settings refresh updates them without a catalog read.
export const catalogSettings = ref({});

export const CATALOG_SETTING_KEYS = Object.freeze([
    'stock_enabled', 'recipe_ledger_enabled', 'tables_enabled',
    'service_charge_enabled', 'service_charge_percentage', 'auto_apply_service_charge',
]);

const normalize = (value) => (typeof value === 'boolean' ? (value ? '1' : '0') : String(value));

export const applyCatalogSettings = (data) => {
    const next = {};
    for (const key of CATALOG_SETTING_KEYS) {
        const value = data?.[key];
        if (value !== undefined && value !== null) next[key] = normalize(value);
    }
    catalogSettings.value = next;
};

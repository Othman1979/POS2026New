import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settings = readFileSync(resolve(process.cwd(), 'src/admin/pages/Settings.vue'), 'utf8');
const arabic = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));

describe('Quick numpad settings wiring', () => {
    it('loads, displays, and saves the persisted toggle', () => {
        expect(settings).toContain('v-model="quickNumpadMode"');
        expect(settings).toContain("quickNumpadMode.value = dataSet.quick_numpad_mode === '1'");
        expect(settings).toContain("quick_numpad_mode: quickNumpadMode.value ? '1' : '0'");
    });

    it('loads, displays, and saves the quantity preset toggle with presets enabled by default', () => {
        expect(settings).toContain('v-model="quantityPresetsEnabled"');
        expect(settings).toContain("quantityPresetsEnabled.value = dataSet.quantity_presets_enabled !== '0'");
        expect(settings).toContain("quantity_presets_enabled: quantityPresetsEnabled.value ? '1' : '0'");
    });

    it('uses deliberate English and Arabic copy', () => {
        expect(settings).toContain("$t('Quick numpad mode')");
        expect(arabic['Quick numpad mode']).toBe('وضع لوحة الأرقام السريعة');
        expect(arabic['Enter an amount, then choose a product. Press × first to enter a quantity.'])
            .toBe('أدخل المبلغ ثم اختر الصنف. اضغط × أولاً لإدخال الكمية.');
        expect(arabic['Quantity preset buttons']).toBe('أزرار الكمية الجاهزة');
        expect(arabic['Show 0.125, 0.25, 0.5 and 0.75 above the keypad.'])
            .toBe('اعرض 0.125 و0.25 و0.5 و0.75 فوق لوحة الأرقام.');
    });
});

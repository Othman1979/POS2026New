import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Quick-amount store behaviour lives in src/pos/cartWrites.spec.js and the catalog
// click in catalogDerivation.spec.js; these pin the remaining template wiring.

const read = path => readFileSync(resolve(process.cwd(), path), 'utf8');
const cart = read('src/components/pos/PosCartWorkspace.vue');
const modifier = read('src/components/pos/ModifierSelectorModal.vue');
const arabic = JSON.parse(read('src/shared/i18n/ar.json'));

describe('Quick numpad UI contract', () => {
  it('clears transient input whenever the saved mode changes', () => {
    expect(cart).toMatch(/watch\(quickNumpadMode,[\s\S]*cancelQuickAmount\(\)[\s\S]*setNumpadMode\('qty'\)[\s\S]*immediate: true/);
  });

  it('shows enabled quantity presets in quick or quantity mode and routes them through quantity behavior', () => {
    expect(cart).toContain('v-if="quantityPresetsEnabled && (quickNumpadMode || numpadMode === \'qty\')"');
    expect(cart).toContain('const { quickNumpadMode, quantityPresetsEnabled } = useTerminal()');
    expect(cart).toContain('@click="applyQuantityPreset(preset)"');
  });

  it('cancels an armed quantity before selecting an existing cart row', () => {
    expect(cart).toContain('@click.stop="selectCartRow(row)"');
    expect(cart).toMatch(/const selectCartRow = \(row\) => \{[\s\S]*cancelQuickAmount\(\);[\s\S]*selectedCartIndex\.value =[\s\S]*numpadInput\.value = '';/);
  });

  it('cancels modifier work through one cleanup action', () => {
    expect(modifier).not.toContain('@click="showModifierModal = false"');
    expect(modifier.match(/@click="cancelModifiers"/g)).toHaveLength(2);
  });

  it('has natural Arabic error messages', () => {
    expect(arabic['Enter an amount, then choose a product. Press × first to enter a quantity.'])
      .toBe('أدخل المبلغ ثم اختر الصنف. اضغط × أولاً لإدخال الكمية.');
    expect(arabic['Enter a valid quantity first.']).toBe('أدخل كمية صحيحة أولاً.');
    expect(arabic['This product needs a valid price before its quantity can be calculated.'])
      .toBe('يجب أن يكون للصنف سعر صحيح قبل حساب كميته.');
  });
});

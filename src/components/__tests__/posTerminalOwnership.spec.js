import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountClient } from '../pos/__tests__/clientTemplateHarness.js';

const componentRoot = resolve(process.cwd(), 'src/components');
const orderSessionStorePath = resolve(process.cwd(), 'src/pos/stores/orderSessionStore.js');
const posTerminalPath = resolve(componentRoot, 'PosTerminal.vue');
const arabicCatalog = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
const componentFiles = (directory) => readdirSync(directory).flatMap((entry) => {
  const fullPath = resolve(directory, entry);
  if (statSync(fullPath).isDirectory()) return componentFiles(fullPath);
  return /\.(?:js|vue)$/.test(entry) ? [fullPath] : [];
});

describe('POS terminal ownership', () => {
  it('keeps components off private order-session implementation modules', () => {
    for (const file of componentFiles(componentRoot)) {
      if (file.split(/[\\/]/).includes('__tests__')) continue;
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /(?:@\/|src\/|(?:\.\.?\/)+)pos\/stores\/orderSession\//
      );
    }
  });

  it('keeps request transport out of the order-session store and POS terminal component', () => {
    expect(readFileSync(orderSessionStorePath, 'utf8')).not.toMatch(/\bfetch\s*\(/);
    expect(readFileSync(posTerminalPath, 'utf8')).not.toMatch(/\bfetch\s*\(/);
  });

  it('keeps the catalog visual workflow behind one workspace component', () => {
    const source = readFileSync(posTerminalPath, 'utf8');
    expect(source).toContain('<PosCatalogWorkspace');
    expect(source).not.toContain('id="categories-sidebar"');
    expect(source).not.toContain('const handleProductClick');
  });

  it('loads POS dialogs only when their workflows open and preloads hot dialogs while idle', () => {
    const source = readFileSync(posTerminalPath, 'utf8');
    expect(source).not.toMatch(/import CheckoutModal from/);
    expect(source).not.toMatch(/import TerminalSettingsModal from/);
    expect(source).toContain("const loadCheckoutModal = () => import('./pos/CheckoutModal.vue')");
    expect(source).toContain('<CheckoutModal v-if="showCheckoutModal" />');
    expect(source).toContain('<SplitCheckModal v-if="!isCallCenter && showSplitModal" />');
    expect(source).toContain('<TerminalSettingsModal v-if="!isCallCenter && showTerminalSettings" />');
    expect(source).toContain('scheduleIdlePreload(preloadHotDialogs)');
    expect(source).toContain('loadCheckoutModal(),');
    expect(source).toContain('loadModifierSelectorModal(),');
    expect(source).toContain('loadCartNotesModal(),');
    // Dialogs and screens the user can reach are warmed too; the unused receipt preview is not.
    for (const loader of ['loadSplitCheckModal', 'loadShiftReportModal', 'loadTerminalSettingsModal', 'loadPrivilegesModal', 'loadExpenseModal']) {
      expect(source).toContain(`const ${loader} = () => import(`);
      expect(source).toContain(`lazyPosComponent(${loader},`);
      expect(source.slice(source.indexOf('const preloadHotDialogs'), source.indexOf('const scheduleHotDialogPreload'))).toContain(`${loader}()`);
    }
    expect(source).not.toMatch(/const preloadHotDialogs[\s\S]*ReceiptPreview[\s\S]*const scheduleHotDialogPreload/);
    expect(source).toMatch(/can\('tables\.access'\)[^\n]*preloadRoute\(router, '\/tables'\)/);
    expect(source).toMatch(/can\('pos\.hold_orders'\)[^\n]*preloadRoute\(router, '\/order-notes'\)/);
  });

  it('translates the compact table relationship actions to Arabic', () => {
    const workspace = readFileSync(resolve(componentRoot, 'pos/PosCartWorkspace.vue'), 'utf8');

    expect(arabicCatalog.Transfer).toBe('نقل');
    expect(arabicCatalog.Join).toBe('ضم');
    expect(arabicCatalog.Disjoin).toBe('فصل');
    expect(workspace).toContain("$t(isCallCenter ? 'Send Order' : 'Pay')");
  });

  it('applies the availability PATCH response instead of re-reading the catalog', () => {
    const workspace = readFileSync(resolve(componentRoot, 'pos/PosCatalogWorkspace.vue'), 'utf8');
    const handler = workspace.slice(
      workspace.indexOf('const updateProductAvailability'),
      workspace.indexOf('const handleProductContextMenu')
    );
    expect(handler).not.toContain('forceFull');
    expect(handler).toContain('products.applyProductAvailabilityChanges');
  });

  it('shows the previous drawer close as a translated read-only reference', () => {
    const source = readFileSync(posTerminalPath, 'utf8');

    expect(source).toContain('v-if="previousShiftClosingCash !== null"');
    expect(source).toContain("previousShiftClosingCash.toFixed(2)");
    expect(source).not.toContain('v-model.number="previousShiftClosingCash"');
    expect(arabicCatalog['Previous shift drawer closing balance']).toBe('رصيد الصندوق عند إغلاق الوردية السابقة');
    expect(source).toContain("$t('Starting cash is prefilled from the previous closing count. Count the drawer and correct it if different.')");
    expect(arabicCatalog['Starting cash is prefilled from the previous closing count. Count the drawer and correct it if different.']).toBe('يُعبأ النقد الافتتاحي من عدّ الإغلاق السابق. عُدّ الصندوق وصحّحه إذا كان مختلفاً.');
  });

  it('keeps starting cash the cashier typed when a shift check returns a different suggestion', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ success: true, shift: null, previous_shift_closing_cash: 80, suggested_starting_cash: 80 }),
    })));
    try {
      const { useAuth } = await import('@/pos/useAuth.js');
      const { startingCashInput, markStartingCashEdited, checkActiveShift } = useAuth();
      // Mount the real starting-cash input compiled from PosTerminal.vue, wired to the real auth store.
      const { root, app } = mountClient(
        { setup: () => ({ startingCashInput, markStartingCashEdited }) }, posTerminalPath,
        template => template.match(/<input id="starting-cash-input"[^>]*>/)[0],
      );
      const input = root.children[0];
      expect(input.props.id, 'starting cash input rendered').toBe('starting-cash-input');
      // Type as the browser does: the field value changes, then v-model and the input listener run.
      input.value = '25';
      input.props['onUpdate:modelValue'](25);
      expect(input.props.onInput, 'starting cash input listener').toBeTypeOf('function');
      input.props.onInput({ target: input });
      expect(startingCashInput.value).toBe(25);
      await checkActiveShift(7);
      expect(startingCashInput.value, 'typed starting cash after a shift check').toBe(25);
      app.unmount();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('clears one-shot numpad intent on POS activation and deactivation', () => {
    const source = readFileSync(posTerminalPath, 'utf8');
    const activation = source.slice(
      source.indexOf('onActivated(async () =>'),
      source.indexOf('onDeactivated(() =>')
    );
    const deactivation = source.slice(
      source.indexOf('onDeactivated(() =>'),
      source.indexOf('onUnmounted(() =>')
    );

    expect(activation).toContain('cancelQuickAmount()');
    expect(deactivation).toContain('cancelQuickAmount()');
  });

  it('keeps the cart visual workflow behind one workspace component', () => {
    const source = readFileSync(posTerminalPath, 'utf8');
    const workspace = readFileSync(resolve(componentRoot, 'pos/PosCartWorkspace.vue'), 'utf8');
    expect(source).toContain('<PosCartWorkspace');
    expect(source).not.toContain('class="cart-panel');
    expect(source).not.toContain('const getCartRowPresentation');
    expect(workspace).toContain('const cart = useCart()');
    expect(workspace).toContain('const tables = useTables()');
    expect(workspace).not.toContain('useOrderSessionStore');
  });
});

describe('browser print layout', () => {
  it('is mounted with the terminal and styled globally so the first sale and X/Z reports print their own layout', () => {
    const source = readFileSync(posTerminalPath, 'utf8');
    const receipt = readFileSync(resolve(componentRoot, 'pos/ReceiptPreviewModal.vue'), 'utf8')
      + readFileSync(resolve(componentRoot, 'pos/ReceiptPrintLayout.vue'), 'utf8');
    const styles = readFileSync(resolve(process.cwd(), 'src/pos.css'), 'utf8');
    // Only the small print layout is eager; the dormant preview stays a lazy chunk.
    expect(source).toMatch(/import ReceiptPrintLayout from '\.\/pos\/ReceiptPrintLayout\.vue'/);
    expect(source).toContain('<ReceiptPrintLayout v-if="!isCallCenter" />');
    expect(source).not.toMatch(/import ReceiptPreviewModal from/);
    expect(source).toContain('<ReceiptPreviewModal v-if="!isCallCenter && showReceiptModal" />');
    expect(receipt).not.toContain('<style');
    expect(styles).toMatch(/body\.printing-thermal-receipt > \*:not\(\.receipt-print-wrapper\)/);
    expect(styles).toMatch(/body\.printing-shift-report > \*:not\(\.shift-print-wrapper\)/);
    expect(styles).toMatch(/@media screen \{\s*\.receipt-print-wrapper, \.shift-print-wrapper/);
  });
});

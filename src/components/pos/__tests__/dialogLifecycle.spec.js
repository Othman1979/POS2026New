import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effectScope, ref } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';

const composables = vi.hoisted(() => ({ cart: null, auth: null, dialogs: [] }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => composables.cart }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => composables.auth }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({}) }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ activeTable: { value: null }, holdCurrentOrder: () => {} }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: ({ open, onEscape }) => composables.dialogs.push({ open, onEscape }) }));
import CheckoutModal from '../CheckoutModal.vue';
import ShiftReportModal from '../ShiftReportModal.vue';

const source = path => readFileSync(resolve(__dirname, path), 'utf8');
// Any binding a dialog reads that a test does not set is an empty ref.
const withRefDefaults = values => new Proxy(values, { get: (target, key) => (key in target ? target[key] : (target[key] = ref(null))) });
// Set up a component and return the Escape handler of the dialog that `open` shows.
const escapeHandlerOf = (component, open) => {
  composables.dialogs = [];
  const scope = effectScope();
  scope.run(() => component.setup({}, { expose() {}, emit: vi.fn() }));
  scope.stop();
  return composables.dialogs.find(dialog => dialog.open === open).onEscape;
};
// PosTerminal's real QR comparison close handler, bound to the given refs.
const terminalScript = parse(source('../../PosTerminal.vue')).descriptor.scriptSetup.content;
const qrCloseNode = parseScript(terminalScript, { sourceType: 'module' }).program.body
  .find(node => node.declarations?.some(d => d.id.name === 'closeQrComparisonDialog'));
const qrComparisonClose = new Function('isImportingQrDraft', 'showQrComparisonModal',
  `${terminalScript.slice(qrCloseNode.start, qrCloseNode.end)}\nreturn closeQrComparisonDialog;`);

const sharedLifecycleDialogs = [
  '../CartNotesModal.vue',
  '../CheckoutModal.vue',
  '../ExpenseModal.vue',
  '../FailedPrintsBell.vue',
  '../ModifierSelectorModal.vue',
  '../PrivilegesModal.vue',
  '../ReceiptPreviewModal.vue',
  '../ShiftReportModal.vue',
  '../TerminalSettingsModal.vue',
];

describe('POS dialog lifecycle contract', () => {
  it.each(sharedLifecycleDialogs)('%s has modal semantics and the shared focus lifecycle', path => {
    const modal = source(path);
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('usePosDialogFocus');
  });

  it('covers global dialogs, navigation, mandatory intake, shift opening, and inline actions', () => {
    const app = source('../../../App.vue');
    const terminal = source('../../PosTerminal.vue');
    expect(app.match(/role="dialog"/g)).toHaveLength(3);
    expect(app.match(/aria-describedby=/g)).toHaveLength(3);
    expect(app).toContain('resolveOpenGlobalDialogs');
    expect(app).toContain('usePosDialogFocus');
    expect(terminal).toContain('id="pos-user-sidebar"');
    expect(terminal).toContain('ref="callCenterIntakeDialog"');
    expect(terminal).toContain('ref="shiftOpeningDialog"');
    expect(terminal).toContain('for="starting-cash-input"');
    expect(terminal).toContain('ref="moreActionsDialog"');
    expect(terminal).toContain('ref="qrComparisonDialog"');
    expect(terminal).toContain('ref="courseDialog"');
    expect(terminal).toContain('ref="tablePinDialog"');
  });

  it('keeps the checkout open on Escape while a payment is processing', () => {
    const isProcessing = ref(true);
    const showCheckoutModal = ref(true);
    const closeCheckoutModal = vi.fn();
    composables.cart = withRefDefaults({ isProcessing, isHolding: ref(false), showCheckoutModal, closeCheckoutModal, cart: ref([]), orderTypes: ref([]) });
    const escape = escapeHandlerOf(CheckoutModal, showCheckoutModal);

    escape();
    expect(closeCheckoutModal).not.toHaveBeenCalled();
    isProcessing.value = false;
    escape();
    expect(closeCheckoutModal).toHaveBeenCalledOnce();
  });

  it('keeps the checkout open on Escape while a hold is in flight', () => {
    const isHolding = ref(true);
    const showCheckoutModal = ref(true);
    const closeCheckoutModal = vi.fn();
    composables.cart = withRefDefaults({ isProcessing: ref(false), isHolding, showCheckoutModal, closeCheckoutModal, cart: ref([]), orderTypes: ref([]) });
    const escape = escapeHandlerOf(CheckoutModal, showCheckoutModal);

    escape();
    expect(closeCheckoutModal, 'checkout dismissed while the hold is in flight').not.toHaveBeenCalled();
    isHolding.value = false;
    escape();
    expect(closeCheckoutModal).toHaveBeenCalledOnce();
  });

  it('keeps the Z report open on Escape while the shift is closing', () => {
    const isClosingShift = ref(true);
    const showZReportModal = ref(true);
    composables.auth = withRefDefaults({ isClosingShift, showZReportModal });
    const escape = escapeHandlerOf(ShiftReportModal, showZReportModal);

    escape();
    expect(showZReportModal.value).toBe(true);
    isClosingShift.value = false;
    escape();
    expect(showZReportModal.value).toBe(false);
  });

  it('keeps the QR comparison open while its draft is importing', () => {
    const isImportingQrDraft = ref(true);
    const showQrComparisonModal = ref(true);
    const close = qrComparisonClose(isImportingQrDraft, showQrComparisonModal);

    close();
    expect(showQrComparisonModal.value).toBe(true);
    isImportingQrDraft.value = false;
    close();
    expect(showQrComparisonModal.value).toBe(false);
  });

  it('preserves the existing hand-built lifecycle for the two complex table dialogs', () => {
    for (const path of ['../SplitCheckModal.vue', '../TableItemTransferModal.vue']) {
      const modal = source(path);
      expect(modal).toContain('role="dialog"');
      expect(modal).toContain('aria-modal="true"');
      expect(modal).toContain("event.key !== 'Tab'");
      expect(modal).toContain("event.key === 'Escape'");
    }
  });
});

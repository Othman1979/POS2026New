import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const terminal = vi.hoisted(() => ({ load: null }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({
  showTerminalSettings: terminal.show, localPrinterId: ref(''), receiptPrinters: ref([]),
  loadReceiptPrinters: terminal.load, saveTerminalSettings: () => {},
}) }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
import TerminalSettingsModal from '../TerminalSettingsModal.vue';

const scope = effectScope();
afterEach(() => scope.stop());

describe('terminal settings printer list', () => {
  it('reports a failed printer read and retries it on request', async () => {
    terminal.show = ref(true);
    terminal.load = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const modal = scope.run(() => TerminalSettingsModal.setup());
    await Promise.resolve(); await Promise.resolve();
    expect(modal.printersFailed.value).toBe(true);
    await modal.retryPrinters();
    expect(terminal.load).toHaveBeenCalledTimes(2);
    expect(modal.printersFailed.value).toBe(false);
  });
});

<template>
  <!-- Terminal Settings Modal -->
  <transition name="pos-modal">
  <div v-if="showTerminalSettings"
    class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/90 no-print p-4">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-settings-title" tabindex="-1" class="modal-panel bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col border border-outline-variant/30 max-h-[90vh]">
      <div class="bg-surface-container-low text-on-surface border-b border-outline-variant/30 px-5 sm:px-6 py-4 sm:py-5 flex justify-between items-center shrink-0">
        <h3 id="terminal-settings-title" class="font-headline font-bold text-sm sm:text-base tracking-tight">
          <i class="fa-solid fa-desktop me-2 text-primary"></i> {{ $t('Terminal Setup') }}
        </h3>
        <button type="button" :aria-label="$t('Close')" @click="showTerminalSettings = false"
          class="text-on-surface-variant hover:text-error transition-colors w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-lowest shadow-sm border border-outline-variant/30">
          <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
        </button>
      </div>
      <div class="p-5 sm:p-6 bg-surface-container-lowest space-y-4 sm:space-y-5 overflow-y-auto">
        <p class="text-[11px] sm:text-xs text-on-surface-variant font-black uppercase tracking-widest border-b border-outline-variant/20 pb-2">{{ $t('Device Configuration') }}</p>
        <div>
          <label class="block text-[11px] sm:text-xs font-black text-on-surface-variant uppercase tracking-widest mb-2">{{ $t('Assigned Receipt Printer') }}</label>
          <select v-model="draftPrinterId"
            class="w-full bg-surface-container-low border-none rounded-xl p-3.5 sm:p-4 text-sm sm:text-base font-bold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary shadow-inner">
            <option value="">{{ $t('Automatic (only one printer)') }}</option>
            <option v-for="printer in receiptPrinters" :key="printer.id" :value="printer.id" data-no-i18n>{{ printer.name }} ({{ printer.type }})</option>
          </select>
          <p v-if="printersFailed" class="text-[11px] font-bold text-error mt-2" role="alert">
            {{ $t('Could not load printers.') }}
            <button type="button" @click="retryPrinters" class="underline ms-1">{{ $t('Retry') }}</button>
          </p>
          <p class="text-[10px] sm:text-[11px] text-on-surface-variant font-bold mt-2 sm:mt-3 leading-relaxed">
            {{ $t('Select which physical receipt printer is attached to THIS specific terminal. Kitchen prep printers are routed automatically.') }}
          </p>
        </div>
      </div>
      <div class="p-4 sm:p-5 border-t border-outline-variant/20 bg-surface-container-low flex gap-2 sm:gap-3 shrink-0">
        <button @click="showTerminalSettings = false"
          class="btn-3d flex-1 py-3 sm:py-3.5 bg-surface border border-outline-variant/40 text-on-surface font-bold rounded-xl hover:bg-surface-container-low text-xs sm:text-sm uppercase tracking-widest shadow-sm transition-colors"
          style="--shadow-color: #cbd5e1;">{{ $t('Cancel') }}</button>
        <button @click="onSave"
          class="btn-3d flex-1 py-3 sm:py-3.5 action-gradient text-on-primary font-black rounded-xl shadow-md hover:opacity-90 text-xs sm:text-sm uppercase tracking-widest transition-opacity"
          style="--shadow-color: #2b4b71;">{{ $t('Save Device') }}</button>
      </div>
    </div>
  </div>
  </transition>
</template>

<script>
import { ref, watch } from 'vue';
import { useTerminal } from '@/pos/useTerminal.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

export default {
  setup() {
    const {
      showTerminalSettings,
      localPrinterId,
      receiptPrinters,
      loadReceiptPrinters,
      saveTerminalSettings
    } = useTerminal();

    const draftPrinterId = ref(localPrinterId.value);
    const dialog = ref(null);
    usePosDialogFocus({ open: showTerminalSettings, dialog, onEscape: () => { showTerminalSettings.value = false; } });

    const printersFailed = ref(false);
    const retryPrinters = async () => {
      printersFailed.value = false;
      printersFailed.value = !(await loadReceiptPrinters());
    };

    watch(showTerminalSettings, (newVal) => {
      if (newVal) {
        draftPrinterId.value = localPrinterId.value;
        void retryPrinters();
      }
    }, { immediate: true });

    const onSave = () => {
      localPrinterId.value = draftPrinterId.value;
      saveTerminalSettings();
    };

    return {
      showTerminalSettings,
      draftPrinterId,
      receiptPrinters,
      onSave,
      printersFailed,
      retryPrinters,
      dialog
    };
  }
}
</script>

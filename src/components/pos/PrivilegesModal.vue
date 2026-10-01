<template>
  <!-- Privileges Override Modal -->
  <transition name="pos-modal">
  <div v-if="showOverrideModal"
    class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/95 no-select p-4">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="privileges-dialog-title" tabindex="-1" class="modal-panel bg-surface-container-lowest w-full max-w-sm rounded-2xl shadow-xl flex flex-col overflow-hidden border border-outline-variant/30">
      <div class="px-5 sm:px-6 py-4 sm:py-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0">
        <div>
          <h3 id="privileges-dialog-title" class="font-headline font-bold text-on-surface text-base sm:text-lg tracking-tight">{{ $t('Approve checkout changes') }}</h3>
          <p class="text-[10px] sm:text-[11px] text-on-surface-variant font-bold mt-0.5 uppercase tracking-widest">{{ $t('Enter Manager PIN to unlock') }}</p>
        </div>
        <button type="button" :aria-label="$t('Close')" @click="closeModal"
          class="text-on-surface-variant hover:text-error transition-colors w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-full bg-surface-container-lowest shadow-sm border border-outline-variant/30">
          <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
        </button>
      </div>
      <div class="p-5 sm:p-6 bg-surface flex flex-col items-center">
        <div class="w-16 h-16 sm:w-20 sm:h-20 bg-surface-container-lowest rounded-full flex items-center justify-center mb-4 sm:mb-6 border border-outline-variant/30 shadow-sm">
          <i class="fa-solid fa-shield-halved text-3xl sm:text-4xl text-primary"></i>
        </div>
        <input data-dialog-initial-focus type="password" inputmode="numeric" enterkeyhint="done" v-model="overridePin" :aria-label="$t('Manager PIN')" placeholder="••••" maxlength="8" autofocus @keyup.enter="activateOverride"
          class="w-full text-center tracking-[1em] font-black text-3xl sm:text-4xl bg-surface-container-lowest border-none rounded-xl py-4 sm:py-5 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary shadow-inner mb-2 sm:mb-3">
        <p class="text-sm text-center text-on-surface-variant mt-3">{{ $t('Enables approved discounts and price changes for 5 minutes. Each checkout verifies the PIN again.') }}</p>
      </div>
      <div class="modal-footer modal-actions px-5 sm:px-6 py-4 sm:py-5 border-t border-outline-variant/20 bg-surface-container-low shrink-0 flex gap-2 sm:gap-3">
        <button @click="closeModal"
          class="modal-action btn-3d flex-1 py-3.5 sm:py-4 bg-surface border border-outline-variant/40 text-on-surface font-bold hover:bg-surface-container-low rounded-xl transition-colors text-xs sm:text-sm uppercase tracking-widest shadow-sm"
          style="--shadow-color: #cbd5e1;">{{ $t('Cancel') }}</button>
        <button @click="activateOverride" :disabled="isActivatingOverride || overridePin.length < 4"
          class="modal-action modal-action--primary btn-3d flex-1 py-3.5 sm:py-4 action-gradient text-on-primary font-black rounded-xl hover:opacity-90 transition-opacity text-xs sm:text-sm uppercase tracking-widest shadow-md disabled:opacity-50"
          style="--shadow-color: #2b4b71;">{{ $t('Unlock') }}</button>
      </div>
    </div>
  </div>
  </transition>
</template>

<script>
import { useAuth } from '@/pos/useAuth.js';
import { ref } from 'vue';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

export default {
  setup() {
    const {
      showOverrideModal,
      overridePin,
      isActivatingOverride,
      activateOverride
    } = useAuth();
    const dialog = ref(null);
    const closeModal = () => {
      overridePin.value = '';
      showOverrideModal.value = false;
    };
    usePosDialogFocus({ open: showOverrideModal, dialog, onEscape: closeModal });

    return {
      showOverrideModal,
      overridePin,
      isActivatingOverride,
      activateOverride,
      closeModal,
      dialog
    };
  }
}
</script>

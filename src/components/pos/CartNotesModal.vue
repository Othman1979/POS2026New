<template>
  <!-- Note / Discount Modal -->
  <transition name="pos-modal">
  <div v-if="activeModal === 'note' || activeModal === 'discount'"
    class="fixed inset-0 z-[90] flex items-center justify-center bg-on-background/80 p-4">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="cart-note-dialog-title" tabindex="-1" class="modal-panel bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-outline-variant/30 flex flex-col">
      <div class="bg-surface-container-low px-6 py-4 border-b border-outline-variant/30 flex justify-between items-center">
        <h3 id="cart-note-dialog-title" class="font-headline font-bold text-on-surface text-sm sm:text-base tracking-tight">
          {{ activeModal === 'note' ? (modalTarget === 'order' ? $t('Order Note') : $t('Item Note')) : (modalTarget === 'order' ? $t('Order Discount') : $t('Item Discount')) }}
        </h3>
      </div>
      <div class="p-5 sm:p-6 bg-surface-container-lowest">
        <template v-if="activeModal === 'note'">
          <textarea v-model="tempNote" rows="3" inputmode="text" enterkeyhint="done"
            class="w-full bg-surface-container-low border-none rounded-xl p-4 text-sm sm:text-base font-bold focus:ring-2 focus:ring-primary outline-none resize-none shadow-inner"
            :placeholder="$t('Type instructions here...')"></textarea>
        </template>
        <template v-if="activeModal === 'discount'">
          <div class="flex gap-2 mb-4 bg-surface-container-low p-1.5 rounded-xl border border-outline-variant/20">
            <button @click="tempDiscount.type = 'percent'"
              :class="['flex-1 py-2.5 sm:py-3 rounded-lg text-xs sm:text-sm font-black uppercase tracking-wider', tempDiscount.type === 'percent' ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest']">
              {{ $t('Percentage (%)') }}
            </button>
            <button @click="tempDiscount.type = 'fixed'"
              :class="['flex-1 py-2.5 sm:py-3 rounded-lg text-xs sm:text-sm font-black uppercase tracking-wider', tempDiscount.type === 'fixed' ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest']">
              {{ $t('Fixed Amt') }}
            </button>
          </div>
          <div class="relative">
            <span v-if="tempDiscount.type === 'fixed'" class="absolute left-4 top-1/2 transform -translate-y-1/2 text-on-surface-variant font-bold text-lg sm:text-xl">JD</span>
            <input type="number" inputmode="decimal" enterkeyhint="done" v-model.number="tempDiscount.value"
              class="w-full bg-surface-container-low border-none rounded-xl p-3.5 sm:p-4 text-xl sm:text-2xl font-black text-center text-on-surface focus:ring-2 focus:ring-primary outline-none shadow-inner"
              placeholder="0">
            <span v-if="tempDiscount.type === 'percent'" class="absolute right-4 top-1/2 transform -translate-y-1/2 text-on-surface-variant font-bold text-lg sm:text-xl">%</span>
          </div>
        </template>
      </div>
      <div class="modal-footer modal-actions p-4 sm:p-5 border-t border-outline-variant/20 bg-surface-container-low flex justify-between gap-3">
        <button v-if="activeModal === 'discount'" @click="clearDiscount"
          class="modal-action modal-action--danger px-4 sm:px-6 py-3 sm:py-3.5 bg-error-container text-on-error-container font-bold rounded-xl hover:bg-error hover:text-white transition-colors text-xs sm:text-sm uppercase tracking-widest">
          {{ $t('Remove') }}
        </button>
        <div class="flex gap-2 sm:gap-3 ms-auto">
          <button @click="closeModal"
            class="modal-action btn-3d px-4 sm:px-6 py-3 sm:py-3.5 bg-surface border border-outline-variant/40 text-on-surface font-bold rounded-xl hover:bg-surface-container-low transition-colors text-xs sm:text-sm uppercase tracking-widest shadow-sm"
            style="--shadow-color: #cbd5e1;">
            {{ $t('Cancel') }}
          </button>
          <button @click="activeModal === 'note' ? saveNote() : saveDiscount()"
            class="modal-action modal-action--primary px-5 sm:px-8 py-3 sm:py-3.5 action-gradient text-on-primary font-black rounded-xl shadow-md hover:opacity-90 transition-opacity text-xs sm:text-sm uppercase tracking-widest">
            {{ $t('Save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </transition>
</template>

<script>
import { useCart } from '@/pos/useCart.js';
import { ref, computed } from 'vue';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

export default {
  setup() {
    const {
      activeModal,
      modalTarget,
      tempNote,
      tempDiscount,
      clearDiscount,
      saveNote,
      saveDiscount
    } = useCart();

    const closeModal = () => {
      activeModal.value = null;
    };
    const dialog = ref(null);
    const isOpen = computed(() => activeModal.value === 'note' || activeModal.value === 'discount');
    usePosDialogFocus({ open: isOpen, dialog, onEscape: closeModal });

    return {
      activeModal,
      modalTarget,
      tempNote,
      tempDiscount,
      clearDiscount,
      saveNote,
      saveDiscount,
      closeModal,
      dialog
    };
  }
}
</script>

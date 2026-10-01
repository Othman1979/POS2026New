<template>
  <!-- Item Custom Modifier Modal -->
  <transition name="pos-modal">
  <div v-if="showModifierModal"
    class="fixed inset-0 z-[100] flex items-center justify-center bg-on-background/80 no-select p-4">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="modifier-dialog-title" tabindex="-1" class="modal-panel bg-surface-container-lowest w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-outline-variant/30">
      <div class="px-5 sm:px-6 py-4 sm:py-5 border-b border-outline-variant/30 flex justify-between items-center shrink-0 bg-surface-container-low">
        <div>
          <h3 id="modifier-dialog-title" class="font-headline font-black text-on-surface text-lg sm:text-xl" data-no-i18n>{{ activeModifierProduct?.name }}</h3>
          <p class="text-[10px] sm:text-xs font-bold text-on-surface-variant uppercase tracking-widest mt-1">{{ $t('Customize your item') }}</p>
        </div>
        <button type="button" :aria-label="$t('Close')" @click="cancelModifiers"
          class="text-on-surface-variant hover:text-error w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-full bg-surface-container-lowest shadow-sm border border-outline-variant/30 transition-colors">
          <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto premium-scroll p-4 sm:p-6 space-y-6 sm:space-y-8 bg-surface">
        <div v-for="(group, gIndex) in activeModifierProduct?.parsedMods" :key="gIndex" class="space-y-3 sm:space-y-4">
          <div class="flex justify-between items-end border-b border-outline-variant/20 pb-2">
            <span class="font-black text-sm sm:text-base text-on-surface uppercase tracking-wider" data-no-i18n>{{ group.name }}</span>
            <span v-if="group.required" class="text-[10px] sm:text-xs font-black text-error uppercase tracking-widest px-2 sm:px-3 py-1 rounded bg-error-container">{{ $t('Required') }}</span>
            <span v-else class="text-[10px] sm:text-xs font-bold text-on-surface-variant uppercase tracking-widest">{{ $t('Optional') }}</span>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            <div v-for="(opt, oIndex) in group.options" :key="oIndex" @click="toggleModifier(gIndex, oIndex, group.multi_select)"
              role="button"
              tabindex="0"
              @keydown.enter.prevent="toggleModifier(gIndex, oIndex, group.multi_select)"
              @keydown.space.prevent="toggleModifier(gIndex, oIndex, group.multi_select)"
              :class="['modifier-option relative p-4 sm:p-5 rounded-xl border transition-all cursor-pointer flex flex-col shadow-sm', (selectedModifiers[gIndex] || []).includes(oIndex) ? 'border-primary bg-primary-fixed text-on-primary-fixed-variant' : 'border-outline-variant/30 bg-surface-container-lowest hover:border-primary/50 text-on-surface']">
              <div class="font-bold text-xs sm:text-sm mb-2 pr-5 sm:pr-6" data-no-i18n>{{ opt.name }}</div>
              <div class="text-[11px] sm:text-xs mt-auto font-black" :class="(selectedModifiers[gIndex] || []).includes(oIndex) ? 'text-primary' : 'text-on-surface-variant'">
                <span v-if="parseFloat(opt.price) > 0">+{{ parseFloat(opt.price).toFixed(2) }} JD</span>
                <span v-else>{{ $t('No Extra Cost') }}</span>
              </div>
              <i v-if="(selectedModifiers[gIndex] || []).includes(oIndex)" class="fa-solid fa-circle-check absolute top-4 right-4 sm:top-5 sm:right-5 text-primary text-lg sm:text-xl"></i>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer modal-actions px-5 sm:px-6 py-4 sm:py-5 border-t border-outline-variant/20 bg-surface-container-low shrink-0 flex justify-end items-center gap-2 sm:gap-3">
        <button @click="cancelModifiers"
          class="modal-action btn-3d px-4 sm:px-6 py-3 sm:py-3.5 bg-surface border border-outline-variant/40 text-on-surface font-bold hover:bg-surface-container-low rounded-xl transition-colors text-xs sm:text-sm uppercase tracking-widest shadow-sm"
          style="--shadow-color: #cbd5e1;">{{ $t('Cancel') }}</button>
        <button @click="confirmModifiers"
          class="modal-action modal-action--primary btn-3d px-5 sm:px-8 py-3 sm:py-3.5 action-gradient text-on-primary font-black rounded-xl hover:opacity-90 transition-opacity text-xs sm:text-sm uppercase tracking-widest shadow-md flex items-center gap-2"
          style="--shadow-color: #2b4b71;">{{ $t('Add to Order') }}</button>
      </div>
    </div>
  </div>
  </transition>
</template>

<script>
import { useCart } from '@/pos/useCart.js';
import { ref } from 'vue';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

export default {
  setup() {
    const {
      showModifierModal,
      activeModifierProduct,
      selectedModifiers,
      toggleModifier,
      confirmModifiers,
      cancelModifiers
    } = useCart();
    const dialog = ref(null);
    usePosDialogFocus({ open: showModifierModal, dialog, onEscape: cancelModifiers });

    return {
      showModifierModal,
      activeModifierProduct,
      selectedModifiers,
      toggleModifier,
      confirmModifiers,
      cancelModifiers,
      dialog
    };
  }
}
</script>

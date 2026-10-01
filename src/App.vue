<template>
  <router-view v-slot="{ Component }">
    <transition name="route">
      <!-- INVARIANT: logout() in useAuth.js MUST stay window.location.href (full reload). -->
      <!-- These components retain module-scope singleton state (cart, tables, auth). -->
      <!-- A same-tab router.push() login without a prior hard reload leaks User A's state to User B. -->
      <keep-alive v-if="Component" :include="['PosTerminal', 'TableFloorPlan']">
        <component :is="Component" />
      </keep-alive>
      <div v-else-if="isPublicBootRoute || signedOutBoot" id="login-boot-shell" role="status" aria-label="Loading login" class="fixed inset-0 bg-background"></div>
      <div v-else id="pos-boot-shell" role="status" aria-label="Loading POS">
        <div class="pos-boot-top" aria-hidden="true"></div>
        <div class="pos-boot-body" aria-hidden="true">
          <div class="pos-boot-rail"></div>
          <div class="pos-boot-products">
            <span></span><span></span><span></span><span></span><span></span><span></span>
            <span></span><span></span><span></span><span></span><span></span><span></span>
          </div>
          <div class="pos-boot-cart"></div>
        </div>
      </div>
    </transition>
  </router-view>

  <!-- Sleek Premium Custom Toast -->
  <transition
    enter-active-class="app-toast-enter-active"
    enter-from-class="app-toast-enter-from"
    leave-active-class="app-toast-leave-active"
  >
    <div v-if="customToast.show" :role="customToast.type === 'error' ? 'alert' : 'status'" :aria-live="customToast.type === 'error' ? 'assertive' : 'polite'" class="fixed bottom-6 right-6 z-[200] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-4 py-3.5 rounded-xl shadow-lg flex items-center gap-3 text-sm font-semibold border border-gray-100 dark:border-gray-800 max-w-sm">
      <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0" 
           :class="customToast.type === 'success' ? 'bg-green-500/10 text-green-500' : (customToast.type === 'error' ? 'bg-rose-500/10 text-rose-500' : 'bg-teal-500/10 text-teal-500')">
        <i class="fa-solid text-xs" :class="customToast.type === 'success' ? 'fa-circle-check' : (customToast.type === 'error' ? 'fa-circle-xmark' : 'fa-circle-info')"></i>
      </div>
      <span class="font-medium text-xs">{{ customToast.message }}</span>
    </div>
  </transition>

  <!-- Custom Alert Modal Overlay -->
  <div v-if="customAlert.show" class="fixed inset-0 z-[210] flex items-center justify-center bg-gray-900/80 p-4 animate-fade-in">
    <div ref="alertDialog" role="dialog" aria-modal="true" aria-labelledby="pos-alert-title" aria-describedby="pos-alert-message" tabindex="-1" class="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-scale-in">
      <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-900 bg-gray-50/50 dark:bg-gray-900/30 flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-teal-50 dark:bg-teal-950/30 text-teal-600 dark:text-teal-400">
          <i class="fa-solid fa-circle-info text-base"></i>
        </div>
        <h3 id="pos-alert-title" class="font-bold text-xs uppercase tracking-wider text-gray-900 dark:text-gray-100">{{ customAlert.title }}</h3>
      </div>
      <div id="pos-alert-message" class="p-6 text-sm text-gray-600 dark:text-gray-400 leading-relaxed font-medium">
        {{ customAlert.message }}
      </div>
      <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-900 flex justify-end">
        <button data-dialog-initial-focus @click="resolveAlert" class="px-5 py-2.5 bg-teal-600 text-white font-bold rounded-xl hover:bg-teal-700 text-xs uppercase tracking-wider shadow-sm transition-all h-10 flex items-center justify-center">
          {{ $t ? $t('OK') : 'OK' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Custom Confirm Modal Overlay -->
  <div v-if="customConfirm.show" class="fixed inset-0 z-[210] flex items-center justify-center bg-gray-900/80 p-4 animate-fade-in">
    <div ref="confirmDialog" role="dialog" aria-modal="true" aria-labelledby="pos-confirm-title" aria-describedby="pos-confirm-message" tabindex="-1" class="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-scale-in">
      <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-900 bg-gray-50/50 dark:bg-gray-900/30 flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400">
          <i class="fa-solid fa-triangle-exclamation text-base"></i>
        </div>
        <h3 id="pos-confirm-title" class="font-bold text-xs uppercase tracking-wider text-gray-900 dark:text-gray-100">{{ customConfirm.title }}</h3>
      </div>
      <div id="pos-confirm-message" class="p-6 text-sm text-gray-600 dark:text-gray-400 leading-relaxed font-medium">
        {{ customConfirm.message }}
      </div>
      <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-900 flex justify-end gap-3">
        <button data-dialog-initial-focus @click="resolveConfirm(false)" class="px-5 py-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 font-bold rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all h-10 flex items-center justify-center">
          {{ $t ? $t('Cancel') : 'Cancel' }}
        </button>
        <button @click="resolveConfirm(true)" class="px-5 py-2.5 bg-teal-600 text-white font-bold rounded-xl hover:bg-teal-700 text-xs uppercase tracking-wider shadow-sm transition-all h-10 flex items-center justify-center">
          {{ $t ? $t('Confirm') : 'Confirm' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Custom Prompt Modal Overlay -->
  <div v-if="customPrompt.show" class="fixed inset-0 z-[210] flex items-center justify-center bg-gray-900/80 p-4 animate-fade-in">
    <div ref="promptDialog" role="dialog" aria-modal="true" aria-labelledby="pos-prompt-title" aria-describedby="pos-prompt-message" tabindex="-1" class="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-scale-in">
      <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-900 bg-gray-50/50 dark:bg-gray-900/30 flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400">
          <i class="fa-solid fa-pen-to-square text-base"></i>
        </div>
        <h3 id="pos-prompt-title" class="font-bold text-xs uppercase tracking-wider text-gray-900 dark:text-gray-100">{{ customPrompt.title }}</h3>
      </div>
      <div class="p-6 space-y-4">
        <p id="pos-prompt-message" class="text-sm text-gray-600 dark:text-gray-400 leading-relaxed font-medium">{{ customPrompt.message }}</p>
        <input data-dialog-initial-focus type="text" v-model="customPrompt.value" :aria-label="customPrompt.message || customPrompt.title" :placeholder="customPrompt.placeholder" class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl py-3 px-4 text-xs font-semibold text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 placeholder:text-gray-400 outline-none transition-all shadow-inner h-11" @keyup.enter="resolvePrompt(customPrompt.value)">
      </div>
      <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-900 flex justify-end gap-3">
        <button @click="resolvePrompt(null)" class="px-5 py-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 font-bold rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all h-10 flex items-center justify-center">
          {{ $t ? $t('Cancel') : 'Cancel' }}
        </button>
        <button @click="resolvePrompt(customPrompt.value)" class="px-5 py-2.5 bg-teal-600 text-white font-bold rounded-xl hover:bg-teal-700 text-xs uppercase tracking-wider shadow-sm transition-all h-10 flex items-center justify-center">
          {{ $t ? $t('Submit') : 'Submit' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { t } from '@/shared/i18n.js';
import { createToastQueue } from '@/shared/toastQueue.js';
import { startIdleTracker, stopIdleTracker } from '@/pos/useIdleTracker.js';
import { clearPosOrderSessionStorage } from '@/pos/posSessionStorage.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';

const route = useRoute();
// Same rule as the index.html boot hint: nobody signed in on this browser, so the session check
// is about to redirect to /login; keep the neutral shell instead of a POS skeleton.
// Re-read on every route change: logging in moves to the POS without a reload.
const signedOutBoot = computed(() => {
  void route.path;
  try {
    return !localStorage.getItem('pos_active_user_id');
  } catch (e) {
    return false;
  }
});
const isPublicBootRoute = computed(() => {
  const path = route.path === '/' ? window.location.pathname : route.path;
  return path === '/login' || path === '/device-enrollment';
});

// Custom Sleek Dialog States for POS app
const customAlert = ref({ show: false, message: '', title: '', resolve: null });
const customConfirm = ref({ show: false, message: '', title: '', resolve: null });
const customPrompt = ref({ show: false, message: '', title: '', defaultValue: '', placeholder: '', value: '', resolve: null });
const customToast = ref({ show: false, message: '', type: 'info' });
const alertDialog = ref(null);
const confirmDialog = ref(null);
const promptDialog = ref(null);

const settleDialog = (state, value) => {
  const resolve = state.value.resolve;
  state.value.show = false;
  state.value.resolve = null;
  resolve?.(value);
};
const resolveAlert = () => settleDialog(customAlert, undefined);
const resolveConfirm = (value) => settleDialog(customConfirm, value);
const resolvePrompt = (value) => settleDialog(customPrompt, value);
const resolveOpenGlobalDialogs = () => {
  if (customAlert.value.show) resolveAlert();
  if (customConfirm.value.show) resolveConfirm(false);
  if (customPrompt.value.show) resolvePrompt(null);
};

usePosDialogFocus({ open: () => customAlert.value.show, dialog: alertDialog, onEscape: resolveAlert });
usePosDialogFocus({ open: () => customConfirm.value.show, dialog: confirmDialog, onEscape: () => resolveConfirm(false) });
usePosDialogFocus({ open: () => customPrompt.value.show, dialog: promptDialog, onEscape: () => resolvePrompt(null) });

// Expose these methods globally to the window object so our composables can use them
window.showPosAlert = (message, title = '') => {
  return new Promise((resolve) => {
    resolveOpenGlobalDialogs();
    customAlert.value = { show: true, message, title: title || t('Alert'), resolve };
  });
};

window.showPosConfirm = (message, title = '') => {
  return new Promise((resolve) => {
    resolveOpenGlobalDialogs();
    customConfirm.value = { show: true, message, title: title || t('Confirm'), resolve };
  });
};

window.showPosPrompt = (message, defaultValue = '', placeholder = '', title = '') => {
  return new Promise((resolve) => {
    resolveOpenGlobalDialogs();
    customPrompt.value = { 
      show: true, message, title: title || t('Prompt'), 
      defaultValue, placeholder, value: defaultValue, resolve 
    };
  });
};

window.showPosToast = createToastQueue(customToast);

window.resetPosDialogs = () => {
  resolveOpenGlobalDialogs();
};

// Global polyfills for legacy native calls
window.alert = (message) => {
  window.showPosAlert(message);
};

window.confirm = (message) => {
  // Warn developers that this is asynchronous and won't block execution unless awaited.
  // Native confirms must be rewritten to await window.showPosConfirm
  window.showPosAlert("Developer warning: Use window.showPosConfirm to properly await user responses instead of native confirm.");
  return false;
};

const handleStorageChange = async (event) => {
  if (event.key === 'pos_active_user_id') {
    const storedUserId = event.newValue;
    const currentUserId = (() => {
      try {
        const user = JSON.parse(sessionStorage.getItem('pos_user'));
        return user ? String(user.id) : null;
      } catch (_) { return null; }
    })();

    if (!storedUserId) {
      sessionStorage.removeItem('pos_user');
      sessionStorage.removeItem('pos_token');
      localStorage.removeItem('pos_token');
      clearPosOrderSessionStorage();

      window.location.href = '/login';
    } else if (storedUserId !== currentUserId) {
      sessionStorage.removeItem('pos_user');
      window.location.reload();
    }
  }
};

// Start idle tracker once the user data is available from sessionStorage
onMounted(() => {
  window.addEventListener('storage', handleStorageChange);
  try {
    const userStr = sessionStorage.getItem('pos_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      if (user?.id) startIdleTracker(user);
    }
  } catch (_) {}
});

onUnmounted(() => {
  window.removeEventListener('storage', handleStorageChange);
  stopIdleTracker();
});
</script>

<style>
.route-enter-active { transition: opacity 0.12s ease-out; }
.route-enter-from { opacity: 0; }
.route-leave-active { display: none; }
@media (prefers-reduced-motion: reduce) { .route-enter-active { transition-duration: 0.01ms; } }

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleIn {
  from { transform: scale(0.95); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.animate-fade-in {
  animation: fadeIn 0.15s ease-out forwards;
}

.animate-scale-in {
  animation: scaleIn 0.15s ease-out forwards;
}

.app-toast-enter-active { transition: opacity 150ms ease-out, transform 150ms ease-out; }
.app-toast-enter-from { opacity: 0; transform: translateY(0.5rem); }
.app-toast-leave-active { display: none; }

@media (prefers-reduced-motion: reduce) {
  .animate-fade-in,
  .animate-scale-in,
  .animate-bounce,
  .animate-pulse { animation: none !important; }
  .app-toast-enter-active { transition-duration: 0.01ms; }
}
</style>

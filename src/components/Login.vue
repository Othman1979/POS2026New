<template>
  <div class="login-screen text-on-surface w-full flex items-center justify-center bg-background font-sans">
    <div
      id="login-app"
      class="login-card bg-surface rounded-3xl shadow-2xl shadow-slate-200/50 border border-outline-variant flex flex-col items-center"
    >
      <div class="w-full relative">
        <div
          class="pin-display w-full bg-surface-container-low border-2 rounded-2xl flex items-center justify-center shadow-inner transition-colors overflow-hidden px-4"
          :class="userNumber.length > 0 ? 'is-filled bg-surface' : 'border-outline-variant'"
        >
          <span v-if="userNumber.length === 0" class="text-sm font-bold text-on-surface-variant tracking-widest uppercase opacity-60">
            {{ $t('Enter PIN') }}
          </span>

          <div v-else class="flex items-center justify-center gap-2.5 flex-wrap">
            <div
              v-for="i in userNumber.length"
              :key="i"
              class="w-4 h-4 rounded-full dot-animate"
            ></div>
          </div>
        </div>

      <p class="text-center text-error font-bold text-sm leading-5 min-h-5 mt-1 transition-opacity" :class="errorMessage ? 'opacity-100' : 'opacity-0'">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i> {{ errorMessage }}
      </p>
      <p v-if="authMode === 'enforced'" class="text-center text-on-surface-variant text-xs leading-snug">
        {{ $t('Only users with a registered browser need device verification.') }}
      </p>
      </div>

      <div v-if="approvalRequestId" class="w-full rounded-2xl bg-surface-container-low p-5 text-center">
        <i class="fa-solid fa-shield-halved text-2xl text-[#24405e]"></i>
        <h2 class="mt-3 text-base font-bold">{{ $t('Waiting for administrator approval') }}</h2>
        <p class="mt-2 text-xs leading-relaxed text-on-surface-variant">{{ $t('Ask an administrator to approve this browser from Device access.') }}</p>
        <div class="mt-4 flex items-center justify-center gap-4">
          <button type="button" @click="checkApproval" :disabled="isLoading" class="text-xs font-semibold underline underline-offset-4 disabled:opacity-50">{{ $t('Check again') }}</button>
          <button type="button" @click="cancelApproval" class="text-xs font-semibold underline underline-offset-4">{{ $t('Cancel') }}</button>
        </div>
      </div>

      <div v-else dir="ltr" class="login-pad w-full grid grid-cols-3">
        <button
          v-for="n in padKeys"
          :key="n"
          @click="appendNumber(n)"
          class="is-key pos-button pad-key pad-digit bg-surface-container border border-outline-variant hover:bg-surface-container-high rounded-2xl font-bold text-on-surface shadow-sm flex items-center justify-center transition-all"
        >
          {{ n }}
        </button>

        <button
          @click="clearInput"
          class="pos-button pad-key bg-surface-container-low border border-outline-variant hover:bg-error/10 hover:text-error hover:border-error/30 rounded-2xl text-sm font-black uppercase tracking-widest text-on-surface-variant transition-all flex items-center justify-center"
        >
          {{ $t('Clear') }}
        </button>

        <button
          @click="appendNumber(0)"
          class="is-key pos-button pad-key pad-digit bg-surface-container border border-outline-variant hover:bg-surface-container-high rounded-2xl font-bold text-on-surface shadow-sm flex items-center justify-center transition-all"
        >
          0
        </button>

        <button
          @click="removeLast"
          class="pos-button pad-key bg-surface-container-low border border-outline-variant hover:bg-surface-container-high hover:text-on-surface rounded-2xl pad-icon text-on-surface-variant transition-all flex items-center justify-center"
        >
          <i class="fa-solid fa-delete-left"></i>
        </button>
      </div>

      <button
        v-if="!approvalRequestId"
        @click="login"
        :disabled="isLoading || userNumber.length === 0"
        class="login-submit pos-button w-full text-white font-black text-lg uppercase tracking-widest rounded-2xl disabled:opacity-50 flex items-center justify-center gap-3 transition-all"
      >
        <i v-if="isLoading" class="fa-solid fa-circle-notch fa-spin text-xl"></i>
        <span v-else>{{ $t('Login') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { fetchJson, fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { getPublicPreferences } from '@/shared/faviconInjector.js';
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { setLanguage, t } from '@/shared/i18n.js';
import { clearPosOrderSessionStorage } from '@/pos/posSessionStorage.js';
import { authenticateRegisteredDevice, browserDeviceLabel, cancelBrowserApproval, completeApprovedBrowserRequest, getLoginPolicy, isBrowserDeviceSupported, isTerminalApprovalCode, requestBrowserApproval } from '@/shared/browserDeviceClient.js';

const router = useRouter();
const userNumber = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const authMode = ref('disabled');
const deviceSupported = ref(isBrowserDeviceSupported());
const approvalRequestId = ref('');
const APPROVAL_STORAGE_KEY = 'pos_browser_approval_request_id';
// The login page has no socket: a slow, bounded check (the request lives 10 minutes)
// plus focus/online and a Check again button. One pending timer at most.
let approvalTimer = null;
let approvalChecksLeft = 0;
const APPROVAL_CHECK_MS = 15000;
const APPROVAL_MAX_CHECKS = 40;
const stopApprovalChecks = () => { clearTimeout(approvalTimer); approvalTimer = null; };
const startApprovalChecks = () => { approvalChecksLeft = APPROVAL_MAX_CHECKS; scheduleApprovalCheck(); };
function scheduleApprovalCheck() {
  stopApprovalChecks();
  if (!approvalRequestId.value || approvalChecksLeft <= 0) return;
  approvalChecksLeft -= 1;
  approvalTimer = setTimeout(async () => { approvalTimer = null; await checkApproval(); scheduleApprovalCheck(); }, APPROVAL_CHECK_MS);
}
const onApprovalWake = () => { if (approvalRequestId.value) checkApproval(); };
let policyPromise = null;
// Bounds a wait that has no abort of its own (the policy read, the optional approval suggestion).
const withDeadline = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException('Request timed out.', 'TimeoutError')), ms); })])
    .finally(() => clearTimeout(timer));
};
// One policy read per page: the submit reuses the mount-time read and refetches only after a
// failure. Bounded, so a read that stalls without failing cannot hold every submit.
const POLICY_TIMEOUT_MS = 8000;
const loadPolicy = () => (policyPromise ||= withDeadline(getLoginPolicy(), POLICY_TIMEOUT_MS).catch((error) => { policyPromise = null; throw error; }));
// Calculator/keyboard numpad order (7-8-9 top row, 0 in bottom row), not phone order.
const padKeys = [7, 8, 9, 4, 5, 6, 1, 2, 3];

const appendNumber = (num) => {
  if (userNumber.value.length < 12) userNumber.value += num;
  errorMessage.value = '';
};

const clearInput = () => {
  userNumber.value = '';
  errorMessage.value = '';
};

const removeLast = () => {
  userNumber.value = userNumber.value.slice(0, -1);
  errorMessage.value = '';
};

function finishLogin(data, { preservePendingApproval = false } = {}) {
  sessionStorage.removeItem('pos_token');
  localStorage.removeItem('pos_token');
  clearPosOrderSessionStorage();
  sessionStorage.setItem('pos_user', JSON.stringify(data.user));
  localStorage.setItem('pos_active_user_id', data.user.id);
  sessionStorage.setItem('pos_user_at', String(Date.now()));
  stopApprovalChecks();
  if (!preservePendingApproval) sessionStorage.removeItem(APPROVAL_STORAGE_KEY);

  const role = data.user.role;
  if (role === 'admin' || role === 'programmer') window.location.href = '/admin/dashboard';
  else if (role === 'waiter') window.location.href = '/tables';
  else window.location.href = '/pos';
}

async function checkApproval() {
  if (!approvalRequestId.value || isLoading.value) return;
  isLoading.value = true;
  try {
    const result = await completeApprovedBrowserRequest(approvalRequestId.value);
    errorMessage.value = '';
    if (result?.success && result.user) finishLogin(result);
    else if (isTerminalApprovalCode(result?.code)) endApprovalWait();
  } catch (error) {
    // Only a terminal answer ends the wait; a dropped link or edge page keeps the request.
    if (isTerminalApprovalCode(error?.code)) endApprovalWait();
    else errorMessage.value = t('Network error connecting to server.');
  } finally {
    isLoading.value = false;
  }
}

function endApprovalWait() {
  stopApprovalChecks();
  approvalRequestId.value = '';
  sessionStorage.removeItem(APPROVAL_STORAGE_KEY);
  errorMessage.value = t('This browser approval request is no longer available.');
}

async function cancelApproval() {
  stopApprovalChecks();
  if (approvalRequestId.value) await cancelBrowserApproval(approvalRequestId.value).catch(() => {});
  await fetchJson('api/auth/logout', { method: 'POST' }).catch(() => {});
  approvalRequestId.value = '';
  sessionStorage.removeItem(APPROVAL_STORAGE_KEY);
  clearInput();
}

const login = async () => {
  if (!userNumber.value || isLoading.value) return;

  isLoading.value = true;
  errorMessage.value = '';

  try {
    const policy = await loadPolicy();
    authMode.value = policy?.mode || authMode.value;
    if (policy?.enforce_https === true && window.location.protocol !== 'https:') {
      throw new Error('This POS must be opened over HTTPS before you can sign in.');
    }
    let { data } = await fetchJsonResponseWithTimeout('api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_number: userNumber.value }),
    });
    if (data?.code === 'DEVICE_AUTH_REQUIRED') {
      if (policy?.supported === false) {
        throw Object.assign(new Error('Registered-device access is not configured correctly.'), { code: 'WEBAUTHN_CONFIG_INVALID' });
      }
      if (!deviceSupported.value) {
        throw Object.assign(new Error('This browser cannot verify a registered device.'), { code: 'BROWSER_DEVICE_UNSUPPORTED' });
      }
      data = await authenticateRegisteredDevice(userNumber.value);
    }

    if (data.success) {
      if (data.device_registration_required === true) {
        if (!deviceSupported.value) throw Object.assign(new Error('This browser cannot register a device.'), { code: 'BROWSER_DEVICE_UNSUPPORTED' });
        const pending = await requestBrowserApproval(browserDeviceLabel());
        if (!pending?.success) throw Object.assign(new Error(pending?.message || 'Unable to request browser approval.'), { code: pending?.code });
        approvalRequestId.value = pending.request_id;
        sessionStorage.setItem(APPROVAL_STORAGE_KEY, pending.request_id);
        isLoading.value = false;
        startApprovalChecks();
      } else if (data.device_registration_suggested === true && deviceSupported.value) {
        let preservePendingApproval = false;
        try {
          const pending = await withDeadline(requestBrowserApproval(browserDeviceLabel()), 5000);
          if (pending?.success && pending.request_id) {
            sessionStorage.setItem(APPROVAL_STORAGE_KEY, pending.request_id);
            preservePendingApproval = true;
          }
        } catch (error) {
          console.warn('[Device access] Browser detection could not start.', error?.code || error?.message);
        }
        finishLogin(data, { preservePendingApproval });
      } else {
        finishLogin(data);
      }
    } else {
      const messages = {
        WEBAUTHN_AUTHENTICATION_FAILED: 'This browser is not registered for this user.',
        BROWSER_DEVICE_KEY_MISSING: 'This browser is not registered for this user.',
        SERVER_BUSY: 'The server is busy. Try again in a moment.',
      };
      errorMessage.value = t(messages[data?.code] || data.message || 'Invalid user number.');
      isLoading.value = false;
    }
  } catch (error) {
    const messages = {
      BROWSER_DEVICE_KEY_MISSING: 'This browser is not registered for this user.',
      BROWSER_DEVICE_UNSUPPORTED: 'This browser cannot verify a registered device.',
      WEBAUTHN_AUTHENTICATION_FAILED: 'This browser is not registered for this user.',
      WEBAUTHN_CONFIG_REQUIRED: 'Registered-device access is not configured on this server.',
      WEBAUTHN_CONFIG_INVALID: 'Registered-device access is not configured correctly.',
      WEBAUTHN_HTTPS_REQUIRED: 'Registered-device access requires a stable HTTPS origin.',
      WEBAUTHN_ORIGIN_INVALID: 'The request origin is not allowed.',
      SERVER_BUSY: 'The server is busy. Try again in a moment.',
    };
    // Timeouts, dropped connections and non-JSON edge pages are connection problems, not user errors.
    const connectionFailure = ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(error?.name);
    errorMessage.value = t(messages[error?.code] || (connectionFailure ? '' : error?.message) || 'Network error connecting to server.');
    isLoading.value = false;
  }
};

const handleKeyDown = (e) => {
  if (approvalRequestId.value) return;
  if (e.key >= '0' && e.key <= '9') appendNumber(e.key);
  else if (e.key === 'Backspace') removeLast();
  else if (e.key === 'Enter') login();
  else if (e.key === 'Escape') clearInput();
};

onMounted(async () => {
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('focus', onApprovalWake);
  window.addEventListener('online', onApprovalWake);

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('reason') === 'expired') {
    errorMessage.value = t('Session expired. Please log in again.');
  }

  try {
    const [policy, data] = await Promise.all([loadPolicy(), getPublicPreferences()]);
    if (policy?.success) authMode.value = policy.mode || 'disabled';
    deviceSupported.value = isBrowserDeviceSupported();
    if (data.success) await setLanguage(data.admin_language || 'en');
  } catch (error) {
    await setLanguage(localStorage.getItem('pos_admin_language') || 'en', { persist: false });
  }

  const pendingApproval = sessionStorage.getItem(APPROVAL_STORAGE_KEY);
  if (pendingApproval) {
    approvalRequestId.value = pendingApproval;
    await checkApproval();
    startApprovalChecks();
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('focus', onApprovalWake);
  window.removeEventListener('online', onApprovalWake);
  stopApprovalChecks();
});
</script>

<style scoped>
/* One height budget for every screen: the keys take whatever the viewport leaves after the
   PIN display, message line and Login button, between a 3.5rem touch floor and 5.5rem.
   Short screens (800x480, 1024x600, a browser bar on 1366x768) fit without zooming; the
   screen scrolls instead of clipping if a note or a very small window still overflows. */
.login-screen {
  /* vh first: the older terminals the build still targets (Chrome 87, Safari 14) have no dvh,
     and a custom property holding an unsupported unit would void every size that reads it. */
  --gap: clamp(0.5rem, 1.2vh, 0.75rem);
  --key: clamp(3.5rem, calc((100vh - 12.5rem) / 4.75), 5.5rem);
  min-height: 100vh;
  min-height: 100dvh;
  padding: 0.75rem;
  overflow-y: auto;
  box-sizing: border-box;
}
@supports (height: 100dvh) {
  .login-screen {
    --gap: clamp(0.5rem, 1.2dvh, 0.75rem);
    --key: clamp(3.5rem, calc((100dvh - 12.5rem) / 4.75), 5.5rem);
  }
}
.login-card {
  width: min(100%, calc(var(--key) * 4.2 + var(--gap) * 2 + 2.5rem));
  padding: clamp(0.75rem, 2vh, 1.25rem);
  gap: var(--gap);
}
.pin-display { height: clamp(3rem, calc(var(--key) * 0.7), 3.75rem); }
.login-pad { gap: var(--gap); }
.pad-key { height: var(--key); }
.pad-digit { font-size: clamp(1.5rem, calc(var(--key) * 0.4), 2rem); }
.pad-icon { font-size: clamp(1.25rem, calc(var(--key) * 0.32), 1.5rem); }
.login-submit { height: clamp(3.25rem, calc(var(--key) * 0.75), 4rem); }

button {
  touch-action: manipulation;
}
.pos-button:active {
  transform: scale(0.96);
}

@keyframes popIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dot-animate {
  animation: popIn 100ms ease-out forwards;
}

@media (prefers-reduced-motion: reduce) {
  .dot-animate { animation: none; }
}

/* ---------------------------------------------------------------------------
   Accent: ledger ink, to match the admin.
   Kept local on purpose. This component is rendered by the POS router under
   src/pos.css, which also drives the POS terminal. Tailwind v4 inlines theme colours at build time, so overriding the
   variable here would not reach the utilities anyway — the accent is applied
   directly to the four things that carry it.
   --------------------------------------------------------------------------- */
.pin-display.is-filled {
  border-color: rgb(36 64 94 / 55%);
}

.dot-animate {
  background-color: #24405e;
  box-shadow: 0 0 10px rgb(36 64 94 / 30%);
}

/* Digit keys only. Clear keeps its red hover and backspace its neutral one —
   the accent should not overwrite a destructive affordance. */
.is-key:hover {
  border-color: rgb(36 64 94 / 45%);
  color: #24405e;
}

/* Prefixed with the id so it outranks Tailwind's shadow composite, which
   otherwise wins at equal specificity and leaves the button flat. */
/* Flat, like the ink buttons in the admin. The teal-tinted drop shadow this
   replaced was the only thing on the panel still carrying the old accent, and
   a flat ink button matches the rest of the product. */
#login-app .login-submit {
  background-color: #24405e;
}
#login-app .login-submit:hover:not(:disabled) {
  background-color: #1d3450;
}

::selection {
  background-color: rgb(36 64 94 / 20%);
}
</style>

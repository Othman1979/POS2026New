<template>
  <main class="min-h-screen bg-background text-on-surface flex items-center justify-center p-6" dir="rtl">
    <section class="w-full max-w-md bg-surface border border-outline-variant rounded-2xl p-6 shadow-xl">
      <h1 class="text-xl font-bold">{{ $t('Register this device') }}</h1>
      <p class="mt-2 text-sm text-on-surface-variant leading-relaxed">{{ $t('Use this one-time code on the intended terminal, then verify the device locally.') }}</p>
      <form v-if="state === 'manual'" class="mt-6 space-y-3" @submit.prevent="submitManualCode">
        <label class="block text-sm font-semibold" for="enrollment-code">{{ $t('Enrollment code') }}</label>
        <input id="enrollment-code" v-model="manualCode" autocomplete="one-time-code" class="w-full h-11 rounded-xl border border-outline-variant bg-surface px-4 font-mono" :placeholder="$t('Enter enrollment code')">
        <p v-if="message" class="text-sm font-semibold text-error">{{ message }}</p>
        <button type="submit" :disabled="working || !manualCode.trim()" class="w-full h-11 rounded-xl bg-[#24405e] text-white font-bold disabled:opacity-50">{{ $t('Continue') }}</button>
      </form>
      <div v-else-if="state === 'loading'" class="mt-6 text-sm text-on-surface-variant">{{ $t('Preparing device registration…') }}</div>
      <div v-else-if="state === 'ready'" class="mt-6 space-y-4">
        <div v-if="enrollmentInfo" class="rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-sm">
          <p class="font-bold">{{ enrollmentInfo.name }}</p>
          <p class="mt-1 text-xs text-on-surface-variant">{{ enrollmentInfo.device_label }}</p>
        </div>
        <p class="text-sm font-semibold">{{ $t('Register this browser for this user. No Windows PIN is required.') }}</p>
        <button type="button" @click="register" :disabled="working" class="w-full h-11 rounded-xl bg-[#24405e] text-white font-bold disabled:opacity-50">
          {{ working ? $t('Registering browser…') : $t('Register device') }}
        </button>
      </div>
      <div v-else-if="state === 'done'" class="mt-6 text-sm font-semibold text-emerald-700">{{ $t('Device registered. Return to the login screen.') }}</div>
      <div v-else class="mt-6 text-sm font-semibold text-error">{{ message }}</div>
      <button v-if="state === 'done' || state === 'error'" type="button" @click="goLogin" class="mt-6 text-sm underline underline-offset-4">{{ $t('Return to login') }}</button>
    </section>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeEnrollment, getEnrollmentOptions, isBrowserDeviceSupported } from '@/shared/browserDeviceClient.js';
import { t } from '@/shared/i18n.js';

const router = useRouter();
const state = ref('loading');
const working = ref(false);
const message = ref('');
const manualCode = ref('');
const enrollmentInfo = ref(null);
let enrollmentCode = '';
let optionsData = null;

function goLogin() {
  router.replace('/login');
}

function readFragmentCode() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = params.get('code') || '';
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  return code;
}

async function prepare(code) {
  enrollmentCode = String(code || '').trim();
  if (!isBrowserDeviceSupported()) {
    message.value = t('This browser cannot register a device.');
    state.value = 'error';
    return;
  }
  state.value = 'loading';
  message.value = '';
  try {
    optionsData = await getEnrollmentOptions(enrollmentCode);
    enrollmentInfo.value = {
      name: optionsData.user?.name || '',
      device_label: optionsData.device_label || '',
    };
    // The code stays in this closure and is never written to URL, storage, or telemetry.
    state.value = 'ready';
  } catch (error) {
    message.value = t(error?.message || 'Enrollment code is invalid or expired.');
    enrollmentCode = '';
    state.value = 'manual';
  }
}

function submitManualCode() {
  const code = manualCode.value.trim().replace(/\s+/g, '');
  if (code) prepare(code);
}

async function load() {
  const code = readFragmentCode();
  if (code) await prepare(code);
  else state.value = isBrowserDeviceSupported() ? 'manual' : 'error';
  if (!isBrowserDeviceSupported()) message.value = t('This browser cannot register a device.');
}

async function register() {
  if (working.value || !enrollmentCode) return;
  working.value = true;
  try {
    const result = await completeEnrollment(enrollmentCode, optionsData);
    if (!result?.success) throw Object.assign(new Error(result?.message || 'Enrollment failed.'), { code: result?.code });
    enrollmentCode = '';
    optionsData = null;
    state.value = 'done';
  } catch (error) {
    message.value = t(error?.message || 'Enrollment failed.');
    state.value = 'error';
    enrollmentCode = '';
    optionsData = null;
  } finally {
    working.value = false;
  }
}

onMounted(load);
</script>

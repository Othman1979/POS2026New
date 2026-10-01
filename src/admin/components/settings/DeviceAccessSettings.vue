<template>
  <section class="flex-1 overflow-y-auto premium-scroll bg-card border border-zinc-300 rounded-xl p-5 space-y-5" data-testid="device-access-settings">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-sm font-bold text-foreground">{{ $t('Device access') }}</h2>
        <p class="mt-1 text-xs text-muted-foreground leading-relaxed">{{ $t('Only users with a registered browser need device verification.') }}</p>
      </div>
      <span :class="statusClass" class="px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-wider">{{ statusLabel }}</span>
    </div>

    <p v-if="error" class="text-xs text-rose-700 font-semibold bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{{ $t(error) }}</p>

    <p v-if="loading" class="text-xs text-muted-foreground">{{ $t('Loading device access…') }}</p>

    <div v-else-if="needsBootstrap" class="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div>
        <h3 class="text-xs font-bold text-amber-900">{{ $t('First device setup') }}</h3>
        <p class="mt-1 text-[11px] text-amber-800 leading-relaxed">{{ $t('Use the server-managed bootstrap secret once to register this administrator device. The secret is never saved in the browser.') }}</p>
      </div>
      <div class="grid sm:grid-cols-2 gap-2">
        <input v-model="bootstrapSecret" type="password" autocomplete="off" :placeholder="$t('Bootstrap secret')" class="h-9 rounded-lg border border-amber-300 bg-white px-3 text-xs">
        <input v-model="bootstrapLabel" maxlength="100" :placeholder="$t('Device label')" class="h-9 rounded-lg border border-amber-300 bg-white px-3 text-xs">
      </div>
      <button type="button" @click="runBootstrap" :disabled="working || !bootstrapSecret || !bootstrapLabel" class="h-9 px-4 rounded-lg bg-amber-700 text-white text-xs font-bold disabled:opacity-50">{{ working ? $t('Registering browser…') : $t('Register this administrator device') }}</button>
    </div>

    <div v-else class="space-y-4">
      <div v-if="state.mode === 'disabled'" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-300 bg-zinc-50 p-3">
        <div><p class="text-xs font-bold text-foreground">{{ $t('Device access is disabled') }}</p><p class="mt-1 text-[11px] text-muted-foreground">{{ $t('Users can sign in with their PIN from any browser.') }}</p><p v-if="!isProgrammer" class="mt-1 text-[11px] text-muted-foreground">{{ $t('Only the programmer can manage registered browsers while device access is disabled.') }}</p></div>
        <button v-if="isProgrammer && state.mode !== 'enforced'" type="button" @click="enableEnforcement" :disabled="working" class="h-9 px-4 rounded-lg bg-[#24405e] text-white text-xs font-bold disabled:opacity-50">{{ $t('Enable device access') }}</button>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-muted/40 p-3">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xs font-bold text-foreground">{{ $t('Browser setup') }}</h3>
            <span class="text-[11px] font-semibold text-muted-foreground"><b class="text-foreground">{{ boundUserCount }}</b> / {{ state.users.length }} {{ $t('users bound') }}</span>
          </div>
          <p v-if="state.mode === 'staged'" class="mt-1 text-[11px] text-muted-foreground">{{ $t("A user's first PIN login requests this browser automatically. Approve it here to finish registration.") }}</p>
          <p v-else-if="state.mode === 'disabled'" class="mt-1 text-[11px] text-muted-foreground">{{ $t('Registered browsers are preserved while device access is disabled.') }}</p>
          <p v-else class="mt-1 text-[11px] text-muted-foreground">{{ $t('Users without a registered browser can sign in with their PIN from any browser.') }}</p>
        </div>
        <div class="flex gap-2">
          <button v-if="isProgrammer && state.mode === 'staged'" type="button" @click="enableEnforcement" :disabled="working" class="h-9 px-4 rounded-lg bg-rose-700 text-white text-xs font-bold disabled:opacity-50">{{ $t('Enable device access') }}</button>
          <button v-if="isProgrammer && state.mode === 'enforced'" type="button" @click="disableDeviceAccess" :disabled="working" class="h-9 px-4 rounded-lg border border-rose-300 text-rose-700 text-xs font-bold disabled:opacity-50">{{ $t('Disable device access') }}</button>
        </div>
      </div>

      <div class="divide-y divide-zinc-200 border border-zinc-200 rounded-xl overflow-hidden">
        <article v-for="user in orderedUsers" :key="user.id" class="p-4 space-y-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="text-xs font-bold text-foreground">{{ user.name }}</h3>
              <p class="mt-0.5 text-[10px] text-muted-foreground">{{ $t(roleLabel(user.role)) }} · {{ user.active_device_count }}/{{ user.device_limit }} {{ $t('registered browsers') }}</p>
            </div>
            <span class="rounded-full px-2.5 py-1 text-[10px] font-bold" :class="user.active_device_count ? 'bg-emerald-50 text-emerald-800' : 'bg-zinc-100 text-zinc-700'">{{ user.active_device_count ? $t('Bound') : $t('PIN only') }}</span>
          </div>
          <div class="grid gap-2">
            <div v-for="credential in activeCredentials(user)" :key="credential.id" class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <div class="min-w-0"><span class="text-xs font-semibold text-foreground">{{ credential.device_label }}</span><span class="block text-[10px] text-muted-foreground">{{ $t('Last used') }} · {{ formatDate(credential.last_used_at || credential.registered_at) }}</span></div>
              <button v-if="canManageDevices" type="button" @click="revokeCredential(user, credential)" class="text-[10px] font-bold text-rose-700 hover:underline">{{ $t('Remove access') }}</button>
            </div>
            <p v-if="!user.active_device_count" class="text-xs text-muted-foreground">{{ $t('No browser registered.') }}</p>
          </div>
          <div v-if="canManageDevices && !pendingOf(user)" class="flex flex-wrap gap-2">
            <button v-if="!user.active_device_count" type="button" @click="openEnroll(user, 'add')" class="h-9 px-3 rounded-lg bg-[#24405e] text-white text-xs font-bold">{{ $t('Register browser') }}</button>
            <button v-else-if="user.active_device_count < user.device_limit" type="button" @click="openEnroll(user, 'add')" class="h-9 px-3 rounded-lg border border-zinc-300 text-xs font-bold hover:bg-muted">{{ $t('Register another browser') }}</button>
            <button v-if="user.active_device_count" type="button" @click="openEnroll(user, 'replace')" class="h-9 px-3 rounded-lg border border-zinc-300 text-xs font-bold hover:bg-muted">{{ $t('Change browser') }}</button>
          </div>
          <div v-if="pendingOf(user) && pendingOf(user).browser_requested && !pendingOf(user).approved" class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
            <div><p class="text-xs font-bold">{{ $t('New browser waiting for approval') }}</p><p class="mt-0.5 text-[10px]">{{ pendingOf(user).device_label }}</p></div>
            <div v-if="canManageDevices" class="flex gap-2"><button type="button" @click="approve(pendingOf(user).id)" :disabled="working" class="h-9 rounded-lg bg-[#24405e] px-3 text-xs font-bold text-white disabled:opacity-50">{{ $t('Approve browser') }}</button><button type="button" @click="cancel(pendingOf(user).id)" :disabled="working" class="h-9 rounded-lg border border-amber-300 px-3 text-xs font-bold disabled:opacity-50">{{ $t('Reject') }}</button></div>
          </div>
          <div v-else-if="pendingOf(user)?.browser_requested && pendingOf(user).approved" class="flex items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800"><span>{{ $t('Approved — waiting for browser') }}</span><button v-if="canManageDevices" type="button" @click="cancel(pendingOf(user).id)" :disabled="working" class="font-bold underline disabled:opacity-50">{{ $t('Cancel') }}</button></div>
          <div v-else-if="pendingOf(user)" class="text-[10px] text-amber-700 flex items-center justify-between gap-2"><span>{{ $t('Enrollment in progress') }} · {{ pendingOf(user).device_label }}</span><button v-if="canManageDevices" type="button" @click="cancel(pendingOf(user).id)" class="font-bold underline">{{ $t('Cancel') }}</button></div>
        </article>
      </div>
    </div>

    <div v-if="enrollmentResult" class="fixed inset-0 z-[300] bg-black/40 flex items-center justify-center p-4" @click.self="closeEnrollment">
      <div class="w-full max-w-sm rounded-2xl bg-card border border-zinc-300 shadow-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-3"><h3 class="text-sm font-bold">{{ $t('Enrollment code') }}</h3><button type="button" @click="closeEnrollment" class="text-muted-foreground"><i class="fa-solid fa-xmark"></i></button></div>
        <img v-if="enrollmentResult.qr_data_url" :src="enrollmentResult.qr_data_url" alt="" class="w-44 h-44 mx-auto border border-zinc-200 p-2">
        <p class="text-[11px] text-muted-foreground leading-relaxed">{{ $t('Open the enrollment link on the intended terminal. The code expires soon and is shown only once.') }}</p>
        <p class="text-xs font-semibold">{{ $t('Expires in') }} {{ enrollmentCountdown }}</p>
        <code class="block rounded-lg bg-muted p-3 text-xs break-all select-all" data-testid="enrollment-code">{{ groupedEnrollmentCode }}</code>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" @click="openEnrollmentLink" class="h-9 rounded-lg bg-[#24405e] text-white text-xs font-bold">{{ $t('Open enrollment page') }}</button>
          <button type="button" @click="copyEnrollmentLink" class="h-9 rounded-lg border border-zinc-300 text-xs font-bold">{{ $t('Copy enrollment link') }}</button>
        </div>
        <button type="button" @click="copyEnrollmentCode" class="w-full h-9 rounded-lg border border-zinc-300 text-xs font-bold">{{ $t('Copy code') }}</button>
      </div>
    </div>

    <div v-if="replaceUser" class="fixed inset-0 z-[280] bg-black/40 flex items-center justify-center p-4" @click.self="replaceUser = null">
      <div class="w-full max-w-sm rounded-2xl bg-card border border-zinc-300 shadow-2xl p-5 space-y-3">
        <h3 class="text-sm font-bold">{{ action === 'replace' ? $t('Change browser') : (replaceUser.active_device_count ? $t('Register another browser') : $t('Register browser')) }}</h3>
        <select v-if="action === 'replace'" v-model="replaceCredentialId" class="w-full h-9 rounded-lg border border-zinc-300 bg-card px-3 text-xs"><option v-for="credential in eligibleCredentials(replaceUser)" :key="credential.id" :value="credential.id">{{ credential.device_label }}</option></select>
        <input v-model="deviceLabel" maxlength="100" :placeholder="$t('Device label')" class="w-full h-9 rounded-lg border border-zinc-300 bg-card px-3 text-xs">
        <div class="flex justify-end gap-2"><button type="button" @click="replaceUser = null" class="h-9 px-3 rounded-lg border border-zinc-300 text-xs font-bold">{{ $t('Cancel') }}</button><button type="button" @click="createEnrollment" :disabled="working || !deviceLabel" class="h-9 px-3 rounded-lg bg-[#24405e] text-white text-xs font-bold disabled:opacity-50">{{ $t('Continue') }}</button></div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { formatBusinessDateTimeShort } from '@/utils/businessDate.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useDeviceAccess } from '@/admin/composables/useDeviceAccess.js';
import { t } from '@/shared/i18n.js';

const { state, loading, error, load, bootstrap, enroll, approveEnrollment, cancelEnrollment, revoke, setMode } = useDeviceAccess();
const working = ref(false);
const bootstrapSecret = ref('');
const bootstrapLabel = ref('');
const enrollmentResult = ref(null);
const replaceUser = ref(null);
const action = ref('add');
const replaceCredentialId = ref(null);
const deviceLabel = ref('');
const now = ref(Date.now());
let countdownTimer;

let currentRole = '';
try { currentRole = JSON.parse(sessionStorage.getItem('pos_user') || '{}')?.role || ''; } catch { currentRole = ''; }
const isProgrammer = currentRole === 'programmer';
const canManageDevices = computed(() => state.value.mode !== 'disabled' || isProgrammer);

const statusLabel = computed(() => ({ disabled: t('Disabled'), staged: t('Enrollment in progress'), enforced: t('Enforced') }[state.value.mode] || state.value.mode));
const statusClass = computed(() => ({ disabled: 'bg-zinc-100 border-zinc-300 text-zinc-700', staged: 'bg-amber-50 border-amber-200 text-amber-800', enforced: 'bg-emerald-50 border-emerald-200 text-emerald-800' }[state.value.mode] || 'bg-muted border-zinc-200 text-muted-foreground'));
const boundUserCount = computed(() => state.value.users.filter(user => user.active_device_count > 0).length);
const orderedUsers = computed(() => [...state.value.users].sort((a, b) => Number(a.active_device_count > 0) - Number(b.active_device_count > 0)));
const needsBootstrap = computed(() => state.value.mode === 'disabled' && !state.value.bootstrap_consumed && !isProgrammer);
const groupedEnrollmentCode = computed(() => String(enrollmentResult.value?.enrollment_code || '').match(/.{1,4}/g)?.join(' ') || '');
const enrollmentCountdown = computed(() => {
  const seconds = Math.max(0, Math.ceil((new Date(enrollmentResult.value?.expires_at || 0).getTime() - now.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

// A request or link that lapsed while the page stayed open leaves no event; the 1 s clock hides it.
function pendingOf(user) {
  const pending = user.pending_enrollment;
  if (!pending) return null;
  const expiresAt = pending.expires_at ? new Date(pending.expires_at).getTime() : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now.value ? null : pending;
}
function formatDate(value) { return formatBusinessDateTimeShort(value) || '—'; }
function activeCredentials(user) { return user.credentials.filter(credential => credential.status === 'active'); }
function eligibleCredentials(user) { return activeCredentials(user).filter(credential => credential.device_type === 'singleDevice' && !credential.backed_up && (!credential.authenticator_attachment || credential.authenticator_attachment === 'platform')); }
function roleLabel(role) { return ({ admin: 'Admin', programmer: 'Programmer', cashier: 'Cashier', waiter: 'Waiter', table_manager: 'Table Manager', call_center: 'Call Center' })[role] || role; }
function openEnroll(user, nextAction) { replaceUser.value = user; action.value = nextAction; replaceCredentialId.value = eligibleCredentials(user)[0]?.id || null; deviceLabel.value = ''; }
async function createEnrollment() {
  working.value = true;
  try {
    const result = await enroll({ userId: replaceUser.value.id, action: action.value, replacementCredentialId: replaceCredentialId.value, deviceLabel: deviceLabel.value });
    if (result?.success) { enrollmentResult.value = result; replaceUser.value = null; }
  } finally { working.value = false; }
}
async function cancel(id) { working.value = true; try { await cancelEnrollment(id); } finally { working.value = false; } }
async function approve(id) { working.value = true; try { await approveEnrollment(id); } finally { working.value = false; } }
async function revokeCredential(user, credential) { const reason = window.prompt(t('Reason for revoking this device')); if (!reason) return; working.value = true; try { return await revoke(credential.id, reason); } finally { working.value = false; } }
async function enableEnforcement() { working.value = true; try { await setMode('enforced'); } finally { working.value = false; } }
async function disableDeviceAccess() { working.value = true; try { await setMode('disabled'); } finally { working.value = false; } }
async function runBootstrap() {
  working.value = true;
  try {
    const result = await bootstrap({ secret: bootstrapSecret.value, deviceLabel: bootstrapLabel.value });
    if (result?.success) bootstrapLabel.value = '';
  } finally {
    bootstrapSecret.value = '';
    working.value = false;
  }
}
function closeEnrollment() { enrollmentResult.value = null; }
async function copyEnrollmentCode() { if (enrollmentResult.value?.enrollment_code) await navigator.clipboard?.writeText(enrollmentResult.value.enrollment_code); }
function enrollmentLink() { return enrollmentResult.value?.enrollment_url ? new URL(enrollmentResult.value.enrollment_url, window.location.origin).href : ''; }
function openEnrollmentLink() { const link = enrollmentLink(); if (link) window.open(link, '_blank', 'noopener,noreferrer'); }
async function copyEnrollmentLink() { const link = enrollmentLink(); if (link) await navigator.clipboard?.writeText(link); }

// Device changes arrive as a socket event; a reconnect re-reads what was missed while offline.
const REFRESH_EVENTS = ['device_access_changed', 'socket_reconnected'];
let refreshing = false;
let refreshAgain = false;
async function refreshSilently() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    do { refreshAgain = false; await load({ silent: true }); } while (refreshAgain);
  } finally { refreshing = false; }
}
onMounted(() => {
  load();
  countdownTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
  for (const type of REFRESH_EVENTS) window.addEventListener(type, refreshSilently);
});
onUnmounted(() => {
  window.clearInterval(countdownTimer);
  for (const type of REFRESH_EVENTS) window.removeEventListener(type, refreshSilently);
});
</script>

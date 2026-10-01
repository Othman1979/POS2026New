import { ref } from 'vue';
import QRCode from 'qrcode';
import { fetchJson } from '@/shared/http.js';
import { beginStepUp, bootstrapRegisteredDevice } from '@/shared/browserDeviceClient.js';

async function request(path, options = {}, retry = true) {
    try {
        const data = await fetchJson(path, options);
        if (data?.code === 'WEBAUTHN_STEP_UP_REQUIRED' && retry) {
            const stepUp = await beginStepUp();
            if (!stepUp?.success) return stepUp;
            return request(path, options, false);
        }
        return data;
    } catch (error) {
        return { success: false, code: error?.code || 'DEVICE_ACCESS_FAILED', message: error?.message || 'Device access operation failed.' };
    }
}

function json(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function useDeviceAccess() {
    const state = ref({ mode: 'disabled', users: [] });
    const loading = ref(false);
    const error = ref('');

    function setResultError(result) {
        if (!result?.success) error.value = result?.message || 'Device access operation failed.';
        return result;
    }

    function failed(error) {
        return setResultError({ success: false, code: error?.code || 'DEVICE_ACCESS_FAILED', message: error?.message || 'Device access operation failed.' });
    }

    // Reads overlap (mount, an action's own reload, socket refreshes); only the latest one may land.
    // A superseded read still ends its own spinner, so loading follows the foreground reads in flight.
    let latestLoad = 0;
    let foregroundLoads = 0;
    async function load({ silent = false } = {}) {
        const seq = ++latestLoad;
        if (!silent) { foregroundLoads += 1; loading.value = true; }
        error.value = '';
        try {
            const data = await fetchJson('api/admin/device-access');
            if (!data?.success) throw new Error(data?.message || 'Unable to load device access.');
            if (seq === latestLoad) state.value = data;
        } catch (e) {
            if (seq === latestLoad) error.value = e.message;
        } finally {
            if (!silent) { foregroundLoads -= 1; loading.value = foregroundLoads > 0; }
        }
    }

    async function bootstrap({ secret, deviceLabel }) {
        try {
            const result = await bootstrapRegisteredDevice({ secret, deviceLabel });
            if (result?.success) await load();
            return setResultError(result);
        } catch (error) { return failed(error); }
    }

    async function enroll({ userId, action, replacementCredentialId, deviceLabel }) {
        const result = await request('api/admin/device-access/enrollments', json('POST', { user_id: userId, action, replace_credential_id: replacementCredentialId, device_label: deviceLabel }));
        if (result?.success) {
            if (result.enrollment_url) result.qr_data_url = await QRCode.toDataURL(`${window.location.origin}${result.enrollment_url}`);
            await load();
        }
        return setResultError(result);
    }

    async function cancelEnrollment(id) {
        const result = await request(`api/admin/device-access/enrollments/${encodeURIComponent(id)}`, json('DELETE', {}));
        if (result?.success) await load();
        return setResultError(result);
    }

    async function approveEnrollment(id) {
        const result = await request(`api/admin/device-access/enrollments/${encodeURIComponent(id)}/approve`, json('POST', {}));
        if (result?.success) await load({ silent: true });
        return setResultError(result);
    }

    async function revoke(credentialId, reason) {
        const result = await request(`api/admin/device-access/credentials/${encodeURIComponent(credentialId)}/revoke`, json('POST', { reason }));
        if (result?.success) await load();
        return setResultError(result);
    }

    async function setMode(mode) {
        const result = await request('api/admin/device-access/mode', json('POST', { mode }));
        if (result?.success) await load();
        return setResultError(result);
    }

    return { state, loading, error, load, bootstrap, enroll, approveEnrollment, cancelEnrollment, revoke, setMode };
}

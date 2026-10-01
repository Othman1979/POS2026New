import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchJson, beginStepUp, bootstrapRegisteredDevice } = vi.hoisted(() => ({
    fetchJson: vi.fn(),
    beginStepUp: vi.fn(),
    bootstrapRegisteredDevice: vi.fn(),
}));

vi.mock('@/shared/http.js', () => ({ fetchJson }));
vi.mock('@/shared/browserDeviceClient.js', () => ({
    beginStepUp,
    bootstrapRegisteredDevice,
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));

import { useDeviceAccess } from '../useDeviceAccess.js';

describe('device access administration errors', () => {
    beforeEach(() => vi.clearAllMocks());

    it('surfaces a missing registered-browser key when step-up cannot start', async () => {
        fetchJson.mockResolvedValueOnce({ success: false, code: 'WEBAUTHN_STEP_UP_REQUIRED' });
        beginStepUp.mockRejectedValueOnce(Object.assign(new Error('This browser is not registered for this user.'), { code: 'BROWSER_DEVICE_KEY_MISSING' }));
        const { cancelEnrollment, error } = useDeviceAccess();

        await expect(cancelEnrollment('request-1')).resolves.toMatchObject({ success: false, code: 'BROWSER_DEVICE_KEY_MISSING' });
        expect(error.value).toBe('This browser is not registered for this user.');
    });

    it('surfaces browser storage failure during first-device bootstrap', async () => {
        bootstrapRegisteredDevice.mockRejectedValueOnce(Object.assign(new Error('This browser cannot store a registered-device key.'), { code: 'BROWSER_DEVICE_UNSUPPORTED' }));
        const { bootstrap, error } = useDeviceAccess();

        await expect(bootstrap({ secret: 'secret', deviceLabel: 'Admin browser' })).resolves.toMatchObject({ success: false, code: 'BROWSER_DEVICE_UNSUPPORTED' });
        expect(error.value).toBe('This browser cannot store a registered-device key.');
    });

    it('sends the selected global mode and reloads the authoritative state', async () => {
        fetchJson
            .mockResolvedValueOnce({ success: true, mode: 'disabled' })
            .mockResolvedValueOnce({ success: true, mode: 'disabled', users: [] });
        const { setMode, state } = useDeviceAccess();

        await expect(setMode('disabled')).resolves.toMatchObject({ success: true, mode: 'disabled' });
        expect(fetchJson).toHaveBeenNthCalledWith(1, 'api/admin/device-access/mode', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ mode: 'disabled' }),
        }));
        expect(state.value.mode).toBe('disabled');
    });
});

describe('device access registered-browser proof', () => {
    const STEP_UP = { success: false, code: 'WEBAUTHN_STEP_UP_REQUIRED', message: 'Verify this browser.' };
    const modeWrites = () => fetchJson.mock.calls.filter(([path]) => path === 'api/admin/device-access/mode');

    beforeEach(() => {
        fetchJson.mockReset();
        beginStepUp.mockReset().mockResolvedValue({ success: true });
    });

    it('replays a mutation once after the browser proves itself and then reloads', async () => {
        fetchJson
            .mockResolvedValueOnce(STEP_UP)
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: true, mode: 'enforced', users: [] });
        const access = useDeviceAccess();

        const result = await access.setMode('enforced');

        expect(result).toEqual({ success: true });
        expect(beginStepUp).toHaveBeenCalledOnce();
        expect(modeWrites()).toHaveLength(2);
        expect(access.state.value.mode).toBe('enforced');
    });

    it('does not ask for proof a second time when the replay is still refused', async () => {
        // A third answer bounds a regression that keeps retrying instead of hanging.
        fetchJson
            .mockResolvedValueOnce(STEP_UP)
            .mockResolvedValueOnce(STEP_UP)
            .mockResolvedValue({ success: true });
        const access = useDeviceAccess();

        const result = await access.setMode('enforced');

        expect(result.code).toBe('WEBAUTHN_STEP_UP_REQUIRED');
        expect(beginStepUp).toHaveBeenCalledOnce();
        expect(modeWrites()).toHaveLength(2);
        expect(access.error.value).toBe('Verify this browser.');
    });

    it('does not replay the mutation when the browser proof fails', async () => {
        fetchJson.mockResolvedValue(STEP_UP);
        beginStepUp.mockResolvedValue({ success: false, message: 'Browser verification was cancelled.' });
        const access = useDeviceAccess();

        await access.setMode('enforced');

        expect(modeWrites()).toHaveLength(1);
        expect(access.error.value).toBe('Browser verification was cancelled.');
    });
});

describe('device access overlapping reads', () => {
    beforeEach(() => vi.clearAllMocks());

    it('keeps the newest read when an older one resolves last', async () => {
        let resolveOld;
        fetchJson
            .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ success: true, mode: 'enforced', users: [] });
        const { load, state } = useDeviceAccess();

        const older = load({ silent: true });
        await load({ silent: true });
        expect(state.value.mode).toBe('enforced');

        resolveOld({ success: true, mode: 'disabled', users: [] });
        await older;
        expect(state.value.mode).toBe('enforced');
    });

    it('ends the spinner of a foreground read that a silent read superseded', async () => {
        let resolveFirst;
        fetchJson
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
            .mockResolvedValueOnce({ success: true, mode: 'enforced', users: [] });
        const { load, loading, state } = useDeviceAccess();

        const foreground = load();
        expect(loading.value).toBe(true);
        await load({ silent: true });
        expect(loading.value).toBe(true);

        resolveFirst({ success: true, mode: 'disabled', users: [] });
        await foreground;
        expect(loading.value).toBe(false);
        expect(state.value.mode).toBe('enforced');
    });

    it('keeps the spinner while a newer foreground read is still running', async () => {
        const resolvers = [];
        fetchJson.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
        const { load, loading } = useDeviceAccess();

        const first = load();
        const second = load();
        resolvers[1]({ success: true, mode: 'enforced', users: [] });
        await second;
        resolvers[0]({ success: true, mode: 'disabled', users: [] });
        await first;
        expect(loading.value).toBe(false);

        const older = load();
        const newer = load();
        resolvers[2]({ success: true, mode: 'disabled', users: [] });
        await older;
        expect(loading.value).toBe(true);
        resolvers[3]({ success: true, mode: 'enforced', users: [] });
        await newer;
        expect(loading.value).toBe(false);
    });
});

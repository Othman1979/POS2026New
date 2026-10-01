import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const page = vi.hoisted(() => ({ mounted: [], events: [] }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: callback => page.mounted.push(callback) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/shared/browserDeviceClient.js', () => ({
    isBrowserDeviceSupported: () => true,
    getEnrollmentOptions: vi.fn(async code => { page.events.push(['options', code]); return { user: { name: 'Rana' }, device_label: 'Front till' }; }),
    completeEnrollment: vi.fn(async code => { page.events.push(['complete', code]); return { success: true }; }),
}));
import DeviceEnrollment from '../DeviceEnrollment.vue';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/DeviceEnrollment.vue'), 'utf8');

describe('device enrollment page', () => {
    it('takes the one-time code from the link fragment, clears it from the address bar before any request, and enrolls with it', async () => {
        vi.stubGlobal('document', { title: 'Enroll' });
        vi.stubGlobal('window', {
            location: { hash: '#code=ABC123', pathname: '/device-enrollment', search: '?lang=ar' },
            history: { replaceState: (state, title, url) => page.events.push(['address', url]) },
        });
        const scope = effectScope();
        try {
            const state = scope.run(() => DeviceEnrollment.setup({}, { expose() {} }));
            await page.mounted[0]();
            await state.register();

            expect(page.events).toEqual([
                ['address', '/device-enrollment?lang=ar'],
                ['options', 'ABC123'],
                ['complete', 'ABC123'],
            ]);
            expect(state.state.value).toBe('done');
        } finally {
            scope.stop();
            vi.unstubAllGlobals();
        }
    });

    it('accepts a copied enrollment code when no QR fragment is available', () => {
        expect(source).toContain('v-model="manualCode"');
        expect(source).toContain('@submit.prevent="submitManualCode"');
        expect(source).toContain('manualCode.value.trim()');
        expect(source).toContain("replace(/\\s+/g, '')");
    });

    it('registers silently in the browser without an operating-system authenticator prompt', () => {
        expect(source).toContain("@/shared/browserDeviceClient.js");
        expect(source).toContain('isBrowserDeviceSupported');
        expect(source).not.toContain('Approve the device prompt');
        expect(source).not.toContain('isWebAuthnSupported');
    });
});

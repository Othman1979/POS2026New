import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';

const access = vi.hoisted(() => ({ state: null }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/admin/composables/useDeviceAccess.js', () => ({
    useDeviceAccess: () => ({ state: ref(access.state), loading: ref(false), error: ref(''), load: vi.fn(), bootstrap: vi.fn(), enroll: vi.fn(), approveEnrollment: vi.fn(), cancelEnrollment: vi.fn(), revoke: vi.fn(), setMode: vi.fn() }),
}));
import DeviceAccessSettings from '../../components/settings/DeviceAccessSettings.vue';

async function renderAs(role, state) {
    access.state = { users: [], bootstrap_consumed: true, ...state };
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ role }) });
    const app = createSSRApp(DeviceAccessSettings);
    app.config.globalProperties.$t = key => key;
    return renderToString(app);
}
afterEach(() => { vi.unstubAllGlobals(); });

const ROOT = path.resolve(process.cwd());
const component = fs.readFileSync(path.join(ROOT, 'src/admin/components/settings/DeviceAccessSettings.vue'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'src/admin/pages/Settings.vue'), 'utf8');
const composable = fs.readFileSync(path.join(ROOT, 'src/admin/composables/useDeviceAccess.js'), 'utf8');
const ar = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/i18n/ar.json'), 'utf8'));

describe('device access settings surface', () => {
    it('is a dedicated settings tab with clear browser access actions', () => {
        expect(settings).toContain("activeTab === 'deviceAccess'");
        for (const label of ['Register browser', 'Register another browser', 'Change browser', 'Remove access', 'Enable device access', 'Disable device access']) expect(component).toContain(label);
        expect(component).not.toMatch(/recovery/i);
        expect(composable).not.toMatch(/recovery/i);
        expect(composable).toContain("api/admin/device-access/enrollments");
        expect(composable).toContain("api/admin/device-access/credentials/");
    });

    it('explains per-user binding and prioritizes PIN-only users', () => {
        expect(component).toContain("A user's first PIN login requests this browser automatically. Approve it here to finish registration.");
        expect(component).toContain('Registered browsers are preserved while device access is disabled.');
        expect(component).toContain('Only the programmer can manage registered browsers while device access is disabled.');
        expect(component).toContain('Users without a registered browser can sign in with their PIN from any browser.');
        expect(component).not.toContain('The last registered browser cannot be removed while device access is enabled. Change it or disable device access first.');
        expect(component).toContain("state.mode === 'staged'");
        expect(component).toContain('canManageDevices');
        expect(component).not.toContain("A user's first PIN login does not register a browser.");
        expect(component).toContain('orderedUsers');
        expect(component).toContain('boundUserCount');
        expect(component).toContain('roleLabel(user.role)');
        expect(component).toContain('activeCredentials(user)');
        expect(component).not.toContain('{{ user.role }}');
        expect(component).not.toContain('{{ credential.status }}');
    });

    it('shows detected browser requests as approve or reject decisions', () => {
        expect(component).toContain('pendingOf(user).browser_requested');
        expect(component).toContain("$t('Approve browser')");
        expect(component).toContain("$t('Reject')");
        expect(component).toContain("$t('Approved — waiting for browser')");
        expect(component).toMatch(/pendingOf\(user\)\.approved[\s\S]{0,500}cancel\(pendingOf\(user\)\.id\)/);
        expect(component).toContain('!pendingOf(user).approved');
        expect(composable).toContain('/approve');
        expect(composable).toContain('approveEnrollment');
    });

    it('offers only eligible browsers as replacement targets', () => {
        expect(component).toContain('eligibleCredentials(user)');
        expect(component).toMatch(/v-for="credential in eligibleCredentials\(replaceUser\)"/);
    });

    it('offers desktop-friendly enrollment controls and an expiring grouped enrollment code', () => {
        expect(component).not.toContain('readinessOpen');
        expect(component).toContain('enrollmentCountdown');
        expect(component).toContain('groupedEnrollmentCode');
        expect(component).toContain('openEnrollmentLink');
        expect(component).toContain('copyEnrollmentLink');
        expect(component).toContain("$t('Open enrollment page')");
        expect(component).toContain("$t('Copy enrollment link')");
        expect(composable).not.toContain('confirm_last_privileged');
        expect(component).not.toContain('window.confirm');
    });

    it('surfaces failed mutations through the shared error state', () => {
        expect(composable).toContain('setResultError');
        expect(composable).toMatch(/if \(!result\?\.success\)[\s\S]{0,160}error\.value/);
    });

    it.each([
        ['enforced', 'Disable device access'],
        ['staged', 'Enable device access'],
        ['disabled', 'Enable device access'],
    ])('shows the %s-mode "%s" control to the programmer', async (mode, control) => {
        expect(await renderAs('programmer', { mode })).toContain(control);
    });

    it.each(['enforced', 'staged', 'disabled'])('hides every enforcement control from an admin in %s mode', async mode => {
        const html = await renderAs('admin', { mode });
        expect(html).not.toContain('Disable device access');
        expect(html).not.toContain('Enable device access');
    });

    it('asks an admin for first device setup before bootstrap but never asks the programmer', async () => {
        expect(await renderAs('admin', { mode: 'disabled', bootstrap_consumed: false })).toContain('Register this administrator device');
        expect(await renderAs('programmer', { mode: 'disabled', bootstrap_consumed: false })).not.toContain('Register this administrator device');
    });

    it('provides Arabic copy for the complete enrollment and enforcement workflow', () => {
        expect(component).toContain('$t(error)');
        for (const key of ["A user's first PIN login requests this browser automatically. Approve it here to finish registration.", 'Registered browsers are preserved while device access is disabled.', 'Only the programmer can manage registered browsers while device access is disabled.', 'Users without a registered browser can sign in with their PIN from any browser.', 'Only users with a registered browser need device verification.', 'Register browser', 'Register another browser', 'Approve browser', 'Reject', 'New browser waiting for approval', 'Approved — waiting for browser', 'Waiting for administrator approval', 'Ask an administrator to approve this browser from Device access.', 'Change browser', 'Remove access', 'PIN only', 'Bound', 'Programmer', 'Table Manager', 'Registered-device access is not configured correctly.', 'Unable to load device access.', 'Device access operation failed.', 'Enter enrollment code', 'Expires in', 'Open enrollment page', 'Copy enrollment link', 'Disable device access', 'Enable device access', 'Only the programmer can change device access enforcement.', 'This browser is already registered for this user.']) {
            expect(ar[key]).toMatch(/[\u0600-\u06ff]/);
        }
    });
});

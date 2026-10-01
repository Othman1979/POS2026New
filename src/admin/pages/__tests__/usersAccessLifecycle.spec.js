import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson, fetchJsonResponseWithTimeout: async (...args) => ({ data: await fetchJson(...args) }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: ref('en') }));
vi.mock('vue', async original => ({ ...await original(), onMounted: vi.fn(), onUnmounted: vi.fn(), useSSRContext: () => ({ modules: new Set() }) }));
import Users from '../Users.vue';
import policy from '@posapp/permission-policy';

const employee = (version = 'original') => ({ id: 2, name: 'Cashier', user_number: '1234', role: 'cashier', permissions: ['pos.checkout'], table_access_scope: 'all', allowed_sections: '', edit_version: version });
let scope;
beforeEach(() => {
    fetchJson.mockReset();
    vi.stubGlobal('window', { showAdminAlert: vi.fn(), showAdminToast: vi.fn() });
});
afterEach(() => { scope?.stop(); vi.unstubAllGlobals(); });
async function page() {
    scope = effectScope();
    const state = scope.run(() => Users.setup());
    fetchJson.mockResolvedValueOnce({ success: true, users: [employee()], sections: [] });
    fetchJson.mockResolvedValueOnce({ success: true, catalog: policy.catalog });
    await state.fetchUsersAndSections();
    return state;
}

describe('user access editor lifecycle', () => {
    it('starts a new waiter with table editing, no cashier grants and an explicit section choice', async () => {
        const state = await page();
        state.openModal();
        state.form.value.role = 'waiter';
        state.handleRoleChange();
        expect(state.form.value.permissions).toEqual(['waiter.edit_locked']);
        expect(state.form.value.table_access_scope).toBe('none');
        expect(state.selectedPreset.value).toBe('waiter');
    });

    it('offers a cashier table preset that keeps later edits and voids separate', async () => {
        const state = await page();
        state.openModal();
        state.selectedPreset.value = 'cashier_tables';
        state.applyPreset();
        expect(state.form.value.permissions).toEqual(expect.arrayContaining(['pos.checkout', 'tables.access', 'tables.save']));
        expect(state.form.value.permissions).not.toContain('waiter.edit_locked');
        expect(state.form.value.permissions).not.toContain('pos.void_item');
        state.onPermissionsChanged();
        expect(state.selectedPreset.value).toBe('custom');
    });

    it('preserves explicit scope and applicable grants when an existing employee changes role', async () => {
        const state = await page();
        state.openModal({ ...employee(), table_access_scope: 'selected', allowed_sections: '2', permissions: ['tables.save', 'pos.checkout'] });
        state.form.value.role = 'waiter';
        state.handleRoleChange();
        expect(state.form.value).toMatchObject({ table_access_scope: 'selected', allowed_sections: [2], permissions: ['pos.checkout'] });
        expect(state.roleChanged.value).toBe(true);
    });

    it('blocks empty selected scope and serializes an explicit selection', async () => {
        const state = await page();
        state.openModal(employee());
        state.form.value.table_access_scope = 'selected';
        const count = fetchJson.mock.calls.length;
        await state.saveUser();
        expect(fetchJson).toHaveBeenCalledTimes(count);
        state.toggleSection(2);
        fetchJson.mockResolvedValueOnce({ success: true, edit_version: 'saved' });
        await state.saveUser();
        expect(JSON.parse(fetchJson.mock.lastCall[1].body)).toMatchObject({ table_access_scope: 'selected', allowed_sections: '2' });
    });

    it('submits no stale authority for a call-center user and uses the canonical saved profile', async () => {
        const state = await page();
        state.openModal(employee());
        Object.assign(state.form.value, { role: 'call_center', table_access_scope: 'all', allowed_sections: [2], permissions: ['pos.checkout'] });
        const user = { ...employee('canonical'), role: 'call_center', name: 'Trimmed name', table_access_scope: 'none', allowed_sections: null, permissions: [] };
        fetchJson.mockResolvedValueOnce({ success: true, edit_version: 'canonical', user });
        await state.saveUser();
        expect(JSON.parse(fetchJson.mock.lastCall[1].body)).toMatchObject({ table_access_scope: 'none', allowed_sections: '', permissions: [] });
        expect(state.filteredUsers.value[0]).toMatchObject(user);
    });

    it('includes all-scope employees and excludes no-scope employees in section filters', async () => {
        const state = await page();
        state.selectedSections.value = [2];
        expect(state.filteredUsers.value).toHaveLength(1);
        state.openModal(employee());
        state.form.value.table_access_scope = 'none';
        fetchJson.mockResolvedValueOnce({ success: true, edit_version: 'saved' });
        await state.saveUser();
        expect(state.filteredUsers.value).toHaveLength(0);
    });
    it('keeps the draft on conflict and reloads only after an explicit action', async () => {
        const state = await page();
        state.openModal(employee());
        state.form.value.name = 'Unsaved name';
        fetchJson.mockResolvedValueOnce({ success: false, code: 'USER_EDIT_CONFLICT' });
        await state.saveUser();
        expect(state.editConflict.value).toBe(true);
        expect(state.form.value.name).toBe('Unsaved name');
        const count = fetchJson.mock.calls.length;
        await state.saveUser();
        expect(fetchJson).toHaveBeenCalledTimes(count);
        fetchJson.mockResolvedValueOnce({ success: true, users: [{ ...employee('current'), permissions: [] }], sections: [] });
        await state.reloadEditedUser();
        expect(state.form.value).toMatchObject({ edit_version: 'current', permissions: [], name: 'Cashier' });
        expect(state.editConflict.value).toBe(false);
    });

    it('sends one mutation while saving and retains the returned version for the next edit', async () => {
        const state = await page();
        state.openModal(employee());
        let finish;
        fetchJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const saving = state.saveUser();
        await state.saveUser();
        expect(fetchJson.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
        expect(state.isSaving.value).toBe(true);
        finish({ success: true, edit_version: 'updated' });
        await saving;
        state.openModal(state.filteredUsers.value[0]);
        expect(state.form.value.edit_version).toBe('updated');
    });

    it('preserves create mode and values after a failed request', async () => {
        const state = await page();
        state.openModal();
        Object.assign(state.form.value, { name: 'New staff', user_number: '5678' });
        fetchJson.mockRejectedValueOnce(new Error('Lost response'));
        await state.saveUser();
        expect(window.showAdminToast).not.toHaveBeenCalled();
        expect(state.isEditing.value).toBe(false);
        expect(state.showModal.value).toBe(true);
        expect(state.form.value).toMatchObject({ id: null, name: 'New staff', user_number: '5678' });
        expect(state.isSaving.value).toBe(false);
        expect(state.uncertainSave.value).toMatchObject({ user_number: '5678' });
        const calls = fetchJson.mock.calls.length;
        await state.saveUser();
        expect(fetchJson).toHaveBeenCalledTimes(calls);
        fetchJson.mockResolvedValueOnce({ success: true, users: [{ ...employee('committed'), id: 9, user_number: '5678', name: 'New staff' }] });
        await state.checkSavedUser();
        expect(state.uncertainSave.value).toBe(null);
        expect(state.isEditing.value).toBe(true);
        expect(state.form.value).toMatchObject({ id: 9, edit_version: 'committed' });
    });

    it('keeps an uncertain save blocked if checking the server fails', async () => {
        const state = await page();
        state.openModal(employee());
        fetchJson.mockRejectedValueOnce(new Error('Lost response'));
        await state.saveUser();
        fetchJson.mockRejectedValueOnce(new Error('Offline'));
        await state.checkSavedUser();
        expect(state.uncertainSave.value).not.toBe(null);
        state.openModal();
        expect(state.form.value.id).toBe(2);
    });

    it('can immediately edit a successfully created user', async () => {
        const state = await page();
        state.openModal();
        Object.assign(state.form.value, { name: 'New staff', user_number: '5678' });
        fetchJson.mockResolvedValueOnce({ success: true, id: 9, edit_version: 'created' });
        await state.saveUser();
        state.openModal(state.filteredUsers.value.find(user => user.id === 9));
        expect(state.form.value).toMatchObject({ id: 9, edit_version: 'created' });
        expect(state.isEditing.value).toBe(true);
    });

    it('ignores a user refresh started before a successful save', async () => {
        const state = await page();
        state.openModal({ ...employee(), role: 'admin' });
        let finishRefresh;
        fetchJson.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
        const refresh = state.fetchUsersAndSections();
        fetchJson.mockResolvedValueOnce({ success: true, edit_version: 'updated' });
        await state.saveUser();
        finishRefresh({ success: true, users: [employee()], sections: [] });
        await refresh;
        expect(state.filteredUsers.value[0].edit_version).toBe('updated');
    });
});

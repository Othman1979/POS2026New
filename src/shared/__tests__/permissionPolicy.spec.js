import { describe, expect, it } from 'vitest';
import policy from '@posapp/permission-policy';
const { evaluateAction, userHas, catalog, PERMISSIONS } = policy;
const actor = (permissions = [], role = 'cashier') => ({ id: 7, role, permissions });

describe('shared permission action policy', () => {
    it('requires maintained role and explanation metadata and resolves every declared action', () => {
        expect(new Set(catalog.map(row => row.perm_key)).size).toBe(catalog.length);
        for (const row of catalog) {
            expect(row.roles.length).toBeGreaterThan(0);
            expect(row.group).toBeTruthy();
            expect(row.example).toBeTruthy();
            expect(row.example_ar).toBeTruthy();
            expect(evaluateAction(actor([], 'admin'), row.action || row.perm_key, row.action_context).code).not.toBe('UNKNOWN_ACTION');
        }
    });

    it('uses installation cashier defaults without leaking them into the waiter preset', () => {
        const customized = catalog.map(row => ({ ...row, default_cashier: row.perm_key === 'pos.refund' ? 1 : 0 }));
        expect(policy.presetPermissions('cashier', customized)).toEqual(['pos.refund']);
        expect(policy.presetPermissions('waiter', customized)).toEqual(['waiter.edit_locked']);
        expect(policy.presetPermissions('cashier_tables', customized).sort()).toEqual(['pos.refund', 'tables.access', 'tables.save']);
        expect(policy.presetPermissions('missing', customized)).toEqual([]);
        expect(policy.canAssignPermission('cashier', 'waiter.checkout')).toBe(false);
        expect(policy.canAssignPermission('waiter', 'tables.save')).toBe(false);
    });

    it('uses explicit table scope and fails closed when scope is absent or malformed', () => {
        expect(policy.getTableSectionIds(actor())).toEqual([]);
        expect(policy.getTableSectionIds({ ...actor(), table_access_scope: 'typo', allowed_sections: '1' })).toEqual([]);
        expect(policy.getTableSectionIds({ ...actor(), table_access_scope: 'all' })).toBe(null);
        expect(policy.getTableSectionIds({ ...actor([], 'waiter'), table_access_scope: 'selected', allowed_sections: ' 2,2,0,3bad,4 ' })).toEqual([2, 4]);
        expect(policy.getTableSectionIds({ ...actor([], 'call_center'), table_access_scope: 'all' })).toEqual([]);
        expect(evaluateAction(actor(), 'checkout', null).allowed).toBe(false);
    });

    it('derives each public constant from the known catalog and fails closed for unknown actions', () => {
        expect(Object.values(PERMISSIONS).sort()).toEqual(catalog.map(row => row.perm_key).sort());
        for (const role of ['admin', 'programmer', 'cashier', 'waiter', 'call_center']) {
            expect(userHas(actor(['typo.permission'], role), 'typo.permission')).toBe(false);
            expect(evaluateAction(actor([], role), 'typo.action').allowed).toBe(false);
        }
    });

    it.each(['cashier', 'waiter'])('keeps first-save and edit authority distinct for %s', role => {
        const firstSave = actor(['tables.access', 'tables.save'], role);
        expect(evaluateAction(firstSave, 'table.create').allowed).toBe(role === 'cashier');
        expect(evaluateAction(firstSave, 'table.edit').allowed).toBe(false);
        firstSave.permissions.push('waiter.edit_locked');
        expect(evaluateAction(firstSave, 'table.create').allowed).toBe(true);
        expect(evaluateAction(firstSave, 'table.edit').allowed).toBe(true);
    });

    it('distinguishes draft removal, saved cancellation and bill-printed cancellation', () => {
        const user = actor();
        expect(evaluateAction(user, 'table.void', { saved: false }).allowed).toBe(true);
        expect(evaluateAction(user, 'table.void', { printed: false }).missingPermissions).toEqual(['pos.void_item']);
        user.permissions.push('pos.void_item');
        expect(evaluateAction(user, 'table.void', { printed: false }).allowed).toBe(true);
        expect(evaluateAction(user, 'table.void', { printed: true }).missingPermissions).toEqual(['pos.void_printed_item']);
        user.permissions.push('pos.void_printed_item');
        expect(evaluateAction(user, 'table.void', { printed: true }).allowed).toBe(true);
    });

    it('explains why moving individual items needs more authority than moving the whole table', () => {
        const user = actor(['waiter.transfer_table']);
        expect(evaluateAction(user, 'table.transfer').allowed).toBe(true);
        expect(evaluateAction(user, 'table.transfer_items').missingPermissions).toEqual(['waiter.edit_locked']);
        user.permissions.push('waiter.edit_locked');
        expect(evaluateAction(user, 'table.transfer_items').allowed).toBe(true);
    });

    it('uses the same durable grant for joining and separating tables', () => {
        for (const action of ['table.join', 'table.disjoin']) {
            expect(evaluateAction(actor(), action).missingPermissions).toEqual(['waiter.merge_tables']);
            expect(evaluateAction(actor(['waiter.merge_tables']), action).allowed).toBe(true);
        }
    });

    it.each(['cashier', 'waiter'])('scopes waiter payment authority by role and order context for %s', role => {
        const user = actor(['waiter.checkout'], role);
        expect(evaluateAction(user, 'checkout').allowed).toBe(false);
        expect(evaluateAction(user, 'checkout', { tablePayment: true }).allowed).toBe(role === 'waiter');
        user.permissions.push('pos.checkout');
        expect(evaluateAction(user, 'checkout').allowed).toBe(true);
        expect(evaluateAction(user, 'checkout', { tablePayment: true }).allowed).toBe(true);
    });

    it('keeps administrators unrestricted for known actions and call center fixed', () => {
        for (const action of ['table.create', 'table.edit', 'table.void', 'table.transfer_items', 'checkout', ...Object.values(PERMISSIONS)]) {
            expect(evaluateAction(actor([], 'admin'), action, { printed: true }).allowed).toBe(true);
            expect(evaluateAction(actor(Object.values(PERMISSIONS), 'call_center'), action, { saved: false, tablePayment: true }).allowed).toBe(false);
        }
    });
});

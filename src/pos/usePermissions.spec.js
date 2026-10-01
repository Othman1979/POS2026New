import { ref } from 'vue';

const activeUser = ref(null);
const isTempAdmin = ref(false);
const temporaryPermissions = ref([]);

vi.mock('./useAuth.js', () => ({
    useAuth: () => ({ activeUser, isTempAdmin, temporaryPermissions })
}));

describe('usePermissions fixed call-center role', () => {
    it('denies stale grants before checking the permission list', async () => {
        activeUser.value = {
            id: 20,
            role: 'call_center',
            permissions: ['pos.checkout', 'tables.access', 'orders.view']
        };
        isTempAdmin.value = true;
        temporaryPermissions.value = ['pos.checkout'];

        const { usePermissions } = await import('./usePermissions.js');
        expect(usePermissions().can('pos.checkout')).toBe(false);
        expect(usePermissions().can('tables.access')).toBe(false);
        isTempAdmin.value = false;
        temporaryPermissions.value = [];
    });

    it('allows known grants and rejects unknown keys even for administrators', async () => {
        const { usePermissions } = await import('./usePermissions.js');
        activeUser.value = { id: 2, role: 'cashier', permissions: ['orders.view'] };
        expect(usePermissions().can('orders.view')).toBe(true);
        expect(usePermissions().can('pos.checkout')).toBe(false);

        activeUser.value = { id: 1, role: 'admin', permissions: [] };
        expect(usePermissions().can('pos.checkout')).toBe(true);
        expect(usePermissions().can('anything')).toBe(false);
    });

    it('treats table access as intrinsic to waiters, matching the server route', async () => {
        const { usePermissions } = await import('./usePermissions.js');
        activeUser.value = { id: 7, role: 'waiter', permissions: [] };

        expect(usePermissions().can('tables.access')).toBe(true);
        expect(usePermissions().can('pos.checkout')).toBe(false);
    });

    it('grants only server-approved temporary checkout permissions', async () => {
        const { usePermissions } = await import('./usePermissions.js');
        activeUser.value = { id: 2, role: 'cashier', permissions: [] };
        isTempAdmin.value = true;
        temporaryPermissions.value = ['pos.discount', 'pos.price_override', 'pos.checkout', 'pos.service_charge', 'orders.view'];

        const permissions = usePermissions();
        expect(permissions.can('pos.discount')).toBe(true);
        expect(permissions.can('pos.price_override')).toBe(true);
        expect(permissions.can('pos.checkout')).toBe(false);
        expect(permissions.can('pos.service_charge')).toBe(false);
        expect(permissions.can('orders.view')).toBe(false);
        expect(permissions.hasDirect('pos.discount')).toBe(false);

        isTempAdmin.value = false;
        temporaryPermissions.value = [];
    });
});

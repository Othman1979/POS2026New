import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({}), useRoute: () => ({ name: 'dashboard', query: {} }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn(), currentLanguage: { value: 'en' } }));
vi.mock('../../components/Sidebar.vue', () => ({ default: {} }));
vi.mock('../../components/AdminDialogs.vue', () => ({ default: {} }));
vi.mock('../../components/AdminHeader.vue', () => ({ default: {} }));
vi.mock('../../composables/useAdminDialogs.js', () => ({ installAdminDialogGlobals: vi.fn() }));
vi.mock('../../composables/useAdminSession.js', async () => {
    const { ref } = await import('vue');
    return { useAdminSession: () => ({ activeUser: ref(null), userRole: ref('admin'), logout: vi.fn() }) };
});
vi.mock('../../composables/useSystemStatus.js', () => ({ useSystemStatus: () => ({}) }));
vi.mock('../../composables/useStockAlerts.js', async () => {
    const { ref } = await import('vue');
    return { useStockAlerts: () => ({ lowStockItems: ref([]) }) };
});
import App from '../../App.vue';
import Dashboard from '../Dashboard.vue';

describe('admin page caching', () => {
    // <keep-alive :include> matches the page component's name, so renaming the
    // Dashboard would silently stop it being cached and it would reload on every visit.
    it('caches the Dashboard under the name the admin shell keeps alive', () => {
        const scope = effectScope();
        const { cachedPages } = scope.run(() => App.setup());
        scope.stop();
        expect(cachedPages).toContain(Dashboard.name);
    });
});

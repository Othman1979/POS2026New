import { fetchJson } from '@/shared/http.js';
import { createRouter, createWebHistory } from 'vue-router';
import { pageLoaders, pageNames } from './pageRegistry.js';

const savedPage = () => {
    let page = localStorage.getItem('admin_current_page') || 'dashboard';
    const legacyPages = {
        'reports-overview': 'reports-summary',
        'reports-products': 'reports-sales',
        'reports-tables': 'reports-sales',
        'reports-staff': 'reports-sales',
        'reports-invoices': 'orders',
        'reports-shifts': 'shifts'
    };
    if (legacyPages[page]) {
        page = legacyPages[page];
        localStorage.setItem('admin_current_page', page);
    }
    return pageNames.includes(page) ? page : 'dashboard';
};

const routes = [
    {
        path: '/',
        redirect: () => `/${savedPage()}`
    },
    // ─── Legacy reports redirects ───
    { path: '/reports-overview', redirect: '/reports-summary' },
    { path: '/reports-products', redirect: '/reports-sales' },
    { path: '/reports-tables', redirect: '/reports-sales' },
    { path: '/reports-staff', redirect: '/reports-sales' },
    { path: '/reports-invoices', redirect: '/orders' },
    { path: '/reports-shifts', redirect: '/shifts' },
    
    // ─── Nested reports — layout stays alive on tab switches ───
    {
        path: '/reports',
        component: () => import('./components/ReportsLayout.vue'),
        redirect: '/reports-summary',
        children: [
            { path: '/reports-summary',  name: 'reports-summary',  component: pageLoaders['reports-summary'],  meta: { page: 'reports' } },
            { path: '/reports-sales',    name: 'reports-sales',    component: pageLoaders['reports-sales'],    meta: { page: 'reports' } },
            { path: '/reports-refunds',  name: 'reports-refunds',  component: pageLoaders['reports-refunds'],  meta: { page: 'reports' } },
            { path: '/reports-expenses', name: 'reports-expenses', component: pageLoaders['reports-expenses'], meta: { page: 'reports' } },
            { path: '/reports-product-profit', name: 'reports-product-profit', component: pageLoaders['reports-product-profit'], meta: { page: 'reports' } },
            { path: '/reports-ingredients', name: 'reports-ingredients', component: pageLoaders['reports-ingredients'], meta: { page: 'reports' } },
        ]
    },
    // ─── All other flat pages ───
    ...pageNames.filter(p => !p.startsWith('reports-')).map((page) => ({
        path: `/${page}`,
        name: page,
        component: pageLoaders[page],
        meta: { page }
    })),
    {
        path: '/:pathMatch(.*)*',
        redirect: '/dashboard'
    }
];

export const createAdminRouter = () => {
    const router = createRouter({
        history: createWebHistory('/admin'),
        routes,
        scrollBehavior() {
            return { top: 0 };
        }
    });

    const SESSION_REVALIDATE_MS = 30 * 60 * 1000;

    router.beforeEach(async (to) => {
        let userStr = sessionStorage.getItem('pos_user');
        const storedAt = parseInt(sessionStorage.getItem('pos_user_at') || '0', 10);
        const isStale = userStr && storedAt > 0 && (Date.now() - storedAt > SESSION_REVALIDATE_MS);

        if (!userStr || isStale) {
            try {
                const data = await fetchJson('api/auth/me');
                if (data.success && data.user) {
                    sessionStorage.setItem('pos_user', JSON.stringify(data.user));
                    sessionStorage.setItem('pos_user_at', String(Date.now()));
                    localStorage.setItem('pos_active_user_id', data.user.id);
                    userStr = JSON.stringify(data.user);
                } else if (isStale) {
                    sessionStorage.removeItem('pos_user');
                    sessionStorage.removeItem('pos_user_at');
                    userStr = null;
                }
            } catch (e) {
                console.error("Failed to restore admin session", e);
            }
        }

        if (!userStr) {
            window.location.href = '/login';
            return false;
        }

        try {
            const user = JSON.parse(userStr);
            const role = user.role;

            // The admin dashboard is admin/programmer only — no other role has any
            // admin surface, regardless of granted permissions. Cashiers have their
            // own order history inside the POS app (/order-notes).
            if (role === 'admin' || role === 'programmer') {
                return;
            }

            // Waiters go to the floor plan; everyone else to the POS terminal.
            window.location.href = role === 'waiter' ? '/tables' : '/pos';
            return false;
        } catch (e) {
            window.location.href = '/login';
            return false;
        }
    });

    // Handle dynamic import chunk loading failures (due to new deployment replacing chunks)
    router.onError((error) => {
        if (error.message && (
            error.message.includes('Failed to fetch dynamically imported module') || 
            error.message.includes('Importing a module script failed') ||
            error.message.includes('failed to fetch dynamically imported module')
        )) {
            window.location.reload();
        }
    });

    return router;
};

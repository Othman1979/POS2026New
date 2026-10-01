export const pageLoaders = {
    dashboard: () => import('./pages/Dashboard.vue'),
    orders: () => import('./pages/Orders.vue'),
    'reports-summary': () => import('./pages/ReportsSummary.vue'),
    'reports-sales': () => import('./pages/ReportsSalesDetails.vue'),
    'reports-refunds': () => import('./pages/ReportsRefunds.vue'),
    'reports-expenses': () => import('./pages/ReportsExpenses.vue'),
    'reports-product-profit': () => import('./pages/ReportsProductProfit.vue'),
    'reports-ingredients': () => import('./pages/ReportsIngredients.vue'),
    customers: () => import('./pages/Customers.vue'),
    'platform-remittances': () => import('./pages/PlatformRemittances.vue'),
    jofotara: () => import('./pages/JofotaraOperations.vue'),
    'print-templates': () => import('./pages/PrintTemplates.vue'),
    inventory: () => import('./pages/Inventory.vue'),
    ingredients: () => import('./pages/Ingredients.vue'),
    tablemap: () => import('./pages/TableMapEditor.vue'),
    waiterperformance: () => import('./pages/WaiterPerformance.vue'),
    shifts: () => import('./pages/Shifts.vue'),
    users: () => import('./pages/Users.vue'),
    settings: () => import('./pages/Settings.vue')
};

export const pageNames = Object.keys(pageLoaders);

export const preloadPage = (page) => {
    // Own entries only: a URL like /admin/toString must not call an inherited method.
    if (Object.prototype.hasOwnProperty.call(pageLoaders, page)) pageLoaders[page]().catch(() => {});
};

// The page the router will most likely open first: the URL segment, else the
// saved page, else the dashboard. Only used to warm its chunk at boot.
export const initialPage = (pathname, getStorage) => {
    const segment = String(pathname || '').replace(/^\/admin(?=\/|$)/, '').split('/').filter(Boolean)[0];
    if (segment) return segment;
    try {
        return getStorage().getItem('admin_current_page') || 'dashboard';
    } catch {
        return 'dashboard';
    }
};

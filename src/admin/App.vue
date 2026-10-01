<template>
    <div class="flex h-full w-full bg-background text-foreground relative overflow-hidden">
        <transition
            enter-active-class="transition-opacity duration-300 ease-out"
            enter-from-class="opacity-0"
            enter-to-class="opacity-100"
            leave-active-class="transition-opacity duration-200 ease-in"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0"
        >
            <div
                v-if="sidebarOpen"
                @click="sidebarOpen = false"
                class="fixed inset-0 bg-zinc-900/60 backdrop-blur-sm z-40 lg:hidden"
            ></div>
        </transition>

        <admin-sidebar
            :current-page="currentPage"
            :is-open="sidebarOpen"
            :user-role="userRole"
            :low-stock-count="lowStockItems.length"
            @navigate="navigateTo"
            @close="sidebarOpen = false"
        ></admin-sidebar>

        <div class="flex-1 flex flex-col h-full overflow-hidden relative" style="transform: translate3d(0,0,0); backface-visibility: hidden;">
            <admin-header
                :page-title="pageTitle"
                :active-user="activeUser"
                :user-role="userRole"
                :is-socket-connected="isSocketConnected"
                :printer-statuses="printerStatuses"
                :all-printers-online="allPrintersOnline"
                :any-printer-online="anyPrinterOnline"
                :failed-print-jobs-count="failedPrintJobsCount"
                :stale-print-stations="stalePrintStations"
                :low-stock-items="lowStockItems"
                :system-health="systemHealth"
                @open-sidebar="sidebarOpen = true"
                @navigate="navigateTo"
                @logout="logout"
            ></admin-header>

            <main class="flex-1 overflow-y-auto premium-scroll p-6 lg:p-8 relative bg-background">
                <router-view v-slot="{ Component }">
                    <transition name="admin-page">
                        <keep-alive :include="cachedPages">
                            <component :is="Component"></component>
                        </keep-alive>
                    </transition>
                </router-view>
            </main>
        </div>

        <!-- Custom Zinc dialogs -->
        <admin-dialogs></admin-dialogs>
    </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Sidebar from './components/Sidebar.vue';
import { setLanguage, t } from '@/shared/i18n.js';
import { pageNames, preloadPage } from './pageRegistry.js';
import { getSystemSettings } from '@/shared/systemSettings.js';
import AdminDialogs from './components/AdminDialogs.vue';
import AdminHeader from './components/AdminHeader.vue';
import { installAdminDialogGlobals } from './composables/useAdminDialogs.js';
import { useAdminSession } from './composables/useAdminSession.js';
import { useSystemStatus } from './composables/useSystemStatus.js';
import { useStockAlerts } from './composables/useStockAlerts.js';
import { createAdminRealtimeBridge } from './realtime.js';

export default {
    components: {
        AdminSidebar: Sidebar,
        AdminHeader,
        AdminDialogs
    },
    setup() {
        installAdminDialogGlobals();
        const router = useRouter();
        const route = useRoute();

        // Pages cached by <keep-alive> in the main router-view. Must match each
        // page component's `name` option exactly. Keep this list minimal —
        // only heavy, frequently-revisited pages belong here.
        const cachedPages = ['dashboard', 'orders', 'inventory'];

        const session = useAdminSession();
        const { activeUser, userRole, logout } = session;
        const sidebarOpen = ref(false);
        const alerts = useStockAlerts();
        const { lowStockItems } = alerts;
        let stopRealtime = null;
        let shellAlive = true;


        const status = useSystemStatus();
        const { isSocketConnected, printerStatuses, failedPrintJobsCount, stalePrintStations, allPrintersOnline, anyPrinterOnline, systemHealth } = status;





        const currentPage = computed(() => {
            const page = String(route.name || route.meta?.page || 'dashboard');
            return pageNames.includes(page) ? page : 'dashboard';
        });

        const pageTitle = computed(() => {
            const page = currentPage.value;
            if (page && page.startsWith('reports')) {
                return t('Reports');
            }
            const titles = {
                dashboard: t('Dashboard'),
                orders: t('Order History'),
                waiterperformance: t('Waiter Performance'),
                customers: t('Customers'),
                'platform-remittances': t('Platform Payouts'),
                jofotara: t('JoFotara Operations'),
                'print-templates': t('Print Templates'),
                inventory: t('Inventory'),
                ingredients: t('Ingredients'),
                tablemap: t('Table Editor'),
                shifts: t('Shifts'),
                users: t('User Security'),
                settings: t('Settings')
            };
            return titles[page] || t('Dashboard');
        });



        const syncLanguagePreference = async () => {
            try {
                const data = await getSystemSettings();
                if (data.success && data.admin_language) await setLanguage(data.admin_language);
            } catch (_error) {}
        };

        const navigateTo = async (page) => {
            const nextPage = pageNames.includes(page) ? page : 'dashboard';
            preloadPage(nextPage);
            localStorage.setItem('admin_current_page', nextPage);

            if (currentPage.value !== nextPage) {
                await router.push({ name: nextPage });
            }
        };



        onUnmounted(() => {
            shellAlive = false;
            stopRealtime?.();
            window.removeEventListener('settings_changed', syncLanguagePreference);
            window.removeEventListener('socket_reconnected', syncLanguagePreference);
        });

        onMounted(async () => {
            const ok = await session.bootstrap();
            if (!shellAlive || !ok) return;

            // The admin dashboard is admin/programmer only. Any other role that reaches
            // here (the router guard also blocks them) is bounced to its own surface.
            if (userRole.value !== 'admin' && userRole.value !== 'programmer') {
                window.showAdminAlert(t('Unauthorized Access. Redirecting to POS Terminal.')).then(() => {
                    window.location.href = userRole.value === 'waiter' ? '/tables' : '/pos';
                });
                return;
            }

            localStorage.setItem('admin_current_page', currentPage.value);
            window.addEventListener('settings_changed', syncLanguagePreference);
            window.addEventListener('socket_reconnected', syncLanguagePreference);
            syncLanguagePreference();
            // Subscribe to the socket before the first alerts read so a change made
            // after that read is delivered as an event, not missed.
            stopRealtime = createAdminRealtimeBridge();
            alerts.start();
        });

        return {
            activeUser,
            userRole,
            currentPage,
            pageTitle,
            sidebarOpen,
            lowStockItems,
            navigateTo,
            logout,
            isSocketConnected,
            printerStatuses,
            allPrintersOnline,
            anyPrinterOnline,
            failedPrintJobsCount,
            stalePrintStations,
            systemHealth,
            cachedPages
        };
    }
};
</script>

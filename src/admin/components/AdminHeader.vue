<template>
    <header class="admin-topbar">
        <div class="admin-topbar-page">
            <button
                @click="$emit('open-sidebar')"
                class="admin-topbar-menu lg:hidden"
                :aria-label="$t('Open menu')"
                type="button"
            >
                <i class="fa-solid fa-bars"></i>
            </button>
            <h2 class="admin-topbar-title">
                {{ pageTitle }}
            </h2>
        </div>

        <div class="admin-topbar-actions">
            <!-- Live clock -->
            <div class="admin-topbar-clock hidden md:flex">
                <span class="tabular-nums" data-no-i18n>{{ clockTime }}</span>
                <span class="admin-topbar-clock-divider"></span>
                <span class="admin-topbar-date" data-no-i18n>{{ clockDate }}</span>
            </div>

            <!-- Consolidated System Status -->
            <div class="admin-topbar-slot relative">
                <button
                    @click="showSystemDropdown = !showSystemDropdown"
                    type="button"
                    class="admin-system-trigger"
                >
                    <span :class="['console-dot h-1.5 w-1.5', systemHealth.dotClass, systemHealth.pulse ? 'console-dot-pulse' : '']"></span>
                    <span class="hidden sm:inline">{{ $t('System') }}</span>
                    <i class="fa-solid fa-chevron-down text-[9px] text-muted-foreground transition-transform duration-200" :class="{ 'rotate-180': showSystemDropdown }"></i>
                </button>

                <div v-if="showSystemDropdown" @click="showSystemDropdown = false" class="fixed inset-0 z-[9990]"></div>

                <transition
                    enter-active-class="transition duration-200 ease-out"
                    enter-from-class="transform translate-y-1 opacity-0"
                    enter-to-class="transform translate-y-0 opacity-100"
                    leave-active-class="transition duration-100 ease-in"
                    leave-from-class="transform translate-y-0 opacity-100"
                    leave-to-class="transform translate-y-1 opacity-0"
                >
                    <div v-if="showSystemDropdown" class="header-dropdown absolute logical-inline-end top-full w-72 bg-card shadow-lg border-x border-b border-border rounded-b-lg z-[9999] overflow-hidden">
                        <div class="px-4 py-3 border-b border-border/40 bg-muted flex items-center justify-between">
                            <h4 class="font-bold text-[10px] tracking-wider text-muted-foreground uppercase">{{ $t('System Status') }}</h4>
                            <span :class="['w-1.5 h-1.5 console-dot', systemHealth.dotClass, systemHealth.pulse ? 'console-dot-pulse' : '']"></span>
                        </div>
                        <div class="divide-y divide-border/40">
                            <!-- Connection -->
                            <div class="px-4 py-3 flex items-center justify-between">
                                <span class="text-xs font-semibold text-foreground">{{ $t('Connection') }}</span>
                                <span class="flex items-center gap-1.5 text-[11px] font-bold" :class="isSocketConnected ? 'text-teal-600' : 'text-red-500'">
                                    <span :class="['w-1.5 h-1.5 console-dot', isSocketConnected ? 'console-dot-ok' : 'console-dot-down', isSocketConnected ? 'console-dot-pulse' : '']"></span>
                                    {{ isSocketConnected ? $t('Live') : $t('Offline') }}
                                </span>
                            </div>
                            <!-- Printers -->
                            <div v-if="printerStatuses && printerStatuses.length > 0" class="px-4 py-3">
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-xs font-semibold text-foreground">{{ $t('Printers') }}</span>
                                    <span class="text-[11px] font-bold" :class="allPrintersOnline ? 'text-teal-600' : (anyPrinterOnline ? 'text-amber-500' : 'text-red-500')">
                                        {{ allPrintersOnline ? $t('All online') : (anyPrinterOnline ? $t('Some offline') : $t('All offline')) }}
                                    </span>
                                </div>
                                <div class="flex flex-col gap-1.5">
                                    <div v-for="p in printerStatuses" :key="p.id" class="flex items-center justify-between text-[11px] py-0.5">
                                        <span class="text-muted-foreground font-medium" data-no-i18n>{{ p.name }}</span>
                                        <span class="flex items-center gap-1">
                                            <span :class="['w-1.5 h-1.5 console-dot', p.online ? 'console-dot-ok' : 'console-dot-down']"></span>
                                            <span :class="[p.online ? 'text-teal-600' : 'text-red-500', 'font-bold']">{{ p.online ? $t('Online') : $t('Offline') }}</span>
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <!-- Failed prints -->
                            <button
                                v-if="failedPrintJobsCount > 0"
                                @click="$emit('navigate', 'settings'); showSystemDropdown = false"
                                class="w-full px-4 py-3 flex items-center justify-between hover:bg-muted transition-colors text-left border-none outline-none cursor-pointer"
                            >
                                <span class="text-xs font-bold text-red-600">{{ $t('Failed Prints') }}</span>
                                <span class="bg-red-50 text-red-600 px-2 py-0.5 rounded-md text-[11px] font-bold border border-red-200">{{ failedPrintJobsCount }}</span>
                            </button>
                            <!-- Stale print stations -->
                            <button
                                v-if="stalePrintStations.length > 0"
                                @click="$emit('navigate', 'settings'); showSystemDropdown = false"
                                class="w-full px-4 py-3 flex items-center justify-between hover:bg-muted transition-colors text-left border-none outline-none cursor-pointer"
                            >
                                <span class="text-xs font-bold text-amber-600">{{ $t('Stale Print Stations') }}</span>
                                <span class="bg-amber-50 text-amber-700 px-2 py-0.5 rounded-md text-[11px] font-bold border border-amber-200">{{ stalePrintStations.length }}</span>
                            </button>
                        </div>
                    </div>
                </transition>
            </div>

            <!-- Stock Alerts -->
            <div class="admin-topbar-slot relative">
                <button
                    @click="showAlertsDropdown = !showAlertsDropdown"
                    class="admin-alert-trigger"
                    type="button"
                    :aria-label="$t('Stock alerts')"
                >
                    <i class="fa-solid fa-bell text-sm"></i>
                    <span
                        v-if="lowStockItems.length > 0"
                        class="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center border border-white tracking-tighter shadow-sm"
                    >{{ lowStockItems.length }}</span>
                </button>

                <div v-if="showAlertsDropdown" @click="showAlertsDropdown = false" class="fixed inset-0 z-[9990]"></div>

                <transition
                    enter-active-class="transition duration-200 ease-out"
                    enter-from-class="transform translate-y-1 opacity-0"
                    enter-to-class="transform translate-y-0 opacity-100"
                    leave-active-class="transition duration-100 ease-in"
                    leave-from-class="transform translate-y-0 opacity-100"
                    leave-to-class="transform translate-y-1 opacity-0"
                >
                    <div
                        v-if="showAlertsDropdown"
                        class="header-dropdown absolute logical-inline-end top-full mt-0 w-80 bg-card border-x border-b border-border shadow-lg rounded-b-lg z-[9999] overflow-hidden flex flex-col max-h-96 text-foreground"
                    >
                        <div class="px-4 py-3 border-b border-border bg-card text-muted-foreground flex justify-between items-center shrink-0">
                            <h4 class="font-bold text-[10px] tracking-wider text-muted-foreground uppercase">
                                <i class="fa-solid fa-bell mr-1.5"></i> {{ $t('Stock Alerts') }}
                            </h4>
                            <span
                                v-if="lowStockItems.length > 0"
                                class="bg-red-100 text-red-600 border border-red-200 px-2 py-0.5 rounded-md text-[10px] font-bold"
                            >{{ lowStockItems.length }}</span>
                        </div>

                        <div class="overflow-y-auto premium-scroll flex-1 divide-y divide-border bg-card">
                            <div v-if="lowStockItems.length === 0" class="p-6 text-center text-muted-foreground">
                                <i class="fa-solid fa-box-open text-2xl mb-2 opacity-50"></i>
                                <p class="font-medium text-xs">{{ $t('No low stock alerts right now.') }}</p>
                            </div>

                            <div
                                v-for="item in lowStockItems"
                                :key="item.id"
                                @click="$emit('navigate', 'inventory'); showAlertsDropdown = false"
                                class="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors group flex items-start gap-3"
                            >
                                <div class="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0 group-hover:bg-red-50 group-hover:text-red-500 transition-colors mt-0.5 text-muted-foreground border border-border group-hover:border-red-200">
                                    <i class="fa-solid fa-box-open text-xs"></i>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <p class="font-semibold text-xs text-foreground leading-tight truncate" data-no-i18n>{{ item.name }}</p>
                                    <p class="text-[10px] font-bold mt-1" :class="item.stock <= 0 ? 'text-red-600' : 'text-amber-600'">
                                        {{ item.stock <= 0 ? $t('Out of Stock') : $t('Only') + ' ' + item.stock + ' ' + $t('remaining') }}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div class="px-4 py-2 border-t border-border bg-card shrink-0 text-center">
                            <button
                                @click="$emit('navigate', 'inventory'); showAlertsDropdown = false"
                                class="w-full text-[10px] font-bold text-muted-foreground hover:text-foreground hover:underline transition-colors py-1 uppercase tracking-wider border-none bg-transparent cursor-pointer"
                                type="button"
                            >{{ $t('Manage Inventory') }}</button>
                        </div>
                    </div>
                </transition>
            </div>

            <!-- User menu -->
            <div class="admin-user-slot relative">
                <button
                    @click="showUserMenu = !showUserMenu"
                    type="button"
                    :aria-label="$t('Account')"
                    class="admin-user-trigger group"
                >
                    <div class="admin-user-copy hidden sm:block">
                        <div class="admin-user-name" data-no-i18n>{{ activeUser?.name || $t('Loading...') }}</div>
                        <div class="admin-user-role">{{ $t(userRole) }}</div>
                    </div>
                    <div class="admin-avatar">
                        {{ activeUser?.name ? activeUser.name.charAt(0).toUpperCase() : 'U' }}
                    </div>
                    <i class="fa-solid fa-chevron-down text-[9px] text-muted-foreground hidden sm:block"></i>
                </button>

                <div v-if="showUserMenu" @click="showUserMenu = false" class="fixed inset-0 z-[9990]"></div>

                <transition
                    enter-active-class="transition duration-200 ease-out"
                    enter-from-class="transform translate-y-1 opacity-0"
                    enter-to-class="transform translate-y-0 opacity-100"
                    leave-active-class="transition duration-100 ease-in"
                    leave-from-class="transform translate-y-0 opacity-100"
                    leave-to-class="transform translate-y-1 opacity-0"
                >
                    <div v-if="showUserMenu" class="header-dropdown absolute logical-inline-end top-full mt-0 w-60 bg-card shadow-lg border-x border-b border-border rounded-b-lg z-[9999] overflow-hidden text-foreground">
                        <div class="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
                            <div class="w-9 h-9 bg-teal-600 text-white border border-teal-700 rounded-md flex items-center justify-center text-sm font-bold uppercase shrink-0">
                                {{ activeUser?.name ? activeUser.name.charAt(0).toUpperCase() : 'U' }}
                            </div>
                            <div class="min-w-0 leading-none">
                                <div class="text-sm font-semibold text-foreground truncate" data-no-i18n>{{ activeUser?.name || $t('Loading...') }}</div>
                                <div class="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mt-1">{{ $t(userRole) }}</div>
                            </div>
                        </div>
                        <div class="p-1 flex flex-col gap-0.5 bg-card">
                            <button @click="showUserMenu = false; $emit('logout')" type="button" class="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-semibold text-red-600 hover:bg-red-50 active:scale-[0.98] transition-all w-full text-start border-none cursor-pointer">
                                <i class="fa-solid fa-power-off w-4 text-center"></i>
                                {{ $t('Logout') }}
                            </button>
                        </div>
                    </div>
                </transition>
            </div>
        </div>
    </header>
</template>

<script>
import { wallClockAtBusinessOffset } from '@/utils/businessDate.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { currentLanguage } from '@/shared/i18n.js';

export default {
    name: 'AdminHeader',
    props: {
        pageTitle: { type: String, default: '' },
        activeUser: { type: Object, default: null },
        userRole: { type: String, default: '' },
        isSocketConnected: { type: Boolean, default: false },
        printerStatuses: { type: Array, default: () => [] },
        allPrintersOnline: { type: Boolean, default: false },
        anyPrinterOnline: { type: Boolean, default: false },
        failedPrintJobsCount: { type: Number, default: 0 },
        stalePrintStations: { type: Array, default: () => [] },
        lowStockItems: { type: Array, default: () => [] },
        systemHealth: { type: Object, required: true }
    },
    emits: ['open-sidebar', 'navigate', 'logout'],
    setup() {
        const showSystemDropdown = ref(false);
        const showAlertsDropdown = ref(false);
        const showUserMenu = ref(false);

        // Live clock — a POS signature; locale-aware so it reads correctly in Arabic.
        const now = ref(new Date());
        let clockTimer = null;
        const businessClock = () => wallClockAtBusinessOffset(now.value);
        const clockTime = computed(() => {
            const loc = currentLanguage.value === 'ar' ? 'ar-u-nu-latn' : 'en-US';
            return new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(businessClock());
        });
        const clockDate = computed(() => {
            const loc = currentLanguage.value === 'ar' ? 'ar-u-nu-latn' : 'en-US';
            return new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(businessClock());
        });

        onMounted(() => {
            clockTimer = setInterval(() => { now.value = new Date(); }, 1000);
        });
        onUnmounted(() => {
            if (clockTimer) clearInterval(clockTimer);
        });

        return { showSystemDropdown, showAlertsDropdown, showUserMenu, clockTime, clockDate };
    }
};
</script>

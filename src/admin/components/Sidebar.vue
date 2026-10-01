<template>
    <aside :class="['sidebar fixed inset-y-0 left-0 z-50 lg:relative lg:translate-x-0', isOpen ? 'translate-x-0' : '-translate-x-full', isCollapsed ? 'collapsed' : '']">
        <div class="sidebar-header">
            <div class="workspace-info">
                <div class="workspace-logo-slot" data-no-i18n>PS</div>
                <span class="workspace-title">{{ $t('POS Admin') }}</span>
            </div>

            <button
                @click="toggleCollapse"
                :aria-label="$t('Collapse menu')"
                class="collapse-toggle-btn hidden lg:flex"
                type="button"
            >
                <SidebarIcon name="panel" />
            </button>

            <button @click.stop="emit('close')" :aria-label="$t('Close')" class="sidebar-close lg:hidden" type="button">
                <SidebarIcon name="close" />
            </button>
        </div>

        <nav class="sidebar-nav" :aria-label="$t('Menu')">
            <section v-for="group in navGroups" :key="group.key" class="nav-group">
                <div class="nav-group-label">{{ $t(group.label) }}</div>
                <div class="nav-group-list">
                    <template v-for="item in group.items" :key="item.page">
                        <button v-if="item.children" type="button" class="nav-link reports-disclosure"
                            :class="{ active: isActive(item) }" :aria-label="$t(item.label)"
                            :aria-expanded="reportsOpen" aria-controls="sidebar-reports" @click="toggleReports">
                            <span class="nav-icon"><SidebarIcon name="reports" /></span>
                            <span class="nav-label">{{ $t(item.label) }}</span>
                            <SidebarIcon name="chevron" class="reports-chevron" :class="{ expanded: reportsOpen }" />
                            <span class="nav-tooltip">{{ $t(item.label) }}</span>
                        </button>
                        <a v-else :href="`/admin/${item.page}`" @click="followLink($event, item.page)"
                            :aria-label="$t(item.label)" :aria-current="isActive(item) ? 'page' : undefined"
                            :class="['nav-link', { active: isActive(item) }]">
                            <span class="nav-icon">
                                <SidebarIcon :name="item.page" />
                                <span v-if="item.page === 'inventory' && lowStockCount > 0 || item.page === 'jofotara' && jofotaraCount > 0" class="nav-dot"></span>
                            </span>
                            <span class="nav-label">{{ $t(item.label) }}</span>
                            <span v-if="item.page === 'inventory' && lowStockCount > 0" class="nav-badge" data-no-i18n>{{ lowStockCount }}</span>
                            <span v-if="item.page === 'jofotara' && jofotaraCount > 0" class="nav-badge" data-no-i18n>{{ jofotaraCount }}</span>
                            <span class="nav-tooltip">{{ $t(item.label) }}</span>
                        </a>
                        <div v-if="item.children" v-show="reportsOpen" id="sidebar-reports" class="report-children">
                            <a v-for="child in item.children" :key="child.value" :href="`/admin/${child.value}`"
                                @click="followLink($event, child.value)" class="report-child"
                                :aria-current="currentPage === child.value ? 'page' : undefined">
                                <SidebarIcon :name="child.value" />
                                <span>{{ $t(child.label) }}</span>
                            </a>
                        </div>
                    </template>
                </div>
            </section>
        </nav>

        <div class="sidebar-footer">
            <a href="/pos" class="pos-btn">
                <span class="pos-btn-full">{{ $t('Launch POS') }}</span>
                <span class="pos-btn-short" data-no-i18n>POS</span>
            </a>
        </div>
    </aside>
</template>

<script setup>
import { fetchJson } from '@/shared/http.js';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { getSystemSettings } from '@/shared/systemSettings.js';

import SidebarIcon from './SidebarIcon.vue';
import { reportPages } from '../reportPages.js';

const props = defineProps({
    currentPage: { type: String, default: 'dashboard' },
    isOpen: { type: Boolean, default: false },
    userRole: { type: String, default: '' },
    lowStockCount: { type: Number, default: 0 }
});

const emit = defineEmits(['navigate', 'close', 'toggle-collapse']);
const tablesEnabled = ref(false);
const recipeLedgerEnabled = ref(false);
const jofotaraEnabled = ref(false);
const jofotaraCount = ref(0);
const isCollapsed = ref(window.innerWidth >= 1024 && localStorage.getItem('admin_sidebar_collapsed') === 'true');
const isAdmin = computed(() => props.userRole === 'admin' || props.userRole === 'programmer');

const navGroups = computed(() => {
    const admin = isAdmin.value;
    const groups = [
        {
            key: 'daily-work',
            label: 'Daily work',
            items: [
                { page: 'dashboard', label: 'Dashboard', show: admin },
                { page: 'orders', label: 'Order History', show: admin },
                { page: 'reports-summary', label: 'Reports', children: reportPages.filter(page => page.value !== 'reports-ingredients' || recipeLedgerEnabled.value), show: admin, match: (page) => Boolean(page?.startsWith('reports')) },
                { page: 'shifts', label: 'Shifts', show: admin }
            ]
        },
        {
            key: 'management',
            label: 'Management',
            items: [
                { page: 'customers', label: 'Customers', show: admin },
                { page: 'platform-remittances', label: 'Platform Payouts', show: admin },
                { page: 'jofotara', label: 'JoFotara Operations', show: admin },
                { page: 'print-templates', label: 'Print Templates', show: admin },
                { page: 'inventory', label: 'Inventory', show: admin },
                { page: 'ingredients', label: 'Ingredients', show: admin && recipeLedgerEnabled.value },
                { page: 'tablemap', label: 'Table Editor', show: admin && tablesEnabled.value },
                { page: 'users', label: 'User Security', show: admin },
                { page: 'settings', label: 'Settings', show: admin }
            ]
        }
    ];

    return groups
        .map((group) => ({ ...group, items: group.items.filter((item) => item.show) }))
        .filter((group) => group.items.length > 0);
});

const reportsOpen = ref(props.currentPage.startsWith('reports'));
watch(() => props.currentPage, (page) => {
    if (page.startsWith('reports')) reportsOpen.value = true;
});
const toggleReports = () => {
    if (isCollapsed.value) {
        toggleCollapse();
        reportsOpen.value = true;
    } else reportsOpen.value = !reportsOpen.value;
};
const followLink = (event, page) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault();
    goTo(page);
};

const isActive = (item) => item.match ? item.match(props.currentPage) : props.currentPage === item.page;

const goTo = (page) => {
    emit('navigate', page);
    emit('close');
};

const toggleCollapse = () => {
    isCollapsed.value = !isCollapsed.value;
    localStorage.setItem('admin_sidebar_collapsed', String(isCollapsed.value));
    emit('toggle-collapse', isCollapsed.value);
};

let sidebarAlive = true;
let badgeRead = null;
let badgeDirty = false;
let badgeScheduled = false;

function scheduleBadgeRead() {
    if (!sidebarAlive || !jofotaraEnabled.value || !badgeDirty || badgeRead || badgeScheduled) return;
    badgeScheduled = true;
    nextTick(() => {
        badgeScheduled = false;
        if (sidebarAlive && badgeDirty && !badgeRead) void loadJofotaraCount();
    });
}

function requestBadgeRefresh() {
    if (!jofotaraEnabled.value) return;
    badgeDirty = true;
    scheduleBadgeRead();
}

async function loadJofotaraCount() {
    if (!sidebarAlive || !jofotaraEnabled.value) return;
    badgeDirty = false;
    badgeRead = new AbortController();
    try {
        const data = await fetchJson('api/admin/jofotara/operations/count', { signal: badgeRead.signal });
        if (sidebarAlive && jofotaraEnabled.value) jofotaraCount.value = data.success ? Number(data.total || 0) : 0;
    } catch (_) {
        if (sidebarAlive && jofotaraEnabled.value) jofotaraCount.value = 0;
    } finally {
        badgeRead = null;
        scheduleBadgeRead();
    }
}

async function loadSettings(event) {
    try {
        const data = await getSystemSettings();
        if (sidebarAlive && data.success) {
            tablesEnabled.value = data.tables_enabled === '1';
            recipeLedgerEnabled.value = data.recipe_ledger_enabled === '1';
            const wasJofotaraEnabled = jofotaraEnabled.value;
            jofotaraEnabled.value = data.jofotara_enabled === '1';
            if (!jofotaraEnabled.value) {
                badgeDirty = false;
                badgeRead?.abort();
                jofotaraCount.value = 0;
            } else if (!wasJofotaraEnabled || event?.type === 'socket_reconnected') {
                requestBadgeRefresh();
            }
        }
    } catch (error) {
        console.error('Failed to load sidebar settings', error);
    }
}

onMounted(() => {
    emit('toggle-collapse', isCollapsed.value);
    window.addEventListener('settings_changed', loadSettings);
    window.addEventListener('socket_reconnected', loadSettings);
    void loadSettings();
    window.addEventListener('jofotara_operations_changed', requestBadgeRefresh);
});

onUnmounted(() => {
    sidebarAlive = false;
    badgeDirty = false;
    badgeRead?.abort();
    window.removeEventListener('jofotara_operations_changed', requestBadgeRefresh);
    window.removeEventListener('settings_changed', loadSettings);
    window.removeEventListener('socket_reconnected', loadSettings);
});
</script>

<style scoped>
.nav-link { min-height: 44px; height: auto; }
.nav-icon { width: 22px; height: 22px; flex: none; }
.nav-icon svg, .report-child > svg { display: block; }
/* Arabic glyphs sit above the line-box centre; align the visible icon to them. */
:global(html[dir="rtl"] .sidebar .nav-icon svg),
:global(html[dir="rtl"] .sidebar .report-child > svg) { position: relative; top: -2px; }
.reports-disclosure { width: 100%; text-align: start; }
.reports-chevron { width: 16px; height: 16px; margin-inline-start: auto; transform: rotate(-90deg); }
:global(html[dir="rtl"] .reports-chevron) { transform: rotate(90deg); }
.reports-chevron.expanded { transform: rotate(0deg); }
.report-children { margin: 3px 17px 8px 27px; padding-inline-start: 12px; border-inline-start: 1px solid #35414c; }
:global(html[dir="rtl"] .report-children) { margin: 3px 27px 8px 17px; }
.report-child { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 7px 10px; border-radius: 6px; color: #aeb9c3; font-size: .79rem; line-height: 1.5; }
.report-child svg { width: 18px; height: 18px; flex: none; opacity: .8; }
.report-child:hover { background: #1c252d; color: #fff; }
.report-child[aria-current="page"] { background: #22364a; color: #e4f0fc; font-weight: 650; }
.report-child[aria-current="page"] svg { color: #94c4f2; opacity: 1; }
.nav-link:focus-visible, .report-child:focus-visible { outline: 2px solid #94c4f2; outline-offset: -2px; }
@media (min-width: 1024px) {
    .sidebar.collapsed .report-children, .sidebar.collapsed .reports-chevron { display: none; }
    .sidebar.collapsed .nav-icon svg { top: 0; }
}
</style>

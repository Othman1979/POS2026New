<template>
    <teleport to="body">
        <div v-if="open" class="fixed inset-0 z-[120]">
            <!-- Backdrop: click to close -->
            <div class="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm animate-in fade-in duration-150" @click="$emit('close')"></div>

            <!-- Right-docked drawer (inline-end: right in LTR, left in RTL) -->
            <div
                class="orders-summary-drawer absolute top-0 bottom-0 logical-inline-end w-full max-w-xs bg-card border-s border-border shadow-2xl flex flex-col"
                :class="isRtl ? 'from-start' : 'from-end'"
                :dir="isRtl ? 'rtl' : 'ltr'"
            >
                <!-- Header -->
                <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
                    <h3 class="font-semibold text-sm text-foreground flex items-center gap-2">
                        <i class="fa-solid fa-chart-simple text-teal-500 text-xs"></i>
                        {{ $t('Summary') }}
                    </h3>
                    <button @click="$emit('close')" :aria-label="$t('Close')" class="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors focus:outline-none">
                        <i class="fa-solid fa-xmark text-sm"></i>
                    </button>
                </div>

                <!-- Body: revenue only, net of refunds -->
                <div class="flex-1 overflow-y-auto premium-scroll p-5 flex flex-col gap-5">
                    <!-- Total headline -->
                    <div class="flex flex-col gap-1">
                        <span class="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{{ $t('Total Revenue') }}</span>
                        <span class="font-display text-3xl font-bold text-foreground tabular-nums tracking-tight" data-no-i18n>{{ fmt(stats?.total_revenue) }} JD</span>
                    </div>

                    <!-- Breakdown -->
                    <div class="flex flex-col divide-y divide-border border border-border rounded-lg overflow-hidden">
                        <div class="flex items-center justify-between px-4 py-3">
                            <span class="inline-flex items-center gap-2 text-xs font-medium text-foreground"><span class="w-1.5 h-1.5 rounded-full bg-teal-500"></span>{{ $t('Cash') }}</span>
                            <span class="text-sm font-semibold text-foreground tabular-nums" data-no-i18n>{{ fmt(stats?.cash_revenue) }} JD</span>
                        </div>
                        <div class="flex items-center justify-between px-4 py-3">
                            <span class="inline-flex items-center gap-2 text-xs font-medium text-foreground"><span class="w-1.5 h-1.5 rounded-full bg-sky-500"></span>{{ $t('Card') }}</span>
                            <span class="text-sm font-semibold text-foreground tabular-nums" data-no-i18n>{{ fmt(stats?.card_revenue) }} JD</span>
                        </div>
                        <div class="flex items-center justify-between px-4 py-3">
                            <span class="inline-flex items-center gap-2 text-xs font-medium text-foreground"><span class="w-1.5 h-1.5 rounded-full bg-violet-500"></span>{{ $t('Platform') }}</span>
                            <span class="text-sm font-semibold text-foreground tabular-nums" data-no-i18n>{{ fmt(stats?.platform_revenue) }} JD</span>
                        </div>
                        <div class="flex items-center justify-between px-4 py-3">
                            <span class="inline-flex items-center gap-2 text-xs font-medium text-foreground"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>{{ $t('Split') }}</span>
                            <span class="text-sm font-semibold text-foreground tabular-nums" data-no-i18n>{{ fmt(stats?.split_revenue) }} JD</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </teleport>
</template>

<script>
import { computed } from 'vue';
import { currentLanguage } from '@/shared/i18n.js';

export default {
    name: 'OrdersSummaryPanel',
    props: {
        stats: { type: Object, default: () => ({}) },
        open: { type: Boolean, default: false }
    },
    emits: ['close'],
    setup() {
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const fmt = (v) => Number(v || 0).toFixed(2);
        return { isRtl, fmt };
    }
};
</script>

<style scoped>
/* Direction-aware slide-in. Drawer docks at inline-end (right in LTR, left in
   RTL), so the off-screen start differs by direction. translateX is physical,
   so the signs are explicit rather than logical. If animations are disabled the
   drawer still renders in place — this is polish, never a visibility gate. */
.orders-summary-drawer.from-end { animation: drawer-in-end 0.22s ease-out; }
.orders-summary-drawer.from-start { animation: drawer-in-start 0.22s ease-out; }
@keyframes drawer-in-end {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
}
@keyframes drawer-in-start {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
}
</style>

<template>
    <div>
        <!-- Backdrop for Drawer -->
        <div v-if="open" @click="$emit('update:open', false)" class="fixed inset-0 bg-slate-900/40 z-[150] transition-opacity animate-fade-in print:hidden"></div>

        <!-- Thermal receipt preview drawer -->
        <div :class="[
            'fixed inset-y-0 w-full max-w-[360px] sm:max-w-[400px] z-[160] shadow-2xl flex flex-col transition-transform duration-300 transform-gpu ease-out print:hidden',
            isRtl ? 'left-0 right-auto border-r border-[#e7e5e4] rounded-r-md' : 'right-0 left-auto border-l border-[#e7e5e4] rounded-l-md',
            open ? 'translate-x-0' : (isRtl ? '-translate-x-full' : 'translate-x-full')
        ]" class="bg-[#fafaf9] text-[#1c1917] font-mono select-none">
            
            <!-- Drawer Loader -->
            <div v-if="loading" class="absolute inset-0 bg-[#fafaf9]/90 z-20 flex flex-col items-center justify-center">
                <i class="fa-solid fa-circle-notch fa-spin text-3xl text-slate-800"></i>
                <p class="text-[10px] font-bold mt-2 text-slate-600 uppercase tracking-widest">{{ $t('Loading...') }}</p>
            </div>

            <!-- Header buttons -->
            <div class="flex justify-between items-center p-4 border-b border-[#e7e5e4] bg-[#f5f5f4] shrink-0 font-sans">
                <h3 class="font-display text-xs font-bold text-slate-800 tracking-tight flex items-center gap-1.5">
                    <i :class="['fa-solid', headerIcon]"></i> {{ $t(headerTitle) }}
                </h3>
                <button @click="$emit('update:open', false)" class="w-8 h-8 rounded border border-[#e7e5e4] hover:bg-[#e7e5e4] text-slate-600 flex items-center justify-center transition-colors cursor-pointer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Receipt Roll content wrapper -->
            <div class="flex-1 overflow-y-auto premium-scroll p-5 space-y-6 select-text">
                <!-- Physical Receipt Body Layout -->
                <div class="border border-[#e7e5e4] rounded p-5 bg-white relative shadow-sm border-dashed">
                    <!-- Ticket jagged top border -->
                    <div class="absolute -top-[5px] left-0 right-0 h-1 flex overflow-hidden justify-between pointer-events-none">
                        <div v-for="n in 30" :key="n" class="w-0.5 h-0.5 border-t-2 border-r-2 border-transparent border-t-[#e7e5e4] border-r-[#e7e5e4] rotate-45 transform origin-top-left"></div>
                    </div>

                    <!-- Store Brand Header -->
                    <div class="text-center space-y-1 pb-4 border-b border-dashed border-[#d6d3d1]">
                        <h2 class="font-display text-base font-bold tracking-wide" data-no-i18n>{{ store.store_name || 'POS' }}</h2>
                        <template v-if="subtitle">
                            <h3 class="font-display text-xs font-bold tracking-tight">{{ $t(subtitle) }}</h3>
                        </template>
                        <template v-else>
                            <p class="text-[10px] text-slate-500" data-no-i18n>{{ store.store_address }}</p>
                            <p class="text-[10px] text-slate-500" v-if="store.store_phone">TEL: <span data-no-i18n>{{ store.store_phone }}</span></p>
                        </template>
                    </div>

                    <slot name="body" />
                </div>
            </div>

            <!-- Footer actions -->
            <div class="p-4 border-t border-[#e7e5e4] bg-[#f5f5f4] shrink-0 flex gap-3 font-sans">
                <slot name="actions" />
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'ThermalDrawer',
    props: {
        open: { type: Boolean, required: true },
        isRtl: { type: Boolean, required: true },
        store: { type: Object, default: () => ({}) },
        loading: { type: Boolean, default: false },
        headerTitle: { type: String, required: true },
        headerIcon: { type: String, required: true },
        subtitle: { type: String, default: '' }
    },
    emits: ['update:open']
};
</script>

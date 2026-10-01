<template>
    <div>
        <!-- Custom Zinc Toast Notification Overlay -->
        <transition
            enter-active-class="transition duration-300 ease-out"
            enter-from-class="transform translate-y-4 opacity-0 scale-95"
            enter-to-class="transform translate-y-0 opacity-100 scale-100"
            leave-active-class="transition duration-200 ease-in"
            leave-from-class="transform translate-y-0 opacity-100 scale-100"
            leave-to-class="transform translate-y-4 opacity-0 scale-95"
        >
            <div v-if="customToast.show" class="fixed bottom-6 right-6 z-[10010] bg-card text-foreground px-4 py-3 rounded-sm shadow-md flex items-center gap-3 text-sm font-semibold border border-border max-w-sm">
                <div class="w-6 h-6 rounded-sm flex items-center justify-center shrink-0"
                     :class="customToast.type === 'success' ? 'bg-green-500/10 text-green-500' : (customToast.type === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')">
                    <i class="fa-solid text-xs" :class="customToast.type === 'success' ? 'fa-circle-check' : (customToast.type === 'error' ? 'fa-circle-xmark' : 'fa-circle-info')"></i>
                </div>
                <span data-no-i18n>{{ customToast.message }}</span>
            </div>
        </transition>

        <!-- Custom Zinc Alert Modal Overlay -->
        <div v-if="customAlert.show" class="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-4 animate-fade-in">
            <div class="bg-card border border-border rounded-sm shadow-lg w-full max-w-md overflow-hidden animate-scale-in">
                <div class="px-6 py-3 border-b border-border bg-muted flex items-center gap-3">
                    <i class="fa-solid fa-circle-info text-teal-600 text-base"></i>
                    <h3 class="font-bold text-xs uppercase tracking-wider text-foreground" data-no-i18n>{{ customAlert.title }}</h3>
                </div>
                <div class="p-6 text-sm text-muted-foreground leading-relaxed font-medium" data-no-i18n>
                    {{ customAlert.message }}
                </div>
                <div class="px-6 py-3.5 border-t border-border bg-muted flex justify-end">
                    <button @click="customAlert.show = false; customAlert.resolve && customAlert.resolve()" class="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-sm text-xs uppercase tracking-widest transition-colors shadow-sm h-9 flex items-center justify-center">
                        {{ $t('OK') }}
                    </button>
                </div>
            </div>
        </div>

        <!-- Custom Zinc Confirm Modal Overlay -->
        <div v-if="customConfirm.show" class="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-4 animate-fade-in">
            <div class="bg-card border border-border rounded-sm shadow-lg w-full max-w-md overflow-hidden animate-scale-in">
                <div class="px-6 py-3 border-b border-border bg-muted flex items-center gap-3">
                    <i class="fa-solid fa-triangle-exclamation text-amber-500 text-base"></i>
                    <h3 class="font-bold text-xs uppercase tracking-wider text-foreground" data-no-i18n>{{ customConfirm.title }}</h3>
                </div>
                <div class="p-6 text-sm text-muted-foreground leading-relaxed font-medium" data-no-i18n>
                    {{ customConfirm.message }}
                </div>
                <div class="px-6 py-3.5 border-t border-border bg-muted flex justify-end gap-3">
                    <button @click="customConfirm.show = false; customConfirm.resolve && customConfirm.resolve(false)" class="px-4 py-2 bg-card border border-border text-foreground hover:bg-muted font-bold rounded-sm text-xs uppercase tracking-widest shadow-sm transition-colors h-9 flex items-center justify-center">
                        {{ $t('Cancel') }}
                    </button>
                    <button @click="customConfirm.show = false; customConfirm.resolve && customConfirm.resolve(true)" class="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-sm text-xs uppercase tracking-widest shadow-sm transition-colors h-9 flex items-center justify-center">
                        {{ $t('Confirm') }}
                    </button>
                </div>
            </div>
        </div>

        <!-- Custom Zinc Prompt Modal Overlay -->
        <div v-if="customPrompt.show" class="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-4 animate-fade-in">
            <div class="bg-card border border-border rounded-sm shadow-lg w-full max-w-md overflow-hidden animate-scale-in">
                <div class="px-6 py-3 border-b border-border bg-muted flex items-center gap-3">
                    <i class="fa-solid fa-pen-to-square text-teal-600 text-base"></i>
                    <h3 class="font-bold text-xs uppercase tracking-wider text-foreground" data-no-i18n>{{ customPrompt.title }}</h3>
                </div>
                <div class="p-6 space-y-4">
                    <p class="text-sm text-muted-foreground leading-relaxed font-medium" data-no-i18n>{{ customPrompt.message }}</p>
                    <input type="text" v-model="customPrompt.value" :placeholder="customPrompt.placeholder" class="w-full bg-card border border-border rounded-sm py-2.5 px-3 text-xs font-mono font-semibold text-foreground focus:ring-1 focus:ring-teal-500 focus:border-teal-500 placeholder:text-muted-foreground outline-none shadow-sm h-10" @keyup.enter="customPrompt.show = false; customPrompt.resolve && customPrompt.resolve(customPrompt.value)">
                </div>
                <div class="px-6 py-3.5 border-t border-border bg-muted flex justify-end gap-3">
                    <button @click="customPrompt.show = false; customPrompt.resolve && customPrompt.resolve(null)" class="px-4 py-2 bg-card border border-border text-foreground hover:bg-muted font-bold rounded-sm text-xs uppercase tracking-widest shadow-sm transition-colors h-9 flex items-center justify-center">
                        {{ $t('Cancel') }}
                    </button>
                    <button @click="customPrompt.show = false; customPrompt.resolve && customPrompt.resolve(customPrompt.value)" class="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-sm text-xs uppercase tracking-widest shadow-sm transition-colors h-9 flex items-center justify-center">
                        {{ $t('Submit') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { customAlert, customConfirm, customPrompt, customToast } from '../composables/useAdminDialogs.js';

export default {
    name: 'AdminDialogs',
    setup() {
        return { customAlert, customConfirm, customPrompt, customToast };
    }
};
</script>

<template>
    <Teleport to="body">
    <div v-if="show" ref="dialog" role="dialog" aria-modal="true" :aria-label="title || undefined" tabindex="-1"
         class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 p-3"
         @click.self="$emit('close')">
        <div :class="widthClass" class="bg-card w-full rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[calc(100dvh-1.5rem)] border border-border">
            <div class="px-6 py-4 border-b border-zinc-200 flex justify-between items-center shrink-0">
                <slot name="header">
                    <h3 class="font-semibold text-foreground text-base">{{ title }}</h3>
                </slot>
                <button type="button" @click="$emit('close')" :aria-label="$t('Close')" class="w-11 h-11 flex items-center justify-center text-zinc-700 hover:bg-muted hover:text-foreground rounded-md focus-visible:outline-2 focus-visible:outline-primary">
                    <i class="fa-solid fa-xmark text-sm"></i>
                </button>
            </div>
            <slot />
        </div>
    </div>
    </Teleport>
</template>

<script>
import { ref, nextTick, watch, onBeforeUnmount } from 'vue';
import { customAlert, customConfirm, customPrompt } from '../composables/useAdminDialogs.js';

export default {
    name: 'ModalShell',
    props: {
        show: { type: Boolean, default: false },
        title: { type: String, default: '' },
        widthClass: { type: String, default: 'max-w-2xl' }
    },
    emits: ['close'],
    setup(props, { emit }) {
        const dialog = ref(null);
        let previousFocus;
        // Preserve Escape behavior even when focus is outside the modal panel.
        // immediate:true is REQUIRED — a modal mounted already-open (e.g. ImportModal is
        // v-if'd in and passes :show="true", so show never transitions) would otherwise
        // never attach the listener and Escape would silently stop working.
        const onEscKey = (e) => {
            // A nested confirmation owns its own keyboard interaction.
            if (customAlert.value.show || customConfirm.value.show || customPrompt.value.show) return;
            const dialogs = document.querySelectorAll('[role="dialog"]');
            if (dialogs[dialogs.length - 1] !== dialog.value) return;
            if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
            if (e.key !== 'Tab') return;
            const controls = [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter(el => el.getClientRects().length);
            const first = controls[0];
            const last = controls.at(-1);
            if (!first) { e.preventDefault(); dialog.value?.focus(); }
            else if (e.shiftKey && (document.activeElement === first || !dialog.value.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !dialog.value.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        };
        watch(() => props.show, (open) => {
            if (open) {
                previousFocus = document.activeElement;
                document.addEventListener('keydown', onEscKey);
                nextTick(() => {
                    if (!props.show) return;
                    const firstField = [...(dialog.value?.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || [])].find(el => el.getClientRects().length);
                    (firstField || dialog.value?.querySelector('button'))?.focus();
                });
            } else {
                document.removeEventListener('keydown', onEscKey);
                previousFocus?.isConnected && previousFocus.focus();
            }
        }, { immediate: true });
        onBeforeUnmount(() => document.removeEventListener('keydown', onEscKey));
        return { dialog };
    }
};
</script>

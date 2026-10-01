<template>
    <div ref="root" class="report-print-menu" @keydown.esc="onEscape">
        <button ref="trigger" type="button"
                class="report-print-menu__trigger"
                :class="variant"
                :disabled="disabled || busy"
                aria-haspopup="menu"
                :aria-expanded="open"
                @click="toggleMenu">
            <i :class="busy ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-print'" aria-hidden="true"></i>
            <span>{{ label }}</span>
            <i class="fa-solid fa-chevron-down report-print-menu__caret" aria-hidden="true"></i>
        </button>

        <div v-if="open" class="report-print-menu__list" role="menu">
            <button ref="firstItem" type="button" role="menuitem" @click="selectLayout('thermal')">
                <strong>{{ $t('Thermal (80mm)') }}</strong>
                <small>{{ $t('Compact receipt layout') }}</small>
            </button>
            <button type="button" role="menuitem" @click="selectLayout('a4')">
                <strong>{{ $t('Detailed A4') }}</strong>
                <small>{{ $t('Full-page detailed layout') }}</small>
            </button>
        </div>
    </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

defineProps({
    label: { type: String, required: true },
    disabled: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    variant: { type: String, default: '' },
});

const emit = defineEmits(['select']);
const root = ref(null);
const trigger = ref(null);
const firstItem = ref(null);
const open = ref(false);

function closeMenu(restoreFocus = true) {
    if (!open.value) return;
    open.value = false;
    if (restoreFocus) nextTick(() => trigger.value?.focus());
}

// Only swallow Escape while the dropdown is actually open. This menu sits inside
// the shift modal, whose Escape handler is a bubble-phase listener on document
// (ModalShell.vue:35-38). Stopping propagation unconditionally left the modal
// unclosable from the keyboard whenever focus rested on the Print button.
function onEscape(event) {
    if (!open.value) return;
    event.stopPropagation();
    event.preventDefault();
    closeMenu();
}

function toggleMenu() {
    open.value = !open.value;
    if (open.value) nextTick(() => firstItem.value?.focus());
}

function selectLayout(layout) {
    emit('select', layout);
    closeMenu();
}

function onOutsidePress(event) {
    if (open.value && !root.value?.contains(event.target)) closeMenu();
}

onMounted(() => document.addEventListener('pointerdown', onOutsidePress));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePress));
</script>

<style scoped>
.report-print-menu {
    position: relative;
    display: inline-block;
}

.report-print-menu__trigger {
    display: inline-flex;
    min-height: 2.35rem;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    padding: 0.55rem 0.9rem;
    color: #3f3f46;
    background: #fff;
    font-size: 0.75rem;
    font-weight: 700;
}

.report-print-menu__trigger.report-action-button--primary {
    border-color: #24405e;
    color: #fff;
    background: #24405e;
}

.report-print-menu__trigger.report-action-button--primary:hover:not(:disabled) {
    background: #1d3450;
}

.report-print-menu__trigger.admin-grid-button--primary {
    border-color: #24405e;
    color: #fff;
    background: #24405e;
}

.report-print-menu__trigger.admin-grid-button--soft {
    border-color: rgb(36 64 94 / 42%);
    color: #24405e;
    background: #dce4ee;
}

.report-print-menu__trigger.admin-grid-button--dark {
    border-color: #30363b;
    color: #fff;
    background: #30363b;
}

.report-print-menu__trigger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.report-print-menu__trigger:focus-visible,
.report-print-menu__list button:focus-visible {
    outline: 2px solid #3a5c85;
    outline-offset: 2px;
}

.report-print-menu__caret {
    margin-inline-start: 0.15rem;
    font-size: 0.62rem;
}

.report-print-menu__list {
    position: absolute;
    z-index: 40;
    inset-block-start: calc(100% + 0.35rem);
    inset-inline-end: 0;
    display: grid;
    min-width: 15rem;
    overflow: hidden;
    border: 1px solid #d4d4d8;
    border-radius: 9px;
    background: #fff;
    box-shadow: 0 12px 30px rgb(15 23 42 / 16%);
}

.report-print-menu__list button {
    display: grid;
    gap: 0.2rem;
    border: 0;
    padding: 0.75rem 0.85rem;
    color: #27272a;
    background: #fff;
    text-align: start;
}

.report-print-menu__list button + button {
    border-block-start: 1px solid #e4e4e7;
}

.report-print-menu__list button:hover,
.report-print-menu__list button:focus-visible {
    background: #f4f4f5;
}

.report-print-menu__list strong {
    font-size: 0.76rem;
    font-weight: 750;
}

.report-print-menu__list small {
    color: #71717a;
    font-size: 0.67rem;
}
</style>

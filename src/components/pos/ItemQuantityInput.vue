<template>
  <div class="item-quantity" role="group" :aria-label="label" dir="ltr" data-no-i18n>
    <button type="button" :disabled="disabled || !units" :aria-label="`${$t('Decrease quantity')}: ${label}`" @click="step(-1)">−</button>
    <input :value="modelValue" inputmode="decimal" :aria-label="label" :aria-invalid="!valid" :disabled="disabled" @input="$emit('update:modelValue', $event.target.value)" @keydown.up.prevent="step(1)" @keydown.down.prevent="step(-1)" />
    <button type="button" :disabled="disabled || units === limit" :aria-label="`${$t('Increase quantity')}: ${label}`" @click="step(1)">+</button>
    <button type="button" :disabled="disabled" @click="$emit('update:modelValue', quantityText(limit))">{{ $t('All') }}</button>
  </div>
</template>
<script setup>
import { computed } from 'vue';
import { quantityUnits, quantityText, validQuantity } from '@/utils/itemQuantity.js';
const props = defineProps({ modelValue: [String, Number], max: { type: [String, Number], required: true }, label: { type: String, required: true }, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const units = computed(() => quantityUnits(props.modelValue));
const limit = computed(() => quantityUnits(props.max));
const valid = computed(() => validQuantity(props.modelValue, props.max));
function step(direction) {
  if (!props.disabled) emit('update:modelValue', quantityText(Math.max(0, Math.min(limit.value, (units.value || 0) + direction * 1000000))));
}
</script>
<style scoped>
.item-quantity{display:flex;gap:.25rem;align-items:center}.item-quantity button,.item-quantity input{height:2.75rem;min-width:2.75rem;border:1px solid var(--color-outline-variant);border-radius:.4rem;background:var(--color-surface-container-lowest);color:var(--color-on-surface);text-align:center;font-size:.875rem}.item-quantity input{width:5.5rem;min-width:0;padding:0 .2rem;font-variant-numeric:tabular-nums}.item-quantity button{padding:0 .6rem;font-weight:700}.item-quantity button:hover:not(:disabled){background:var(--color-surface-container-high)}.item-quantity :disabled{opacity:.4}.item-quantity input[aria-invalid=true]{border-color:var(--color-error)}.item-quantity :focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
</style>

<template>
    <div :class="['border rounded-lg p-3', box === 'rose' ? 'bg-rose-50 border-rose-200' : 'bg-muted border-zinc-200']">
        <p :class="['text-[9px] font-bold uppercase tracking-wider mb-1', box === 'rose' ? 'text-rose-600' : 'text-muted-foreground']">{{ $t(label) }}</p>
        <p :class="['font-bold tabular-nums', valueSize === 'xl' ? 'text-xl' : 'text-lg', toneClass]" data-no-i18n><slot /></p>
        <p v-if="$slots.sub" class="text-[9px] text-muted-foreground font-medium mt-0.5"><slot name="sub" /></p>
    </div>
</template>

<script>
import { computed } from 'vue';
const TONES = { default: 'text-foreground', teal: 'text-teal-700', amber: 'text-amber-600', rose: 'text-rose-700', muted: 'text-muted-foreground' };
export default {
    name: 'StatCard',
    props: {
        label: { type: String, required: true },
        tone: { type: String, default: 'default' },
        box: { type: String, default: 'muted' },
        valueSize: { type: String, default: 'lg' }
    },
    setup(props) {
        return { toneClass: computed(() => TONES[props.tone] || TONES.default) };
    }
};
</script>

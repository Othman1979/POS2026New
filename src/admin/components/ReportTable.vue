<template>
    <div :class="wrapperClass">
        <table :class="['w-full text-xs whitespace-nowrap', align === 'left' ? 'text-left' : 'logical-text-start', minWidth]">
            <thead class="bg-zinc-200/80 sticky top-0 border-b border-zinc-300 z-10 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                <tr>
                    <th v-for="(col, i) in columns" :key="i"
                        :class="[headPadClass, col.align === 'center' ? 'text-center' : col.align === 'end' ? 'logical-text-end' : '', col.width]">
                        {{ col.label ? $t(col.label) : '' }}
                    </th>
                </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 bg-card text-foreground font-medium">
                <tr v-if="empty">
                    <td :colspan="columns.length" :class="['text-center text-muted-foreground', emptyPad === 'sm' ? 'py-12' : 'py-20']">
                        {{ $t(emptyText) }}
                    </td>
                </tr>
                <slot v-else name="body" />
            </tbody>
        </table>
    </div>
</template>

<script>
import { computed } from 'vue';

export default {
    name: 'ReportTable',
    props: {
        columns: { type: Array, required: true },
        empty: { type: Boolean, default: false },
        emptyText: { type: String, default: '' },
        emptyPad: { type: String, default: 'lg' },
        align: { type: String, default: 'start' },
        minWidth: { type: String, default: '' },
        wrapperClass: { type: String, default: 'overflow-x-auto premium-scroll flex-1' },
        headPad: { type: String, default: 'md' }
    },
    setup(props) {
        const headPadClass = computed(() => (props.headPad === 'lg' ? 'py-2.5 px-5' : 'py-3 px-4'));
        return { headPadClass };
    }
};
</script>

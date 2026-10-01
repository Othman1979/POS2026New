<script setup lang="ts">
import { attentionMessage } from '../../utils/dashboardPresentation'
import type {
  DashboardAttentionItem,
  DashboardDestination,
} from '../../pages/dashboard/dashboardTypes'

defineProps<{ items: DashboardAttentionItem[] }>()
const emit = defineEmits<{
  navigate: [destination: DashboardDestination]
}>()
</script>

<template>
  <section
    v-if="items.length"
    class="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 sm:p-5"
    :aria-label="$t('Needs attention')"
  >
    <h2 class="font-display text-base font-semibold text-foreground">
      {{ $t('Needs attention') }}
    </h2>
    <div class="mt-3 divide-y divide-amber-200/70">
      <button
        v-for="(item, index) in items"
        :key="`${item.type}-${index}`"
        type="button"
        class="flex min-h-11 w-full items-center justify-between gap-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        @click="emit('navigate', item.destination)"
      >
        <span class="text-sm font-medium text-zinc-800" data-no-i18n>
          {{ attentionMessage(item) }}
        </span>
        <i
          class="fa-solid fa-arrow-up-right-from-square shrink-0 text-xs text-zinc-500"
          aria-hidden="true"
        ></i>
      </button>
    </div>
  </section>
</template>

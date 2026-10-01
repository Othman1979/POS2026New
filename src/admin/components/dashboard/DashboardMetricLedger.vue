<script setup lang="ts">
import { computed } from 'vue'
import {
  formatReportMoney,
  formatReportNumber,
  formatReportPercent,
} from '../../utils/reportFormatting.js'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'

const props = defineProps<{
  headline: DashboardPayload['headline']
  comparison: DashboardPayload['comparison']
}>()
const emit = defineEmits<{ openExpenses: [] }>()

const metrics = computed(() => [
  {
    key: 'sales',
    label: 'Sales today',
    value: formatReportMoney(props.headline.sales_today),
    delta: props.comparison.delta?.sales_today.percent ?? null,
  },
  {
    key: 'orders',
    label: 'Orders',
    value: formatReportNumber(props.headline.orders),
    delta: props.comparison.delta?.orders.percent ?? null,
  },
  {
    key: 'average',
    label: 'Average check',
    value: formatReportMoney(props.headline.average_check),
    delta: props.comparison.delta?.average_check.percent ?? null,
  },
  {
    key: 'estimate',
    label: 'Estimated close',
    value: props.headline.estimated_close === null
      ? '—'
      : formatReportMoney(props.headline.estimated_close),
    delta: null,
  },
])

function deltaLabel(value: number | null) {
  if (value === null) return ''
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatReportPercent(value)}`
}
</script>

<template>
  <section
    class="overflow-hidden rounded-2xl border border-border bg-card"
    :aria-label="$t('Sales today')"
  >
    <div class="grid grid-cols-2 xl:grid-cols-4">
      <article
        v-for="(metric, index) in metrics"
        :key="metric.key"
        class="min-w-0 p-4 sm:p-5 xl:p-6"
        :class="[
          index % 2 ? 'border-s border-border' : '',
          index > 1 ? 'border-t border-border xl:border-t-0' : '',
          index ? 'xl:border-s xl:border-border' : '',
        ]"
      >
        <p class="text-xs font-medium text-muted-foreground">
          {{ $t(metric.label) }}
        </p>
        <p
          class="mt-2 truncate font-display text-2xl font-semibold tracking-tight text-foreground tabular-nums sm:text-3xl"
          data-no-i18n
        >
          {{ metric.value }}
        </p>
        <p
          v-if="metric.delta !== null"
          class="mt-2 text-xs font-semibold tabular-nums"
          :class="metric.delta > 0
            ? 'text-teal-700'
            : metric.delta < 0
              ? 'text-rose-700'
              : 'text-muted-foreground'"
          data-no-i18n
        >
          {{ deltaLabel(metric.delta) }}
        </p>
        <p
          v-else-if="metric.key === 'estimate'"
          class="mt-2 text-xs text-muted-foreground"
        >
          {{ $t('At this pace') }}
        </p>
      </article>
    </div>
    <button
      type="button"
      class="grid min-h-12 w-full grid-cols-2 border-t border-border bg-muted/35 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
      @click="emit('openExpenses')"
    >
      <span class="border-e border-border px-4 py-3 sm:px-5">
        <small class="block text-xs text-muted-foreground">{{ $t('Expenses today') }}</small>
        <strong class="mt-1 block text-sm tabular-nums text-rose-700" data-no-i18n>{{ formatReportMoney(headline.expenses_today) }}</strong>
      </span>
      <span class="px-4 py-3 sm:px-5">
        <small class="block text-xs text-muted-foreground">{{ $t('Remaining after expenses') }}</small>
        <strong class="mt-1 block text-sm tabular-nums text-teal-800" data-no-i18n>{{ formatReportMoney(headline.remaining_after_expenses) }}</strong>
      </span>
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  formatReportMoney,
  formatReportPercent,
} from '../../utils/reportFormatting.js'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'

const props = defineProps<{ payments: DashboardPayload['payments'] }>()
const cashShare = computed(() =>
  props.payments.find(item => item.method === 'cash')?.share || 0,
)
</script>

<template>
  <section
    class="rounded-2xl border border-border bg-card p-5"
    :aria-label="$t('Cash and card')"
  >
    <h2 class="font-display text-base font-semibold">{{ $t('Cash and card') }}</h2>
    <template v-if="payments.length">
      <div
        class="mt-5 flex h-2 overflow-hidden rounded-full bg-zinc-200"
        dir="ltr"
        aria-hidden="true"
      >
        <span class="bg-teal-700" :style="{ width: `${cashShare}%` }"></span>
        <span class="flex-1 bg-zinc-400"></span>
      </div>
      <dl class="mt-4 divide-y divide-border">
        <div
          v-for="payment in payments"
          :key="payment.method"
          class="flex items-center justify-between gap-4 py-3"
        >
          <dt class="capitalize">{{ $t(payment.method) }}</dt>
          <dd class="flex gap-3 tabular-nums" data-no-i18n>
            <strong>{{ formatReportMoney(payment.amount) }}</strong>
            <span class="text-muted-foreground">{{ formatReportPercent(payment.share) }}</span>
          </dd>
        </div>
      </dl>
    </template>
    <p v-else class="mt-6 text-sm text-muted-foreground">
      {{ $t('No payments yet.') }}
    </p>
  </section>
</template>

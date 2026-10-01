<script setup lang="ts">
import {
  formatReportMoney,
  formatReportNumber,
} from '../../utils/reportFormatting.js'
import { formatElapsedMinutes } from '../../utils/dashboardPresentation'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'

defineProps<{ tables: NonNullable<DashboardPayload['tables']> }>()
const emit = defineEmits<{ navigate: [] }>()
</script>

<template>
  <section
    class="rounded-2xl border border-border bg-card p-5"
    :aria-label="$t('Tables right now')"
  >
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-display text-base font-semibold">
        {{ $t('Tables right now') }}
      </h2>
      <button
        type="button"
        class="min-h-11 px-2 text-sm font-semibold text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        @click="emit('navigate')"
      >
        {{ $t('View tables') }}
      </button>
    </div>
    <dl class="mt-4 divide-y divide-border text-sm">
      <div class="flex justify-between gap-4 py-3">
        <dt class="text-muted-foreground">{{ $t('Occupied tables') }}</dt>
        <dd class="font-semibold tabular-nums" data-no-i18n>
          {{ formatReportNumber(tables.occupied_count) }}
        </dd>
      </div>
      <div class="flex justify-between gap-4 py-3">
        <dt class="text-muted-foreground">{{ $t('Open unpaid value') }}</dt>
        <dd class="font-semibold tabular-nums" data-no-i18n>
          {{ formatReportMoney(tables.open_unpaid_value) }}
        </dd>
      </div>
      <div v-if="tables.longest_open" class="flex justify-between gap-4 py-3">
        <dt class="text-muted-foreground">
          {{ $t('Longest open') }} · {{ $t('Table') }}
          <span data-no-i18n>{{ tables.longest_open.table_number }}</span>
        </dt>
        <dd class="font-semibold tabular-nums" data-no-i18n>
          {{ formatElapsedMinutes(tables.longest_open.elapsed_minutes) }}
        </dd>
      </div>
    </dl>
  </section>
</template>

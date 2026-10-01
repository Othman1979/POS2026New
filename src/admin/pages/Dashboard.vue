<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import DashboardAttention from '../components/dashboard/DashboardAttention.vue'
import DashboardMetricLedger from '../components/dashboard/DashboardMetricLedger.vue'
import DashboardPaceChart from '../components/dashboard/DashboardPaceChart.vue'
import DashboardPayments from '../components/dashboard/DashboardPayments.vue'
import DashboardProducts from '../components/dashboard/DashboardProducts.vue'
import DashboardTablesNow from '../components/dashboard/DashboardTablesNow.vue'
import { useDashboardData } from '../composables/useDashboardData'
import { buildDashboardNarrative } from '../utils/dashboardPresentation'
import {
  formatReportBusinessDate,
  formatReportBusinessTime,
} from '../utils/reportFormatting.js'
import type { DashboardDestination } from './dashboard/dashboardTypes'

defineOptions({ name: 'dashboard' })

const router = useRouter()
const {
  data,
  isLoading,
  isRefreshing,
  error,
  staleError,
  load,
} = useDashboardData()

const narrative = computed(() =>
  data.value ? buildDashboardNarrative(data.value) : '',
)

const destinationRoutes: Record<DashboardDestination, string> = {
  'reports-summary': 'reports-summary',
  'reports-sales': 'reports-sales',
  'reports-refunds': 'reports-refunds',
  'reports-expenses': 'reports-expenses',
  shifts: 'shifts',
  inventory: 'inventory',
  tablemap: 'tablemap',
}

function navigate(destination: DashboardDestination) {
  router.push({ name: destinationRoutes[destination] })
}
</script>

<template>
  <main
    class="min-w-0 space-y-5 pb-10 text-foreground"
    aria-live="polite"
  >
    <section
      v-if="isLoading && !data"
      class="space-y-5"
      :aria-label="$t('Loading dashboard')"
    >
      <div class="h-20 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"></div>
      <div class="grid grid-cols-2 overflow-hidden rounded-2xl border border-border xl:grid-cols-4">
        <div
          v-for="index in 4"
          :key="index"
          class="h-28 animate-pulse border-border bg-muted/70 motion-reduce:animate-none"
          :class="index > 1 ? 'border-t xl:border-t-0' : ''"
        ></div>
      </div>
      <div class="h-72 animate-pulse rounded-2xl bg-muted/70 motion-reduce:animate-none"></div>
    </section>

    <section
      v-else-if="error && !data"
      class="rounded-2xl border border-border bg-card p-8 text-center"
    >
      <h1 class="font-display text-xl font-semibold">
        {{ $t('Dashboard could not be loaded.') }}
      </h1>
      <p class="mt-2 text-sm text-muted-foreground" data-no-i18n>{{ error }}</p>
      <button
        type="button"
        class="mt-5 min-h-11 rounded-xl bg-teal-700 px-5 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2"
        @click="load()"
      >
        {{ $t('Try again') }}
      </button>
    </section>

    <template v-else-if="data">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="text-sm font-medium text-muted-foreground">
            <span class="tabular-nums" data-no-i18n>
              {{ formatReportBusinessDate(data.business_date) }}
            </span>
            · {{ $t('Current business day') }}
          </p>
          <h1
            class="mt-2 max-w-4xl font-display text-xl font-semibold leading-snug tracking-tight sm:text-2xl"
            data-no-i18n
          >
            {{ narrative }}
          </h1>
          <p class="mt-2 text-xs text-muted-foreground">
            {{ $t('Last updated') }}
            <span class="tabular-nums" data-no-i18n>
              {{ formatReportBusinessTime(data.refreshed_at) }}
            </span>
          </p>
        </div>
        <button
          type="button"
          class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:cursor-wait disabled:opacity-60"
          :disabled="isRefreshing"
          @click="load({ silent: true })"
        >
          <i
            class="fa-solid fa-rotate motion-reduce:animate-none"
            :class="isRefreshing ? 'fa-spin' : ''"
            aria-hidden="true"
          ></i>
          <span>{{ $t('Refresh dashboard') }}</span>
        </button>
      </header>

      <div
        v-if="staleError && data"
        class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        {{ $t('Showing last successful update.') }}
        <button
          type="button"
          class="ms-2 min-h-11 font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
          @click="load({ silent: true })"
        >
          {{ $t('Try again') }}
        </button>
      </div>

      <DashboardMetricLedger
        :headline="data.headline"
        :comparison="data.comparison"
        @open-expenses="navigate('reports-expenses')"
      />
      <DashboardAttention
        :items="data.attention"
        @navigate="navigate"
      />

      <div
        class="grid min-w-0 grid-cols-1 gap-5"
        :class="data.tables
          ? 'xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]'
          : ''"
      >
        <DashboardPaceChart
          class="min-w-0"
          :points="data.pace.points"
        />
        <DashboardTablesNow
          v-if="data.tables"
          :tables="data.tables"
          @navigate="navigate('tablemap')"
        />
      </div>

      <div class="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <DashboardProducts
          :products="data.products"
          @navigate="navigate('reports-sales')"
        />
        <DashboardPayments :payments="data.payments" />
      </div>
    </template>
  </main>
</template>

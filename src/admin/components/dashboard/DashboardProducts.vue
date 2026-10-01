<script setup lang="ts">
import {
  formatReportMoney,
  formatReportPercent,
} from '../../utils/reportFormatting.js'
import { formatProductUnits } from '../../utils/dashboardPresentation'
import type { DashboardProduct } from '../../pages/dashboard/dashboardTypes'

defineProps<{ products: DashboardProduct[] }>()
const emit = defineEmits<{ navigate: [] }>()
</script>

<template>
  <section
    class="rounded-2xl border border-border bg-card p-5"
    :aria-label="$t('What sold')"
  >
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-display text-base font-semibold">{{ $t('What sold') }}</h2>
      <button
        type="button"
        class="min-h-11 px-2 text-sm font-semibold text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        @click="emit('navigate')"
      >
        {{ $t('Sales Breakdown') }}
      </button>
    </div>
    <ol v-if="products.length" class="mt-3 divide-y divide-border">
      <li
        v-for="product in products"
        :key="`${product.product_id}-${product.name}`"
        class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3"
      >
        <div class="min-w-0">
          <p class="break-words text-sm font-medium" data-no-i18n>{{ product.name }}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            <span data-no-i18n>{{ formatProductUnits(product.net_units) }}</span>
          </p>
        </div>
        <div class="text-end">
          <p class="text-sm font-semibold tabular-nums" data-no-i18n>
            {{ formatReportMoney(product.net_sales) }}
          </p>
          <p
            v-if="product.delta_percent !== null"
            class="mt-1 text-xs tabular-nums text-muted-foreground"
            data-no-i18n
          >
            {{ product.delta_percent > 0 ? '+' : '' }}{{ formatReportPercent(product.delta_percent) }}
          </p>
        </div>
      </li>
    </ol>
    <p v-else class="mt-6 text-sm text-muted-foreground">
      {{ $t('No products sold yet.') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { Chart } from 'chart.js'
import { currentLanguage, t } from '@/shared/i18n.js'
import {
  formatReportMoney,
  formatReportNumber,
} from '../../utils/reportFormatting.js'
import { getBusinessDayStartHour } from '../../../utils/businessDate.js'
import type { PacePoint } from '../../pages/dashboard/dashboardTypes'

let chartModule: Promise<typeof import('./paceChartJs')> | null = null
function loadChart() {
  chartModule ??= import('./paceChartJs').catch(error => {
    chartModule = null
    throw error
  })
  return chartModule
}

const props = defineProps<{ points: PacePoint[] }>()
const canvas = shallowRef<HTMLCanvasElement | null>(null)
let chart: Chart | null = null
let renderGen = 0

function timeLabel(elapsedMinute: number) {
  const absolute = (getBusinessDayStartHour() * 60 + elapsedMinute) % 1440
  const hours24 = Math.floor(absolute / 60)
  const minutes = absolute % 60
  const hours12 = hours24 % 12 || 12
  return `${formatReportNumber(hours12, { minimumIntegerDigits: 2 })}:${formatReportNumber(minutes, { minimumIntegerDigits: 2 })} ${t(hours24 >= 12 ? 'PM' : 'AM')}`
}

async function render() {
  const gen = ++renderGen
  await nextTick()
  chart?.destroy()
  chart = null
  if (!canvas.value || !props.points.length) return
  let ChartCtor: typeof Chart
  try {
    ChartCtor = (await loadChart()).Chart
  } catch {
    return // the next data refresh retries the import
  }
  if (gen !== renderGen || !canvas.value) return

  const fontFamily = currentLanguage.value === 'ar'
    ? 'IBM Plex Sans Arabic'
    : 'Sitka Heading'
  chart = new ChartCtor(canvas.value, {
    type: 'line',
    data: {
      labels: props.points.map(point => timeLabel(point.elapsed_minute)),
      datasets: [
        {
          label: t('Today'),
          data: props.points.map(point => point.today),
          borderColor: '#24405e',
          borderWidth: 2.5,
          pointRadius: 2,
          tension: 0.22,
        },
        {
          label: t('Typical day'),
          data: props.points.map(point => point.typical),
          borderColor: '#a1a1aa',
          borderDash: [6, 5],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.22,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false
        : { duration: 180 },
      locale: currentLanguage.value === 'ar'
        ? 'ar-JO-u-nu-latn'
        : 'en-JO-u-nu-latn',
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            usePointStyle: true,
            boxWidth: 8,
            font: { family: fontFamily },
          },
        },
        tooltip: {
          callbacks: {
            label: context => `${context.dataset.label}: ${formatReportMoney(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            font: { family: fontFamily },
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(113,113,122,.12)' },
          ticks: { callback: value => formatReportNumber(value) },
        },
      },
    },
  })
}

watch([() => props.points, currentLanguage], render, {
  deep: true,
  immediate: true,
})
onBeforeUnmount(() => {
  renderGen++
  chart?.destroy()
  chart = null
})
</script>

<template>
  <section
    class="rounded-2xl border border-border bg-card p-4 sm:p-5"
    :aria-label="$t('Sales today')"
  >
    <div>
      <h2 class="font-display text-base font-semibold">{{ $t('Sales today') }}</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('Today compared with a typical matching weekday') }}
      </p>
    </div>
    <div class="mt-5 h-64 w-full sm:h-72" dir="ltr">
      <canvas ref="canvas"></canvas>
    </div>
  </section>
</template>

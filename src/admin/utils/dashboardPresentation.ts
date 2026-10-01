import { t } from '@/shared/i18n.js'
import {
  formatReportMoney,
  formatReportNumber,
  formatReportWeekday,
} from './reportFormatting.js'
import type {
  DashboardAttentionItem,
  DashboardPayload,
} from '../pages/dashboard/dashboardTypes'

type Translate = (value: string) => string

function fill(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

export function buildDashboardNarrative(
  payload: DashboardPayload,
  translate: Translate = t,
) {
  if (payload.headline.orders === 0 && payload.headline.sales_today === 0) {
    return translate('No sales yet today.')
  }
  if (!payload.history.comparison_ready || !payload.comparison.delta) {
    return translate('Not enough matching days for a useful comparison yet.')
  }

  const weekday = formatReportWeekday(payload.business_date)
  const percent = formatReportNumber(
    Math.abs(payload.comparison.delta.sales_today.percent || 0),
    { maximumFractionDigits: 0 },
  )
  const introKey = payload.comparison.pace_state === 'ahead'
    ? 'Sales are {percent}% ahead of a typical {weekday}.'
    : payload.comparison.pace_state === 'behind'
      ? 'Sales are {percent}% behind a typical {weekday}.'
      : 'Sales are close to a typical {weekday}.'
  const intro = fill(translate(introKey), { percent, weekday })
  const causeKeys = {
    ahead: {
      orders: 'More orders caused most of the increase.',
      average_check: 'Higher average checks caused most of the increase.',
      both: 'Order count and average check both contributed.',
      none: '',
    },
    behind: {
      orders: 'Fewer orders caused most of the difference.',
      average_check: 'Lower average checks caused most of the difference.',
      both: 'Order count and average check both contributed.',
      none: '',
    },
    typical: { orders: '', average_check: '', both: '', none: '' },
    unavailable: { orders: '', average_check: '', both: '', none: '' },
  } as const
  const cause = causeKeys[payload.comparison.pace_state][payload.comparison.driver]
  return cause ? `${intro} ${translate(cause)}` : intro
}

export function attentionMessage(
  item: Pick<DashboardAttentionItem, 'message_key' | 'params'>,
  translate: Translate = t,
) {
  const templates: Record<string, string> = {
    refund_rate: 'Refunds are higher than usual: {amount}.',
    void_rate: 'Voids are higher than usual: {amount}.',
    discount_rate: 'Discounts are higher than usual: {amount}.',
    register_variance: 'One closed register is {amount} {direction}.',
    low_stock: '{count} products are low in stock.',
  }
  const direction = item.params.direction === 'short'
    ? translate('short')
    : translate('over')
  return fill(translate(templates[item.message_key] || item.message_key), {
    ...item.params,
    amount: item.params.amount === undefined ? '' : formatReportMoney(item.params.amount),
    direction,
  })
}

export function formatElapsedMinutes(value: number, translate: Translate = t) {
  const minutes = Math.max(0, Math.floor(Number(value) || 0))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${formatReportNumber(rest)} ${translate('min')}`
  if (rest === 0) return `${formatReportNumber(hours)} ${translate('hr')}`
  return `${formatReportNumber(hours)} ${translate('hr')} ${formatReportNumber(rest)} ${translate('min')}`
}

export function formatProductUnits(value: number, translate: Translate = t) {
  const label = Number(value) === 1 ? translate('Unit') : translate('Units')
  return `${formatReportNumber(value)} ${label}`
}

export type PaceState = 'ahead' | 'behind' | 'typical' | 'unavailable'
export type DashboardDriver = 'orders' | 'average_check' | 'both' | 'none'
export type DashboardDestination =
  | 'reports-summary'
  | 'reports-sales'
  | 'reports-refunds'
  | 'reports-expenses'
  | 'shifts'
  | 'inventory'
  | 'tablemap'

export interface DashboardDelta {
  amount: number
  percent: number | null
}

export interface PacePoint {
  elapsed_minute: number
  today: number
  typical: number | null
}

export interface DashboardAttentionItem {
  type: 'refund' | 'void' | 'discount' | 'register' | 'stock'
  severity: 'warning' | 'danger'
  message_key: string
  params: Record<string, string | number>
  destination: DashboardDestination
}

export interface DashboardProduct {
  product_id: number | null
  name: string
  net_sales: number
  net_units: number
  delta_percent: number | null
}

export interface DashboardPayload {
  success: boolean
  business_date: string
  as_of: string
  refreshed_at: string
  history: { eligible_days: number; comparison_ready: boolean }
  headline: {
    sales_today: number
    orders: number
    average_check: number
    estimated_close: number | null
    expenses_today: number
    remaining_after_expenses: number
  }
  comparison: {
    typical: null | { sales_today: number; orders: number; average_check: number }
    delta: null | {
      sales_today: DashboardDelta
      orders: DashboardDelta
      average_check: DashboardDelta
    }
    pace_state: PaceState
    driver: DashboardDriver
  }
  pace: { points: PacePoint[] }
  tables: null | {
    occupied_count: number
    open_unpaid_value: number
    longest_open: null | {
      invoice_id: number
      table_number: string
      opened_at: string
      elapsed_minutes: number
    }
  }
  attention: DashboardAttentionItem[]
  products: DashboardProduct[]
  payments: Array<{ method: 'cash' | 'card'; amount: number; share: number }>
}

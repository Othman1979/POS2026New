import {
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
} from 'vue'
import type { DashboardPayload } from '../pages/dashboard/dashboardTypes'

const DASHBOARD_REALTIME_TYPES = new Set([
  'new_order',
  'inventory_changed',
  'shifts_changed',
  'table_update',
  'expenses_changed',
  'socket_reconnected',
])

const DASHBOARD_SETTING_KEYS = new Set([
  'tables_enabled',
  'stock_enabled',
  'low_stock_threshold',
])

interface DashboardVisibilityTarget extends EventTarget {
  readonly visibilityState?: DocumentVisibilityState
}

interface DashboardControllerDependencies {
  fetchImpl?: typeof fetch
  eventTarget?: EventTarget
  documentRef?: DashboardVisibilityTarget
  refreshMs?: number
  signalMinMs?: number
  realtimeDelayMs?: number
}

export function createDashboardDataController({
  fetchImpl = window.fetch.bind(window),
  eventTarget = window,
  documentRef = document,
  refreshMs = 5 * 60 * 1000,
  signalMinMs = 60 * 1000,
  realtimeDelayMs = 400,
}: DashboardControllerDependencies = {}) {
  const data = shallowRef<DashboardPayload | null>(null)
  const isLoading = ref(false)
  const isRefreshing = ref(false)
  const error = ref<string | null>(null)
  const staleError = ref<string | null>(null)
  let requestSequence = 0
  let abortController: AbortController | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let realtimeTimer: ReturnType<typeof setTimeout> | null = null
  let active = false
  let requestInFlight = false
  let refreshAfterLoad = false
  let lastReadStartedAt = Number.NEGATIVE_INFINITY

  function isVisible() {
    return documentRef.visibilityState !== 'hidden'
  }

  function clearReconciliationTimer() {
    if (realtimeTimer !== null) clearTimeout(realtimeTimer)
    realtimeTimer = null
  }

  function clearFallbackTimer() {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function scheduleFallback(delay = refreshMs) {
    clearFallbackTimer()
    if (!active || !isVisible()) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      requestReconciliation({ immediate: true })
    }, delay)
  }

  function requestReconciliation({ immediate = false } = {}) {
    if (!active || !isVisible()) return
    clearFallbackTimer()
    if (requestInFlight) {
      refreshAfterLoad = true
      return
    }
    if (realtimeTimer !== null) return
    if (immediate) {
      void load({ silent: true })
      return
    }
    const sinceLastStart = performance.now() - lastReadStartedAt
    const delay = Math.max(realtimeDelayMs, signalMinMs - sinceLastStart, 0)
    realtimeTimer = setTimeout(() => {
      realtimeTimer = null
      if (requestInFlight) refreshAfterLoad = true
      else void load({ silent: true })
    }, delay)
  }

  async function load({ silent = false } = {}) {
    clearReconciliationTimer()
    clearFallbackTimer()
    refreshAfterLoad = false
    const sequence = ++requestSequence
    abortController?.abort()
    abortController = new AbortController()
    lastReadStartedAt = performance.now()
    requestInFlight = true
    let requestSucceeded = false
    if (silent && data.value) isRefreshing.value = true
    else isLoading.value = true
    if (!silent) error.value = null

    try {
      const response = await fetchImpl('api/admin/dashboard', {
        signal: abortController.signal,
      })
      const json = await response.json()
      if (!response.ok || !json.success) {
        throw new Error(json.message || 'Dashboard could not be loaded.')
      }
      if (sequence !== requestSequence) return
      data.value = json
      error.value = null
      staleError.value = null
      requestSucceeded = true
    } catch (caught) {
      if ((caught instanceof Error && caught.name === 'AbortError') || sequence !== requestSequence) {
        return
      }
      const message = caught instanceof Error
        ? caught.message
        : 'Dashboard could not be loaded.'
      if (data.value) staleError.value = message
      else error.value = message
    } finally {
      if (sequence === requestSequence) {
        requestInFlight = false
        isLoading.value = false
        isRefreshing.value = false
        if (active && isVisible() && refreshAfterLoad) {
          refreshAfterLoad = false
          requestReconciliation()
        } else {
          scheduleFallback(requestSucceeded ? refreshMs : signalMinMs)
        }
      }
    }
  }

  function handleRealtime(event: Event) {
    if (!active) return
    const detail = (event as CustomEvent).detail
    if (detail?.type === 'settings_changed') {
      const keys = detail?.payload?.keys
      const validKeys = Array.isArray(keys)
        && keys.length > 0
        && keys.every((key: unknown) => typeof key === 'string')
      if (!validKeys
        || keys.some((key: string) => DASHBOARD_SETTING_KEYS.has(key))) {
        requestReconciliation()
      }
      return
    }
    if (DASHBOARD_REALTIME_TYPES.has(detail?.type)) requestReconciliation()
  }

  const handleFocus = () => requestReconciliation()
  function handleVisibilityChange() {
    if (!active) return
    if (!isVisible()) {
      clearReconciliationTimer()
      clearFallbackTimer()
      refreshAfterLoad = false
      return
    }
    requestReconciliation()
  }

  function activate({ reconcile = false } = {}) {
    if (active) {
      if (reconcile) requestReconciliation()
      return
    }
    active = true
    eventTarget.addEventListener('admin:realtime', handleRealtime)
    eventTarget.addEventListener('focus', handleFocus)
    documentRef.addEventListener('visibilitychange', handleVisibilityChange)
    if (reconcile) requestReconciliation()
    else if (!requestInFlight) scheduleFallback()
  }

  function deactivate() {
    active = false
    eventTarget.removeEventListener('admin:realtime', handleRealtime)
    eventTarget.removeEventListener('focus', handleFocus)
    documentRef.removeEventListener('visibilitychange', handleVisibilityChange)
    clearReconciliationTimer()
    clearFallbackTimer()
    refreshAfterLoad = false
    abortController?.abort()
  }

  function destroy() {
    deactivate()
    requestSequence += 1
  }

  return {
    data,
    isLoading,
    isRefreshing,
    error,
    staleError,
    load,
    activate,
    deactivate,
    destroy,
    handleRealtime,
  }
}

export function useDashboardData() {
  const controller = createDashboardDataController()
  let firstActivation = true

  onMounted(() => {
    controller.activate()
    void controller.load()
  })
  onActivated(() => {
    if (!firstActivation) controller.activate({ reconcile: true })
    firstActivation = false
  })
  onDeactivated(controller.deactivate)
  onUnmounted(controller.destroy)

  return controller
}

// Warms lazy chunks after the first paint so the next screen or dialog opens
// from cache. Failures are ignored: the real open imports again and has its own
// recovery (lazyPosComponent retry, router.onError).
export function scheduleIdlePreload(preload) {
  const idle = typeof window.requestIdleCallback === 'function';
  let handle = null;
  const run = () => {
    handle = null;
    void Promise.allSettled(preload());
  };
  handle = idle ? window.requestIdleCallback(run, { timeout: 2_000 }) : window.setTimeout(run, 1_500);
  return () => {
    if (handle === null) return;
    if (idle) window.cancelIdleCallback?.(handle);
    else window.clearTimeout(handle);
    handle = null;
  };
}

// Calls the route's own lazy loader (router.js), so the route and the preload
// share one chunk; the router caches only a successful load.
export function preloadRoute(router, path) {
  const load = router.resolve?.(path)?.matched?.[0]?.components?.default;
  return typeof load === 'function' ? load() : undefined;
}

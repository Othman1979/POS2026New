import { afterEach, expect, it, vi } from 'vitest';
import { preloadRoute, scheduleIdlePreload } from './idlePreload.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('preloads at idle, swallows a failed chunk and can be cancelled', async () => {
  let idle;
  vi.stubGlobal('window', { requestIdleCallback: vi.fn(fn => { idle = fn; return 7; }), cancelIdleCallback: vi.fn() });
  const load = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
  scheduleIdlePreload(() => [load()]);
  expect(load).not.toHaveBeenCalled();
  idle();
  expect(load).toHaveBeenCalledOnce();
  await Promise.resolve();
  scheduleIdlePreload(() => [load()])();
  expect(window.cancelIdleCallback).toHaveBeenCalledWith(7);
});

it('falls back to a short timer where idle callbacks are missing', () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const load = vi.fn();
  scheduleIdlePreload(() => [load()]);
  vi.advanceTimersByTime(1500);
  expect(load).toHaveBeenCalledOnce();
});

it('warms a lazy route through the router loader without caching a failure', () => {
  const loader = vi.fn(() => Promise.resolve({}));
  const router = { resolve: () => ({ matched: [{ components: { default: loader } }] }) };
  preloadRoute(router, '/pos');
  preloadRoute(router, '/pos');
  expect(loader).toHaveBeenCalledTimes(2);
  expect(preloadRoute({ resolve: () => ({ matched: [] }) }, '/nowhere')).toBeUndefined();
});

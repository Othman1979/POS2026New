import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogRefreshScheduler, STOCK_REFRESH_WINDOW_MS } from './catalogRefreshScheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('catalogRefreshScheduler', () => {
  it('coalesces a burst into bounded runs and reconciles after the last request', async () => {
    vi.useFakeTimers();
    const starts = [];
    const run = vi.fn(() => new Promise(resolve => {
      starts.push(Date.now());
      setTimeout(resolve, 100);
    }));
    const scheduler = createCatalogRefreshScheduler(run);

    scheduler.request(); // t=0
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(150); // t=150,300,450,600
      scheduler.request();
    }
    await vi.advanceTimersByTimeAsync(2000);

    expect(run).toHaveBeenCalledTimes(3);
    expect(starts[2]).toBeGreaterThan(600); // final run follows the last request
  });

  it('runs once for simultaneous requests', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCatalogRefreshScheduler(run);

    for (let i = 0; i < 5; i++) scheduler.request();
    await vi.advanceTimersByTimeAsync(STOCK_REFRESH_WINDOW_MS * 4);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs once per request when they are spaced beyond the window', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCatalogRefreshScheduler(run);

    for (let i = 0; i < 5; i++) {
      scheduler.request();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(run).toHaveBeenCalledTimes(5);
  });

  it('schedules exactly one trailing run for events during a read', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise(resolve => setTimeout(resolve, 400)));
    const scheduler = createCatalogRefreshScheduler(run);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(STOCK_REFRESH_WINDOW_MS); // run 1 starts, resolves at +400
    scheduler.request();
    scheduler.request();
    scheduler.request();
    await vi.advanceTimersByTimeAsync(2000);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel() during waiting prevents the run', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCatalogRefreshScheduler(run);

    scheduler.request();
    expect(scheduler.pending()).toBe(true);
    scheduler.cancel();
    expect(scheduler.pending()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(run).not.toHaveBeenCalled();
  });

  it('ignores a cancelled in-flight run when it settles', async () => {
    vi.useFakeTimers();
    let resolveFirst;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    const scheduler = createCatalogRefreshScheduler(run);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(STOCK_REFRESH_WINDOW_MS); // run 1 starts, stays pending
    scheduler.cancel();

    scheduler.request();
    resolveFirst(); // stale settle must not consume the new cycle
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.pending()).toBe(false);
  });

  it('a rejected run does not break subsequent requests', async () => {
    vi.useFakeTimers();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const scheduler = createCatalogRefreshScheduler(run);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(false);

    scheduler.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

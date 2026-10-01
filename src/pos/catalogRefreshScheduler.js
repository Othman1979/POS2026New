export const STOCK_REFRESH_WINDOW_MS = 250;

// Coalesces a burst of stock events into at most one catalog read per window,
// and guarantees a final authoritative read after the last event seen while a
// read is in flight. Pure module: timers are injectable for tests.
export function createCatalogRefreshScheduler(run, { windowMs = STOCK_REFRESH_WINDOW_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let state = 'idle'; // idle | waiting (timer armed) | running (read in flight)
    let trailing = false;
    let timer = null;
    let cycle = 0;

    const finish = (current) => {
        if (current !== cycle) return;
        if (trailing) {
            trailing = false;
            state = 'waiting';
            timer = setTimer(tick, windowMs);
        } else {
            state = 'idle';
            timer = null;
        }
    };

    const tick = () => {
        timer = null;
        state = 'running';
        const current = ++cycle;
        Promise.resolve().then(run).catch(() => {}).then(() => finish(current));
    };

    const request = () => {
        if (state === 'running') {
            trailing = true;
            return;
        }
        if (state === 'waiting') return;
        state = 'waiting';
        timer = setTimer(tick, windowMs);
    };

    const cancel = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        trailing = false;
        state = 'idle';
        cycle += 1;
    };

    const pending = () => state !== 'idle';

    return { request, cancel, pending };
}

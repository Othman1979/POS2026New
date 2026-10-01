import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ref } from 'vue';
import { lazyPosComponent } from './lazyPosComponent.js';

const renderer = createRenderer({
  createElement: tag => ({ tag }), createText: text => ({ text }),
  createComment: text => ({ text }), insert() {}, remove() {},
  setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
});
const flush = async () => { for (let i = 0; i < 15; i++) await nextTick(); };
let app;
afterEach(() => { app?.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function mount(loader) {
  const open = ref(true);
  const unavailable = vi.fn(() => { open.value = false; });
  const errors = [];
  const component = lazyPosComponent(loader, unavailable);
  app = renderer.createApp({ setup: () => () => open.value ? h(component) : null });
  app.config.errorHandler = error => errors.push(error);
  app.mount({});
  return { open, unavailable, errors };
}

describe('lazy POS workflow recovery', () => {
  it('closes a stalled workflow at its deadline and allows a fresh open', async () => {
    vi.useFakeTimers();
    let finish;
    const mounted = vi.fn();
    const ready = { setup() { mounted(); return () => h('div'); } };
    const loader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(ready);
    const state = mount(loader);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(state.open.value).toBe(false);
    expect(state.unavailable).toHaveBeenCalledTimes(1);
    expect(state.errors[0].message).toContain('timed out');
    state.open.value = true;
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(mounted).toHaveBeenCalledTimes(1);
    finish(ready);
    await flush();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(state.open.value).toBe(true);
  });

  it('bounds online retries and closes after rejection', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const loader = vi.fn().mockRejectedValue(new Error('chunk unavailable'));
    const state = mount(loader);
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(state.unavailable).toHaveBeenCalledTimes(1);
    expect(state.open.value).toBe(false);
  });

  it('does not close a healthy dialog when its old deadline arrives', async () => {
    vi.useFakeTimers();
    const state = mount(() => Promise.resolve({ render: () => h('div') }));
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.unavailable).not.toHaveBeenCalled();
    expect(state.open.value).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

const socket = vi.hoisted(() => ({ count: null }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ failedPrintJobsCount: socket.count }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: ref({ role: 'cashier' }) }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
import FailedPrintsBell from '../FailedPrintsBell.vue';

const reply = data => ({ ok: true, status: 200, json: async () => ({ success: true, ...data }) });
const job = (id, reprintable = true) => ({ id, reprintable, print_type: 'receipt' });
let scope;
const mount = () => scope.run(() => FailedPrintsBell.setup({ isDarkMode: false }, { expose: () => {} }));
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  scope = effectScope();
  socket.count = ref(2);
  vi.stubGlobal('window', { showPosConfirm: vi.fn(async () => true) });
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('failed prints bell', () => {
  // App.vue replaces window.confirm with a warning that returns false, so the
  // bell must ask through the POS dialog or an uncertain reprint silently cancels.
  it('asks through the POS dialog before reprinting an uncertain ticket', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ jobs: [] })));
    const reprints = () => fetch.mock.calls.filter(([url]) => String(url).includes('reprint')).length;
    const bell = mount();
    const uncertain = { ...job(1), last_failure_class: 'uncertain' };
    window.showPosConfirm.mockResolvedValueOnce(false);
    await bell.reprint(uncertain);
    expect(reprints()).toBe(0);
    await bell.reprint(uncertain);
    expect(window.showPosConfirm).toHaveBeenCalledTimes(2);
    expect(reprints()).toBe(1);
  });

  it('re-reads the open list when the live count changes', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply({ jobs: [job(1, false), job(2)] }))
      .mockResolvedValueOnce(reply({ jobs: [job(1), job(2), job(3)] })));
    const bell = mount();
    bell.open(); await settle();
    socket.count.value = 3; await nextTick(); await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bell.jobs.value.map(row => row.id)).toEqual([1, 2, 3]);
  });

  it('does not re-read while a reprint is in flight, so the reprinted row stays gone', async () => {
    let answer;
    vi.stubGlobal('fetch', vi.fn(url => String(url).includes('reprint')
      ? new Promise(resolve => { answer = resolve; })
      : Promise.resolve(reply({ jobs: [job(1), job(2)] }))));
    const bell = mount();
    bell.open(); await settle();
    const pending = bell.reprint(job(1));
    await settle();
    socket.count.value = 1; await nextTick(); await settle();
    answer(reply({})); await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bell.jobs.value.map(row => row.id)).toEqual([2]);
  });

  it('frees the reprint buttons after a stalled reprint and says it is unconfirmed without resending', async () => {
    vi.stubGlobal('fetch', vi.fn(url => String(url).includes('reprint')
      ? new Promise(() => {})
      : Promise.resolve(reply({ jobs: [job(1)] }))));
    const bell = mount();
    bell.open(); await settle();
    const pending = bell.reprint(job(1));
    await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(bell.reprintingId.value).toBe(null);
    expect(bell.actionError.value).toBe('Printing was not confirmed. Check Printing before retrying.');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('reprint'))).toHaveLength(1);
  });

  it('bounds a stalled list read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const bell = mount();
    bell.open();
    await vi.advanceTimersByTimeAsync(15000);
    expect(bell.loading.value).toBe(false);
    expect(bell.loadError.value).toBe(true);
  });
});

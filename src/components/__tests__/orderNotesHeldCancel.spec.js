import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: () => {}, onUnmounted: () => {} }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ socket: { value: null }, initSocket: () => null }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => ({ restoreHeldOrder: () => {}, markServerCanonicalRestore: () => {} }) }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ clearActiveTableSession: () => {} }) }));
vi.mock('@/pos/useTerminal.js', async () => {
  const { ref } = await vi.importActual('vue');
  return { useTerminal: () => ({ storeName: ref('Fixture'), storeAddress: ref(''), storePhone: ref(''), ensureSettings: async () => true, loadSettings: async () => true }) };
});
vi.mock('../OrderNoteCard.vue', () => ({ default: {} }));
import OrderNotes from '../OrderNotes.vue';

let scope, page, requests, answers;
const order = { id: 5, isHeld: true, raw_held_data: { version: 3 } };
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const sent = suffix => requests.filter(request => request.url === `api/pos/held_orders/5${suffix}`);
const cancels = () => requests.filter(request => request.method === 'DELETE');

beforeEach(() => {
  scope = effectScope();
  requests = [];
  answers = {};
  const stored = new Map();
  vi.stubGlobal('window', { showPosConfirm: vi.fn(async () => true), showPosAlert: vi.fn(async () => {}), showPosToast: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    const answer = answers[`${request.method} ${url}`];
    if (answer) return answer.shift()();
    return reply({ success: true, data: [], orders: [] });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  page = scope.run(() => OrderNotes.setup({}, { expose: () => {} }));
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('held order cancellation from the board', () => {
  it('releases its claim when the server refuses the cancellation', async () => {
    answers['POST api/pos/held_orders/5/claim'] = [() => reply({ success: true, order: { version: 4 } })];
    answers['DELETE api/pos/held_orders/5'] = [() => reply({ success: false, message: 'Order changed' }, 409)];
    await page.cancelHeldOrder(order);
    expect(sent('/release').map(request => request.method)).toEqual(['POST']);
    const [claim] = sent('/claim');
    const [release] = sent('/release');
    expect(release.body).toMatchObject({ claim_token: claim.body.claim_token, expected_version: 4 });
    expect(window.showPosAlert).toHaveBeenCalledWith('Order changed');
  });

  it('releases its claim when the cancellation answer is lost', async () => {
    answers['POST api/pos/held_orders/5/claim'] = [() => reply({ success: true, order: { version: 4 } })];
    answers['DELETE api/pos/held_orders/5'] = [() => { throw new TypeError('Failed to fetch'); }];
    await page.cancelHeldOrder(order);
    expect(sent('/release')).toHaveLength(1);
    expect(window.showPosAlert).toHaveBeenCalledWith('Cancelling the suspended ticket was not confirmed. Check the board before retrying.');
  });

  it('keeps its claim once the cancellation succeeds', async () => {
    answers['POST api/pos/held_orders/5/claim'] = [() => reply({ success: true, order: { version: 4 } })];
    answers['DELETE api/pos/held_orders/5'] = [() => reply({ success: true })];
    await page.cancelHeldOrder(order);
    expect(sent('/release')).toEqual([]);
    expect(window.showPosToast).toHaveBeenCalledWith('Suspended order cancelled.', 'success');
  });

  it('neither cancels nor releases when the server refuses the claim', async () => {
    answers['POST api/pos/held_orders/5/claim'] = [() => reply({ success: false, message: 'Being edited' }, 409)];
    await page.cancelHeldOrder(order);
    expect(cancels()).toEqual([]);
    expect(sent('/release')).toEqual([]);
  });

  it('sends nothing while another terminal holds an unexpired claim', async () => {
    const claimed = { ...order, raw_held_data: { version: 3, claimed_by_user_id: 8, claim_expires_at: new Date(Date.now() + 60000).toISOString() } };
    await page.cancelHeldOrder(claimed);
    expect(requests).toEqual([]);
    expect(window.showPosConfirm).not.toHaveBeenCalled();
  });

  it('replays the same claim token when retrying after a lost claim answer', async () => {
    answers['POST api/pos/held_orders/5/claim'] = [
      () => { throw new TypeError('Failed to fetch'); },
      () => reply({ success: true, order: { version: 4 } }),
    ];
    answers['DELETE api/pos/held_orders/5'] = [() => reply({ success: true })];
    await page.cancelHeldOrder(order);
    await page.cancelHeldOrder(order);
    const [lost, retry] = sent('/claim').map(request => request.body.claim_token);
    expect(retry).toBe(lost);
    expect(retry).toMatch(/^[0-9a-f]{64}$/);
  });
});

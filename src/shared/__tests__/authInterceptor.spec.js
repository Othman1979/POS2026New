import { afterEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = (entries = {}) => {
  const data = new Map(Object.entries(entries));
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
};

async function loadInterceptor({ status, body, role = 'cashier' }) {
  const session = memoryStorage({ pos_user: JSON.stringify({ id: 4, role }) });
  const local = memoryStorage({ pos_cart: '[{"id":1}]', pos_active_user_id: '4' });
  const location = { origin: 'http://pos.test', href: '/pos' };
  const network = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('window', { location, fetch: network });
  await import('@/shared/authInterceptor.js');
  return { session, local, location, network, fetch: window.fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('auth interceptor', () => {
  it('sends internal API requests with same-origin credentials', async () => {
    const { fetch, network } = await loadInterceptor({ status: 200, body: {} });
    await fetch('api/orders');
    expect(network).toHaveBeenCalledWith('api/orders', { credentials: 'same-origin' });
  });

  it('redirects an expired call-center session to login and clears its POS draft', async () => {
    const { fetch, session, local, location } = await loadInterceptor({
      status: 401, body: { code: 'SESSION_INVALID' }, role: 'call_center',
    });
    await fetch('api/orders');
    expect(location.href).toBe('/login?reason=expired');
    expect(session.getItem('pos_user')).toBeNull();
    expect(local.getItem('pos_cart')).toBeNull();
  });

  it('keeps the POS draft of an expired cashier session for the next sign-in', async () => {
    const { fetch, session, local, location } = await loadInterceptor({
      status: 401, body: { code: 'SESSION_REQUIRED' },
    });
    await fetch('api/orders');
    expect(location.href).toBe('/login?reason=expired');
    expect(session.getItem('pos_user')).toBeNull();
    expect(local.getItem('pos_cart')).toBe('[{"id":1}]');
    // The next visit to / must paint the neutral boot shell, not a POS skeleton.
    expect(local.getItem('pos_active_user_id')).toBeNull();
  });

  it('hands a domain 401 such as a wrong manager PIN back to the caller without signing out', async () => {
    const { fetch, session, local, location } = await loadInterceptor({
      status: 401, body: { code: 'INVALID_PIN' },
    });
    const response = await fetch('api/pos/override');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'INVALID_PIN' });
    expect(location.href).toBe('/pos');
    expect(session.getItem('pos_user')).not.toBeNull();
    expect(local.getItem('pos_active_user_id')).toBe('4');
  });
});

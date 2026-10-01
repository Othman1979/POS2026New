import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));

const socket = { on: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn(), off: vi.fn() } };
vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('@/shared/http.js', () => ({
    fetchJson: vi.fn(async url => (url === 'public_menu.json'
        ? { success: true, store: {}, categories: [], products: [] }
        : { success: false }))
}));
vi.mock('@/shared/i18n.js', () => ({ setLanguage: vi.fn(async () => true) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:') } }));
import { io } from 'socket.io-client';
import { SOCKET_CLIENT_OPTIONS } from '@/shared/socketRefusalRetry.js';
import MenuApp from '../MenuApp.vue';

// Only setup() and its mount hooks matter here; the template is replaced by an empty render.
const renderer = createRenderer({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null
});

let app;
afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function mountMenu(search) {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
    vi.stubGlobal('window', {
        location: { search, href: 'http://pos.test/menu.html' + search, origin: 'http://pos.test', pathname: '/menu.html' },
        addEventListener() {}, removeEventListener() {}
    });
    vi.stubGlobal('document', { documentElement: {} });
    app = renderer.createApp({ render: () => h({ ...MenuApp, ssrRender: undefined, render: () => null }) });
    app.mount({});
    for (let i = 0; i < 10; i++) await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe('MenuApp customer socket', () => {
    it('connects with the bundled client and customer table auth when the QR carries a table', async () => {
        await mountMenu('?table=3&token=t');
        expect(io).toHaveBeenCalledTimes(1);
        expect(io).toHaveBeenCalledWith({
            ...SOCKET_CLIENT_OPTIONS,
            auth: { type: 'customer', tableId: 3, token: 't' }
        });
    });

    it('opens no socket for a menu link without a table', async () => {
        await mountMenu('');
        expect(io).not.toHaveBeenCalled();
    });
});

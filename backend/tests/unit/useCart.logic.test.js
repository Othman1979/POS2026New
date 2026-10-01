// backend/tests/unit/useCart.logic.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';


// Set up browser/DOM mock globals before importing Vue or Vue composables
const store = {};
const mockLocalStorage = {
    getItem: vi.fn(key => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn(key => { delete store[key]; }),
    clear: vi.fn(() => { for (const k in store) delete store[k]; })
};

global.window = {
    localStorage: mockLocalStorage,
    showPosAlert: vi.fn(),
    showPosConfirm: vi.fn(() => Promise.resolve(true)),
    showPosPrompt: vi.fn(() => Promise.resolve('')),
    location: { href: '' },
    history: { replaceState: vi.fn() }
};

global.localStorage = mockLocalStorage;

global.document = {
    documentElement: { dir: 'ltr' }
};

// Mock i18n
vi.mock('@/shared/i18n.js', () => ({
    t: (key) => key
}));

// Mock other composables
const activeUserMock = { id: 1, name: 'Test Cashier', role: 'cashier', permissions: ['pos.checkout', 'pos.hold_orders', 'orders.view', 'shift.open', 'shift.close', 'pos.discount', 'pos.void_item'] };
const activeShiftMock = { id: 12 };
const lastOrderMock = { value: null };

vi.mock('@/pos/useAuth.js', () => ({
    useAuth: () => ({
        activeUser: { value: activeUserMock },
        activeShift: { value: activeShiftMock },
        isTempAdmin: { value: false },
        showOverrideModal: { value: false }
    })
}));

vi.mock('@/pos/useTables.js', () => ({
    useTables: () => ({
        activeTable: { value: null },
        clearActiveTableSession: vi.fn()
    })
}));

vi.mock('@/pos/useTerminal.js', () => ({
    useTerminal: () => ({
        lastOrder: lastOrderMock,
        printReceipt: vi.fn(),
        taxInclusivePricing: { value: false },
        receiptTaxInclusiveDisplay: { value: false }
    })
}));

vi.mock('@/pos/useProducts.js', () => ({
    useProducts: () => ({
        settings: { value: { stock_enabled: '0' } }
    })
}));

// Import useCart
import { useCart } from '@/pos/useCart.js';

describe('useCart idempotency key lifecycle unit tests', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        mockLocalStorage.clear();
        lastOrderMock.value = null;
    });

    it('should generate an idempotency key when opening checkout modal and clear it when closed', () => {
        const { cart, openCheckoutModal, closeCheckoutModal, activeIdempotencyKey, showCheckoutModal } = useCart();

        cart.value = [{ id: 101, name: 'Cappuccino', price: 3.50, qty: 1 }];

        expect(activeIdempotencyKey.value).toBe('');
        expect(showCheckoutModal.value).toBe(false);

        openCheckoutModal();

        expect(showCheckoutModal.value).toBe(true);
        expect(activeIdempotencyKey.value).toMatch(/^TXN-\d+-\d+$/);

        const initialKey = activeIdempotencyKey.value;

        closeCheckoutModal();

        expect(showCheckoutModal.value).toBe(false);
        expect(activeIdempotencyKey.value).toBe('');
    });

});

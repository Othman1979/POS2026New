import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
const mocks = vi.hoisted(() => ({ cart: null, products: null, terminal: {} }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onBeforeUnmount: vi.fn(), onDeactivated: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/shared/i18n.js', () => ({ currentLanguage: { value: 'en' }, getDirection: () => 'ltr', t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: { value: { role: 'admin' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => mocks.cart }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => mocks.products }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ activeTable: { value: null } }) }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => mocks.terminal }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ isSocketConnected: { value: true } }) }));
vi.mock('../FailedPrintsBell.vue', () => ({ default: {} }));
import Catalog from '../PosCatalogWorkspace.vue';
let scope;
beforeEach(() => {
  scope = effectScope();
  mocks.products = { filteredProducts: ref([{ id: 1 }, { id: 2 }]) };
  mocks.cart = { cart: ref([{ id: 1, qty: '1.5' }, { id: '1', qty: 2 }, { id: 1, qty: 90, is_custom: true }]), selectedCartIndex: ref(null) };
  mocks.cart.getQtyInCart = vi.fn(productId => mocks.cart.cart.value.filter(item => String(item.id) === String(productId) && !item.is_custom).reduce((sum, item) => sum + parseFloat(item.qty), 0));
});
afterEach(() => scope.stop());
const setup = () => scope.run(() => Catalog.setup({}, { expose: () => {}, emit: vi.fn() }));

describe('catalog product clicks', () => {
  beforeEach(() => vi.stubGlobal('window', { showPosToast: vi.fn() }));
  afterEach(() => vi.unstubAllGlobals());
  const click = async (product, quick) => {
    mocks.terminal = { quickNumpadMode: ref(quick) };
    Object.assign(mocks.cart, { addToCart: vi.fn(), cancelQuickAmount: vi.fn() });
    mocks.products.filteredProducts.value = [product];
    await setup().handleProductClick(product);
    return mocks.cart;
  };

  it('adds a tapped product through the quick amount only while quick mode is on', async () => {
    const tea = { id: 1, name: 'Tea' };
    expect((await click(tea, true)).addToCart).toHaveBeenCalledWith(tea, { source: 'catalog', useQuickAmount: true });
    expect((await click(tea, false)).addToCart).toHaveBeenCalledWith(tea, { source: 'catalog', useQuickAmount: false });
  });

  it('drops an armed quick amount instead of adding a sold-out product', async () => {
    const cart = await click({ id: 1, name: 'Tea', can_sell: 0 }, true);
    expect(cart.addToCart).not.toHaveBeenCalled();
    expect(cart.cancelQuickAmount).toHaveBeenCalledOnce();
  });

  it('cancels an armed quick amount on a note tap so the next item is not priced by it', async () => {
    const note = { id: 2, name: 'No sugar', category_is_notes: 1 }, tea = { id: 1, name: 'Tea' };
    window.showPosAlert = vi.fn();
    // The store clears the armed amount; quick mode itself is a terminal setting and stays on.
    const armed = ref(5);
    let armedAtAdd;
    mocks.terminal = { quickNumpadMode: ref(true) };
    Object.assign(mocks.cart, {
      cancelQuickAmount: vi.fn(() => { armed.value = null; }),
      addToCart: vi.fn(() => { armedAtAdd = armed.value; }),
    });
    mocks.products.filteredProducts.value = [note, tea];
    const catalog = setup();
    await catalog.handleProductClick(note);
    await catalog.handleProductClick(tea);
    expect(mocks.cart.cancelQuickAmount).toHaveBeenCalledOnce();
    expect(mocks.cart.addToCart).toHaveBeenCalledOnce();
    expect(mocks.cart.addToCart).toHaveBeenCalledWith(tea, { source: 'catalog', useQuickAmount: true });
    expect(armedAtAdd).toBeNull();
  });
});

describe('catalog availability gestures', () => {
  let armed;
  beforeEach(() => {
    armed = ref(5);
    vi.stubGlobal('window', { showPosToast: vi.fn(), showPosAlert: vi.fn(), showPosConfirm: vi.fn(async () => true) });
    mocks.terminal = { quickNumpadMode: ref(true) };
    Object.assign(mocks.cart, { addToCart: vi.fn(), cancelQuickAmount: vi.fn(() => { armed.value = null; }) });
    Object.assign(mocks.products, {
      setProductAvailability: vi.fn(async () => ({ response: { ok: true }, data: { success: true } })),
      applyProductAvailabilityChanges: vi.fn(),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps an armed quick amount when a right click marks a product sold out', async () => {
    const tea = mocks.products.filteredProducts.value[0];
    const catalog = setup();
    catalog.handleProductContextMenu(tea);
    await vi.waitFor(() => expect(mocks.products.setProductAvailability).toHaveBeenCalledWith(1, false));
    // The trailing click of the same gesture is swallowed and must not add or drop the armed amount.
    await catalog.handleProductClick(tea);
    expect(mocks.cart.addToCart).not.toHaveBeenCalled();
    expect(mocks.cart.cancelQuickAmount).not.toHaveBeenCalled();
    expect(armed.value).toBe(5);
  });

  it('keeps an armed quick amount when a long press marks a product sold out', async () => {
    vi.useFakeTimers();
    const tea = mocks.products.filteredProducts.value[0];
    const catalog = setup();
    catalog.startProductLongPress(tea, { isPrimary: true, pointerType: 'touch', clientX: 0, clientY: 0 });
    await vi.advanceTimersByTimeAsync(650);
    expect(mocks.products.setProductAvailability).toHaveBeenCalledWith(1, false);
    await catalog.handleProductClick(tea);
    expect(mocks.cart.addToCart).not.toHaveBeenCalled();
    expect(mocks.cart.cancelQuickAmount).not.toHaveBeenCalled();
    expect(armed.value).toBe(5);
  });
});

describe('catalog quantity derivation', () => {
  it('tile price follows the order session tax profile, not the live terminal setting', () => {
    const product = { price: '10', tax_rate: '16' };
    // A hold restored under sales tax after the venue switched to income tax keeps charging tax.
    mocks.terminal = { taxRegistrationType: ref('income_tax') };
    mocks.cart.taxRegistrationType = ref('sales_tax');
    expect(setup().tilePrice(product)).toBe('11.60');
    mocks.terminal.taxRegistrationType.value = 'sales_tax';
    mocks.cart.taxRegistrationType.value = 'income_tax';
    expect(setup().tilePrice(product)).toBe('10.00');
  });

  it('refreshes card styles for quantity, color and selected note changes', () => {
    const page = setup();
    const product = mocks.products.filteredProducts.value[0];
    expect(page.cardStyles(product).bgClass).toContain('bg-primary');
    mocks.cart.cart.value = [];
    product.background_color = '#ffffff';
    expect(page.cardStyles(product).textClass).toBe('text-gray-950');
    product.background_color = '#101010';
    expect(page.cardStyles(product).textClass).toContain('text-white');
    mocks.products.filteredProducts.value = [{ id: 9, category_is_notes: 1 }];
    mocks.cart.cart.value = [{ id: 1, qty: 1, selectedModifiers: [{ noteProductId: 9 }] }];
    mocks.cart.selectedCartIndex.value = 0;
    expect(page.cardStyles(mocks.products.filteredProducts.value[0]).bgClass).toContain('bg-primary');
    mocks.cart.cart.value[0].selectedModifiers = [];
    expect(page.cardStyles(mocks.products.filteredProducts.value[0]).bgClass).toContain('bg-surface-container-lowest');
  });

  it('shares one authoritative quantity calculation across repeated card bindings', () => {
    const page = setup();
    for (let i = 0; i < 5; i++) expect(page.getQtyInCart(1)).toBe(3.5);
    expect(mocks.cart.getQtyInCart.mock.calls.filter(([id]) => String(id) === '1')).toHaveLength(1);
  });

  it('invalidates quantities for edits, custom flags, removal and restored carts', () => {
    const page = setup();
    expect(page.getQtyInCart('1')).toBe(3.5);
    mocks.cart.cart.value[0].qty = 3;
    expect(page.getQtyInCart(1)).toBe(5);
    mocks.cart.cart.value[1].is_custom = true;
    expect(page.getQtyInCart(1)).toBe(3);
    mocks.cart.cart.value.splice(0, 1);
    expect(page.getQtyInCart(1)).toBe(0);
    mocks.cart.cart.value = [{ id: '1', qty: 7.25 }];
    expect(page.getQtyInCart(1)).toBe(7.25);
  });

  it('keeps the card styles map identity when a quantity change does not change card state', () => {
    const page = setup();
    const stylesBefore = page.productCardStyles.value;
    const quantitiesBefore = page.productQuantities.value;
    mocks.cart.cart.value[1].qty = 5; // product 1 qty 3.5 -> 6.5, still in cart
    expect(page.productQuantities.value).not.toBe(quantitiesBefore);
    expect(page.productQuantities.value.get('1')).toBe(6.5);
    expect(page.productCardStyles.value).toBe(stylesBefore);
  });

  it('keeps both map identities for a cart change that touches no visible product', () => {
    const page = setup();
    const stylesBefore = page.productCardStyles.value;
    const quantitiesBefore = page.productQuantities.value;
    mocks.cart.cart.value.push({ id: 5, qty: 3 });
    expect(page.productQuantities.value).toBe(quantitiesBefore);
    expect(page.productCardStyles.value).toBe(stylesBefore);
  });

  it('exposes only real parent ids in categoryParentIds', () => {
    mocks.products.categories = ref([
      { id: 1, parent_id: null },
      { id: 2, parent_id: 1 },
      { id: 3, parent_id: null },
      { id: 4, parent_id: 2 },
    ]);
    const page = setup();
    expect(page.categoryParentIds.value.has('1')).toBe(true);
    expect(page.categoryParentIds.value.has('2')).toBe(true);
    expect(page.categoryParentIds.value.has('3')).toBe(false);
    expect(page.categoryParentIds.value.has('4')).toBe(false);
  });

  it('refreshes newly visible products and preserves card color/selection rules', () => {
    const page = setup();
    expect(page.getQtyInCart(2)).toBe(0);
    mocks.products.filteredProducts.value = [{ id: 3 }];
    mocks.cart.cart.value.push({ id: 3, qty: 2 });
    expect(page.getQtyInCart(3)).toBe(2);
    expect(page.getProductCardStyles('#ffffff', false).textClass).toBe('text-gray-950');
    expect(page.getProductCardStyles('#101010', false).textClass).toContain('text-white');
    expect(page.getProductCardStyles('#ffffff', true).bgClass).toContain('bg-primary');
  });
});

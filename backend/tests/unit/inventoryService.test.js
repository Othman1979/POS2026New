const {
  fetchCartProducts,
  deductStockForCart,
  restockOrderItems,
  restoreStockForCart
} = require('../../services/InventoryService');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem } = require('../helpers/fixtures');

const catalogRow = (id) => ({
  id,
  name: `Product ${id}`,
  price: 1,
  tax_rate: 0,
  stock: id === 1 ? 10 : null,
  category_id: 1,
  modifiers: null,
  is_available: 1,
  can_sell: 1,
});

describe('InventoryService priced note lookups', () => {
  it('loads only the bounded note-product prefix for pricing', async () => {
    const query = vi.fn(async (_sql, params) => [params.map(catalogRow)]);
    const selections = Array.from({ length: 51 }, (_, index) => ({ noteProductId: 91 + index }));

    await fetchCartProducts({ query }, [
      { product_id: 1, selectedModifiers: selections },
      { product_id: 1, selectedModifiers: [{ noteProductId: 91 }] }
    ]);

    const [, ids] = query.mock.calls[0];
    expect(ids).toContain(1);
    expect(ids).toContain(91);
    expect(ids).not.toContain(141);
    expect(ids.filter(id => id === 1)).toHaveLength(1);
    expect(ids.filter(id => id === 91)).toHaveLength(1);
  });

  it('locks and updates base products without locking note products', async () => {
    const query = vi.fn(async (sql, params) => {
      if (String(sql).includes('FROM products')) return [params.map(catalogRow)];
      if (String(sql).includes('FROM product_stock_links WHERE')) return [[]];
      return [{ affectedRows: 1 }];
    });

    await deductStockForCart({ query }, [{
      product_id: 1,
      qty: 2,
      selectedModifiers: [{ noteProductId: 91 }],
    }]);

    const productLookup = query.mock.calls.find(([sql]) => String(sql).includes('FROM products'));
    expect(productLookup[0]).toContain('FOR UPDATE');
    expect(productLookup[1]).toEqual([1]);
    const stockUpdate = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE products'));
    expect(stockUpdate[1]).toContain(1);
    expect(stockUpdate[1]).not.toContain(91);
  });

  it('rejects checkout-context joins on the stock-locking read before SQL runs', async () => {
    const query = vi.fn();

    await expect(fetchCartProducts(
      { query },
      [{ product_id: 1 }],
      { lock: true, includeCheckoutContext: true }
    )).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('InventoryService against the seeded catalog', () => {
  const stockOf = async () => {
    const [rows] = await pool.query(
      'SELECT id, stock FROM products WHERE id IN (?, ?) ORDER BY id',
      [SEED.product1.id, SEED.product2.id]
    );
    return Object.fromEntries(rows.map(row => [row.id, Number(row.stock)]));
  };

  beforeEach(async () => {
    await seedDatabase();
    await pool.query('UPDATE products SET stock = ? WHERE id = ?', [10, SEED.product1.id]);
    await pool.query('UPDATE products SET stock = ? WHERE id = ?', [4, SEED.product2.id]);
  });
  afterAll(async () => { await pool.end(); });

  it('loads the price-list override as the effective price for checkout', async () => {
    await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);
    await pool.query(
      'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, ?)',
      [SEED.category.id, SEED.product1.id, 2.5]
    );

    const productMap = await fetchCartProducts(
      pool,
      [{ product_id: SEED.product1.id }],
      { includeCheckoutContext: true }
    );

    expect(productMap.get(SEED.product1.id)).toMatchObject({
      price_list_root_id: SEED.category.id,
      price_list_root_name: SEED.category.name,
      effective_price: 2.5
    });
  });

  it('restores a hundred refund lines in one write, summing repeated products', async () => {
    const query = vi.spyOn(pool, 'query');
    await restoreStockForCart(pool, Array.from({ length: 100 }, (_, index) => ({
      product_id: index % 2 ? String(SEED.product2.id) : SEED.product1.id, quantity: '0.5'
    })));
    const writes = query.mock.calls.length;
    query.mockRestore();

    expect(writes).toBe(1);
    expect(await stockOf()).toEqual({ [SEED.product1.id]: 35, [SEED.product2.id]: 29 });
  });

  it('restockOrderItems restores every line of a product that appears twice', async () => {
    const invoiceId = await insertPaidOrder(pool);
    await insertOrderItem(pool, { invoice_id: invoiceId, product_id: SEED.product2.id, quantity: 1 });
    await insertOrderItem(pool, { invoice_id: invoiceId, product_id: SEED.product2.id, quantity: 2 });
    await insertOrderItem(pool, { invoice_id: invoiceId, product_id: SEED.product1.id, quantity: 1 });

    await restockOrderItems(pool, invoiceId);

    expect(await stockOf()).toEqual({ [SEED.product1.id]: 11, [SEED.product2.id]: 7 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/pos/useCart.js', () => ({
  useCart: () => {
    throw new Error('catalog must not initialize cart');
  }
}));

describe('useProducts dependency ownership', () => {
  beforeEach(() => vi.resetModules());

  it('initializes catalog state without initializing cart state', async () => {
    const { useProducts } = await import('@/pos/useProducts.js');
    expect(() => useProducts()).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { buildCartQuantityIndex } from './cartQuantityIndex.js';

describe('cart quantity index', () => {
  it('combines numeric and string-equivalent product ids with fractional quantities', () => {
    const index = buildCartQuantityIndex([
      { id: 7, qty: '0.125' },
      { id: '7', qty: 1.5 },
      { id: 8, qty: '2' },
    ]);

    expect(index.get('7')).toBe(1.625);
    expect(index.get('8')).toBe(2);
  });

  it('excludes custom lines with the same semantics as the existing cart lookup', () => {
    const index = buildCartQuantityIndex([
      { id: 4, qty: 1, is_custom: false },
      { id: 4, qty: 2, is_custom: 0 },
      { id: 4, qty: 4, is_custom: true },
      { id: 4, qty: 8, is_custom: '0' },
    ]);

    expect(index.get('4')).toBe(3);
  });

  it('preserves an invalid quantity as NaN instead of silently resetting the total', () => {
    const index = buildCartQuantityIndex([
      { id: 3, qty: 2 },
      { id: 3, qty: 'not-a-number' },
      { id: 3, qty: 5 },
    ]);

    expect(Number.isNaN(index.get('3'))).toBe(true);
  });

  it('returns an empty map for absent input', () => {
    expect([...buildCartQuantityIndex()]).toEqual([]);
  });
});

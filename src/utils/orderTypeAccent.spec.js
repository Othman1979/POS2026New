import { describe, it, expect } from 'vitest';
import { getTypeAccent } from './orderTypeAccent.js';

describe('getTypeAccent', () => {
  it('maps takeaway names (EN + AR) to teal', () => {
    expect(getTypeAccent('Takeaway').stripe).toBe('border-teal-600');
    expect(getTypeAccent('سفري').text).toBe('text-teal-700');
    expect(getTypeAccent('Takeaway / سفري').tint).toBe('bg-teal-50');
  });
  it('maps delivery names (EN + AR) to sky', () => {
    expect(getTypeAccent('Delivery').stripe).toBe('border-sky-600');
    expect(getTypeAccent('توصيل').dot).toBe('bg-sky-500');
  });
  it('maps dine-in and null/empty to emerald', () => {
    expect(getTypeAccent('Dine-In').stripe).toBe('border-emerald-600');
    expect(getTypeAccent('طاولة').stripe).toBe('border-emerald-600');
    expect(getTypeAccent(null).stripe).toBe('border-emerald-600');
    expect(getTypeAccent('').stripe).toBe('border-emerald-600');
  });
  it('maps unknown types to amber', () => {
    expect(getTypeAccent('Catering').stripe).toBe('border-amber-600');
  });
  it('exposes a composite chip class for the active phone filter', () => {
    expect(getTypeAccent('Delivery').chip).toBe('bg-sky-50 text-sky-700 border-sky-200');
  });
});

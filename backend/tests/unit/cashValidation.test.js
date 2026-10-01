const { validateCashAmount } = require('../../services/CashValidation');

describe('validateCashAmount', () => {
  it('accepts finite non-negative values within the drawer limit', () => {
    expect(validateCashAmount(100.5)).toEqual({ valid: true, value: 100.5 });
    expect(validateCashAmount('0')).toEqual({ valid: true, value: 0 });
  });

  it('rejects missing, non-numeric, negative, and oversized values', () => {
    expect(validateCashAmount(undefined).valid).toBe(false);
    expect(validateCashAmount(null).valid).toBe(false);
    expect(validateCashAmount('').valid).toBe(false);
    expect(validateCashAmount('abc').valid).toBe(false);
    expect(validateCashAmount(Infinity).valid).toBe(false);
    expect(validateCashAmount(-1).valid).toBe(false);
    expect(validateCashAmount(100000000).valid).toBe(false);
  });
});

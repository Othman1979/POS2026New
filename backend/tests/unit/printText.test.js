const { sanitizePrintString } = require('../../services/printText');

describe('sanitizePrintString', () => {
  it('removes printer control bytes while preserving printable whitespace', () => {
    expect(sanitizePrintString(' a\x1Bb\x1Dc\x00d\x7F ')).toBe('abcd');
    expect(sanitizePrintString('line1\r\nline2\tvalue')).toBe('line1\r\nline2\tvalue');
    expect(sanitizePrintString('a\x01b\x0Bc\x0Cd\x1Fe')).toBe('abcde');
  });

  it('clamps output and handles nullish/non-string values', () => {
    expect(sanitizePrintString('x'.repeat(50), 10)).toHaveLength(10);
    expect(sanitizePrintString(null)).toBe('');
    expect(sanitizePrintString(123)).toBe('123');
  });
});

import { describe, it, expect } from 'vitest';
import {
  formatTimeOnly, formatScheduledTime, formatDateTime, getQtyFormatted, isArabic,
} from './orderNotesFormat.js';

// Dates built from local components so assertions are timezone-independent.
describe('orderNotesFormat', () => {
  it('formatTimeOnly renders 12h hh:mm:ss with AM/PM', () => {
    expect(formatTimeOnly(new Date('2026-01-01T12:04:05Z'))).toBe('03:04:05 PM');
    expect(formatTimeOnly(new Date('2025-12-31T21:09:00Z'))).toBe('12:09:00 AM');
  });
  it('formatScheduledTime renders date + hh:mm AM/PM', () => {
    expect(formatScheduledTime('2026-01-01T15:04')).toBe('2026-01-01 03:04 PM');
  });
  it('formatDateTime renders date + hh:mm:ss AM/PM', () => {
    expect(formatDateTime(new Date('2026-01-01T12:04:05Z'))).toBe('2026-01-01 03:04:05 PM');
  });
  it('formatters return empty string for falsy input', () => {
    expect(formatTimeOnly('')).toBe('');
    expect(formatDateTime(null)).toBe('');
  });
  it('getQtyFormatted keeps integers, fixes fractionals, passes through non-numeric', () => {
    expect(getQtyFormatted(3)).toBe('3');
    expect(getQtyFormatted(2.5)).toBe('2.50');
    expect(getQtyFormatted('abc')).toBe('abc');
  });
  it('isArabic detects Arabic script', () => {
    expect(isArabic('سفري')).toBe(true);
    expect(isArabic('Burger')).toBe(false);
    expect(isArabic('')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  formatTableElapsedTime,
  getTableStatusClass,
  getTableStatusKey
} from './tableFloorPlanPresentation.js';

describe('table floor presentation', () => {
  it.each([
    ['available', 'table-card--available', 'Available'],
    ['occupied', 'table-card--occupied', 'Occupied'],
    ['printed', 'table-card--printed', 'Bill Printed'],
    ['unexpected', 'table-card--unknown', 'Unknown']
  ])('maps %s to an explicit class and translation key', (status, cssClass, key) => {
    expect(getTableStatusClass(status)).toBe(cssClass);
    expect(getTableStatusKey(status)).toBe(key);
  });

  it('formats elapsed minutes and hours with Latin digits', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    const translate = (key) => ({ min: 'د', hr: 'س' })[key] || key;

    expect(formatTableElapsedTime('2026-07-15T11:48:00Z', now, translate)).toBe('12 د');
    expect(formatTableElapsedTime('2026-07-15T10:55:00Z', now, translate)).toBe('1 س 5 د');
    expect(formatTableElapsedTime('2026-07-15T12:05:00Z', now, translate)).toBe('0 د');
  });

  it('returns an empty value for absent or invalid dates', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    expect(formatTableElapsedTime(null, now)).toBe('');
    expect(formatTableElapsedTime('not-a-date', now)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { shouldLoadTableWorkspace } from './tableWorkspacePolicy.js';

const decision = (overrides = {}) => shouldLoadTableWorkspace({
  role: 'cashier',
  canAccessTables: true,
  tablesEnabled: false,
  settingsReadSucceeded: true,
  hasPendingTableSession: false,
  ...overrides,
});

describe('table workspace read policy', () => {
  it('skips disabled tables after an authoritative settings read', () => {
    expect(decision()).toBe(false);
  });

  it('keeps pending table sessions recoverable while tables are disabled', () => {
    expect(decision({ hasPendingTableSession: true })).toBe(true);
  });

  it('loads enabled tables for a permitted cashier and for a waiter', () => {
    expect(decision({ tablesEnabled: true })).toBe(true);
    expect(decision({ role: 'waiter', canAccessTables: false, tablesEnabled: true })).toBe(true);
  });

  it('uses conservative recovery when the latest settings read failed', () => {
    expect(decision({ settingsReadSucceeded: false })).toBe(true);
  });

  it('never loads table data for call-center or unauthorized users', () => {
    expect(decision({ role: 'call_center', tablesEnabled: true, hasPendingTableSession: true })).toBe(false);
    expect(decision({ canAccessTables: false, tablesEnabled: true })).toBe(false);
    expect(decision({ canAccessTables: false, settingsReadSucceeded: false })).toBe(false);
  });
});

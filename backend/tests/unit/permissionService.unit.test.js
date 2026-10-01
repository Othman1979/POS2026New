const {
  PERMISSIONS,
  userHas,
  isAdminRole,
  isCallCenterRole,
  userCanAccessOrderForPrint,
  assertCanVoidSavedUnits,
  canAccessTables,
  getTableSectionIds,
  assertTableSectionAccess,
  CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS,
} = require('../../services/PermissionService');

describe('PermissionService.userHas', () => {
  it('returns true for admin/programmer regardless of grants', () => {
    expect(userHas({ role: 'admin', permissions: [] }, PERMISSIONS.POS_CHECKOUT)).toBe(true);
    expect(userHas({ role: 'programmer', permissions: [] }, PERMISSIONS.POS_DISCOUNT)).toBe(true);
  });

  it('returns true for a cashier holding the grant', () => {
    const u = { role: 'cashier', permissions: ['pos.checkout'] };
    expect(userHas(u, PERMISSIONS.POS_CHECKOUT)).toBe(true);
  });

  it('returns false for a cashier missing the grant', () => {
    const u = { role: 'cashier', permissions: ['pos.hold_orders'] };
    expect(userHas(u, PERMISSIONS.POS_CHECKOUT)).toBe(false);
  });

  it('returns false when permissions is undefined', () => {
    expect(userHas({ role: 'cashier' }, PERMISSIONS.POS_CHECKOUT)).toBe(false);
  });

  it('makes call_center a fixed zero-permission role even when stale grants exist', () => {
    const user = {
      id: 12,
      role: 'call_center',
      permissions: Object.values(PERMISSIONS),
      allowed_sections: '1,2',
    };

    expect(isCallCenterRole(user)).toBe(true);
    for (const permission of Object.values(PERMISSIONS)) {
      expect(userHas(user, permission)).toBe(false);
    }
    expect(userCanAccessOrderForPrint(user, { user_id: 12, waiter_id: null })).toBe(false);
    expect(() => assertCanVoidSavedUnits(user)).toThrow('Forbidden');
  });

  it('isAdminRole detects admin and programmer only', () => {
    expect(isAdminRole({ role: 'admin' })).toBe(true);
    expect(isAdminRole({ role: 'cashier' })).toBe(false);
    expect(isAdminRole({ role: 'call_center' })).toBe(false);
    expect(isCallCenterRole({ role: 'cashier' })).toBe(false);
  });

  it('checks print access by owner, admin, or reprint permission', () => {
    const order = { user_id: 5, waiter_id: null };
    expect(userCanAccessOrderForPrint({ id: 5, role: 'cashier', permissions: [] }, order)).toBe(true);
    expect(userCanAccessOrderForPrint({ id: 9, role: 'admin', permissions: [] }, order)).toBe(true);
    expect(userCanAccessOrderForPrint({ id: 9, role: 'cashier', permissions: ['pos.reprint_receipt'] }, order)).toBe(true);
    expect(userCanAccessOrderForPrint({ id: 9, role: 'cashier', permissions: [] }, order)).toBe(false);
  });

  it('keeps the saved-unit void wall and exact error statuses', () => {
    expect(() => assertCanVoidSavedUnits({ role: 'cashier', permissions: [] })).toThrow('Forbidden: You do not have permission to void a table order.');
    expect(() => assertCanVoidSavedUnits({ role: 'cashier', permissions: ['pos.void_item'] })).toThrow('Forbidden: You do not have permission to void printed items.');
    try {
      assertCanVoidSavedUnits({ role: 'cashier', permissions: [] });
    } catch (error) {
      expect(error.statusCode).toBe(403);
    }
    expect(() => assertCanVoidSavedUnits({ role: 'cashier', permissions: ['pos.void_item', 'pos.void_printed_item'] })).not.toThrow();
  });

  it('treats table access as inherent for waiters only', () => {
    expect(canAccessTables({ role: 'waiter', permissions: [] })).toBe(true);
    expect(canAccessTables({ role: 'cashier', permissions: [] })).toBe(false);
    expect(canAccessTables({ role: 'cashier', permissions: ['tables.access'] })).toBe(true);
  });

  it('shares strict section parsing and explicit scope independent of staff role', () => {
    expect(getTableSectionIds({ role: 'waiter', table_access_scope: 'selected', allowed_sections: '1, 02,1,3oops,4.5,0,-1' })).toEqual([1, 2]);
    expect(getTableSectionIds({ role: 'waiter', allowed_sections: null })).toEqual([]);
    expect(getTableSectionIds({ role: 'cashier', table_access_scope: 'all', allowed_sections: null })).toBeNull();
    expect(getTableSectionIds({ role: 'cashier', table_access_scope: 'none', allowed_sections: null })).toEqual([]);
    expect(getTableSectionIds({ role: 'waiter', table_access_scope: 'all', allowed_sections: null })).toBeNull();
    expect(getTableSectionIds({ role: 'admin', allowed_sections: '1' })).toBeNull();
    expect(getTableSectionIds({ role: 'programmer', allowed_sections: '0' })).toBeNull();
    expect(getTableSectionIds({ role: 'call_center', allowed_sections: '1' })).toEqual([]);
    expect(() => assertTableSectionAccess(undefined, [{ section_id: 1 }])).toThrow('Forbidden');
    expect(() => assertTableSectionAccess({ role: 'waiter', table_access_scope: 'selected', allowed_sections: '1,2' }, [{ section_id: 1 }, { section_id: 2 }])).not.toThrow();
    expect(() => assertTableSectionAccess({ role: 'waiter', table_access_scope: 'selected', allowed_sections: '1' }, [{ section_id: 1 }, { section_id: 2 }])).toThrow('Forbidden');
  });

  it('limits cached manager access to checkout operations that re-verify the PIN', () => {
    expect(CHECKOUT_MANAGER_OVERRIDE_PERMISSIONS).toEqual([
      PERMISSIONS.POS_DISCOUNT,
      PERMISSIONS.POS_PRICE_OVERRIDE,
    ]);
  });
});

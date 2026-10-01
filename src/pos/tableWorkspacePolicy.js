export const shouldLoadTableWorkspace = ({
  role,
  canAccessTables,
  tablesEnabled,
  settingsReadSucceeded,
  hasPendingTableSession,
}) => {
  if (role === 'call_center') return false;
  if (role !== 'waiter' && !canAccessTables) return false;

  return Boolean(tablesEnabled || hasPendingTableSession || !settingsReadSucceeded);
};

// A table row ends the active session when another till freed it or gave it to a
// different order. While this till's own checkout is in flight the same row can be its
// own echo or a reopen, so callers only act on this once the checkout has settled.
export const tableRowEndsSession = (activeOrderId, row) => {
  if (!row) return false;
  if (row.status === 'available' && !row.current_order_id) return true;
  return Boolean(row.current_order_id && activeOrderId
    && String(row.current_order_id) !== String(activeOrderId));
};

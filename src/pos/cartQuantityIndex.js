export const buildCartQuantityIndex = (cartItems = []) => {
  const quantities = new Map();
  for (const item of Array.isArray(cartItems) ? cartItems : []) {
    if (item?.is_custom) continue;
    const key = String(item?.id);
    const current = quantities.has(key) ? quantities.get(key) : 0;
    quantities.set(key, current + parseFloat(item?.qty));
  }
  return quantities;
};

// Quantity the server has not deducted yet. Saved table lines and edited
// invoice lines carry originalQty: the server already removed that stock and
// restocks it before deducting the full cart on the next save or checkout, so
// client stock checks must only count the part above it.
export const buildPendingQuantityIndex = (cartItems = []) => {
  const quantities = new Map();
  for (const item of Array.isArray(cartItems) ? cartItems : []) {
    if (item?.is_custom) continue;
    const key = String(item?.id);
    const pending = Math.max(0, parseFloat(item?.qty) - (parseFloat(item?.originalQty) || 0));
    quantities.set(key, (quantities.get(key) || 0) + pending);
  }
  return quantities;
};

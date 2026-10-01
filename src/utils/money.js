// Shared money formatting for the admin UI — the single source for decimal/rounding.
// formatMoney returns a raw 2-decimal string with NO currency label; pair it with a
// ` JD` literal or a styled JD <span> in markup, exactly as the call site already does.
export const formatMoney = (v) => (Number(v) || 0).toFixed(2);

// A drawer variance within half a cent is a perfect count — treats sub-cent float
// residue from DECIMAL subtraction as zero so "Perfect" shows instead of "+0.00 JD".
export const varianceIsZero = (v) => Math.abs(Number(v) || 0) < 0.005;


export const SCALE = { g: 1, kg: 1000, ml: 1, l: 1000, unit: 1 };
export const DISPLAY_UNITS = { weight: ['g', 'kg'], volume: ['ml', 'l'], count: ['unit'] };
export const fromBaseQty = (qty, unit) => qty == null ? null : Math.round(Number(qty) / (SCALE[unit] || 1) * 1e6) / 1e6;
export const fromBaseCost = (cost, unit) => Math.round(Number(cost) * (SCALE[unit] || 1) * 1e8) / 1e8;

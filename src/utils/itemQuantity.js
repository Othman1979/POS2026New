// The API stores quantities at six decimals. Keep step arithmetic in millionths.
export function quantityUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d{1,6}(?:\.\d{1,6})?|\.\d{1,6})$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
}
export function quantityText(units) {
  return (units / 1000000).toFixed(6).replace(/\.?0+$/, '') || '0';
}
export function validQuantity(value, max, allowZero = true) {
  const units = quantityUnits(value), limit = quantityUnits(max);
  return units !== null && limit !== null && units >= (allowZero ? 0 : 1) && units <= limit;
}

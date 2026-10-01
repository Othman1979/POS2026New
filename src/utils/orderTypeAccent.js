// Maps an order-type name to a single visual accent used across the Order Notes board:
// the card's inline-start rail, the order-type tag (text + tint), the column/chip dot,
// and the active phone-filter chip. Same type detection as before; deeper 600/700 tones
// for a more classical, less pastel feel (takeaway=teal, delivery=sky, dine=emerald,
// everything else=amber for warmth against the cool trio).
//
// IMPORTANT: every value is a FULL LITERAL Tailwind class string. Never interpolate color
// names (e.g. `text-${c}-700`) — Tailwind's JIT only emits classes it can see as literals.

const TEAL = {
  key: 'takeaway',
  stripe: 'border-teal-600',
  text: 'text-teal-700',
  tint: 'bg-teal-50',
  dot: 'bg-teal-500',
  chip: 'bg-teal-50 text-teal-700 border-teal-200',
};
const SKY = {
  key: 'delivery',
  stripe: 'border-sky-600',
  text: 'text-sky-700',
  tint: 'bg-sky-50',
  dot: 'bg-sky-500',
  chip: 'bg-sky-50 text-sky-700 border-sky-200',
};
const EMERALD = {
  key: 'dine',
  stripe: 'border-emerald-600',
  text: 'text-emerald-700',
  tint: 'bg-emerald-50',
  dot: 'bg-emerald-500',
  chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};
const AMBER = {
  key: 'other',
  stripe: 'border-amber-600',
  text: 'text-amber-700',
  tint: 'bg-amber-50',
  dot: 'bg-amber-500',
  chip: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function getTypeAccent(orderTypeName) {
  if (orderTypeName === null || orderTypeName === undefined) return EMERALD;
  const type = String(orderTypeName).toLowerCase().trim();
  if (type === '') return EMERALD;
  if (type.includes('dine') || type.includes('طاولة') || type.includes('صالة')) return EMERALD;
  if (type.includes('take') || type.includes('سفري') || type.includes('خارجي')) return TEAL;
  if (type.includes('deliv') || type.includes('توصيل')) return SKY;
  return AMBER;
}

import { lineNet, lineTax, posTotals, roundSix } from '@/utils/posTotals.js';
import { quantityUnits, validQuantity } from '@/utils/itemQuantity.js';

const lineIdentity = (item) => JSON.stringify([
  item.order_item_id ?? null,
  item.id ?? item.product_id ?? null,
  item.price ?? null,
  item.note ?? '',
  item.tax_rate ?? null,
  item.jofotara_tax_category ?? null,
  item.modifier_surcharge ?? null,
  item.modifier_tax_amount ?? null,
  item.discountType ?? item.discount_type ?? null,
  item.discountValue ?? item.discount_value ?? null,
  item.selectedModifiers ?? item.modifiers ?? null,
  item.bundleItems ?? null,
]);

const addOrMerge = (items, item) => {
  const next = items.map((entry) => ({ ...entry }));
  const existing = next.find((entry) => lineIdentity(entry) === lineIdentity(item));
  if (existing) existing.qty = roundSix(Number(existing.qty || 0) + Number(item.qty || 0));
  else next.push({ ...item });
  return next;
};

export const splitItemFractionally = (items, index, ways, makeId) => {
  const item = items[index];
  const count = Number(ways);
  if (!item || !Number.isInteger(count) || count < 2) return items.map((entry) => ({ ...entry }));
  const total = Number(item.qty) || 0;
  const piece = roundSix(total / count);
  if (piece <= 0 || roundSix(total - piece * (count - 1)) <= 0) return items.map(entry => ({ ...entry }));
  const pieces = Array.from({ length: count }, (_, pieceIndex) => ({
    ...item,
    qty: pieceIndex === count - 1 ? roundSix(total - piece * (count - 1)) : piece,
    cartId: makeId(),
  }));
  return [...items.slice(0, index).map((entry) => ({ ...entry })), ...pieces, ...items.slice(index + 1).map((entry) => ({ ...entry }))];
};

export const moveSplitItem = ({ fromItems, toItems, index, makeId, moveAll = false, quantity }) => {
  const source = fromItems[index];
  if (!source) return { fromItems: fromItems.map((item) => ({ ...item })), toItems: toItems.map((item) => ({ ...item })) };
  if (quantity !== undefined && !validQuantity(quantity, source.qty, false)) {
    return { fromItems: fromItems.map(item => ({ ...item })), toItems: toItems.map(item => ({ ...item })) };
  }
  const moveQty = quantity !== undefined ? quantityUnits(quantity) / 1000000 : moveAll
    ? Number(source.qty) || 0
    : Number(source.qty) >= 1 ? 1 : Number(source.qty) || 0;
  const moved = { ...source, qty: moveQty, cartId: makeId() };
  const nextFrom = fromItems.map((item) => ({ ...item }));
  if (Number(source.qty) > moveQty) nextFrom[index].qty = roundSix(Number(source.qty) - moveQty);
  else nextFrom.splice(index, 1);
  return { fromItems: nextFrom, toItems: addOrMerge(toItems, moved) };
};

const moneyToCents = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100);

const allocateCents = (targetCents, weights, capacities = null) => {
  if (!Number.isSafeInteger(targetCents) || targetCents < 0 || !weights.length) return weights.map(() => 0);
  const safeWeights = weights.map((value) => Math.max(0, Number(value) || 0));
  if (targetCents === 0) return safeWeights.map(() => 0);
  if (safeWeights.every((value) => value === 0)) return safeWeights.map(() => 0);
  const result = safeWeights.map(() => 0);
  let remaining = targetCents;
  while (remaining > 0) {
    const active = result
      .map((allocated, index) => ({ index, capacity: capacities ? capacities[index] - allocated : remaining }))
      .filter((value) => value.capacity > 0);
    if (!active.length) break;
    const activeWeight = active.reduce((sum, value) => sum + safeWeights[value.index], 0);
    const raw = active.map((value) => ({
      ...value,
      share: remaining * (activeWeight > 0 ? safeWeights[value.index] / activeWeight : 1 / active.length),
    }));
    let distributed = 0;
    raw.forEach((value) => {
      const cents = Math.min(Math.floor(value.share), value.capacity);
      result[value.index] += cents;
      distributed += cents;
    });
    remaining -= distributed;
    if (!remaining) break;
    const order = raw
      .filter((value) => result[value.index] < (capacities ? capacities[value.index] : targetCents))
      .sort((left, right) => (
        (right.share - Math.floor(right.share)) - (left.share - Math.floor(left.share))
        || left.index - right.index
      ));
    if (distributed === 0 || remaining < order.length) {
      for (const value of order) {
        if (!remaining) break;
        result[value.index] += 1;
        remaining -= 1;
      }
    }
  }
  return result;
};

export const validateSplitMoneyCents = (value) => {
  const components = ['subtotal', 'discount', 'tax', 'total'];
  if (!value || typeof value !== 'object') throw new Error('Split money allocation is invalid.');
  const allocation = Object.fromEntries(components.map((component) => [component, value[component]]));
  if (Object.values(allocation).some((cents) => !Number.isSafeInteger(cents) || cents < 0)
    || allocation.discount > allocation.subtotal
    || allocation.subtotal - allocation.discount + allocation.tax !== allocation.total) {
    throw new Error('Split money allocation is invalid.');
  }
  return allocation;
};

const addServiceCharge = ({ items, serviceChargeLine, cents, index, makeId }) => (
  cents > 0 ? [...items, { ...serviceChargeLine, id: `FEE_SPLIT_PREVIEW_${index}`, cartId: makeId(), price: cents / 100, qty: 1 }] : items
);

export const buildSplitPreview = ({
  seats = [],
  unassignedItems = [],
  parentTotals = null,
  orderDiscount = null,
  serviceChargeSnapshot = null,
  serviceChargeLine = null,
  taxInclusive = false,
  taxExempt = false,
} = {}) => {
  const candidates = [
    ...(unassignedItems.length ? [{ id: 'unassigned', items: unassignedItems }] : []),
    ...seats,
  ].filter((bucket) => Array.isArray(bucket.items) && bucket.items.length > 0)
    .map((bucket) => ({
      id: bucket.id,
      items: bucket.items.filter((item) => item.note !== 'Auto-Gratuity').map((item) => ({ ...item })),
    }));
  if (!candidates.length) return { buckets: [], byId: new Map() };

  const baseWeights = candidates.map((bucket) => bucket.items.reduce(
    (sum, item) => sum + lineNet(item, { taxInclusive, taxExempt }), 0
  ));
  const serviceChargeTarget = serviceChargeLine && serviceChargeSnapshot
    ? Math.max(0, moneyToCents(serviceChargeLine.price))
    : 0;
  const serviceChargeCents = allocateCents(serviceChargeTarget, baseWeights);
  const bucketsWithFees = candidates.map((bucket, index) => ({
    ...bucket,
    serviceChargeCents: serviceChargeCents[index],
    items: serviceChargeCents[index] > 0
      ? [...bucket.items, { ...serviceChargeLine, price: serviceChargeCents[index] / 100, qty: 1 }]
      : bucket.items,
  }));

  const combinedItems = bucketsWithFees.flatMap((bucket) => bucket.items);
  const authoritativeTotals = parentTotals || posTotals(combinedItems, orderDiscount || {}, { taxInclusive, taxExempt });
  const subtotalTarget = Math.max(0, moneyToCents(authoritativeTotals.subtotal));
  const discountTarget = Math.min(subtotalTarget, Math.max(0, moneyToCents(authoritativeTotals.discount)));
  const totalTarget = Math.max(0, moneyToCents(authoritativeTotals.total));
  const taxTarget = Math.max(0, totalTarget - subtotalTarget + discountTarget);
  const baseTotals = bucketsWithFees.map((bucket) => posTotals(bucket.items, {}, { taxInclusive, taxExempt }));
  const subtotalWeights = baseTotals.map((value) => value.subtotal);
  const subtotalCents = allocateCents(subtotalTarget, subtotalWeights);
  let rawTotals = baseTotals;
  let discountCents;
  if (orderDiscount?.type === 'percent') {
    rawTotals = bucketsWithFees.map((bucket) => posTotals(bucket.items, orderDiscount, { taxInclusive, taxExempt }));
    discountCents = allocateCents(discountTarget, rawTotals.map((value) => value.discount), subtotalCents);
  } else {
    discountCents = allocateCents(discountTarget, subtotalWeights, subtotalCents);
  }
  const seatDiscount = (index) => {
    if (!orderDiscount?.type || discountTarget === 0) return null;
    if (orderDiscount.type === 'percent') return { type: 'percent', value: Math.min(100, Number(orderDiscount.value) || 0) };
    return { type: 'fixed', value: discountCents[index] / 100 };
  };
  if (orderDiscount?.type !== 'percent') {
    rawTotals = bucketsWithFees.map((bucket, index) => (
      posTotals(bucket.items, seatDiscount(index) || {}, { taxInclusive, taxExempt })
    ));
  }
  const taxCents = allocateCents(taxTarget, rawTotals.map((value) => value.tax));
  const buckets = bucketsWithFees.map((bucket, index) => {
    const totalCents = subtotalCents[index] - discountCents[index] + taxCents[index];
    const ratio = rawTotals[index].discountRatio;
    const itemWeights = bucket.items.map((item) => (
      lineNet(item, { taxInclusive, taxExempt }) * ratio + lineTax(item, ratio, { taxInclusive, taxExempt })
    ));
    return {
      ...bucket,
      subtotalCents: subtotalCents[index],
      discountCents: discountCents[index],
      taxCents: taxCents[index],
      totalCents,
      itemTotalCents: allocateCents(totalCents, itemWeights),
    };
  });
  return { buckets, byId: new Map(buckets.map((bucket) => [bucket.id, bucket])) };
};

export const buildSplitRequest = ({
  table, seats, remainingItems = [], remainingCheckId = null, orderDiscount, serviceChargeSnapshot, serviceChargeLine, makeId,
  parentTotals = null, taxInclusive = false, taxExempt = false, allowRemainingOnly = false,
}) => {
  const activeSeats = seats.filter((seat) => seat.items.length > 0);
  if (!activeSeats.length && !(allowRemainingOnly && remainingItems.length)) return null;
  const buckets = [
    ...(remainingItems.length ? [{ id: 'remaining', heldId: remainingCheckId, name: 'Remaining Check', split_role: 'remainder', items: remainingItems }] : []),
    ...activeSeats.map((seat) => ({ ...seat, split_role: 'check' })),
  ];
  const preview = buildSplitPreview({
    seats: buckets, unassignedItems: [], parentTotals, orderDiscount,
    serviceChargeSnapshot, serviceChargeLine, taxInclusive, taxExempt,
  });
  return {
    tableId: table.id,
    currentOrderId: table.current_order_id,
    splits: buckets.map((seat, index) => {
      const bucket = preview.byId.get(seat.id);
      const items = addServiceCharge({
        items: seat.items.filter((item) => item.note !== 'Auto-Gratuity').map((item) => ({ ...item })),
        serviceChargeLine,
        cents: bucket.serviceChargeCents,
        index,
        makeId,
      });
      const type = orderDiscount?.type;
      const order_discount = type === 'percent' && Number(orderDiscount.value) > 0
        ? { type, value: Math.min(100, Number(orderDiscount.value)) }
        : type === 'fixed' && Number(orderDiscount.value) > 0
          ? { type, value: bucket.discountCents / 100 }
          : null;
      return {
        id: seat.heldId ?? undefined,
        referenceName: `Table ${table.table_number} - ${seat.name}`,
        split_role: seat.split_role,
        items,
        subtotal: bucket.totalCents / 100,
        order_discount,
      };
    }),
    voidReason: 'Bill Split',
    tax_exempt: taxExempt === true,
  };
};

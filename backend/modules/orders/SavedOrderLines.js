const CHECKOUT_MESSAGE = 'Items cannot be changed while cashing out. Edit the order on the floor plan first.';
const IDENTITY_MESSAGE = 'Saved item identity changed. Refresh the order and try again.';
const TABLE_MESSAGE = 'Saved item context is stale or ambiguous. Refresh the order and try again.';

function savedLineKey(line) {
  const productId = line.product_id;
  const name = line.item_name || line.name || '';
  const note = line.note || '';
  return `${productId != null ? productId : `custom:${name}`}|${note}`;
}

function finiteOrNull(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function storedSnapshot(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  try { return JSON.stringify(value); } catch (_) { return null; }
}

function parseSnapshot(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function snapshotsMatch(savedValue, submittedValue) {
  const saved = parseSnapshot(savedValue);
  const submitted = parseSnapshot(submittedValue);
  if (!saved || !submitted || saved.length !== submitted.length) return false;
  return saved.every((entry, index) => {
    const candidate = submitted[index];
    if (!entry || !candidate) return false;
    if (entry.gid && entry.oid && candidate.gid && candidate.oid) {
      return entry.gid === candidate.gid && entry.oid === candidate.oid;
    }
    return entry.group === candidate.group && entry.option === candidate.option;
  });
}

function sameIdentity(context, line) {
  const sameProduct = context.product_id == null
    ? line.product_id == null
    : Number(context.product_id) === Number(line.product_id);
  const sameNote = context.note === (line.note || '');
  const submittedName = line.item_name || line.name || '';
  return sameProduct && sameNote && (context.product_id != null || context.name === submittedName);
}

function error(message, statusCode) {
  const result = new Error(message);
  result.statusCode = statusCode;
  return result;
}

function addToSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function buildSavedLineIndex(savedLines) {
  const index = {
    rowById: new Map(),
    claimedTableRowIds: new Set(),
    contextsByKey: new Map(),
    pricesByKey: new Map(),
    taxRatesByKey: new Map(),
    taxCategoriesByKey: new Map(),
    modifierSnapshotsByKey: new Map(),
    surchargesByKey: new Map(),
    modifierTaxesByKey: new Map(),
    namesByKey: new Map()
  };

  for (const row of savedLines) {
    const key = savedLineKey(row);
    const context = {
      price: finiteOrNull(row.price_at_sale),
      priceBeforeTaxExemption: finiteOrNull(row.price_before_tax_exemption),
      taxRate: Number(row.tax_rate),
      taxCategory: row.jofotara_tax_category || null,
      product_id: row.product_id != null ? Number(row.product_id) : null,
      name: row.item_name || '',
      note: row.note || '',
      selectedModifiers: storedSnapshot(row.selected_modifiers),
      modifier_surcharge: finiteOrNull(row.modifier_surcharge),
      modifier_tax_amount: finiteOrNull(row.modifier_tax_amount),
      remaining: finiteOrNull(row.quantity) || 0,
      recipe_line_key: row.recipe_line_key || null,
      stock_authority: row.stock_authority || 'legacy',
      stock_snapshot: storedSnapshot(row.stock_snapshot),
      matchedById: false
    };
    if (row.id != null) index.rowById.set(Number(row.id), context);
    if (!index.contextsByKey.has(key)) index.contextsByKey.set(key, []);
    index.contextsByKey.get(key).push(context);
    addToSet(index.pricesByKey, key, context.price);
    if (Number.isFinite(context.taxRate)) addToSet(index.taxRatesByKey, key, context.taxRate);
    addToSet(index.taxCategoriesByKey, key, context.taxCategory);
    addToSet(index.modifierSnapshotsByKey, key, context.selectedModifiers);
    addToSet(index.surchargesByKey, key, context.modifier_surcharge);
    addToSet(index.modifierTaxesByKey, key, context.modifier_tax_amount);
    addToSet(index.namesByKey, key, context.name);
  }
  return index;
}

function checkoutFallback(index, line, options) {
  const key = savedLineKey(line);
  const contexts = index.contextsByKey.get(key);
  if (!contexts) return null;

  const prices = index.pricesByKey.get(key);
  const taxRates = index.taxRatesByKey.get(key);
  const taxCategories = index.taxCategoriesByKey.get(key);
  const surcharges = index.surchargesByKey.get(key);
  const modifierTaxes = index.modifierTaxesByKey.get(key);
  const recipeKeys = new Set(contexts.map(context => context.recipe_line_key));
  const stockKeys = new Set(contexts.map(context => JSON.stringify([context.stock_authority, context.stock_snapshot])));
  if (prices.size !== 1 || surcharges.size !== 1 || modifierTaxes.size !== 1 ||
    recipeKeys.size !== 1 || stockKeys.size !== 1 ||
    (!options.allowMissingTax && (!taxRates || taxRates.size !== 1 || !taxCategories || taxCategories.size !== 1))) {
    throw error(CHECKOUT_MESSAGE, 403);
  }

  const price = [...prices][0];
  const taxRate = taxRates?.size === 1 ? [...taxRates][0] : null;
  const taxCategory = taxCategories?.size === 1 ? [...taxCategories][0] : null;
  const surcharge = [...surcharges][0];
  const modifierTax = [...modifierTaxes][0];
  const snapshots = index.modifierSnapshotsByKey.get(key);
  let selectedModifiers = snapshots.size === 1 ? [...snapshots][0] : null;
  if (snapshots.size > 1) {
    const matchingSnapshot = line.selectedModifiers && [...snapshots]
      .find(snapshot => snapshot && snapshotsMatch(snapshot, line.selectedModifiers));
    selectedModifiers = matchingSnapshot || null;
  }

  const names = index.namesByKey.get(key);
  return {
    ...contexts[0],
    price,
    taxRate,
    taxCategory,
    selectedModifiers,
    modifier_surcharge: surcharge,
    modifier_tax_amount: modifierTax,
    name: names.size === 1 ? [...names][0] : null,
    matchedById: false
  };
}

function resolveCheckoutSavedLine(index, submittedLine, options = {}) {
  const lineId = submittedLine.order_item_id != null ? Number(submittedLine.order_item_id) : null;
  if (lineId != null) {
    const context = index.rowById.get(lineId);
    if (context) {
      if (!sameIdentity(context, submittedLine)) throw error(IDENTITY_MESSAGE, 409);
      const quantity = finiteOrNull(submittedLine.qty != null ? submittedLine.qty : submittedLine.quantity) || 0;
      if (context.remaining >= quantity - 1e-9) {
        context.remaining -= quantity;
        return { ...context, matchedById: true };
      }
    }
  }
  return checkoutFallback(index, submittedLine, options);
}

function resolveTableSavedLine(index, submittedLine) {
  const lineId = submittedLine.order_item_id != null ? Number(submittedLine.order_item_id) : null;
  if (lineId != null) {
    const context = index.rowById.get(lineId);
    if (context) {
      if (!sameIdentity(context, submittedLine)) throw error(IDENTITY_MESSAGE, 409);
      if (index.claimedTableRowIds.has(lineId)) throw error(TABLE_MESSAGE, 409);
      index.claimedTableRowIds.add(lineId);
      return { ...context, matchedById: true };
    }
  }
  const contexts = index.contextsByKey.get(savedLineKey(submittedLine));
  if (!contexts) return null;
  const completeContexts = new Map();
  for (const context of contexts) {
    const key = JSON.stringify([context.price, context.taxRate, context.taxCategory, context.modifier_surcharge, context.modifier_tax_amount, context.selectedModifiers, context.recipe_line_key, context.stock_authority, context.stock_snapshot]);
    completeContexts.set(key, context);
  }
  if (completeContexts.size !== 1) throw error(TABLE_MESSAGE, 409);
  return { ...completeContexts.values().next().value, matchedById: false };
}

function priceMapFor(index) {
  const prices = new Map();
  for (const [key, contexts] of index.contextsByKey) {
    prices.set(key, contexts[contexts.length - 1].price);
  }
  return prices;
}

function taxOverridesFor(resolvedContexts) {
  const overrides = new Map();
  for (const [line, context] of resolvedContexts) {
    const taxRate = Number(context?.taxRate);
    if (Number.isFinite(taxRate)) overrides.set(line, taxRate);
  }
  return overrides;
}

function hasVoidsOrReductions(newCart, existingItems) {
  const existingMap = new Map();
  for (const item of existingItems) {
    if (item.product_id == null && !(item.item_name || item.name)) continue;
    const key = savedLineKey(item);
    const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
    existingMap.set(key, (existingMap.get(key) || 0) + qty);
  }

  const newMap = new Map();
  for (const item of newCart) {
    if (item.product_id == null && !(item.item_name || item.name)) continue;
    const key = savedLineKey(item);
    const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
    newMap.set(key, (newMap.get(key) || 0) + qty);
  }

  for (const [key, existingQty] of existingMap.entries()) {
    if ((newMap.get(key) || 0) < existingQty) return true;
  }
  return false;
}

function getNewItems(newCart, existingItems) {
  const existingQty = new Map();
  for (const item of existingItems) {
    const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
    const key = savedLineKey(item);
    existingQty.set(key, (existingQty.get(key) || 0) + qty);
  }

  const newAgg = new Map();
  for (const newItem of newCart) {
    const key = savedLineKey(newItem);
    const qty = newItem.qty !== undefined ? Number(newItem.qty) : Number(newItem.quantity || 0);
    if (newAgg.has(key)) newAgg.get(key).qty += qty;
    else newAgg.set(key, { item: newItem, qty });
  }

  const newItemsToPrint = [];
  for (const { item, qty } of newAgg.values()) {
    const diffQty = qty - (existingQty.get(savedLineKey(item)) || 0);
    if (diffQty > 0) newItemsToPrint.push({ ...item, qty: diffQty });
  }
  return newItemsToPrint;
}

module.exports = {
  savedLineKey,
  buildSavedLineIndex,
  resolveCheckoutSavedLine,
  resolveTableSavedLine,
  priceMapFor,
  taxOverridesFor,
  hasVoidsOrReductions,
  getNewItems
};

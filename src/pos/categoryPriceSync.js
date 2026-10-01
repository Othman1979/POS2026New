import { isNoteProduct, noteProductGrossPrice, noteProductIds, syncNoteProducts } from '@/pos/noteProductSelections.js';

const round = (value, places = 4) => Number(Number(value || 0).toFixed(places));

const productIdOf = (line) => line?.product_id ?? line?.id;

// Only an unsaved, ordinary register line may follow a catalog price change.
// Tables and saved/manager-entered lines carry deliberate historical prices.
export const chunkProductIds = (ids, size = 300) => {
    const chunks = [];
    for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
    return chunks;
};

export const collectCartCatalogProductIds = lines => [...new Set(
    (lines || []).filter(item => item && !item.is_custom && !item.is_notes && !item.is_service_charge)
        .flatMap(item => [
            Number(productIdOf(item)),
            ...(!item.order_item_id && !item.manual_price_override ? noteProductIds(item) : [])
        ])
        .filter(id => Number.isSafeInteger(id) && id > 0)
)];

export const requestedIdsCoverCurrentDraft = (requestedIds, currentIds) => {
    const requested = new Set(requestedIds);
    return currentIds.every(id => requested.has(id));
};

export function syncCategoryPrices(lines, resolvedProducts, { calculateModifierTax, refreshPrices = true } = {}) {
    const byId = new Map((resolvedProducts || []).map(product => [String(product.product_id), product]));
    const modifierTax = calculateModifierTax || ((line, taxRate) => {
        const surcharge = Number(line.modifier_surcharge || 0);
        return taxRate > 0 ? round(surcharge - surcharge / (1 + taxRate / 100), 6) : 0;
    });

    let repairedNoteSelections = 0;
    for (const line of lines || []) {
        if (!line || line.is_custom || line.is_notes || line.is_service_charge) continue;
        const resolved = byId.get(String(productIdOf(line)));
        if (!resolved) continue;
        line.price_override_locked = Number(resolved.price_override_locked) || 0;
        if (!refreshPrices || line.order_item_id || line.manual_price_override) continue;
        const taxRate = Number(resolved.tax_rate ?? line.tax_rate ?? 0);
        line.tax_rate = taxRate;
        const { repaired } = syncNoteProducts(line, byId);
        repairedNoteSelections += repaired;
        line.price = round(Number(resolved.price || 0) + Number(line.modifier_surcharge || 0));
        line.modifier_tax_amount = calculateModifierTax
            ? modifierTax(line, taxRate)
            : line.modifier_tax_amount;
    }
    return { lines, repairedNoteSelections };
}

// True when syncCategoryPrices would change a line's price, tax or priced notes
// given these catalog rows (GET /products rows carry the same resolved price as
// the resolve endpoint). A line or priced note the rows cannot confirm (its row
// is not loaded) counts as disagreeing, so it is re-resolved rather than trusted.
export function cartDisagreesWithCatalogRows(lines, catalogRows) {
    const byId = new Map((catalogRows || []).map(row => [String(row.id), row]));
    return (lines || []).some(line => {
        if (!line || line.is_custom || line.is_notes || line.is_service_charge) return false;
        if (line.order_item_id || line.manual_price_override) return false;
        const row = byId.get(String(productIdOf(line)));
        if (!row || round(Number(row.price || 0) + Number(line.modifier_surcharge || 0)) !== round(line.price)) return true;
        if (row.tax_rate != null && Number(line.tax_rate ?? 0) !== Number(row.tax_rate)) return true;
        return (Array.isArray(line.selectedModifiers) ? line.selectedModifiers : []).some(selection => {
            if (!selection?.noteProductId) return false;
            const noteRow = byId.get(String(selection.noteProductId));
            // syncNoteProducts rewrites the note's price and wording from its row.
            const name = String(noteRow?.name || '').trim();
            return !noteRow || !isNoteProduct(noteRow) || Number(noteRow.category_is_active) !== 1
                || noteProductGrossPrice(noteRow) !== Number(selection.price)
                || selection.group !== name || selection.option !== name;
        });
    });
}

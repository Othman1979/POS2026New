import { modifierTaxAmount, roundSix } from '@/utils/posTotals.js';

const safeId = value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const boundedSelections = line => (Array.isArray(line?.selectedModifiers) ? line.selectedModifiers : []).slice(0, 50);
const noteSelections = line => boundedSelections(line).filter(selection => safeId(selection?.noteProductId));
const priceOf = selection => Math.max(0, Number(selection?.price) || 0);
const sumPrices = selections => roundSix(selections.reduce((sum, selection) => sum + priceOf(selection), 0));
const noteProductDisplayLine = selection => Number(selection?.price) > 0
    ? `${selection.option} (+${Number(selection.price).toFixed(2)})`
    : String(selection?.option || '');
const modifierDisplayLine = selection => {
    if (safeId(selection?.noteProductId)) return noteProductDisplayLine(selection);
    const group = String(selection?.group || '').trim();
    const option = String(selection?.option || '').trim();
    if (!option) return '';
    const label = group ? `${group}: ${option}` : option;
    return Number(selection?.price) > 0
        ? `${label} (${Number(selection.price).toFixed(2)} JD)`
        : label;
};
const linesOf = note => String(note || '').split('\n').map(line => line.trim()).filter(Boolean);

export const noteProductGrossPrice = product => roundSix(
    Number(product?.price || 0) * (1 + Number(product?.tax_rate || 0) / 100)
);

export const isNoteProduct = product => Number(product?.category_is_notes) === 1;
export const noteProductIds = line => noteSelections(line).map(selection => safeId(selection.noteProductId));
export const hasNoteProduct = (line, productId) => noteProductIds(line).includes(safeId(productId));

const removeGeneratedLines = (note, selections) => {
    const lines = linesOf(note);
    for (const selection of [...selections].reverse()) {
        const index = lines.lastIndexOf(modifierDisplayLine(selection));
        if (index >= 0) lines.splice(index, 1);
    }
    return lines;
};

const composeNote = (manualLines, selections) => [
    ...manualLines,
    ...selections.map(modifierDisplayLine).filter(Boolean)
].join('\n');

const writeModifierMoney = (line, nonNoteSurcharge, nextNoteSurcharge) => {
    const surcharge = roundSix(Math.max(0, nonNoteSurcharge + nextNoteSurcharge));
    line.modifier_surcharge = surcharge > 0 ? surcharge : null;
    const includedTax = modifierTaxAmount(surcharge, Number(line.tax_rate || 0));
    line.modifier_tax_amount = includedTax == null ? null : roundSix(includedTax);
};

const nonNoteSurchargeOf = (line, currentNoteSelections) => {
    const current = Number(line?.modifier_surcharge);
    if (Number.isFinite(current) && current >= 0) {
        return roundSix(Math.max(0, current - sumPrices(currentNoteSelections)));
    }
    const excluded = new Set(currentNoteSelections);
    return sumPrices((Array.isArray(line?.selectedModifiers) ? line.selectedModifiers : [])
        .filter(selection => !safeId(selection?.noteProductId) && !excluded.has(selection)));
};

const resolvedNoteProduct = (resolvedById, id) => {
    const product = resolvedById.get(id) || resolvedById.get(String(id));
    return product && Number(product.product_is_active) === 1
        && Number(product.category_is_active) === 1
        && Number(product.category_is_notes) === 1
        ? product
        : null;
};

const isLegacyPricedNote = (selection, noteLines) => {
    if (!selection || safeId(selection.noteProductId) || selection.gid || selection.oid) return false;
    if (String(selection.group || '').trim() !== String(selection.option || '').trim()) return false;
    if (!(Number(selection.price) > 0)) return false;
    return noteLines.includes(noteProductDisplayLine(selection));
};

export const editableItemNote = line => removeGeneratedLines(line?.note, boundedSelections(line)).join('\n');

export const saveEditableItemNote = (line, manualText) => {
    line.note = composeNote(linesOf(manualText), boundedSelections(line));
};

export const syncNoteProducts = (line, resolvedById) => {
    const all = boundedSelections(line);
    const currentNotes = noteSelections(line);
    let manualLines = removeGeneratedLines(line?.note, all);
    const legacy = new Set(all.filter(selection => isLegacyPricedNote(selection, manualLines)));
    for (const selection of legacy) {
        const index = manualLines.lastIndexOf(noteProductDisplayLine(selection));
        if (index >= 0) manualLines.splice(index, 1);
    }

    const oldNoteLike = [...currentNotes, ...legacy];
    const nonNoteSurcharge = nonNoteSurchargeOf(line, oldNoteLike);
    const next = [];
    const nextNotes = [];
    const seen = new Set();
    let repaired = 0;

    for (const selection of all) {
        if (legacy.has(selection)) {
            repaired += 1;
            continue;
        }
        const id = safeId(selection?.noteProductId);
        if (!id) {
            next.push(selection);
            continue;
        }
        if (seen.has(id)) {
            repaired += 1;
            continue;
        }
        seen.add(id);
        const product = resolvedNoteProduct(resolvedById, id);
        if (!product) {
            repaired += 1;
            continue;
        }
        const name = String(product.name || '').trim();
        const canonical = { noteProductId: id, group: name, option: name, price: noteProductGrossPrice(product) };
        next.push(canonical);
        nextNotes.push(canonical);
    }

    line.selectedModifiers = next.length ? next : null;
    line.note = composeNote(manualLines, next);
    writeModifierMoney(line, nonNoteSurcharge, sumPrices(nextNotes));
    return { repaired };
};

export const toggleNoteProduct = (line, product) => {
    const id = safeId(product?.id);
    if (!line || !id) return false;

    const all = [...boundedSelections(line)];
    const currentNotes = noteSelections(line);
    const manualLines = removeGeneratedLines(line.note, all);
    const oldNoteTotal = sumPrices(currentNotes);
    const nonNoteSurcharge = nonNoteSurchargeOf(line, currentNotes);
    const existingIndex = all.findIndex(selection => safeId(selection?.noteProductId) === id);

    if (existingIndex >= 0) {
        all.splice(existingIndex, 1);
    } else {
        if (all.length >= 50) return false;
        const name = String(product?.name || '').trim();
        all.push({ noteProductId: id, group: name, option: name, price: noteProductGrossPrice(product) });
    }

    const nextNotes = all.filter(selection => safeId(selection?.noteProductId));
    const nextNoteTotal = sumPrices(nextNotes);
    line.selectedModifiers = all.length ? all : null;
    line.note = composeNote(manualLines, all);
    line.price = Number((Number(line.price || 0) + nextNoteTotal - oldNoteTotal).toFixed(4));
    writeModifierMoney(line, nonNoteSurcharge, nextNoteTotal);
    return existingIndex < 0;
};

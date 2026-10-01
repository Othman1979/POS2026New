import { fromBaseQty } from '../shared/ingredientUnits.js';
const REASONS = {
    spoiled: ['Spoiled', 'تالف'], expired: ['Expired', 'منتهي الصلاحية'],
    dropped_or_burnt: ['Dropped or burnt', 'سقط أو احترق'],
    over_prepared: ['Over-prepared', 'تحضير زائد'], staff_meal: ['Staff meal', 'وجبة موظف'],
    other: ['Other', 'أخرى'],
};

export function ingredientQuantity(qty, unit) {
    if (qty == null) return '—';
    return `${fromBaseQty(qty, unit)} ${unit || ''}`.trim();
}

export function ingredientWasteRows(data) {
    return (data.ingredients || []).flatMap(row => Object.entries(row.waste_by_reason || {}).map(([reason, qty]) => ({
        key: `${row.id}-${reason}`, name: row.name,
        reason: REASONS[reason]?.[data.direction === 'rtl' ? 1 : 0] || reason,
        qty: ingredientQuantity(qty, row.display_unit),
    })));
}

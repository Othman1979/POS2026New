const COMPONENTS = ['subtotal', 'discount', 'tax', 'total'];

const moneyToCents = (value) => {
    const money = Number(value);
    if (!Number.isFinite(money)) throw new Error('Invalid money value.');
    const cents = Math.round((money + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(cents)) throw new Error('Money value exceeds safe integer cents.');
    return cents;
};

function allocateCents(targetCents, weights, capacities = null) {
    if (!Number.isSafeInteger(targetCents) || targetCents < 0
        || !Array.isArray(weights) || weights.length === 0) {
        throw new Error('Invalid cent allocation input.');
    }
    if (capacities !== null && (!Array.isArray(capacities) || capacities.length !== weights.length
        || capacities.some(value => !Number.isSafeInteger(value) || value < 0))) {
        throw new Error('Invalid cent allocation capacity.');
    }
    if (capacities && capacities.reduce((sum, value) => sum + value, 0) < targetCents) {
        throw new Error('Cent allocation exceeds capacity.');
    }

    const numericWeights = weights.map(Number);
    if (numericWeights.some(value => !Number.isFinite(value))) {
        throw new Error('Cent allocation weight must be finite.');
    }
    const safeWeights = numericWeights.map(value => Math.max(0, value));
    if (targetCents === 0) return safeWeights.map(() => 0);
    const totalWeight = safeWeights.reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) throw new Error('Cent allocation has no positive weight.');

    const result = safeWeights.map(() => 0);
    let remaining = targetCents;
    while (remaining > 0) {
        const active = result
            .map((allocated, index) => ({ index, capacity: capacities ? capacities[index] - allocated : remaining }))
            .filter(value => value.capacity > 0);
        if (active.length === 0) throw new Error('Cent allocation exceeds capacity.');

        const activeWeight = active.reduce((sum, value) => sum + safeWeights[value.index], 0);
        const raw = active.map(value => ({
            ...value,
            share: remaining * (activeWeight > 0 ? safeWeights[value.index] / activeWeight : 1 / active.length)
        }));
        let distributed = 0;
        for (const value of raw) {
            const cents = Math.min(Math.floor(value.share), value.capacity);
            result[value.index] += cents;
            distributed += cents;
        }
        remaining -= distributed;
        if (remaining === 0) break;

        const order = raw
            .filter(value => result[value.index] < (capacities ? capacities[value.index] : targetCents))
            .sort((left, right) =>
                (right.share - Math.floor(right.share)) - (left.share - Math.floor(left.share))
                || left.index - right.index);
        if (distributed === 0 || remaining < order.length) {
            for (const value of order) {
                if (remaining === 0) break;
                result[value.index] += 1;
                remaining -= 1;
            }
        }
    }
    return result;
}

const validateSplitMoneyCents = (value) => {
    if (!value || typeof value !== 'object') throw new Error('Split money allocation must be an object.');
    const allocation = Object.fromEntries(COMPONENTS.map(component => [component, value[component]]));
    for (const [component, cents] of Object.entries(allocation)) {
        if (!Number.isSafeInteger(cents)) {
            throw new Error(`Split money ${component} must be an integer.`);
        }
        if (cents < 0) throw new Error(`Split money ${component} must be non-negative.`);
    }
    if (allocation.discount > allocation.subtotal) {
        throw new Error('Split money discount exceeds subtotal.');
    }
    if (allocation.subtotal - allocation.discount + allocation.tax !== allocation.total) {
        throw new Error('Split money allocation does not foot.');
    }
    return allocation;
};

const allocateSplitMoneyCents = (parentTotals, seatTotals) => {
    if (!parentTotals || !Array.isArray(seatTotals) || seatTotals.length === 0) {
        throw new Error('Invalid split money allocation input.');
    }
    const parent = {
        subtotal: moneyToCents(parentTotals.subtotal),
        tax: moneyToCents(parentTotals.tax),
        total: moneyToCents(parentTotals.total)
    };
    parent.discount = parent.subtotal + parent.tax - parent.total;
    if (Object.values(parent).some(value => value < 0) || parent.discount > parent.subtotal) {
        throw new Error('Invalid parent split money totals.');
    }

    const subtotals = allocateCents(parent.subtotal, seatTotals.map(value => value?.subtotal));
    const discounts = allocateCents(
        parent.discount,
        seatTotals.map(value => value?.discount),
        subtotals
    );
    const taxes = allocateCents(parent.tax, seatTotals.map(value => value?.tax));
    const allocations = seatTotals.map((_, index) => validateSplitMoneyCents({
        subtotal: subtotals[index],
        discount: discounts[index],
        tax: taxes[index],
        total: subtotals[index] - discounts[index] + taxes[index]
    }));

    for (const component of COMPONENTS) {
        const expected = parent[component];
        const actual = allocations.reduce((sum, value) => sum + value[component], 0);
        if (actual !== expected) throw new Error(`Split money ${component} does not conserve parent cents.`);
    }
    return allocations;
};

module.exports = {
    allocateCents,
    allocateSplitMoneyCents,
    validateSplitMoneyCents,
    moneyToCents
};

// Tracks which resources were dirtied while a kept-alive page was off-screen.
// A socket generation change while inactive (reconnect, or never observed)
// forces recovery of everything, matching the previous unconditional refresh.
export function createKeepAliveRefreshTracker() {
    const dirty = new Set();
    const catalogIds = new Set();
    let generationAtDeactivation = null;
    const markDirty = kind => dirty.add(kind); // kinds: 'catalog' | 'stock' | 'settings' | 'held' | 'shift' | 'tables'
    return {
        markDirty,
        // Mirrors the active inventory_changed handler: availability has its own
        // event, stock only moves balances, a scoped catalog event names its rows,
        // anything else keeps the full catalog refresh.
        markInventoryChanged: payload => {
            if (payload?.scope === 'availability') return;
            if (payload?.scope === 'stock') return markDirty('stock');
            if (payload?.scope === 'catalog' && Array.isArray(payload.productIds) && payload.productIds.length) {
                for (const id of payload.productIds) catalogIds.add(String(id));
                return;
            }
            markDirty('catalog');
        },
        deactivate: generation => {
            dirty.clear();
            catalogIds.clear();
            generationAtDeactivation = generation;
        },
        activate: generation => {
            const recovery = generationAtDeactivation === null || generation !== generationAtDeactivation;
            const catalog = recovery || dirty.has('catalog');
            const result = {
                recovery,
                catalog,
                // A full catalog refresh already covers the narrower kinds.
                stock: !catalog && dirty.has('stock'),
                catalogIds: catalog ? [] : [...catalogIds],
                settings: recovery || dirty.has('settings'),
                held: recovery || dirty.has('held'),
                shift: recovery || dirty.has('shift'),
                tables: recovery || dirty.has('tables')
            };
            dirty.clear();
            catalogIds.clear();
            generationAtDeactivation = null;
            return result;
        }
    };
}

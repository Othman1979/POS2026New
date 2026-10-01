import { createCatalogRefreshScheduler } from './catalogRefreshScheduler.js';

// Deferred till-side reaction to stock events. Which cached scopes hold the
// change is decided when the event arrives, but the read runs later (a 250 ms
// window, or after a read already in flight) and may cache pre-sale rows in the
// meantime or find another scope loaded. So the pending change is re-applied at
// the start of every run: the scopes it names go stale again, and the run's own
// successful read of the loaded scope clears that scope's mark.
export function createStockChangeRefresh({ products, afterRead = () => {}, createScheduler = createCatalogRefreshScheduler }) {
    let all = false;
    let ids = new Set();

    const scheduler = createScheduler(async () => {
        const pendingAll = all;
        const pendingIds = [...ids];
        all = false;
        ids = new Set();
        if (pendingAll) products.markCatalogScopesStale();
        else if (pendingIds.length) products.noteStockChange(pendingIds);
        await products.fetchData({ force: true });
        afterRead();
    });

    return {
        // A named change: true when a read was requested. False means neither the
        // loaded rows nor a read in flight can hold it; cached scopes are marked.
        noteNamed(productIds) {
            if (!products.noteStockChange(productIds)) return false;
            for (const id of productIds) ids.add(String(id));
            scheduler.request();
            return true;
        },
        // Unknown set: every cached scope may hold the change.
        noteUnscoped() {
            products.markCatalogScopesStale();
            all = true;
            scheduler.request();
        },
        cancel() {
            all = false;
            ids = new Set();
            scheduler.cancel();
        },
        pending: scheduler.pending,
    };
}

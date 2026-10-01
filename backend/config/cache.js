let cacheStore = {
    catalogPayload: null,
    catalogEtag: null,
    dashboardAnalyticsCache: null
};
let dashboardCacheGeneration = 0;
let catalogCacheGeneration = 0;
// A restart resets the counter, so a token carries this boot's id too.
const catalogBootId = require('crypto').randomBytes(6).toString('hex');
let pendingCatalogBuild = null;

const beginCatalogBuild = (generation = catalogCacheGeneration) => {
    if (pendingCatalogBuild?.generation === generation) {
        return { owner: false, promise: pendingCatalogBuild.promise };
    }

    let resolveBuild;
    let rejectBuild;
    const promise = new Promise((resolve, reject) => {
        resolveBuild = resolve;
        rejectBuild = reject;
    });
    // The owner may be the only caller. Keep a rejected build from becoming an
    // unhandled rejection while still letting joined callers observe failure.
    promise.catch(() => {});

    const build = { generation, promise };
    pendingCatalogBuild = build;
    const finish = (settle, value) => {
        if (pendingCatalogBuild === build) pendingCatalogBuild = null;
        settle(value);
    };

    return {
        owner: true,
        promise,
        resolve: (value) => finish(resolveBuild, value),
        reject: (error) => finish(rejectBuild, error)
    };
};

module.exports = {
    getCachedCatalog: () => cacheStore.catalogPayload,
    getCachedCatalogEtag: () => cacheStore.catalogEtag,
    getCatalogCacheGeneration: () => catalogCacheGeneration,
    getCatalogGenerationToken: (generation = catalogCacheGeneration) => `${catalogBootId}:${generation}`,
    beginCatalogBuild,
    setCachedCatalog: (payload, etag, generation = catalogCacheGeneration) => {
        if (generation !== catalogCacheGeneration) return false;
        cacheStore.catalogPayload = payload;
        cacheStore.catalogEtag = etag;
        return true;
    },
    invalidateCatalogCache: () => {
        catalogCacheGeneration += 1;
        cacheStore.catalogPayload = null;
        cacheStore.catalogEtag = null;
    },
    getDashboardAnalyticsCache: (key) => {
        const cached = cacheStore.dashboardAnalyticsCache;
        return cached && cached.key === key ? cached : null;
    },
    getDashboardCacheGeneration: () => dashboardCacheGeneration,
    setDashboardAnalyticsCache: (key, payload, expiresAt, generation) => {
        if (!Number.isSafeInteger(generation)
            || generation !== dashboardCacheGeneration) return false;
        cacheStore.dashboardAnalyticsCache = { key, payload, expiresAt };
        return true;
    },
    invalidateDashboardCache: () => {
        dashboardCacheGeneration += 1;
        cacheStore.dashboardAnalyticsCache = null;
    }
};

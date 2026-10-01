import { fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { ref, computed, watch } from 'vue';
import { catalogSettings as settings } from '@/pos/catalogSettings.js';

const sameId = (left, right) => String(left) === String(right);

// Hoisted Module-Scoped States
const categories = ref([]);
const products = ref([]);
// Server catalog generation of the last applied full read (null from older servers).
const catalogGeneration = ref(null);
// Set once a scoped read drops the token; only a full read may restore it.
let catalogGenerationDropped = false;
const isCatalogLoading = ref(false);
const catalogLoadError = ref("");
const productLimit = ref(120);
const productOffset = ref(0);
const totalProducts = ref(0);
const searchQuery = ref("");
const debouncedQuery = ref("");
let debounceTimer = null;
let catalogRequestId = 0;
let catalogReadController = null;
let catalogMetadataLoaded = false;
let retryCatalogOptions = { forceFull: true };
// Same recovery as settings (useTerminal.js): three quick retries for a blip,
// then only events that prove the server is reachable (heartbeat, focus,
// reconnect, Retry). Every one of them is a no-op while the catalog is fine.
const CATALOG_RETRY_MS = [2000, 5000, 10000];
let catalogFailures = 0;
let catalogRetryTimer = null;
const cancelCatalogRecovery = () => {
    clearTimeout(catalogRetryTimer);
    catalogRetryTimer = null;
};
const loadedCatalogScope = ref(null);
const CATALOG_TIMEOUT_MS = 15000;
const CATALOG_NON_JSON = 'CATALOG_NON_JSON';
const CATALOG_SCOPE_CACHE_LIMIT = 6;
const catalogScopeSnapshots = new Map();
const pendingAvailabilityChanges = new Map();
const staleCatalogScopes = new Set();
// Bumped when a stale cached scope's revalidation lands, so the cart can drop
// any price it picked up from the stale rows (screen == charged).
const catalogRevalidations = ref(0);
// The catalog is shared by the POS and table workspace.  Keep the context next to
// the request guard so a late response can never paint the other workspace.
const salesContext = ref('register');
// Categories differ by context (the server filters them), so a context switch
// parks the outgoing context's rail and selection here and restores the
// incoming one on the same frame. `stale` means its categories/settings need a
// full read before they are trusted again.
const contextMetadata = new Map();
const isContextScope = (scope, context) => {
    try { return JSON.parse(scope)[0] === context; } catch (_) { return false; }
};

const activeCategory = ref(null);
const activeSubcategory = ref(null);
const currentSidebarFolder = ref(null);
const catalogScope = computed(() => {
    const query = debouncedQuery.value.trim();
    return JSON.stringify([
        salesContext.value,
        query ? 'search' : activeSubcategory.value !== null ? 'subcategory' : 'category',
        query || String(activeSubcategory.value ?? activeCategory.value ?? '')
    ]);
});

// Hoisted Watchers
watch(searchQuery, (newVal) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Clearing restores a cached scope, so it applies at once. Aborts and
    // request ids already drop superseded reads; the short window only keeps
    // scanner-speed input from fanning out.
    if (!newVal.trim()) {
        debounceTimer = null;
        debouncedQuery.value = newVal;
        return;
    }
    debounceTimer = setTimeout(() => {
        debouncedQuery.value = newVal;
    }, 120);
});

watch(debouncedQuery, () => {
    fetchData({ preferCache: true });
});

watch(currentSidebarFolder, () => {
    if (typeof document === 'undefined') return;
    const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
    schedule(() => {
        const scroller = document.querySelector('#categories-sidebar .category-rail-scroll');
        scroller?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
});

// Hoisted Computed Properties
const mainCategories = computed(() => categories.value.filter(c => !c.parent_id || c.parent_id == 0));
const currentSubcategories = computed(() => {
    if (!currentSidebarFolder.value) return [];
    return categories.value.filter(c => sameId(c.parent_id, currentSidebarFolder.value));
});
// Preserve the raw snapshot for cart/barcode consumers, but never present its
// rows or pagination under a different category/search/workspace selection.
const filteredProducts = computed(() => loadedCatalogScope.value === catalogScope.value ? products.value : []);
const hasMoreProducts = computed(() => loadedCatalogScope.value === catalogScope.value && products.value.length < totalProducts.value);

const isDescendantOf = (subId, parentId) => {
    const visited = new Set();
    let current = categories.value.find(c => sameId(c.id, subId));
    while (current) {
        const id = String(current.id);
        if (visited.has(id)) return false;
        visited.add(id);
        if (sameId(current.parent_id, parentId)) return true;
        current = categories.value.find(c => sameId(c.id, current.parent_id));
    }
    return false;
};

// Hoisted Methods
const setDefaultCategory = () => {
    const mains = categories.value.filter(c => !c.parent_id || c.parent_id == 0);
    if (mains.length === 0) {
        activeCategory.value = null;
        activeSubcategory.value = null;
        currentSidebarFolder.value = null;
        return;
    }

    const mainIds = new Set(mains.map(c => String(c.id)));
    if (activeCategory.value === null || !mainIds.has(String(activeCategory.value))) {
        const mainWithProducts = mains.find((main) => {
            const subIds = categories.value
                .filter(c => sameId(c.parent_id, main.id))
                .map(c => String(c.id));

            return products.value.some((product) => {
                return sameId(product.category_id, main.id) || subIds.includes(String(product.category_id));
            });
        });

        activeCategory.value = (mainWithProducts || mains[0]).id;
        activeSubcategory.value = null;
        currentSidebarFolder.value = activeCategory.value;
        return;
    }

    const selectedMain = mains.find(c => sameId(c.id, activeCategory.value));
    if (selectedMain) activeCategory.value = selectedMain.id;

    if (activeSubcategory.value !== null && !isDescendantOf(activeSubcategory.value, activeCategory.value)) {
        activeSubcategory.value = null;
        currentSidebarFolder.value = activeCategory.value;
    } else if (activeSubcategory.value !== null) {
        const selectedSubcategory = categories.value.find(c => sameId(c.id, activeSubcategory.value));
        if (selectedSubcategory) activeSubcategory.value = selectedSubcategory.id;
    }
};

const applyCatalogSnapshot = (snapshot) => {
    if (snapshot?.categories_included && Array.isArray(snapshot?.categories)) {
        categories.value = snapshot.categories;
        catalogMetadataLoaded = true;
    }
    products.value = Array.isArray(snapshot?.products) ? snapshot.products : [];
    productOffset.value = Number(snapshot?.pagination?.offset || 0);
    totalProducts.value = Number(snapshot?.pagination?.total ?? products.value.length);
    if (snapshot?.selected_category_id && activeCategory.value === null && !debouncedQuery.value) {
        activeCategory.value = snapshot.selected_category_id;
    }
    setDefaultCategory();
};

const invalidateCatalogSnapshots = () => {
    catalogScopeSnapshots.clear();
    contextMetadata.clear();
    staleCatalogScopes.clear();
    pendingAvailabilityChanges.clear();
    catalogRequestId += 1;
    catalogReadController?.abort();
    catalogReadController = null;
    isCatalogLoading.value = false;
};

const applyProductAvailabilityChanges = (changes = []) => {
    // Availability events are authoritative, but must not cancel an in-flight
    // reconnect snapshot that may contain other changes missed while offline.
    // Overlay the event on that response before it can replace the live rows.
    const hasPendingRead = catalogReadController !== null;
    for (const change of Array.isArray(changes) ? changes : []) {
        const productId = change?.product_id;
        if (productId === undefined || productId === null) continue;
        const normalized = {
            product_id: productId,
            is_available: Number(change.is_available),
            can_sell: Number(change.can_sell),
        };
        if (hasPendingRead) pendingAvailabilityChanges.set(String(productId), normalized);
        const product = products.value.find(row => sameId(row.id, productId));
        if (product) {
            product.is_available = normalized.is_available;
            product.can_sell = normalized.can_sell;
        }
        // Patch cached rows after the live proxy write: the current scope's
        // snapshot shares raw objects with products.value, and a raw write
        // first would make the proxy see no change and skip the re-render.
        for (const snapshot of catalogScopeSnapshots.values()) {
            for (const row of snapshot.products) {
                if (sameId(row.id, productId)) {
                    row.is_available = normalized.is_available;
                    row.can_sell = normalized.can_sell;
                }
            }
        }
    }
};

const overlayPendingAvailabilityChanges = (rows) => {
    if (!pendingAvailabilityChanges.size || !Array.isArray(rows)) return;
    for (const product of rows) {
        const change = pendingAvailabilityChanges.get(String(product.id));
        if (!change) continue;
        product.is_available = change.is_available;
        product.can_sell = change.can_sell;
    }
};

const setCatalogScopeSnapshot = (scope, snapshot) => {
    catalogScopeSnapshots.delete(scope);
    catalogScopeSnapshots.set(scope, snapshot);
    while (catalogScopeSnapshots.size > CATALOG_SCOPE_CACHE_LIMIT) {
        catalogScopeSnapshots.delete(catalogScopeSnapshots.keys().next().value);
    }
};

const toCachedSnapshot = (productsForScope, total) => {
    const cachedProducts = Array.isArray(productsForScope)
        ? productsForScope.slice(0, productLimit.value)
        : [];
    const normalizedTotal = Number(total ?? cachedProducts.length);
    return {
        products: cachedProducts,
        categories: [],
        categories_included: false,
        selected_category_id: null,
        pagination: {
            total: normalizedTotal,
            offset: 0,
            limit: productLimit.value,
            has_more: cachedProducts.length < normalizedTotal
        }
    };
};

const rememberCatalogSnapshot = (scope, snapshot) => {
    if (!scope || debouncedQuery.value.trim()) return;
    setCatalogScopeSnapshot(scope, toCachedSnapshot(snapshot?.products, snapshot?.pagination?.total));
    staleCatalogScopes.delete(scope);
};

const deriveDirectSubcategorySnapshot = (scope) => {
    let parsedScope;
    try { parsedScope = JSON.parse(scope); } catch (_) { return null; }
    const [context, kind, selectedId] = Array.isArray(parsedScope) ? parsedScope : [];
    if (kind !== 'subcategory' || selectedId == null) return null;

    const selectedCategory = categories.value.find(category => sameId(category.id, selectedId));
    if (!selectedCategory?.parent_id) return null;
    const parentCategory = categories.value.find(category => sameId(category.id, selectedCategory.parent_id));
    if (!parentCategory || (parentCategory.parent_id && Number(parentCategory.parent_id) !== 0)) return null;

    const parentScope = JSON.stringify([context, 'category', String(parentCategory.id)]);
    const parentSnapshot = catalogScopeSnapshots.get(parentScope);
    if (!parentSnapshot) return null;
    const parentTotal = Number(parentSnapshot.pagination?.total ?? parentSnapshot.products.length);
    if (parentSnapshot.products.length < parentTotal) return null;

    const childProducts = parentSnapshot.products.filter(product => sameId(product.category_id, selectedCategory.id));
    if (childProducts.length === 0) return null;
    // Reading the complete parent also refreshes its LRU position.
    setCatalogScopeSnapshot(parentScope, parentSnapshot);
    return { snapshot: toCachedSnapshot(childProducts, childProducts.length), stale: staleCatalogScopes.has(parentScope) };
};

const restoreCatalogSnapshot = (scope) => {
    if (!scope || debouncedQuery.value.trim()) return false;
    let snapshot = catalogScopeSnapshots.get(scope);
    let derivedStale = false;
    if (!snapshot) {
        const derived = deriveDirectSubcategorySnapshot(scope);
        if (!derived) return false;
        snapshot = derived.snapshot;
        derivedStale = derived.stale;
    }

    // A fast return to a cached category also supersedes any slower category
    // read that is still in flight.
    catalogRequestId += 1;
    catalogReadController?.abort();
    catalogReadController = null;
    // Refresh recency while keeping the cache strictly bounded.
    setCatalogScopeSnapshot(scope, snapshot);
    applyCatalogSnapshot(snapshot);
    loadedCatalogScope.value = scope;
    isCatalogLoading.value = false;
    catalogLoadError.value = "";
    // The cached rows paint immediately; a stale scope gets one lightweight
    // revalidation read so the terminal still ends on an authoritative state.
    if (staleCatalogScopes.has(scope) || derivedStale) {
        // The mark stays until a revalidation succeeds (rememberCatalogSnapshot).
        void fetchData({ force: true, revalidation: true });
    }
    return true;
};

// Every off-screen cached scope may hold the change: each revalidates on its next view.
// The loaded scope too: the cashier may leave it before the refresh runs, and the
// refresh's own successful read clears its mark (rememberCatalogSnapshot).
const markCatalogScopesStale = () => {
    for (const scope of catalogScopeSnapshots.keys()) staleCatalogScopes.add(scope);
};

const revalidateCatalogScopes = () => {
    for (const scope of catalogScopeSnapshots.keys()) {
        if (scope !== loadedCatalogScope.value) staleCatalogScopes.add(scope);
    }
    return fetchData({ force: true });
};

// A stock event that names its products: cached scopes holding one are marked
// stale so a later view refetches them, and the caller learns whether the
// loaded rows hold one (only then is a read needed now). A read still in flight,
// or rows that belong to another scope, may predate the change, so they count too.
const noteStockChange = (productIds) => {
    const changed = new Set(productIds.map(String));
    const holdsChanged = rows => rows.some(row => changed.has(String(row.id)));
    for (const [scope, snapshot] of catalogScopeSnapshots) {
        // The loaded scope counts too: the cashier may switch away before the
        // deferred refresh runs, and coming back must revalidate its cached rows.
        if (holdsChanged(snapshot.products)) staleCatalogScopes.add(scope);
    }
    return catalogReadController !== null
        || loadedCatalogScope.value !== catalogScope.value
        || holdsChanged(products.value);
};

const buildCatalogUrl = (append = false, forceFull = false) => {
    // Re-reading the scope the user expanded with Load More keeps their rows
    // (server cap 300).
    const limit = !append && loadedCatalogScope.value === catalogScope.value
        ? Math.min(300, Math.max(productLimit.value, products.value.length))
        : productLimit.value;
    const params = new URLSearchParams({
        limit: String(limit),
        offset: String(append ? products.value.length : 0),
        sales_context: salesContext.value
    });

    const query = debouncedQuery.value.trim();
    if (query) {
        params.set('search', query);
    } else if (activeSubcategory.value !== null) {
        params.set('subcategory_id', activeSubcategory.value);
    } else if (activeCategory.value !== null) {
        params.set('category_id', activeCategory.value);
    }

    if (catalogMetadataLoaded && !forceFull && (query || activeSubcategory.value !== null || activeCategory.value !== null || append)) {
        params.set('lightweight', '1');
    }

    return `api/pos/products?${params.toString()}`;
};

const requestCatalogSnapshot = async (url, signal) => {
    const response = await fetch(url, { cache: 'no-cache', signal });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
        const error = new Error(`Catalog returned a non-JSON response (${response.status}; ${contentType}).`);
        error.code = CATALOG_NON_JSON;
        throw error;
    }
    try {
        return await response.json();
    } catch (cause) {
        // Some proxies omit or overwrite Content-Type. Classify a parse failure
        // the same way so the safe GET receives the same single bounded retry.
        const error = new Error(`Catalog returned an invalid JSON response (${response.status}; ${contentType || 'unknown content type'}).`);
        error.code = CATALOG_NON_JSON;
        error.cause = cause;
        throw error;
    }
};

const setSalesContext = (context) => {
    if (context !== 'register' && context !== 'table') return;
    if (salesContext.value === context) return;
    contextMetadata.set(salesContext.value, {
        categories: categories.value,
        activeCategory: activeCategory.value,
        activeSubcategory: activeSubcategory.value,
        currentSidebarFolder: currentSidebarFolder.value,
        stale: !catalogMetadataLoaded,
    });
    salesContext.value = context;
    // Invalidate every response started in the previous workspace. Snapshots
    // are keyed by context, so they stay cached for the way back.
    catalogRequestId += 1;
    catalogReadController?.abort();
    catalogReadController = null;
    pendingAvailabilityChanges.clear();
    isCatalogLoading.value = false;
    catalogLoadError.value = "";
    retryCatalogOptions = { forceFull: true };
    catalogFailures = 0;
    cancelCatalogRecovery();
    const saved = contextMetadata.get(context);
    catalogMetadataLoaded = Boolean(saved && !saved.stale);
    if (saved) {
        categories.value = saved.categories;
    }
    activeCategory.value = saved?.activeCategory ?? null;
    activeSubcategory.value = saved?.activeSubcategory ?? null;
    currentSidebarFolder.value = saved?.currentSidebarFolder ?? null;
    // Cached rows of this context may have missed changes while hidden: paint
    // them now, and the next preferCache read revalidates (catalogRevalidations
    // then re-syncs cart prices, so a cached price is never the charged one).
    for (const scope of catalogScopeSnapshots.keys()) {
        if (isContextScope(scope, context)) staleCatalogScopes.add(scope);
    }
    const snapshot = saved ? catalogScopeSnapshots.get(catalogScope.value) : null;
    if (snapshot) {
        products.value = snapshot.products;
        productOffset.value = 0;
        totalProducts.value = Number(snapshot.pagination?.total ?? snapshot.products.length);
        loadedCatalogScope.value = catalogScope.value;
    } else {
        loadedCatalogScope.value = null;
        products.value = [];
        totalProducts.value = 0;
    }
};

const fetchData = async ({ append = false, force = false, forceFull = false, preferCache = false, revalidation = false } = {}) => {
    if (append && (isCatalogLoading.value || !hasMoreProducts.value)) return;
    if (!append && !force && !forceFull && preferCache && restoreCatalogSnapshot(catalogScope.value)) return;
    if (forceFull) {
        // Keep cached rows usable until fresh data exists: a failed refresh
        // during an internet drop must not empty every other category.
        for (const scope of catalogScopeSnapshots.keys()) staleCatalogScopes.add(scope);
        for (const saved of contextMetadata.values()) saved.stale = true;
        pendingAvailabilityChanges.clear();
        catalogMetadataLoaded = false;
    }
    const requestId = ++catalogRequestId;
    const requestedScope = catalogScope.value;
    const requestedDefaultCategory = !debouncedQuery.value.trim() && activeCategory.value === null && activeSubcategory.value === null;
    catalogReadController?.abort();
    const controller = new AbortController();
    catalogReadController = controller;
    // A retry of a stale-scope revalidation must still report it, or the cart keeps pre-drop prices.
    retryCatalogOptions = { append, forceFull, revalidation };
    cancelCatalogRecovery();
    isCatalogLoading.value = true;
    catalogLoadError.value = "";
    let appliedCatalogSnapshot = false;
    let shouldReconcileAvailability = false;

    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = setTimeout(() => {
        controller.abort(new DOMException('Catalog request timed out.', 'TimeoutError'));
    }, CATALOG_TIMEOUT_MS);

    try {
        const catalogUrl = buildCatalogUrl(append, forceFull);
        const data = await Promise.race([
            (async () => {
                try {
                    return await requestCatalogSnapshot(catalogUrl, controller.signal);
                } catch (error) {
                    // A proxy/CDN occasionally returning an HTML page for a safe GET
                    // should not strand the terminal. Retry once inside the existing
                    // deadline; persistent HTML still surfaces with useful metadata.
                    if (error?.code !== CATALOG_NON_JSON || controller.signal.aborted) throw error;
                    return requestCatalogSnapshot(catalogUrl, controller.signal);
                }
            })(),
            aborted
        ]);
        if (!data.success) {
            throw new Error(data.message || "Catalog response failed.");
        }

        if (requestId !== catalogRequestId || requestedScope !== catalogScope.value) return;

        const snapshot = {
            app_version: data.app_version,
            categories: data.categories || [],
            categories_included: data.categories_included === true,
            products: append ? [...products.value, ...(data.products || [])] : (data.products || []),
            selected_category_id: data.selected_category_id,
            pagination: {
                total: data.pagination?.total ?? (data.products || []).length,
                offset: 0,
                limit: data.pagination?.limit ?? productLimit.value,
                has_more: data.pagination?.has_more || false
            }
        };

        overlayPendingAvailabilityChanges(snapshot.products);
        applyCatalogSnapshot(snapshot);
        if (!append) {
            // An equal token must mean every non-stale cached scope is current. A
            // scoped read that sees a newer token proves other cached scopes may
            // be old, so the token is dropped and the next check reads in full.
            const next = data.catalog_generation || null;
            if (forceFull) {
                catalogGeneration.value = next;
                catalogGenerationDropped = false;
            } else if (!catalogGenerationDropped) {
                if (!catalogGeneration.value || catalogGeneration.value === next) catalogGeneration.value = next;
                else {
                    catalogGeneration.value = null;
                    catalogGenerationDropped = true;
                }
            }
        }
        appliedCatalogSnapshot = true;
        catalogFailures = 0;
        // The initial unfiltered request lets the server select the default.
        // Other metadata-driven selection changes require their own product read.
        loadedCatalogScope.value = requestedDefaultCategory && data.selected_category_id
            ? JSON.stringify([salesContext.value, 'category', String(data.selected_category_id)])
            : requestedScope;
        rememberCatalogSnapshot(loadedCatalogScope.value, snapshot);
        if (revalidation) catalogRevalidations.value += 1;
        if (loadedCatalogScope.value !== catalogScope.value) return fetchData();
    } catch (error) {
        if (requestId !== catalogRequestId) return;
        console.error("Failed to load catalog from server.", error);
        catalogLoadError.value = error?.name === 'TimeoutError'
            ? "Loading products took too long. Please try again."
            : "Unable to load products.";
        catalogFailures += 1;
        const delay = CATALOG_RETRY_MS[catalogFailures - 1];
        if (delay) {
            // Replays the options of the latest read against the scope current
            // at fire time, never a captured URL.
            catalogRetryTimer = setTimeout(() => {
                catalogRetryTimer = null;
                void retryCatalogLoad();
            }, delay);
        }
        // Even a successful empty category owns valid categories/settings.
        // Retain that snapshot and show the failure independently of row count.
    } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        if (requestId === catalogRequestId) {
            shouldReconcileAvailability = appliedCatalogSnapshot && pendingAvailabilityChanges.size > 0;
            catalogReadController = null;
            pendingAvailabilityChanges.clear();
            isCatalogLoading.value = false;
        }
    }
    // A socket event can be newer or older than a response already in flight.
    // Preserve its immediate UI update, then perform one authoritative read so
    // response/event arrival order cannot become the terminal's final state.
    if (shouldReconcileAvailability) return revalidateCatalogScopes();
};

const retryCatalogLoad = () => {
    if (!isCatalogLoading.value) return fetchData(retryCatalogOptions);
};

const retryFailedCatalog = () => {
    if (catalogLoadError.value && !catalogRetryTimer) return retryCatalogLoad();
};

const selectMainCategory = (id, event = null) => {
    activeCategory.value = id;
    activeSubcategory.value = null;
    if (id === null) {
        currentSidebarFolder.value = null;
    } else {
        const hasChildren = categories.value.some(c => sameId(c.parent_id, id));
        currentSidebarFolder.value = hasChildren ? id : null;
    }
    fetchData({ preferCache: true });
    if (event && event.currentTarget) {
        event.currentTarget.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
    }
};

const selectSubcategory = (id, event = null) => {
    activeSubcategory.value = id;
    if (id !== null) {
        const hasChildren = categories.value.some(c => sameId(c.parent_id, id));
        if (hasChildren) {
            currentSidebarFolder.value = id;
        }
    }
    fetchData({ preferCache: true });
    if (event && event.currentTarget) {
        event.currentTarget.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
    }
};

const goBackSidebar = () => {
    if (!currentSidebarFolder.value) return;

    const currentFolderObj = categories.value.find(c => sameId(c.id, currentSidebarFolder.value));
    if (currentFolderObj) {
        if (currentFolderObj.parent_id && currentFolderObj.parent_id != 0) {
            currentSidebarFolder.value = currentFolderObj.parent_id;
        } else {
            currentSidebarFolder.value = null;
        }
    } else {
        currentSidebarFolder.value = null;
        activeCategory.value = null;
        activeSubcategory.value = null;
    }
};

const loadMoreProducts = () => {
    if (!hasMoreProducts.value || isCatalogLoading.value) return;
    fetchData({ append: true });
};

const setProductAvailability = async (productId, isAvailable) => {
    const { response, data } = await fetchJsonResponseWithTimeout(`api/pos/products/${productId}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: isAvailable })
    });
    return { response, data };
};

const resolveCategoryPrices = async (productIds, context = salesContext.value) => {
    const { response, data } = await fetchJsonResponseWithTimeout('api/pos/category-prices/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sales_context: context, product_ids: productIds })
    });
    return { response, data };
};

export function useProducts() {
    return {
        categories,
        products,
        settings,
        salesContext,
        setSalesContext,
        isCatalogLoading,
        catalogLoadError,
        totalProducts,
        hasMoreProducts,
        searchQuery,
        activeCategory,
        activeSubcategory,
        currentSidebarFolder,
        fetchData,
        retryCatalogLoad,
        retryFailedCatalog,
        cancelCatalogRecovery,
        invalidateCatalogSnapshots,
        applyProductAvailabilityChanges,
        revalidateCatalogScopes,
        markCatalogScopesStale,
        noteStockChange,
        catalogRevalidations,
        catalogGeneration,
        mainCategories,
        currentSubcategories,
        selectMainCategory,
        selectSubcategory,
        goBackSidebar,
        filteredProducts,
        loadMoreProducts,
        setProductAvailability,
        resolveCategoryPrices
    };
}

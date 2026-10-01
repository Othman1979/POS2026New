# POS category switching stall — reproduced

Historical diagnosis: the subsequently authorized production fix and its verification are recorded in [POS category recovery](2026-09-10-pos-category-recovery.md).

Reviewed `6bd101a0` on the existing `codex/admin-frontend-audit` branch. The user confirmed that the customer's search box was empty. The recording and that terminal's network/server logs were not available for inspection.

**An application-side handling defect reproduces the reported symptom.** A network failure, a server 503, or a pending request can leave the new category highlighted with the previous category's items still displayed. This establishes a defect in our UI; it does not identify which transport/server condition occurred at the customer's site.

## Finding

**[P1] A failed category change silently presents the old category's clickable items as the new selection.**

1. `src/pos/useProducts.js:219` changes `activeCategory` immediately, then starts the product request. Subcategory selection follows the same pattern at line 234.
2. `fetchData` at line 163 deliberately retains the old `products` array during loading and after a failed refresh. `filteredProducts` at line 56 exposes that array without checking the category that produced it.
3. `src/components/pos/PosCatalogWorkspace.vue:120` only shows the loading state when the product array is empty. The error at line 130 is also inside an empty-array-only branch. Consequently, the error stored at `useProducts.js:204` is invisible after a category already loaded. A Load More spinner can appear when another page exists, but that does not identify the category mismatch or expose a failed request.
4. The product grid at `PosCatalogWorkspace.vue:135` stays interactive. A real click added the old category's product to the isolated local cart while a different category was highlighted. No checkout or server write was performed.

There is also no application-level timeout or AbortController on the catalog GET/body read (`useProducts.js:172`), and the global auth interceptor does not supply one. A transport that remains pending can therefore leave this misleading state until a response, browser/network timeout or another refresh resolves it. The browser diagnostic holds a request for three seconds; the absence of an application deadline is a source finding, not a claim that a three-second test proves an infinite wait.

## Browser evidence

The [diagnostic](../../scripts/reviews/pos-category-stall-browser.cjs) mounts the real POS catalog component, `useProducts`, auth fetch interceptor, and cart stores with controlled loopback responses. Both English and Arabic runs had an empty search box throughout.

| Condition | Observed result |
| --- | --- |
| Healthy Food → Drinks → Dessert → Food responses | Correct products follow every selection |
| Food loaded; Drinks request held pending | Drinks highlighted, Food item displayed, loading flag true, no product-stage loading indicator |
| Drinks request pending; newer Dessert reply arrives first | Dessert displays; later Drinks response is correctly ignored |
| Dessert loaded; Drinks request fails at the network layer | Drinks highlighted, Dessert item retained, internal error set but no error displayed |
| Click retained Dessert item while Drinks remains selected | Dessert item is added to the isolated local cart |
| Next category request returns server 503 | Same stale-grid mismatch as network failure |
| Click category again after responses recover | Correct products return without a document reload |
| Hold another request | Previous products remain, no visible loading/error feedback |

Recorded states and request URLs: [diagnostic results](2026-09-10-pos-category-stall-results.json). Local screenshots are under ignored `scratch/pos-category-stall/`; `en-network-failure.png` shows Drinks highlighted alongside the Dessert item. There were no unexpected Vue/page exceptions. Expected injected transport/server failures are intentional.

Existing request ownership and category-price wiring tests also passed: **2 files / 11 tests**. This is a focused component/composable browser reproduction, not a live customer-server, complete POS bootstrap, database or transaction test.

## Attribution and next fix

- The category click wiring and ordinary request ordering passed the controls. The outgoing requests include the selected category ID, and no search parameter was present.
- Category-filtered requests bypass the server's root catalog cache (`backend/routes/pos/catalog.js:66`); the inspected path does not support blaming a category-independent cache hit for this reproduction. No live backend response was captured from the customer.
- A Git comparison against the pre-optimization frontend `61ab4e38` found no changes in `useProducts.js`, `PosCatalogWorkspace.vue` or the catalog route. The admin performance cuts did not introduce this behavior.
- A narrow fix should distinguish a category change from a background refresh: show a visible loading state for the requested category, prevent old-category cards from being used under the new highlight, expose failure/retry feedback even after a prior successful load, and bound/cancel catalog requests. Preserve the cart and shared settings, and preserve existing stale-response protection. Simply wiping all POS state on every refresh would discard useful state and would not address the error feedback.

Review and reproduction only: no production application code was changed, no new branch was created, and nothing was pushed or deployed. The precise customer trigger still requires that incident's failed/pending catalog request status and timing; a video alone cannot distinguish a stalled connection from a server failure.

Reproduce from the repository root, with the existing Node/Playwright dependencies:

```powershell
node scripts/reviews/pos-category-stall-browser.cjs
npm run test:frontend -- src/pos/useProductsRequests.spec.js src/components/__tests__/categoryPricePosWiring.spec.js
```

The current diagnostic defaults to the fixed behavior. To reproduce the historical failure, use the unfixed production source and `CATEGORY_REVIEW_MODE=baseline`. The recorded before evidence above remains unchanged.

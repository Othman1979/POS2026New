# POS category recovery — implemented

Implemented in production application source on `codex/admin-frontend-audit`, following the [reproduced category stall](2026-09-10-pos-category-stall.md). No new branch, push, merge or deployment was performed.

## Resulting behavior

- The product grid and Load More now belong to the last successful category/subcategory/search and register/table context. Changing that selection hides the previous selection's cards immediately. Raw catalog products remain available to existing barcode, cart-availability and QR consumers; changing categories does not clear the cart or shared settings.
- A category change shows loading, then its products or a visible error with Retry. Same-category background refreshes can keep their matching products visible while showing loading/error feedback. The pending/error states are translated for Arabic and do not depend on the product count.
- Superseded reads are aborted. A 15-second deadline covers both fetching headers and reading the JSON body. Late replies cannot repaint after cancellation or timeout, and old requests cannot clear a newer request's loading state.
- Retry repeats the current selection from offset zero, or retries a failed Load More from its previous offset. A mismatched old snapshot cannot drive pagination. Normal product clicks still work after recovery; clicks on retained old DOM elements cannot add stale-category items.
- Successful empty categories retain their metadata after an error. Initial-load retries and register/table transitions obtain full metadata. The server's initial default category is preserved; if refreshed metadata removes a selected category, the replacement category gets its own product request instead of inheriting the removed category's rows.

Production files: `src/pos/useProducts.js`, `src/components/pos/PosCatalogWorkspace.vue`, and one Arabic translation in `src/shared/i18n/ar.json`. The endpoint, database, checkout, pricing and print contracts are unchanged.

## Verification

- Before the production change, the first 12 targeted cases produced **10 failures and 2 passes**, exposing missing selection isolation, retry/cancellation/deadline behavior and metadata-loss cases. After implementation, **14 new behavioral tests pass**, including search/clear-search and string/number category IDs. The existing request test fixture now includes the same category/default metadata as the real full response.
- The complete frontend suite passed: **109 files / 648 tests**. Production Vite build passed. Sol independently reviewed scope correction, cancellation cleanup, retry ownership, metadata and existing consumers; no blocking finding remained.
- The browser check passed in **English and Arabic at 1280×800 and 390×844**. It mounts the real catalog component, composable, auth interceptor and cart stores on loopback. It checks healthy category changes, stale DOM clicks, out-of-order replies, network failure, server 503, visible loading/Retry, successful recovery, same-category refresh failures and preservation of an existing cart line. It also checks adding a valid product after recovery and retaining the same document through the entire flow.
- Desktop cases additionally hold response headers and stream an unfinished native HTTP JSON body. Both reach the real 15-second deadline, stop loading and allow successful retry. Unit tests independently cover transports that ignore cancellation and resolve after timeout.

After evidence: [browser results](2026-09-10-pos-category-recovery-results.json). The [before evidence](2026-09-10-pos-category-stall-results.json) remains unchanged. Screenshots and complete frontend test/build logs are under ignored `scratch/pos-category-recovery/` and `scratch/pos-category-recovery-*` paths.

The after-results revision identifies the parent commit because verification ran before committing the fix. Its `sourceSha256` values identify the tested production files and were checked against the final source.

The browser fixture makes no application-server, customer-database, checkout, printer or external-provider requests. It is a focused component/store integration test, not a complete customer POS bootstrap or deployment validation.

## Customer-specific certainty

The original symptom was reproduced with an empty search box, and those same failure paths are now covered by the fix. A problem seen at only one customer is compatible with a request failure that occurs only on that instance, but it does not prove whether their connection, server, data or deployed version caused the original failure.

No customer URL, incident request trace or server logs were supplied during this implementation. Therefore the code defect and its correction are confirmed; attribution of that particular recording remains unverified. This change prevents a failed request from silently presenting another category's items, and makes a continuing instance-specific failure visible and retryable. It does not repair an unavailable network or server.

## Reproduce

```powershell
npm run test:frontend -- --reporter=dot --reporter=json --outputFile.json=scratch/pos-category-recovery-tests.json
npm run build:admin
node scripts/reviews/pos-category-stall-browser.cjs
```

The browser harness now expects the fixed behavior and writes to `scratch/pos-category-recovery/`. To characterize the historical defect, use the unfixed production source at `f0eddce9` with `CATEGORY_REVIEW_MODE=baseline`; do not run that mode expecting a pass against the fixed source. No live instance is needed for either mode.

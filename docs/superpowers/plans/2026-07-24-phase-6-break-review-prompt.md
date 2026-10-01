# Phase 6 Hostile Owner-Review Prompt

Act as the owner who must support this POS during a Friday-night rush. Review Phase 6 as a behavior-preserving refactor, not as a license to redesign the frontend.

## Mission

Prove that the proposed native HTTP seam and Inventory split improve ownership without adding layers, changing user-visible behavior, or hiding failures. Attempt to reject every extraction before accepting it.

## Attack order

1. Trace every direct `fetch()` in `src/admin/pages/Inventory.vue`, including success, API-declared failure, network failure, optimistic rollback, silent refresh, stale-response suppression, and CSV pagination.
2. Trace `src/shared/authInterceptor.js`. The new HTTP helper must call the intercepted global `fetch`; it must not replace credentials, 401 redirect behavior, headers, or session ownership.
3. Apply the ponytail deletion test to every proposed file. Keep a file only when it removes repeated transport mechanics or owns independent state plus behavior. Reject repositories, clients, classes, dependency containers, endpoint constants, generic error hierarchies, and one-function-per-file splitting.
4. Verify Inventory has zero direct `fetch()` calls after migration and that every former URL, method, header, body, response branch, toast, alert, rollback, refresh, and loading transition still exists exactly once.
5. Accept only the Stock Activity extraction from Inventory if it owns both feeds, both loading flags, both loaders, and audit presentation. Reject splitting product/category/template sections when it would create prop/event plumbing without reducing ownership ambiguity.
6. Search for stale imports, duplicate implementations, old paths, circular dependencies, browser globals evaluated during Node tests, and aliases missing from Vite or Vitest.
7. Run focused HTTP/controller tests, the existing Inventory structure test, a production build, `git diff --check`, and targeted source searches. Do not substitute green tests for reading the final diff.
8. Compare Phase 6 with Phases 1-5: preserve thin routes/modules already established; do not move backend helpers, schema, endpoints, or POS runtime files.
9. Inspect `backend/routes/pos/tables.js` before assigning `tableRelationships.js` or `splitChecks.js`. If extraction crosses transaction, lock, audit, money, permission, or broadcast boundaries, require a separate Phase 7 with its own focused integration gates.

## Failure conditions

- HTTP code changes response semantics instead of merely centralizing `fetch(...).json()`.
- A helper bypasses the global auth interceptor or captures `fetch` before tests can replace it.
- Inventory loses stale-request protection, optimistic rollback, or a loading reset.
- The page is split by line count instead of state/behavior ownership.
- Phase 6 touches table transaction code.
- Backend extraction copies helpers or SQL instead of moving one complete owner.
- Any route, response envelope, permission, query order, transaction order, audit order, or socket timing changes without an explicit behavior-fix plan.

## Required verdict

Report findings by severity with file and line evidence. If no actionable finding remains, state exactly which searches and behavioral paths were manually traced. Recommend deletion whenever an abstraction cannot justify its maintenance cost.

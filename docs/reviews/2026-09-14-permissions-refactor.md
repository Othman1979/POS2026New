# Permissions refactor execution record

Scope: retain the existing permission/grant tables, financial and table transaction protections, cashier first-save versus later-edit separation, and existing audit suppression policy. No deployment or GitHub integration is included. Implementation and database verification are serial; Luna assistance is read-only.

## Ordered work

1. [x] Reject stale user edits, preserve revocation, and audit access changes without credentials.
2. [x] Centralize known permission definitions and action decisions; align table/payment dependencies and UI enforcement.
3. [x] Add clear staff presets, explicit section scope, effective-access explanations, and safe role-change behavior.
4. [x] Scope manager approvals to supported actions without replacing the employee's role.
5. [x] Verify fresh installation/upgrades, document how to add permissions, and run combined adversarial backend/frontend/browser checks and resource comparisons.

Each step receives focused behavioral verification before the next implementation begins. Final acceptance covers English/Arabic desktop/mobile, direct API attempts, missing dependencies, draft/saved/bill-printed state, ownership/sections, approval, stale editing, revocation, and the existing table financial/void regressions.

## Baseline

- Starting commit: `38d24ecd`, branch `codex/permissions-baseline-and-cashier-tables`; clean checkout.
- Catalog: 25 active keys; fresh bootstrap and migration repair already share one SQL builder.
- User list: one users query, one sections query, one batched grants query. User update reads implemented keys twice and deletes/reinserts all grants even for a name-only edit.
- Existing first-save resource baseline: 10 connection queries, 17 returned rows, one lease, zero remaining leases (see the preceding permissions review).
- Read-only audit reproduced revoked checkout access restored by a stale profile form; source and in-memory probes also confirmed role-default, payment-role, void-copy, transfer-dependency, and approval inconsistencies.

## Decisions

- User edit versions will fingerprint the persisted profile and sorted grants. This detects changes made outside the user editor as well as concurrent edits, uses the existing reads/locks, and needs no schema column or extra per-action query. It is a concurrency token, not an authorization credential.
- Permission decisions remain pure and synchronous. Server-owned state, ownership/section checks, locking, stock, and money validation remain authoritative in their existing workflows.

## Verification results

### Step 1

- The initial isolated RED run reproduced both competing writes succeeding, missing versions accepted, absent grant-change auditing, and duplicate grants causing a failed create. The session assertion initially targeted a nonexistent endpoint and was corrected to the real `/api/auth/me` endpoint.
- Focused backend selection: 57 passed across eight files. After review corrections, the seven lifecycle cases and four manager-PIN cases passed. There are 59 distinct backend cases across the completed selection, including real socket revocation.
- Frontend: 24 passed, including retained conflict drafts, explicit reload, one in-flight write, create recovery, immediate create/edit, and ignoring a stale refresh response.
- Real built browser acceptance: English 1440px and Arabic 390px. Each verifies a second administrator's checkout revocation survives a stale form, explicit reload reveals the revoked grant, deliberate current edits work, and table save/edit/print/payment/shift close still reconcile to 4 JD sales and 54 JD closing cash. Zero browser page errors; owned fixtures removed. The harness was corrected to expand the closed sales-permission group before interacting with its checkbox.
- Name-only edits execute one implemented-catalog read and no grant writes or audit inserts; the existing route used two catalog reads plus delete/reinsert. Versioning adds no query or schema field. Manager PIN changes now share the profile UPDATE, and downgrades clear dormant manager credentials.
- Production build and whitespace check passed. Evidence: `scratch/permissions-step1-backend.json`, `scratch/permissions-browser/results.json` and screenshots. No production DB or physical printer was contacted.

### Step 2

- `backend/config/permissionPolicy.cjs` is a pure shared module. Known keys/constants derive from the catalog; unknown keys/actions fail closed even for administrators. It composes grants for first-save, edits, draft/saved/printed voids, whole-table/item transfer, join/merge/split, and checkout. Existing section, ownership, state and money guards remain in their transaction modules.
- RED established a real isolated 200 counter checkout by a waiter holding only `waiter.checkout`. GREEN rejects that counter sale with 403 and completes a 2 JD saved-table settlement for the same grant. Only locked unpaid-table orders or validated splits enable the table-payment alternative; a client table ID is insufficient.
- The first focused run passed 21 backend cases. Broader selection passed 96 additional backend cases and eight frontend transfer cases, including permission, resource-lifetime, item-transfer money/recipe/retry, and xyz void history behavior. The separate frontend selection passed 50 cases. The old assertion allowing any non-403 checkout response was replaced by actual successful/denied settlements.
- Real English desktop/Arabic mobile cashier acceptance passed again through conflict reload, first save, later edit/print, 4 JD payment and 54 JD shift close; zero page errors and owned fixtures removed.
- Shared policy also executed in a real Vite development browser. The bounded fixture scans its own HTML entry; the initial harness unnecessarily scanned the entire application and timed out. Vite's existing CommonJS support handles the shared module in development and production; no dependency was added. Configuration follows the [Vite 6 linked CommonJS guidance](https://v6.vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies).
- First-save resource comparison remains 10 connection queries, 17 returned rows, one lease, zero remaining leases in all six runs (local 11.56–17.03 ms baseline and 11.61–14.35 ms current). The harness swaps the table writer and shares other current dependencies; it is a query/resource check, not a complete historical HTTP or customer latency benchmark.
- The production POS entry grew from 134.00 to 137.72 kB gzip because the shared policy currently includes the bounded catalog. No per-decision HTTP/DB request was added. Evidence: `scratch/permissions-step2-backend.json`, `scratch/permission-policy-browser/results.json`, `scratch/permissions-browser/results.json`, and `scratch/permissions-resources/results.json`.

### Step 3

- Added explicit all/selected/none table scope. The additive migration preserves existing role/CSV behavior once; runtime unknown or missing scope fails closed. Selected scope requires an existing section, and updates must submit the scope explicitly. Login, session reconstruction, registered-browser authentication, floor reads, direct writes and socket filters use the same value.
- Catalog metadata now owns role applicability, waiter defaults, groups and bilingual examples. Presets use installation cashier defaults; the waiter preset starts with saved-order editing only. Cashier table service adds first-save authority without later edits or voids. Existing role changes retain applicable custom grants and explicit scope for review.
- User responses carry a canonical safe profile and the concurrency stamp. The editor previews actual action dependencies, distinguishes kitchen print from guest bill print, and blocks unknown save results until an explicit read-back. Permission searching and previews make no requests.
- Backend migration/lifecycle selection: 230 passed; one stale expected migration list was corrected. The subsequent access/session selection passed all 215 cases, including the corrected 48-case migration unit suite, real socket revocation and section restrictions. Fresh installer, migration replay, partial migration recovery and preserved grants/defaults passed. Evidence: scratch/permissions-step3-backend.json and scratch/permissions-step3-access.json.
- Focused frontend selection passed 56 tests, followed by 23 policy/editor cases after adding metadata, role preset and explicit scope coverage. Production build passed.
- Built browser acceptance passed English 1440px and Arabic 390px, including catalog failure/retry, presets, section selection, stale edits, first save, forbidden later edit, deliberate edit grant, 4 JD payment/54 JD closing cash, and a deliberately lost committed create response with exactly one created user. Screenshot review found a fieldset scrolling issue; its scroll container and dialog bounds check were corrected for the confirmation pass.
- The final browser confirmation passed both languages and viewports again, with title, scrolling content and Save footer contained inside the dialog, no page errors, and owned fixtures removed.

### Step 4

- RED reproduced valid admin PINs bypassing disabled discount approval and separately disabled manual-price approval, and the service returning broad manager role/grants for an arbitrary requested action.
- ManagerOverrideService now validates a bounded supported action list and returns only manager identity and approved actions. Checkout intersects its three supported fields with the current catalog flags using its existing transaction connection, caches that proof within one invocation and checks each action separately. Checkout itself, tax and service-charge permissions remain non-overridable.
- Price approval is an explicit pricing option rather than an actor mutation. Join/disjoin request only their respective action and retain employee section scope. The original route-only PIN-verification audit remains unchanged; applied operation audits retain their manager identity.
- The temporary UI receives only enabled discount/price keys, cannot enable unrelated keys, and no longer gains administrator report presentation. Duplicate clicks share one in-flight attempt, the request wait is bounded, and the in-memory PIN expires after five minutes.
- Focused backend selection passed 43 cases with connection capacity one, including subscription credit, current-read credentials/catalog, lockout and checkout replay. The broader permission/table selection passed all 108 cases, including manager-authorized join/disjoin without section widening. Frontend approval/hydration/localization checks passed 24 cases. Evidence: scratch/permissions-step4-red.log, scratch/permissions-step4-backend.json, scratch/permissions-step4-access.json.
- Real English/Arabic browser acceptance passed the whole staff/table flow plus a separate manager-approved 10% discount checkout: 1.80 JD sale, 51.80 JD closing cash from 50 JD, original cashier attribution and no X-report access. The fixture was corrected to log in after shift-close correctly cleared the session. Zero page errors; owned database removed.

### Step 5

- Full frontend suite: 857 passed across 125 files. Final read-only review found raw permission checks in routing and Admin Orders plus a missing shared disjoin alias. Those now use the same policy; 62 focused behavioral checks passed, including role-aware routing/refund controls. An old source-text routing assertion was replaced by six actual guard cases.
- The combined isolated application run passed all 1,259 cases across 53 files in 34m 50s. It includes 199 full table cases, 135 checkout cases, 73 refund cases, 74 shift cases, real WebAuthn/device/socket revocation, subscription money paths, catalog/scope migrations and fresh installer/schema validation. No failed or skipped cases. Evidence: scratch/permissions-final-backend.json. Additional archive/xyz/provenance regressions run serially below.
- Added docs/agents/permissions.md and linked it from AGENTS.md and the verification guide. Updated architecture nodes/flows and corrected stale role-escalation/blank-scope statements. Architecture generation and consistency validation pass.
- After the final shared-policy corrections, the entire frontend suite passed again: 867 tests across 126 files. The production rebuild also passed.
- Additional established table-history acceptance passed all 83 tests across six files: deleted-item archive, xyz audit/history policy, concurrent/stale voids, paid-split protection and provenance. The added subscription-credit-approval plus unauthorized tax-exemption case passed with 403 and no invoice/subscription writes, followed by valid credit issuance. Evidence: scratch/permissions-final-table-history.json and scratch/permissions-final-credit-boundary.json.
- The actual Vite development policy check passed with zero page, console or failed-request errors on diagnostic rerun. An initial run timed out waiting for module initialization; no production code change was required, and the harness now retains startup diagnostics on failure.
- Final built English 1440px/Arabic 390px acceptance passed after the routing/refund policy corrections, with zero page errors and owned fixture removal. The real flows reconcile table sales to 4 JD/54 JD closing cash and a separate manager-approved discounted sale to 1.80 JD/51.80 JD closing cash.
- Final resource comparison ran alone: all 12 samples (admin and cashier, three alternating baseline/current pairs each) retained 10 queries, 17 returned rows, one maximum/total connection lease and zero outstanding leases. Admin baseline/current ranges were 8.61-17.04/8.35-14.09 ms; cashier ranges were 9.78-11.94/8.82-10.72 ms. These are small local samples with the earlier table writer and shared current dependencies, not a production-latency guarantee.
- The production build now emits a shared policy/catalog chunk of 6.03 kB gzip; the POS entry is 134.25 kB gzip. The policy metadata has a modest download cost but avoids another runtime catalog request and adds no per-decision queries. No dependency was added.
- Final architecture and whitespace checks pass. All five tasks are complete with serial implementation and read-only Luna reviews. Customer databases, physical printers and deployment were outside this verification; no GitHub push, PR, merge or deployment was performed.

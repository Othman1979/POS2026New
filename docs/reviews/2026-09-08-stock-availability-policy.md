# Estimated ingredient balances without forced opening counts

The quantity ledger now has an explicit stored availability policy. Existing and newly created identities default to `strict`; ingredient activation can deliberately select `estimate` once its writer adapters are complete. This migration does not map or activate ingredients automatically.

Under `estimate`, usage may be recorded while the opening balance is unknown. Receipts and usage preserve `quantity_known=false`; their running delta is not an available-stock count. An observed, nonnegative count establishes the quantity and still checks the recorded version. Known expected balances may become negative, and a negative legacy expected balance can be carried through an explicit estimated opening. A physical count itself cannot be negative.

Expiry, quarantine and required-lot checks remain enforced. The policy comes from the locked stock identity, not a caller-supplied flag. Existing packaged-product activation retains strict behavior. Fixed-point arithmetic, rollback, durable replay and concurrent delta posting remain unchanged.

## Evidence

Four new behavioral cases failed against the strict-only implementation: uncounted usage, depletion below zero, concurrent unknown usage and a negative estimated opening. All five policy tests now pass, including unsupported-policy rejection and lot/expiry/input-bypass protections. The broader stock integration run passes 82 tests across nine files. The schema/manifest/quantity set passed 161 tests before the final required-column validator correction.

The registered migration is `2026-09-08-stock-availability-policy-v1`, checksum `161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88`, after the exact facts migration. Normal, automatic and cumulative manual SQL match. Existing identities default to strict; rerunning SQL preserves an explicit estimate policy. The core schema check now verifies required column names instead of rejecting every additive column or allowing an unrelated column to mask a missing required one. The three affected migration files pass seven tests after that correction.

Redundant core-test setup was removed: the shared fixture already installs these tables and the isolated runner owns database cleanup. The distinct DDL replay/history-preservation test remains.

## Remaining integration and resource checks

The existing stock transaction benchmark now supports an activated identity and compiles the baseline ledger as well as its inventory adapter. Every measured deduction has a distinct source identity, and final product/ledger balances reconcile. Run `node scripts/reviews/stock-adjustment-performance.cjs --baseline=25878b7e --source-context --baseline-source-context --activated`.

[Three alternating rounds, 1,000 measured deductions per implementation per round](2026-09-08-stock-availability-performance.json):

| Round | Prior p95 | Current p95 | Change |
| --- | ---: | ---: | ---: |
| 1 | 3.176 ms | 3.879 ms | +0.703 ms |
| 2 | 4.622 ms | 4.785 ms | +0.163 ms |
| 3 | 4.639 ms | 4.515 ms | -0.123 ms |

This one-identity service-transaction comparison stays below the proposed 2-ms regression margin. Node CPU per call is about 0.3 ms higher in the current phases; no CPU or memory saving is demonstrated. RSS endpoints are roughly 92–95 MiB and include retained fixture/driver memory. These are not full checkout HTTP latency, database CPU/RAM or low-end certification measurements. The durable receipt phase also reconciles the final product and ledger quantities.

The final verification passed both fresh installation and upgrade from the exact July 29 floor (2 passed, 15 unrelated cases filtered out). The schema-authority and automatic-migration unit checks were rerun after the required-column correction and pass. Local machine-readable results are retained in `scratch/stock-availability-install-verification.json` and `scratch/stock-availability-schema-verification.json`.

Ingredient writer adapters, cutover reconciliation, activation/API/UI, general compositions and reporting invalidation remain incomplete. This is a quantity-policy prerequisite, not completion of packages A or B. Complete low-end resource certification remains separate verification work.

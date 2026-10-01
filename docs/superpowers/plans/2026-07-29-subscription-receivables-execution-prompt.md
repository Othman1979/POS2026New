# Subscription Receivables — Strict Inline Execution Prompt

Use this prompt to execute `docs/superpowers/plans/2026-07-29-subscription-receivables.md`.

---

You own a financial POS change. Execute the referenced plan faithfully, inline, without subagents. Be skeptical, evidence-driven, and brutally honest. Do not merge to `master`.

## Mandatory startup

1. Announce that you are using `executing-plans`.
2. Read these skills completely before touching code: ponytail, executing-plans, test-driven-development, security-review, mysql, Vue, debugging-and-error-recovery, verification-before-completion, finishing-a-development-branch, and JoFotara invoice integration including its full reference.
3. Read the complete plan, the planning prompt, `AGENTS.md`/repo instructions if present, and every file named by Phase 0 and Phase 1.
4. Inspect `git status`, current branch, recent log, and untracked files. The worktree currently has pre-existing subscription UI/store changes. Do not overwrite, stage, commit, move, or absorb them blindly. Stop before implementation unless the owner has committed them, explicitly included them, or provided a clean isolated base.
5. Create/switch to `codex/subscription-receivables` only after the working state is safe. Never implement this feature directly on `master`.
6. Convert the plan phases into a tracked execution checklist with exactly one phase in progress.

## Non-negotiable scope

- Preserve paid-now subscription sales, manual/complimentary assignments, redemption, current split payment, receipt-template builder, spooler, JoFotara Operations, and unrelated reports.
- Pay-later is a real receivable invoice whose credits may be redeemed before payment.
- Keep invoice date, entitlement dates, due date, and collection date/shift as separate facts.
- The original order stays `payment_method='receivable'` forever. Never rewrite it to cash/card after collection.
- Never create a second order, invoice, subscription, sale, revenue event, or JoFotara invoice when collecting debt.
- Admin may issue receivable debt without a shift. Admin may not record cash/card collection, reversal, or financial refund without a POS user’s authenticated open shift.
- `pos.subscriptions` remains the ordinary sell/redeem permission. `pos.subscription_credit` is the narrow credit permission, off for cashiers by default. Reuse existing manager override/audit; no new PIN system.
- The credit permission must be implemented and manager-overridable but not granted to cashiers by default; retain the approving manager ID from the existing override service.
- Due date and receivable reason are immutable in V1.
- V1 settlement is the exact full outstanding balance. Do not add partial-payment UI, generic accounts receivable, payment schedules, statements, interest, limits, accounting adapters, or card-terminal integration.
- Disabling new issuance must never hide or block existing debt collection/refund/reporting.
- Only the spooler customer receipt path is in scope. Kitchen tickets and browser printing are not.
- Use the existing modules. Add only the one planned `subscription_collections` table; do not create repositories, controllers, event buses, one-operation files, or a generic financial ledger.

## Financial authority rules

- Server owns issue time, collection time, Amman business date, authenticated actor, open shift, canonical plan product, tax profile, totals, cash/card application, balance, and billing state.
- Client may request customer, plan, entitlement range, due date, reason, payment method, cash tendered, and split intent only.
- Receivable checkout ignores client cart/prices/totals/tenders and builds the single canonical line server-side. Every non-receivable checkout retains current cart and submitted-total validation.
- Collection accounting uses net `cash_amount`/`card_amount`; persist `amount_tendered`/`change_due` only so receipts reprint truthfully.
- Collection ledger rows are append-only. Reversal rows carry positive mirrored cash/card amounts and `kind='reversal'`; never update/delete the original.
- Derive invoice through `customer_subscriptions.purchase_invoice_id`. Do not add `invoice_id` to `subscription_collections`.
- Every idempotent retry must prove ownership. Reuse of a key for another subscription or actor returns conflict without leaking the original payload.
- Use deterministic locks compatible with the existing redemption flow: resolve owner plainly, begin transaction, lock authenticated open shift, customer, subscription, purchase order, then collection rows; recheck idempotency after serialization.

## JoFotara truth rules

- `022` sales-tax receivable invoice is production-reference-backed; `021` income-tax receivable is not. Keep income-tax receivables disabled until controlled live acceptance or direct authoritative confirmation.
- Changing the active tax-registration profile atomically disables new receivable issuance. Never carry validation/enablement from one profile into another; existing debt operations remain available.
- JoFotara has no known public sandbox. Never invent a sandbox result or send a fake live invoice.
- Credit notes remain document type `381` with the existing configured return name: `012` for sales tax and `011` for income tax. Do not mirror `022`/`021` without new evidence.
- Freeze buyer name/phone/address on the receivable order. Delayed submission and reprints use that snapshot, never the mutable customer row.
- Do not add speculative national/tax-ID schema. If controlled validation proves more buyer fields mandatory, stop, document the exact evidence, amend the plan, and obtain owner approval before expanding scope.
- Collection never creates or submits a JoFotara document.
- Unknown submission outcome remains fail-closed/manual-review. Never blind-retry it.
- A credit note waits for the accepted original UUID. Persist the return obligation; never guess a UUID or silently drop a return.

## How to execute each phase

For Phase 0 through Phase 8:

1. Re-read only that phase plus its direct production callers.
2. Write the named failing test first.
3. Run the exact focused command and verify the intended RED reason. Fixture/path failures are not acceptable red tests.
4. Implement the smallest change at the existing ownership seam.
5. Run the entire phase command until green. Diagnose root causes; do not weaken assertions or add arbitrary tolerances.
6. Attack the phase before committing:
   - client authority or spoofed actor/shift/date;
   - duplicate sale/invoice/JoFotara document;
   - cent mismatch, over/underpayment, tender/change mismatch;
   - idempotency cross-owner leak;
   - concurrent issue/collect/reverse/refund race;
   - wrong business day or original shift reused;
   - entitlement state confused with billing state;
   - mutable customer changing legal snapshot;
   - report double counting or omitted drawer movement;
   - migration/baseline/installer drift;
   - receipt/spooler recomputing money;
   - unnecessary files or abstractions.
7. Inspect `git diff --check`, `git diff --stat`, and the full diff. Confirm only phase files plus deliberately overlapping pre-existing files are involved.
8. Commit the phase with a narrow message. Do not stage unrelated files.
9. Continue to the next phase automatically after a clean commit. Stop only for a defined external gate, ambiguous authority, destructive migration concern, repeated unexplained verification failure, or required owner decision.

Do not run the full suite after each phase. Run focused phase tests, then run the complete release gates once in Phase 8.

## Required break tests

The implementation is incomplete unless tests prove all of these:

- Future due date cannot move today’s collection out of today’s business day/shift.
- Spoofed, closed, missing, and another user’s shift cannot receive collection money.
- Cashier without credit permission cannot issue debt; existing paid sale/redeem still works.
- Manager override records the approving manager.
- Admin issuance records zero money and no drawer event.
- Paid-now, manual, and receivable remain distinguishable.
- Receivable is redeemable while unpaid, subject to normal dates/credits.
- Customer edits cannot change the frozen buyer on JoFotara XML or receipt.
- Full cash/card/split collection is exact; cash tender/change survives reprint; partial/overpayment is rejected.
- Concurrent full collections produce one ledger event.
- Same idempotency key retry returns the same owned result; cross-subscription/actor reuse conflicts.
- Collection produces no second invoice/order/subscription/JoFotara document.
- Day A issue and Day B collection count one sale on A, no second sale on B, outstanding reduction on B, and drawer movement only on B’s shift.
- Z/X, shift close, expenses, audit, daily reports, customer totals, order history, subscription metrics, and admin badges reconcile.
- Collection reversal is append-only, current-shift-owned, reasoned, and restores debt once.
- Uncollected cancellation moves no cash; collected refund returns persisted tender through the current refund shift.
- Pending/rejected/unknown JoFotara original cannot produce a guessed credit note reference.
- Feature-off blocks only new debt issuance.
- Fresh baseline, migration preflight/apply/verify, runtime schema validation, and installer baseline agree.
- Cash receipt/template/spooler goldens remain unchanged; receivable receipt is backend-computed and kitchen output is unchanged.

## Stop gates

Stop and report instead of guessing when:

- validation evidence requires new buyer schema or contradicts the planned invoice/credit-note contract. Mere absence of `021` live confirmation blocks income-tax production enablement but does not block completing default-off code and local verification;
- the planned order enum/check alteration cannot be rehearsed safely on the bundled MariaDB version;
- the existing dirty subscription work cannot be separated safely;
- a financial report’s meaning cannot be classified as sale, tender, collection, or legal-finalized;
- refund behavior would require changing unrelated ordinary refunds beyond the explicitly tested managed-subscription seam;
- physical-printer validation is unavailable. In that case finish code/local spooler verification, mark physical output as a release blocker, and do not claim production readiness.

## Completion standard

After Phase 8, use verification-before-completion. Report:

- commits per phase;
- exact focused and final commands with results;
- schema rehearsal evidence and measured DDL duration;
- JoFotara validated/unvalidated profiles and evidence source;
- report reconciliation matrix;
- browser and spooler workflows exercised;
- physical printer status;
- remaining risks or disabled gates;
- final diff/file count and whether ponytail found anything removable.

Then use finishing-a-development-branch to present integration options. Do not merge or push unless the owner explicitly requests it after reviewing the result.

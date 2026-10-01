# Call-Center Held-Order Cancellation Design

## Goal

Allow any call-center worker handling a returning customer's call to restore and cancel that customer's exact phone-source held order, while preserving accountability and notifying every kitchen station that previously received preparation work.

## Product decisions

- Cancellation is available to any authenticated `call_center` worker for an exact phone-source held order they successfully claim. It is not limited to the original worker because the customer's next call may reach somebody else.
- **Cancel edits** and **Cancel order** are different actions. Cancel edits releases the lease and preserves the row. Cancel order is terminal and requires one approved reason plus explicit confirmation.
- The original source worker remains immutable. The cancelling worker is recorded separately as the audit actor.
- `users.xyz=1` suppresses the held cancellation audit exactly as it suppresses other held lifecycle events. It does not prevent cancellation or kitchen output.
- Existing `admin` and `programmer` held-audit suppression remains unchanged.
- No new business table, permission key, call-center permission editor, cancellation service stack, or spooler route is introduced.

## Eligibility and authorization

The server permits call-center cancellation only when all conditions hold:

1. The row is an ordinary register hold with non-null `call_center_user_id`.
2. The worker found it through the exact-phone POST search and successfully claimed the same held ID.
3. The submitted claim token, expected version, and cancellation operation ID pass the held-lifecycle contract.
4. The order is not a platform/deferred, table, progressive-split, Y-only, settled, or already-consumed row.
5. The request contains an approved cancellation reason code and explicit confirmation.

The browser cannot provide or overwrite source identity, sent-item baseline, printer routing, audit actor, or kitchen payload. Direct cancellation attempts against ordinary or another held-order class return a stable 403/409 without deleting or printing.

## User flow

1. The worker enters the customer's phone and selects the exact active phone order.
2. **Continue order** claims and restores the same durable held row; restore never deletes it.
3. **Cancel order** opens a compact confirmation containing the reference, item count, kitchen state, and this fixed reason list: `customer_changed_mind` (العميل غيّر رأيه / Customer changed mind), `duplicate_order` (طلب مكرر / Duplicate order), `entered_in_error` (أُدخل الطلب بالخطأ / Order entered incorrectly), and `other_customer_request` (طلب آخر من العميل / Other customer request). Do not collect free text or customer PII in this destructive action.
4. Confirming sends the held ID, claim token, expected version, operation ID, approved reason code, and explicit confirmation flag.
5. Success clears the local draft and returns to phone intake. Failure preserves the restored order and explains whether it is in use, stale, missing kitchen history, or missing a printer route.

## Kitchen cancellation behavior

### Order was never fired

- No kitchen ticket is created because no preparation station received the order.
- The transaction abandons any bound service-charge snapshot, writes the audit when enabled, deletes the held row, and commits.

### Order was fired at least once

- Add `cancel` as a trusted kitchen ticket type in the existing document model, template engine, built-in template, custom template editor, compiler, and spooler fallback.
- The visible bilingual heading is `إلغاء الطلب / ORDER CANCELLED` and cannot be supplied by the browser or hidden by compiler fallback.
- The ticket contains the complete trusted sent baseline: original fire plus every successfully queued FOLLOW UP quantity. It excludes unsent cart additions and never uses negative quantities.
- Each portion is sent to the original printer ID recorded in the kitchen snapshot. Current category routing must not silently redirect a cancellation to a different station.
- Existing but offline printers may receive durable pending queue jobs; physical acknowledgement is not required before the customer call finishes.
- If original route evidence is missing, the printer was deleted, the snapshot is malformed, or a fired legacy row has `baseline_unknown`, cancellation fails closed and preserves the held order. An authorized cashier/manager must perform the prerequisite baseline-reconciliation flow first.

The cancellation transaction locks the held row, validates the claim/version, builds the trusted cancellation documents, inserts print-queue rows through the same database connection, abandons the service-charge snapshot, appends the audit when enabled, deletes the row, and commits. Print dispatch starts after commit. A queue or database failure rolls everything back and leaves the order recoverable. Uncertain physical printer outcomes remain dead-letter/manual-review and are never silently retried.

## Audit contract

Use the existing held-specific audit helper and event `held_order_canceled`.

For a normal call-center actor, record only:

- held-order ID and display reference;
- immutable original `call_center_user_id`;
- cancelling worker ID as the audit actor;
- old version and cancellation operation ID;
- approved reason code;
- whether kitchen preparation had been sent;
- final kitchen dispatch version and cancellation batch identity when applicable.

Never record phone, address, customer name, cart JSON, claim token/hash, manager PIN, or full printer payload. When the cancelling worker has `xyz=1`, no audit row is written, but the same authorization, print, service-charge, and deletion transaction still executes.

## Idempotency and concurrency

- Only the active claimant may cancel. Competing terminals receive `HELD_IN_USE` or `HELD_VERSION_CONFLICT`.
- The cancellation operation ID participates in deterministic kitchen batch identity: `held-{heldId}-cancel-{operationId}-{sentSnapshotHash}`. Per-printer queue identity additionally uses the stable original printer ID and canonical payload hash, so response-loss retries or later printer-metadata changes cannot create another physical job.
- A retry before commit cannot create a second audit or queue batch.
- If commit succeeded but the response was lost, the row is absent on refresh and the client treats cancellation as completed. No second kitchen job can be built without the held row.
- Y archive, cashier checkout, kitchen fire/FOLLOW UP, and cancellation all serialize on the same held-row lock.

## Required tests

### Backend

- Any call-center worker can claim and cancel another worker's exact phone-source hold; original source remains unchanged and cancelling actor is audited.
- `xyz=1` cancellation succeeds without an audit event.
- Ordinary, platform, table, split, Y-only, unclaimed, stale-version, and actively claimed-by-other rows cannot be cancelled by call center.
- Missing reason/confirmation, forged source, malformed snapshot, and missing original printer route preserve the row.
- Unfired cancellation creates no print job.
- Fired cancellation queues one trusted `cancel` document per original printer containing the full sent baseline, including prior FOLLOW UP quantities and excluding unsent additions.
- Queue/audit/service-charge/delete failure injection rolls back the entire mutation.
- Response-loss and concurrent cancellation attempts produce no duplicate queue, audit, or deletion side effects.
- Admin/programmer and `xyz=1` audit suppression remain scoped to held lifecycle events.

### Frontend and real browser workflow

- **Cancel edits** releases without deletion; **Cancel order** requires reason and confirmation.
- The action works in light and graphite themes at 1024x768 and mobile widths without clipped confirmation controls.
- Worker B searches a phone order created by Worker A, restores the same held ID, cancels it, and returns to clean intake.
- The cashier Held badge/list refreshes once and the cancelled row disappears.
- Kitchen queue/document inspection shows `إلغاء الطلب / ORDER CANCELLED`, correct original routes, and only the trusted sent baseline.
- Audit inspection shows Worker A as source and Worker B as cancelling actor; repeating with `xyz=1` shows no cancellation audit.

## Non-goals

- No partial sent-line void editor in the call-center workflow.
- No cancellation of paid/settled invoices; those continue through refunds.
- No automatic cancellation based only on a phone match.
- No supervisor role, points/commission calculation, or new audit dashboard.
- No physical-printer acknowledgement wait and no automatic retry of uncertain kitchen output.

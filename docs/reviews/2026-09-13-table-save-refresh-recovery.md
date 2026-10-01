# Confirmed table Save refresh recovery

F8's hostile browser check exposed a frontend gap after a successful Save: the
automatic metadata reload cleared the cart before reading and erased the active
table hint when navigation aborted its GET. Reload could land on an empty register
although the saved 13.60 JD bill remained intact. A fresh isolated baseline reproduced
this in English; F8 evidence reproduced both English and Arabic. Explicit floor
reopening recovered the bill, but should not be required after a confirmed save.

The automatic reload now preserves the acknowledged draft and table/version while
reading canonical row metadata. A failure leaves that recoverable state intact.
A successful result applies only when the draft, table location and revision still
match the captured state. New edits keep their acknowledged revision, so a later
server snapshot cannot silently advance an unsaved draft. Explicit opening retains
its existing reset/review behavior. A late QR read also cannot start another order
read after its table session has ended.

Staff QR and table-order reads now use the existing 15-second header/body deadline
helper, as the floor and split reads already do. The optional QR read can time out
and still allow the order refresh to proceed. Each read has its own deadline;
two sequential stalled reads can therefore take approximately 30 seconds. No new
request, retry, cache, schema, library, or mutation behavior was added.

## Verification

- Initial RED: four failed/one passed new store cases, proving draft loss, late-read
  overwrite and unbounded header/body waits before production edits.
- The next hostile selection found a same-bill relocation case: a late read could
  restore its old seat even without switching invoices. Including table location
  and revision in the captured state fixed it; the other eight cases passed.
- Final store/persistence/session selection: 282 passed. Frontend lifecycle,
  coalescing and shared HTTP selection: 39 passed. Existing saved metadata, service
  charge, canonical reload, stale-save and session-ownership cases remain intact.
- Fresh production build and architecture generation/check passed.
- Real API/database with built English desktop/Arabic mobile: immediate reload after
  Save now restores the 13.60 JD bill without a floor-reopen fallback. Subsequent
  split/payment, stock checks, table release and shift closing pass.
- Hostile real browser check deliberately holds a successful table-order response
  body open through its native deadline. The acknowledged cart and durable table
  identity survive. A second held response arrives after a product is added through
  the UI; the new 15.60 JD draft survives while the server still holds 13.60 JD.
  The next explicit Save persists it, then reload/split/payment completes at 15.60 JD
  with 1.60 JD tax and exactly two burgers/two drinks consumed. Both languages pass
  with no page errors. No physical printer is involved.

## Resources and limits

The before/after browser fixtures record requests. Successful Save still has one
POST followed by its existing QR, order-metadata and floor reads; failed metadata
refresh does not resubmit Save. The new comparison serializes the current draft
twice during an automatic refresh, using memory/work proportional to the cart.
Read deadline controllers/timers use the existing helper and are released on
completion or error; tests assert no surviving deadline timers. No claim of zero
CPU cost, customer latency improvement, or exhaustive crash-point coverage is made.

Raw scripts, request traces, logs, screenshots and cleanup evidence are in ignored
`scratch/tables-save-recovery-20260913/`. Database writes use owned generated loopback
fixtures. Machine environment files, deployment, GitHub and physical printers were
not changed. Counts overlap and must not be added.

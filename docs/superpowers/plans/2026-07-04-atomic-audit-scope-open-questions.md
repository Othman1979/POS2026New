# Atomic-Audit Policy — Scope & Open Questions

> Living doc. Records the boundary of the "destructive audits must be transactional" policy and the questions deliberately deferred. Revise as decisions are made (append to the Revision Log at the bottom).

## Current decision (2026-07-04, owner-confirmed)

**Scope = POS only.** The atomic-audit rule — insert the `audit_events` row on the same transaction connection (`await conn.query`) immediately before `conn.commit()`, so a failed audit rolls the business mutation back — applies to **destructive POS-route mutations**:

- `void_item`, `void_order` (empty-cart table void), `void_split`, `void_checkout` — `backend/routes/pos/{tables,checkout}.js`
- `refund` / `void_order` — `backend/routes/pos/refunds.js`
- `table_merge`, `table_disjoin` — `backend/routes/pos/tables.js`
- any FUTURE destructive POS op that needs an audit (e.g. Plan 4 `DELETE /table_splits`)

**Excluded by design (NOT open — stay fire-and-forget `pool.query().catch()`):** non-mutation security / attempt events that are not tied to a business-mutation rollback:

- `pin_override_locked` / `pin_override_success` / `pin_override_failed` — `backend/routes/pos/helpers.js`
- `drawer_pop`, `drawer_pop_failed` — `backend/routes/pos/checkout.js`

Rationale for the rule and the "no void without audit AND no audit without void" invariant lives in memory `atomic-audit-policy` and the INDEX note (`docs/superpowers/plans/2026-07-04-table-workflow-INDEX.md`, "2026-07-04 audit-policy update").

---

## OPEN QUESTION #1 — Admin-domain destructive audits (DEFERRED)

**Status:** OPEN — deferred. Not in scope for now (POS-only decision above).

`backend/routes/admin/products.js:18` `writeAudit(...)` is a fire-and-forget `pool.query(...)` helper used for product create/update/**delete** audits (and possibly other admin CRUD via the same helper). The POS atomic rule does NOT currently cover it.

**The question:** should the "delete operations" clause of the atomic-audit policy extend to admin-domain destructive mutations (product delete, and any other admin delete/merge that carries an audit)? I.e., should an admin product delete roll back if its audit row can't be written?

**Considerations for the revisit:**
- *For extending:* consistency of the "no destructive mutation without a durable audit" invariant; product deletes are also fraud/compliance-relevant.
- *Against / cost:* `writeAudit` is a shared fire-and-forget helper — admin routes may not run inside a transaction today, so extending means (a) wrapping each admin destructive op + its audit in one txn, (b) threading `conn` into `writeAudit`, (c) accepting that an audit-table failure now blocks admin CRUD. Larger blast radius than the POS routes (many call sites of one helper).
- *Where to look:* grep `writeAudit(` in `backend/routes/admin/` for all call sites; classify which are destructive (delete) vs non-destructive (create/update) — the rule, if adopted, most clearly applies to deletes.

**If adopted later:** wrap the destructive admin op + audit in a single txn, pass the txn `conn` to `writeAudit`, and add a rollback-on-audit-failure test per site (pattern: `failNextConnectionQuery` + `waitForAuditCount`, already in the POS integration suites).

---

## Revision Log

| Date | Change |
|---|---|
| 2026-07-04 | Created. Decision: atomic-audit is **POS-scope only** for now. Open Question #1 (admin-domain deletes) deferred. |

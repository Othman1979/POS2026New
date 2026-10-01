# Table section and QR-draft access — F5

The floor hid tables outside a waiter's assigned sections, but direct API calls
could read or change those bills. A cashier with no grants could also read and
delete QR drafts without a guest token. Further inspection reproduced a direct
way around a draft-only fix: realtime table snapshots sent hidden tables and
their QR guest tokens to every staff socket.

## Changes and policy

`PermissionService.getTableSectionIds` now supplies the same strict, deduplicated
section IDs to the floor, direct object checks, split-list filtering and socket
membership. Admin/programmer bypass is retained. Blank waiter assignments grant
no sections; other staff retain the existing unrestricted blank assignment.
Malformed fragments such as `1oops` and `1.5` no longer grant section 1.

Table save requires existing table access (inherent for waiters). Staff QR reads
and deletion use that same grant plus the table's section. A valid exact QR token
remains an independent read-only capability, including when a restricted staff
cookie accompanies it. Guest tokens do not authorize draft deletion. Deletion
checks the locked seat and releases the connection before publishing its result.

`lockTableSession` now requires the original actor and checks every locked group
member's section before reading the order's money and saved lines. Its save,
mark-printed, checkout, void and progressive split callers all pass that actor.
Empty-group saves and dynamic table resolution apply the same policy. Legacy
split management checks its persisted seat reference, rechecking the reference
after locking the held row. Action and ownership permissions remain separate.

Transfers, swaps and merges check both complete groups using the existing sorted
locks. Join checks the requested seats and existing attached children. Disjoin
discovers the parent IDs without first locking children, locks both sides in one
global ID order, then validates that the relationships still match the probe.
Manager PINs still authorize join/disjoin, but do not mutate the session user's
role/permissions or bypass the actor's assigned sections. Existing PIN security
audits remain independent; a rejected structural action can still have an
authorization-attempt audit, with no table/bill mutation.

Table-order reads and live table/split print references check the referenced
sections. The split board filters inaccessible groups in SQL before parsing
their carts or building receipt presentations. Paid historical receipt
authorization and ordinary register-held order policies are unchanged.

Realtime content uses rooms assigned by the server from the verified session,
covering all sections the actor may access even when the floor is not visible.
Client-selected section subscriptions cannot widen that scope. Table snapshots
omit QR guest tokens. Draft changes go to the corresponding section rooms too;
the guest writer resolves the current section with one bounded read. Existing
user-security edits revoke durable sessions and disconnect their sockets, so
old room memberships cannot survive an edited assignment.

The previously identified ownership policies are preserved: transfer grants
allow moving another waiter's bill; edits/merges and initial split creation keep
their stricter ownership checks; split-board management remains broader within
the actor's assigned sections. Cashier checkout and split grants do not acquire
a new dependency on the floor-page grant. Committed F4 receipts and exact-payload
replays remain available to their original actor with the current action grant,
even after later moves or section changes. They return prior operation evidence
without granting current bill access or performing another mutation.

The new access errors have Arabic translations. There is no schema, dependency,
settings, money-calculation or frontend workflow change. F6 remains separate;
its paid-parent index has not been added here.

## Verification

Work starts at clean F4 commit `7157e8991806466708209eca5e6ecfd18141eb6e` on
`codex/tables-workflow-hardening`, in the shared checkout.

- Initial correctness run: 37 failures and four compatibility passes before
  production edits. The print fixture was then given a real queue destination;
  all four print-access cases failed again before the production print edit.
- Initial HTTP fix: all 41 cases passed. An additional hidden-child split-board
  regression failed before its filtering fix; five accompanying edge cases
  passed. The expanded file has 46 cases, including dynamic sections and PIN
  session isolation.
- Focused F5/F1–F4, section helper, settlement-context and connection-lifetime
  selection: 159 passed across eight files.
- Real Socket.IO regression failed by receiving a hidden table and its QR token
  before the delivery change. Initial socket/unit verification: ten passed.
  The final real-socket case also passed with guest cart writes, scoped draft
  notifications, forged subscriptions and production user-edit disconnection.
- Frontend/session and affected unit boundaries: 413 passed across 15 files.
- Broad table, permission, print, recipe/stock, post-commit and F4 migration
  compatibility selection: 299 passed and two fixture failures. The tax test
  needed the independent table grant to reach its tax-permission assertion;
  the blank-section fixture edited users directly without invalidating cached
  authority. Both original assertions passed after those fixture corrections.
  The production user-edit path's revocation/disconnection is covered by the
  real-socket test. The entire 301-case selection was not repeated.
- Final capacity-one access/connection-lifetime selection: 56 passed. This
  includes both allowed and forbidden paths after the realtime change.
- The new Arabic access-message assertion failed before the catalog addition;
  all four catalog tests then passed, followed by a fresh production build.
- Production frontend build and architecture generation/check passed.

- Built English desktop and Arabic mobile UI: hidden draft read/delete and
  table save return 403 with unchanged business state; a real Save after a seat
  moves outside the assigned section preserves the draft and exposes the
  translated error; restoring access permits QR import, save, reload and card
  settlement. Each language settles 4 JD, consumes exactly two stock units and
  closes the shift with expected/counted cash both 20 JD. No uncaught page errors
  or physical printing occurred.

Counts overlap and must not be added. The full historical backend suite was not
run. English's completed sequence is retained in `browser-mobile-drawer.json`;
the final Arabic sequence is `browser.json`. Earlier Arabic harness attempts
assumed the mobile drawer was open, then assumed it was closed after reload,
and matched its English label before Arabic text replacement. The corrected
harness waits for the cart panel, checks its state and recognizes the displayed
label. Those were test-navigation corrections, with no application change;
their evidence and fixture cleanup are retained.

## Measurements and limits

The before-action measurements were collected before production edits, without
another workload running. They cover standalone roots and 20 children per root,
with one warm-up and five samples. The later read comparison loads the exact
F4 versions of affected production modules in a separate test process, without
overwriting or switching the working tree. It uses four checks per parent,
equal assigned/unassigned sections, and no paid history; it is not F6's index
benchmark. SQL analysis is retained alongside returned-row counts.

| Children per root | Action | Statements before → after | Returned rows before → after | HTTP median ms before → after | Connection-held median ms before → after |
|---|---|---:|---:|---:|---:|
| 0 | Floor | 5 → 3 | 15 → 7 | 2.52 → 2.58 | — |
| 0 | Draft read | 2 → 2 | 2 → 2 | 1.87 → 2.68 | — |
| 0 | Save | 14 → 14 | 20 → 20 | 6.31 → 8.61 | 3.50 → 3.92 |
| 0 | Transfer | 12 → 12 | 6 → 6 | 4.78 → 7.22 | 2.56 → 3.77 |
| 0 | Out-of-section transfer | 12 → 3 | 6 → 3 | 4.90 → 3.14 | 2.84 → 1.56 |
| 0 | Disjoin | 5 → 6 | 3 → 5 | 2.98 → 3.74 | 1.29 → 1.74 |
| 20 | Floor | 5 → 3 | 55 → 47 | 2.67 → 3.12 | — |
| 20 | Draft read | 2 → 2 | 2 → 2 | 1.73 → 1.72 | — |
| 20 | Save | 14 → 14 | 60 → 60 | 6.54 → 4.74 | 3.21 → 2.27 |
| 20 | Transfer | 12 → 12 | 86 → 86 | 6.30 → 6.68 | 3.19 → 3.72 |
| 20 | Out-of-section transfer | 12 → 3 | 86 → 43 | 6.58 → 3.06 | 3.69 → 1.49 |
| 20 | Disjoin | 45 → 26 | 43 → 65 | 7.22 → 6.38 | 5.05 → 4.31 |

These statement counts include pooled post-commit snapshot reads, but exclude
transaction lifecycle calls. Every mutation releases its one connection once.
The previously successful forbidden transfer now rolls back before reading or
moving an order. Disjoin pays for one parent discovery/lock step at one child;
batching its old per-child reads reduces statements at larger groups. Its
returned rows increase because both the probes and locked parent/child rows
are counted. QR deletion adds one locked seat read and a transaction; guest
socket writes add one indexed section lookup. Those two costs were verified
structurally and functionally, not timed as separate workloads.

| Parents / children per parent | Split statements before → after | Returned rows before → after | Response bytes before → after | HTTP median ms before → after |
|---|---:|---:|---:|---:|
| 8 / 0 | 3 → 3 | 33 → 17 | 41,168 → 20,596 | 3.02 → 6.11 |
| 8 / 20 | 3 → 3 | 33 → 17 | 41,168 → 20,596 | 3.06 → 4.22 |
| 80 / 0 | 3 → 3 | 321 → 161 | 413,177 → 206,589 | 8.40 → 7.29 |
| 80 / 20 | 3 → 3 | 321 → 161 | 413,177 → 206,589 | 7.93 → 7.35 |

The split comparison uses one warm-up and seven samples. Filtering halves the
fixture's returned carts because half its sections are unassigned. The 80-parent,
20-child SQL analysis records 40 group checks using `idx_tables_parent_table_id`,
20 member rows per check and **zero full scans** for that dynamic range choice.
The scoped print reader uses index-merge access, returning 1 or 21 group rows
at either floor size. The paid-child count remains unchanged for F6.

Smaller-fixture split latency and several standalone action medians increased;
these results are not a claim of no regression. The action samples were separated
by the usage-limit pause and are not an alternating controlled CPU comparison.
Returned-row counts are not storage-engine row visits; the retained SQL analysis
is the evidence for access paths. No cache, new index or per-recipient permission
query was introduced to hide these costs.

All database writes use generated loopback fixtures created and removed by their
own inspected runners. Browser checks use production assets and the real server;
print destinations are fixture queue entries, with no physical printer attached.
Local timings do not establish customer latency, throughput, or exhaustive
correctness under every concurrent administrative edit or crash interleaving.

Final cleanup independently found all **20 recorded F5 database names absent**.
The generated-name prefix contained only the unrelated older
`posapp_review_recipe_p1_3b0c1cf71f91`, which was preserved. No F5 test/server/browser
Node process remains. `.env` and `.env.test` were not edited. The task was attached
to the Gatekeeper project in the app, but repository and test commands explicitly
used `C:\xampp\htdocs\posapp`; Gatekeeper remained clean. The next task must use
the saved POSApp project with a local environment.

Raw scripts, logs, JSON, SQL plans and screenshots are in ignored
`scratch/tables-f5-20260913/`. No push, PR, release, deployment or protection
change is part of F5. After verification and its task-sized commit, start F6 only
in the next local task on this same branch, using `gpt-6-astra` / `xhigh`.

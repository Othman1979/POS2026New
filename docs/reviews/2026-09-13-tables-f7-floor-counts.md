# Floor split counts — F7

The floor previously downloaded every accessible split cart and receipt presentation
after loading its table rows, then parsed check names to associate counts with table
numbers. Table numbers repeat across sections and joined children share the bill.

The floor now renders each row's server `active_split_count` and derives navigation's
total by distinct `current_order_id`. It neither reads nor parses the split list.
Generic table and held-order notifications share one visible-floor debounce and the
existing workspace request coalescer. Targeted snapshots update counts directly;
reconnect and KeepAlive return refresh the workspace with `skipActivation: true`.
The split board retains its own detail reads, paid-child safeguards and recovery.

Floor count refreshes now use the same existing 15-second header/body deadline helper
as split reads. Previously `get_tables` had no deadline. Failed reads preserve the
previous snapshot, release the request slot and allow a later refresh to recover.
No cache, dependency, schema, server query or permission change was introduced.

Counts describe bills attached to the actor's visible table rows. A visible alias
still carries the server count when its parent is hidden. F5 deliberately excludes
that group's cart details if any member is inaccessible; F7 preserves that distinction
and does not fetch hidden details to reconcile navigation's count with the board.

This also fixes F9's joined-child badge foundation. Direct table opening still follows
the existing parent-order path and is the remaining F9 task. Split-parent saving is
still forbidden. The user subsequently requested continuing all remaining work in
this task, serially after verification, instead of creating a new task per issue.

## Verification

- Before production edits: four meaningful floor lifecycle/count regressions failed;
  the two new native-deadline boundary tests also failed. Existing cases in both
  selections passed (four and eight respectively).
- Initial GREEN: 63 frontend cases covering floor entry/return/reconnect, mixed
  notifications, deactivation, visible aliases, repeated numbers, stale board data,
  timeouts/retry, workspace ownership, split coalescing, presentation and board guards.
- Fresh isolated fixture before and after: 80 active bills, 160 table rows including
  aliases, four unpaid/two paid children per bill, 20,000 unrelated paid orders.
  Both actors retain exact counts and receipt presentations. Moving one group member
  outside the waiter's section keeps the visible root's count at four but excludes
  its four carts from the board. F6's history index is present throughout.
- Real API/database and built English/Arabic desktop UI: join, save through child,
  transfer, reject busy join, join a new child, create/rewrite splits, floor/board
  navigation, reload, two card payments and final table release. Floor reads zero
  split-detail payloads; both joined badges decrease from two to one; cancellation
  disappears after the first payment. Each bill settles exactly 6 JD; no page errors.
- The full synthetic production-bundle matrix passed English/Arabic desktop/mobile
  at CPU rates 1 and 4: drafts/notes, board/table navigation, visibility, coalescing,
  reconnect, detail failure and retry. The initial 4× run failed the older held-race
  fixture because fixed sleeps delivered both notifications before the first read
  started. The fixture now waits for the actual first request before sending the
  second notification and still requires the final 31-card snapshot. No held-order
  production code changed. The failed evidence is retained separately. Expected
  injected HTTP 500 responses are recorded, not unexplained application errors.
- The 12-cycle 4× CPU diagnostic run passed native response-body timeout/recovery
  for floor, held list, split list and Orders details. Controlled failures produced
  two HTTP 500 console entries and the expected split TimeoutError; no page error.
- Production build and architecture generation/check passed. No push, PR, release,
  protection or deployment action was performed; `.env` and `.env.test` are untouched.
- Final isolated compatibility selection: 358 passed across eight files (session
  store/persistence/boundaries, table-session/transfer wiring, section access,
  paid-split index/API and saved revisions). This selection took 179 seconds;
  inspection during the run confirmed active fixture creation rather than a hang.
  Counts overlap earlier selections and must not be added.
- Independent cleanup confirmed all four recorded F7 database names absent. The
  unrelated older `posapp_review_recipe_p1_3b0c1cf71f91` database was preserved.

## Resource evidence

The fixture ran alone with one warm-up and seven HTTP samples per endpoint/actor.
Before-production measurements were collected against clean F6 production code;
the later run uses the same fixture shape with new generated IDs/databases.

| Actor | Floor entry queries before → after | SQL rows returned before → after | JSON bytes before → after |
|---|---:|---:|---:|
| Admin | 6 → 3 | 487 → 166 | 499,980 → 86,379 |
| Restricted waiter | 6 → 3 | 246 → 85 | 250,210 → 43,413 |

The removed request is deferred until board entry. Each endpoint's SQL and payload
remain unchanged. Standalone floor HTTP medians were 5.13 → 4.99 ms (admin) and
3.63 → 3.16 ms (restricted); board medians were 9.66 → 11.51 and 6.80 → 5.44 ms.
These small variations are not server optimization claims. Returned rows are not
storage-engine visits. Actual `ANALYZE FORMAT=JSON` plans are retained.

Three production-bundle browser rounds using the captured fixture at 4× CPU
throttling measured median CDP task work of 673.83 → 574.84 ms for cold floor and
364.99 → 200.46 ms for returning from the board. Board entry was 113.82 → 108.39 ms.
Every floor entry/return removes one 413,601-byte split payload; board entry still
makes one detail read. Joined child badges change from absent to four; navigation
stays 320. Burst/reconnect windows overlap outstanding work in the old baseline,
so their task timings are not treated as controlled per-event comparisons.

These are local diagnostics with small one-product checks, not customer speed,
whole-device memory, physical printer, or exhaustive concurrent correctness claims.
Evidence, scripts, screenshots and raw logs are retained under ignored
`scratch/tables-f7-20260913/` and `scratch/pos-frontend-f7-*/`.

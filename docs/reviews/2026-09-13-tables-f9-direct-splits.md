# Direct split-bill navigation — F9

F7 repaired joined-child counts. Opening those tables still attempted to load the
split parent as an ordinary order and stopped at a 409 alert. The floor now opens
`/table-splits?parent_invoice_id=<current_order_id>` for either alias. It leaves
the existing draft untouched until a check is deliberately selected. If a stale
floor still reports zero splits, the loader preserves `SPLIT_CHECKS_OPEN` and the
floor recovers into that captured bill's checks.

The split endpoint accepts an optional positive, safe-integer `parent_invoice_id`
and applies it as a bound SQL predicate before cart/presentation work. Invalid,
duplicate or empty filters return 400; unknown bills return an empty list. The
existing split grant, root-section guard, hidden-member guard and paid-child count
remain in the same read. No schema, index, money or mutation policy changed.

The board watches the requested bill. Changing scope clears old details and preview;
the shared reader coalesces to the latest scope and rejects late results/errors from
an obsolete scope. Refresh/reconnect retain that bill, while **All** deliberately
opens the full accessible board. Existing 15-second header/body deadlines remain.
Board grouping uses persisted invoice/table IDs, with isolated check IDs for orphan
legacy rows. Restoring a check cannot choose a table by parsing a display name.

## Verification

- Before production edits: six new frontend regressions failed (14 existing cases
  passed); all three new API cases failed because the filter was ignored.
- Initial frontend GREEN: 36 cases. The final frontend selection passed 70 cases, including scope
  failures/retry, coalescing, lifecycle, counts, workspace deadlines and board guards.
- API and store compatibility: 251 passed, including all three scope cases and 248
  session-store cases. The first new API fixture omitted `progressive_split_version`
  and therefore exercised legacy deletion rather than progressive paid protection;
  it now declares the intended fixture type. Three older store fixtures lacked
  table IDs and depended on the unsafe name fallback; they now supply the server's
  row identity while preserving their original discount, cent-allocation and saved
  tax assertions. Separate regressions reject missing identity and preserve the
  structured parent error.
- Real built English desktop/Arabic mobile UI with a generated loopback database:
  direct parent/child entry, same-number bills in different sections, explicit All,
  stale-zero-count 409 recovery, invalid-filter recovery and a real delayed HTTP
  response while selecting another bill. Reload and pay both checks, refuse ordinary
  split-parent saves and paid-group cancellation, verify exact 4 JD settlement and
  joined-table release while the other same-name bill remains intact. No page errors.
- Initial browser attempts checked data before the route transition mounted the
  board, then treated a translated-offscreen mobile drawer as visible. The fixture
  now awaits the requested data and opens the actual cart drawer. Both completed
  language runs and the additional hostile cases pass; earlier evidence is retained.
- Production build and architecture generation/check passed.
- Final pool-capacity-one selection: 70 passed, 178 outside-scope cases skipped,
  across the scope, table-access and existing table/split integration files. Counts
  overlap earlier selections and must not be added.

## Resource evidence

Fresh isolated before/after fixtures retain F6's index and F5's scope filtering:
80 active bills, 160 table rows including aliases, four unpaid/two paid checks per
bill, and 20,000 unrelated paid orders. Each read used one warm-up and seven samples.

| Targeted request actor | Returned checks before → after | SQL result rows before → after | JSON bytes before → after | HTTP p50 ms before → after |
|---|---:|---:|---:|---:|
| Admin | 320 → 4 | 321 → 5 | 413,601 → 5,165 | 12.98 → 2.54 |
| Restricted waiter | 160 → 4 | 161 → 5 | 206,797 → 5,165 | 10.02 → 2.84 |

Three queries remain for both shapes. All-board payloads are unchanged. Each returned
check retains two paid children and its valid receipt presentation. The restricted
partial-group probe still omits the inaccessible group's details. Actual SQL plans
are retained; SQL result rows are not storage-engine row visits. These local timing
samples are not customer throughput or latency claims. No physical printer,
deployment, push, PR, release or protection change was involved.

Raw fixtures, logs, plans, browser screenshots and cleanup evidence live in ignored
`scratch/tables-f9-20260913/`. Continue the remaining tasks here, serially, as the
user requested; do not create a new task.

Independent cleanup confirmed every recorded F9 fixture database absent and retained
only the unrelated older `posapp_review_recipe_p1_3b0c1cf71f91` schema. Machine
`.env` and `.env.test` were not edited.

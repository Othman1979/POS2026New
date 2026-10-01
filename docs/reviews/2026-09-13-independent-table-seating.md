# Independent table seating

Joining tables now changes physical seating without combining their bills. Two
occupied tables keep their invoice IDs, saved items, prices, tax, stock history,
waiters and split checks. Opening, saving, printing, moving, voiding or paying one
bill continues to operate on that bill alone. Separating seating leaves bills open.
Combining bills remains the distinct existing merge operation.

## Data and behavior

`restaurant_tables.seating_parent_id` records the seating group, with an indexed
self-reference and `ON DELETE SET NULL`. Existing `parent_table_id` retains the
legacy shared-bill relationship. Keeping both meanings explicit avoids rewriting
the established settlement, saved-money and stock paths or inventing new issued
bill identities.

The migration copies existing seating once and removes billing links only from
empty seats with no current invoice. Occupied/printed shared aliases retain their
issued bill and still open that bill after their seating is separated. Later raw
migration replay does not restore seating an operator has separated. Fresh tables
and newly joined empty seats open independent bills. Payment releases bill aliases
but leaves physical seating until staff separate it.

Join locks selected roots and all seating members in table-ID order, checks every
affected section and excludes printed members, including members beyond the
selected root. Existing groups can be flattened into one level. Disjoin probes
parents, obtains sorted complete-group locks and rechecks membership. Both actions
audit within their transaction, obey the existing audit suppression policy, release
their connection before broadcasting and never write invoice/line/stock records.
Disjoin updates the selected seats in one statement. Manager PINs retain the
original actor's section scope. Bill access still checks the original shared-bill
aliases; independent neighboring bills do not grant access to each other.

Floor snapshots and realtime updates include the seating link. The UI shows seating
and legacy shared-bill indicators separately, permits occupied targets, excludes
printed groups and explains that bills stay separate. Arabic calls this action
“ضم الطاولات” so it is distinct from bill merging. Existing draft preservation,
split counts and scoped split navigation continue to use invoice identity.

## Verification

- Initial ten integration cases failed on the old behavior. A later empty-group
  upgrade case also failed before its migration correction.
- **84 targeted integration cases passed:** legacy shared-bill checkout, split,
  transfer, merge, section restrictions, audit rollback and new independent seating.
  Old fixtures that used Join to create a shared bill now seed that historical
  shape explicitly; their financial and access assertions remain in place.
- **302 cases passed with connection capacity one:** seating, durable bill-action
  recovery, store state and real socket access. A separate normal-capacity test
  holds both transactions before their locking queries, then releases them
  together: one competing join succeeds, one returns 409, and bills are unchanged.
  Different saved waiters are also preserved in a focused regression.
- **59 migration/manifest checks and 128 schema compatibility checks passed:**
  exact predecessor, interrupted column setup, wrong column shapes, cyclic legacy
  groups, missing/conflicting ledger entries, repeat execution, fallback/hash
  parity, old index/action migrations and fresh installation. The fresh installer
  fixture intercepts machine account/grant statements.
- **32 initial frontend checks and 22 final checks passed**, plus production build,
  architecture generation/check and whitespace validation.
- Real HTTP/browser/DB flows passed in **English and Arabic, desktop and mobile**:
  join occupied 4 JD and 6 JD bills; reopen the second bill; add a drink and save;
  reload its 8 JD bill; split and pay 6 JD + 2 JD; verify the first bill remains
  4 JD and occupied; separate the released seat; reject a printed target; pay the
  first bill; physically separate a legacy shared alias, reopen its original bill
  and pay it. Seven drinks reduce stock from 100 to 93 exactly. No page errors.
  Arabic mobile was repeated after the wording correction and visually inspected.
- Audit failure rolls back the full join and an explicit retry succeeds. Marking
  or voiding one joined bill leaves the neighboring bill intact. Joining/separating
  two separately split bills leaves every held check unchanged.

All DB work used freshly generated loopback fixtures, serially. **15 databases
were verified absent afterward**; the unrelated older order-type fixture remains.
No application/customer DB, external deployment or physical printer was exercised.
Kitchen relocation tickets are a later feature, not part of this seating change.

## Resource comparison

The same fresh 51-table fixture measured eligible empty-group joins before and
after the change, with one warm-up and seven retained samples per size. Occupied
joining previously failed, so it is not used as an equivalent timing baseline.

| Group tables | Transaction queries before → after | SELECT rows returned before → after | Connection held p50, ms before → after |
| --- | --- | --- | --- |
| 2 | 2 → 4 | 2 → 3 | 1.13 → 1.20 |
| 11 | 2 → 4 | 11 → 12 | 1.15 → 1.18 |
| 51 | 2 → 4 | 51 → 52 | 1.69 → 1.77 |

The two extra statements read the audit policy and append the durable audit; the
query count stays constant as the group grows. Each request acquires/releases one
connection. HTTP medians were 3.17–3.63 ms after versus 3.35–3.93 ms before; these
small local timings are not evidence of a customer speed improvement. Storage
engine rows examined and production lock latency were not measured. The floor
adds one scalar field per returned table and no new detail request.

Raw logs, measurements, screenshots and guarded harnesses are in ignored
`scratch/table-seating-20260913/`. Migration authority is
`2026-09-13-table-seating-v1`, checksum
`78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1`.

Continue the remaining authorized table work in this same task, serially, as the
user requested. No push, PR, deployment or new chat is authorized by this report.

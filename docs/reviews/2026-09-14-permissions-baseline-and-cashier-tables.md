# Permissions baseline, user editor and cashier table saving

## Behavior

Fresh installation now seeds every current permission from `backend/config/permissionCatalog.json` through the shared SQL builder. The DDL-only `deployment/database/baseline.sql` remains DDL; `bootstrap-database.js` supplies its data seeds. Previously the bootstrap inserted only four current permissions plus retired inventory permissions, and schema validation did not detect the missing checkout, shift and table keys.

The new managed migration `2026-09-14-permission-catalog-v1` repairs the catalog on existing installations. It inserts missing keys and updates bilingual descriptions without deleting staff grants or overwriting existing `default_cashier`/`overridable` values. It does not automatically give existing cashiers new permissions. The automatic migration, normal SQL and cumulative manual fallback have matching content and verified hashes. Startup now requires all 25 current permissions with English and Arabic text.

The user explicitly chose separate first-save and later-edit permissions:

| Cashier action | Required permissions |
| --- | --- |
| Enter the floor plan | `tables.access` |
| First save of a new table order | `tables.access` + `tables.save` |
| Add or edit after Save/Print | `tables.access` + `waiter.edit_locked` |
| Work on another employee's table | The action's grants plus `waiter.override_tables` |
| Cancel saved items / clear an unpaid table | Existing item-void grants; first-save permission does not allow voids |
| Take payment | Existing checkout permission; save permission does not grant payment |

Waiters retain their existing first-save/edit policy and intrinsic floor access. Their section assignments remain mandatory. Admin/programmer bypass and fixed call-center restrictions remain in place. The first-save decision uses server-resolved table/order state, not the client permission flag.

The user editor now has readable permission groups, searchable actions, real examples, visible allowed states and dependency guidance. It explains waiter automatic access, unrestricted administrator access, fixed call-center access, and empty section assignment semantics. Search and role previews preserve selections. Catalog loading failures block staff-grant saves and offer Retry; new cashier defaults are applied after a successful retry.

Browser verification also found and fixed an existing creation bug: spreading a create payload with `id:null` after the optimistic row ID prevented the server ID from being attached. Immediately editing that newly created row sent an invalid ID. The temporary ID now survives until the actual ID arrives.

## Verification

- Real installer RED: successful bootstrap/schema validation lacked `pos.checkout`. The strengthened test failed before the production fix.
- Installer, schema authority and fresh stock bootstrap: **117 passed**. Fresh DB includes every canonical key, has no staff grants, passes real schema validation, and skips covered migrations twice.
- Catalog repair and complete migration chain: **66 passed** across focused runs. Checked exact predecessor, missing predecessor, checksum conflicts, preserved grants/defaults, bilingual catalog completeness, repeat/no-op behavior, and raw SQL replay. The old chain assertions were extended for the new migration; the final July-floor case was rerun after its ledger expectation update.
- Permission/user/table regression selection: **153 passed across 9 files**, covering cashier first-save/edit separation, real admin user creation/update, session revocation, sections/ownership, void restrictions, saved revisions and connection lifetimes.
- Frontend selection: **56 passed across 7 files**, including reactive first-save versus edit permissions, fixed roles, order-workflow transitions and user-editor recovery.
- Production build, architecture generation/check, and whitespace check passed.
- `scripts/reviews/permissions-browser.cjs`: English 1440px desktop and Arabic 390px mobile, real built admin/POS and real isolated HTTP/DB behavior. Both cases cover catalog failure/retry, search without losing grants, create then immediate edit, first save, blocked subsequent mutation, visible logout/login after security changes, grant-enabled editing after Print, cashier payment, table release and shift close. Sale **4 JD**, opening cash **50 JD**, expected closing cash **54 JD**, zero browser page errors.

The browser harness originally used an API login without refreshing its existing browser user cache, then left a response timeout unhandled while waiting for a disabled control. The server's crash handler shut that test process down. The harness now uses visible logout/login and handles action/response promises together. The interrupted owned fixtures were identified and removed; the final run completed its own cleanup. No production shutdown code was changed for the harness issue.

Visual inspection confirmed the new editor in English desktop and Arabic mobile. The Arabic selected/total count uses LTR isolation. The mechanical design scan reports no findings in the new permission editor; its advisories in the surrounding Users/POS files concern existing smaller font sizes outside this change.

## Resource checks and limits

`scripts/reviews/permissions-resources.cjs` compares the prior table writer at `ed5e7a53823e6b76c512c3b4c3983bccc7647bc2` and the current writer on six independently reseeded first-save cases. Each observed transaction connection executes **10 queries**, returns **17 rows**, uses **one lease**, and leaves **zero leases**. Local timings ranged 11.01–17.86 ms before and 12.25–14.38 ms after; three samples per version establish no customer latency claim. This small stock-disabled save comparison excludes HTTP authentication, physical printers and other stock/fee modes.

Browser permission editing makes exactly two catalog requests in the injected failure/retry case, with no requests from subsequent search/toggle actions. The startup catalog check is a bounded subquery over 25 keys, not an extra per-action permission read. Fresh installation reduces three separate permission seed statements to one.

Ignored evidence: `scratch/permissions-browser/results.json`, its screenshots, `scratch/permissions-resources/results.json`, `scratch/permissions-fixture-cleanup.json`, and `scratch/permissions-ui-detector.json`. Verification uses generated loopback databases and removes only owned fixtures. No customer database or physical printer was used; no deployment or GitHub integration is claimed.

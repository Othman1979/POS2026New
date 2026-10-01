# Database migration workflow

Use only for schema or migration changes. Query edits without schema changes do not require this workflow.

## Ownership and authorization

The main agent owns scope, evidence, migration-file writing, review, verification, and integration. When delegation is requested, `luna_max` (`.codex/agents/luna-max.toml`) can execute; the main agent still reviews its output and owns authorization and integration.

An explicit request to implement the agreed migration is implementation approval; do not ask again for the same scope. Planning-only requests authorize a dated evidence migration draft, not manifest/fallback activation. Production application remains separately authorized. Escalate a materially different schema change before implementing it.

## Sources and ordering

- The historical floor is `2026-07-31-tax-exempt-checks-v1`, checksum `6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3`. Do not register earlier migrations retroactively. New entries follow the current manifest predecessor, not necessarily this historical floor.
- Before implementation approval, write the normal dated evidence migration; add preflight/verify scripts when risk warrants. Leave `backend/migrations/auto-manifest.json` and the manual fallback unchanged.
- After approval, write one Hostinger-safe `.auto.sql`, append its ordered manifest entry with exact predecessor ledger name/checksum, target ledger checksum, and normalized SQL SHA-256. Follow the existing manifest format and hashing implementation.
- Append that exact `.auto.sql` block to `deployment/database/hostinger-manual-migrations.sql`, in manifest order, between `-- BEGIN AUTO MIGRATION: <name> | <checksum>` and `-- END AUTO MIGRATION: <name> | <checksum>`.
- The fallback is cumulative, forward-only emergency SQL for manual Hostinger/phpMyAdmin import. No secrets, `DELIMITER`, routines, triggers, or definers.
- After `2026-09-23-subscriptions-retirement-v1` is recorded, never replay the full cumulative fallback: older repeatable blocks would recreate retired tables. Its header must fail before the first DDL on such a database. Use the automatic migrator for later upgrades, or review and apply only the exact pending `.auto.sql` files in manifest order.
- The normal migration is the evidence/operational script; `.auto.sql` is the execution source; the fallback copies it verbatim. Do not maintain three independently rewritten implementations.

## Verification

Review the resulting SQL against the intended schema change and verify manifest ordering/hashes, fallback parity, and the smallest relevant scratch-DB upgrade from the exact predecessor. Check a current-schema no-op when accessible. Missing predecessors and checksum conflicts must fail closed. Inspect test setup to confirm which database will be used; this guide does not authorize production execution.

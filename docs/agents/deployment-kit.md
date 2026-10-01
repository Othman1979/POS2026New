# Maintained manual deployment kit

Maintain one current kit at `C:\Users\bash\Documents\New folder`:

- `POSAPP-Hostinger-source.zip`: replace the previous source archive after successful build and verification; do not accumulate dated ZIPs here.
- `fresh-database.sql`: fresh empty installation only. Preserve generated login seed records when updating schema.
- `.env` and `INITIAL-LOGIN.txt`: private, preserve unchanged unless specifically requested. Never commit or include in the source ZIP.
- `SETUP.txt` and `VERIFICATION.json`: update for the exact packaged source and SQL, without carrying forward unverified claims.

From a clean, committed checkout on Windows, run:

```powershell
npm run prepare:deployment
```

This is the repository's maintained implementation of the POSApp deployment ZIP workflow. It updates the existing six-file kit above. `-- --directory "C:\path\to\existing-kit"` selects a separate existing kit for verification or another installation; it must contain exactly the same six files. Installed npm dependencies and the loopback test database service are required. Test credentials come from `.env.test`, never the private deployment `.env`. No customer database is exported or modified.

`scripts/prepare-deployment-kit.cjs` coordinates `scripts/build-hostinger-source.ps1`, the canonical bootstrap SQL exporter and the exact-import checker. It builds in staging without checkout `.env` files, verifies each packaged source file and migration hash, preserves the initial-user INSERT from the previous SQL, and validates every permission definition, both login numbers, empty business tables and two startup passes. It then runs retained-history compatibility tests. Build outputs, metadata and SQL must all pass before the six-file candidate replaces the existing directory. Private `.env` and `INITIAL-LOGIN.txt` bytes are preserved. No version bump, GitHub push, upload, deployment or claim of Release gate approval occurs.

The command rejects dirty source, missing/extra kit files, unsupported initial-user seed formats, changed private files, concurrent runs and failed checks. Candidates and the old kit stay on the same volume; a failed rename rolls the old directory back. A process or machine crash may leave a sibling `.posapp-kit-*` workspace and `.New folder.posapp-kit.lock`. Confirm the owning process has stopped, preserve any `previous` directory, and restore it if the kit path is absent before removing the stale lock. Do not delete a recovery copy until the maintained kit has been verified. Ordinary success and handled failures clean up the temporary workspace.

`VERIFICATION.json` records evidence for that exact build. Packaging verification is separate from GitHub Release gate approval. Keep SQL and server source compatible in the same kit.

Fresh baselines omit the ten retired supplier/purchasing tables. Upgraded databases drop each of them through `2026-10-01-retire-purchasing-tables-v1` only when the table exists and is empty; a table that holds history is left in place. Historical migration files/checksums and covered ledger entries remain, so startup skips the older obsolete migrations. Schema validation does not require them, and no route reads them.

Verify the exact import with `node scripts/reviews/fresh-pos-baseline.cjs "C:/Users/bash/Documents/New folder/fresh-database.sql"`. It creates and removes its own guarded loopback database, checks empty business data, runs normal startup migration/validation twice, and verifies the tables remain absent.
For changes to the kit command, run `npm run test:isolated -- deploymentKit installerBaseline inventoryScopeRetirement` and `npx vitest run --config vitest.windows.config.mjs`, then run the actual command against a disposable copy of the existing kit. The Windows job builds a small committed source fixture through the actual PowerShell builder and checks Linux-compatible ZIP paths, metadata, source hashes and exclusions. Cover rejected SQL, mismatched login references, corrupt candidates, concurrent kit edits and rename rollback before updating the maintained kit. The exact-import checker accepts optional JSON-report and initial-login paths as its second and third arguments; reports are written only after fixture cleanup succeeds.

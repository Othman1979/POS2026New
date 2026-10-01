# Release browser requirements and repeatable deployment kits

## Result

The Release gate now runs the existing staff/table/payment browser checks on every PR to master and every master push. Its aggregate requires successful application, browser, Windows installer and spooler jobs; skipped, cancelled, failed or missing results fail the aggregate. The old inventory-branch conditions are removed. Database failures trigger bounded container-state, log, resource and InnoDB diagnostics, uploaded with browser evidence.

`npm run prepare:deployment` updates the existing six-file manual kit using the canonical bootstrap and a maintained source builder. It builds outside the checkout without checkout environment files, compares every archived source file and migration checksum, imports the exact generated SQL into an owned loopback database, verifies the entire permission catalog and preserved login references, runs startup twice, checks empty business tables and tests retained-history compatibility. Publication checks the old kit and candidate again and rolls back a failed directory promotion. Private configuration and login files are preserved byte for byte.

The workflow and command are described in `docs/agents/verification.md` and `docs/agents/deployment-kit.md`. This changes verification and packaging tooling, without changing application request paths or queries.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run test:isolated -- releaseGate deploymentKit installerBaseline inventoryScopeRetirement` | 45 tests, 5 files passed |
| `npm run test:release-browser` | All three workflows passed together after corrections |
| Staff permissions, real built app + HTTP + database | English 1440px and Arabic 390px passed |
| Table cancellation/recovery, real built app + HTTP + database | Both languages, fees on/off: four cases passed |
| Checkout component/store recovery, controlled HTTP fixture | 12 checks passed; no Vue/page errors |
| Actual kit command on a disposable copy | Source build, ZIP verification, SQL import, startup checks, retained history and publication passed |
| Exact fresh SQL | 77 tables, 25 permissions, 65 migration ledger rows; zero business history; two startup passes with no pending migrations |
| Source archive | 754 entries; all selected source bytes and 60 automatic migration checks verified |
| Architecture generation/check | Passed: 288 nodes, 77 flows, 558 steps; all referenced files present |
| Workflow syntax | actionlint 1.7.12 passed (optional shellcheck/pyflakes disabled) |
| Windows builder syntax and Git whitespace check | Passed |
| `npx vitest run --config vitest.windows.config.mjs` | 73 tests, 3 files passed |
| Actual Windows archive portability regression | Passed: nested paths/spaces, forward slashes, UTF-8 metadata without BOM, normalized migration hash, private/test/dependency exclusions, unchanged source and dependency target |

Staff checks include catalog-load failure/retry, preserving grants during search, role presets and explicit section scopes, conflicting edits, recovery after a lost create reply, first-save authority, denied later edits before a grant, editing after Print, table payment and shift cash, and temporary manager approval without changing the cashier role.

Table recovery checks reject stale Clear, recover a committed item removal whose reply was lost, reject a duplicate removal, reopen and clear successfully, restore stock, and cover ordinary audit recording and the `xyz` table-void exemption. Both real database browser fixtures report successful removal and no page errors.

Checkout checks cover receipt and print failures after a committed sale, keeping the original tender and idempotency key after a lost response, recovery with an empty register draft, and held-order handoff failure, declined replacement and late-response races. These are real components and stores with controlled HTTP responses, rather than a payment provider test.

## Deliberate failures

- Each required CI job result was tested as missing, skipped, cancelled and failed. All are rejected.
- Missing Arabic evidence, baseline-only results, page errors and incomplete fixture cleanup are rejected. A fresh browser run clears old success before launching children; child failure leaves an incomplete report.
- Real SQL imports with a removed permission, unexpected customer history or mismatched login reference fail without a success report.
- The complete CLI was run with a mismatched private login reference. It failed and preserved all six previous kit files, with its fixture, lock and staging cleaned.
- Actual CLI dirty-checkout and concurrent-lock attempts were rejected without replacing the kit or deleting the existing lock.
- Tests corrupt a verified candidate, edit a private file during preparation, omit required files and fail the directory promotion midway. Publication is blocked or the entire previous kit is restored.
- Failed Windows builds were checked to preserve all six kit files and clean their lock and staging.

The first combined browser attempt exposed a missing shared-policy alias in the older checkout harness. The actual Windows packaging run exposed normal npm stderr being treated as fatal and an unavailable `Get-FileHash` command. The harness alias was corrected; the builder now judges npm by its exit code and uses .NET stream hashing. Independent final inspection also caught .NET Framework's backslash ZIP entry names. The builder now creates entries with explicit forward slashes and rejects backslashes before publication; a real fixture regression is required in the Windows gate job. Corrected browser and packaging checks passed. An inherited outer test preload and differing SQL/JavaScript catalog sort orders were also corrected during test development.

## Evidence and limits

Local evidence is under ignored `scratch/release-kit-final-tests.log`, `scratch/release-browser-final.log`, `scratch/release-browser.json`, the three browser report paths listed by that summary, and `scratch/kit-command*.log`. The maintained kit's `VERIFICATION.json` records its exact commit and ZIP/SQL hashes only after a successful command.

Local verification used Windows, Node 24.16.0 and MariaDB 10.4.32. The GitHub workflow uses Node 22 and MariaDB 11.4; this branch's GitHub gate has not been run or merged as part of this local task. Docker diagnostics were tested with failed command responses, not an actual local container failure. GitHub service initialization failures remain visible in the runner's service logs before workflow steps can execute.

Packaging reuses installed lockfile dependencies and does not prove a fresh hosting dependency installation. It does not upload, deploy, change hosting environment values, rebuild the Windows spooler installer, or claim GitHub approval. A process/machine crash during directory promotion can leave a recovery copy and stale lock; the documented recovery procedure preserves that copy. No customer database, physical printer or external payment service was used for verification.

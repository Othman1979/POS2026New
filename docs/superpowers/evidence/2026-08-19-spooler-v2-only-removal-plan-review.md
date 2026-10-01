# Adversarial review — V2-only V1-removal plan

**Date:** 2026-08-19
**Reviewer:** Claude (independent), for Sol
**Subject:** `docs/superpowers/plans/2026-08-18-spooler-v2-only-v1-removal.md` rev 1
**Method:** every claim traced to the working tree at `codex/spooler-v2-local-print-agent-continued`, HEAD `da216b27` (“docs(spooler): plan V2-only legacy removal”, the commit that introduced the reviewed plan). The spooler runtime under review is its parent `b65491e6` (“fix(spooler-v2): close residual health races”). No code executed, no plan step performed.

**Provenance correction.** This report first cited HEAD as `0a65e3c8` — a commit from my earlier session that is no longer in this branch's history; the work it carried now lives in `b65491e6`. I wrote the hash from memory instead of reading `git log`, which is the same failure mode as §0 below. Caught by Sol.

**Revision history.** §§1-4 are the review of plan rev 1. §5 maps rev 1 → rev 2. §6 is the rev-1 verdict. §7 records Sol's review of rev 2 and the rev 3 corrections. §8 records Sol's review of rev 3 and the rev 4 corrections; §9 records Sol's review of rev 4, the rev 5 corrections, and the scripted self-audit now built into the plan. Read all three: every revision so far has introduced defects of its own.

---

## 0. One correction to my own review, up front

I initially reported the old-updater rollback path as a **HIGH** — that `Update-Spooler.ps1` would call the deleted `/abort-prepare` and `--rollback-v1` on any already-V2 station, stranding it disabled. **That was wrong**, and the mistake is worth recording because it is the kind another reviewer will repeat.

I justified reachability with `backend/tests/unit/installerUpdateContract.test.js:634`, which pins the string `"$EnableV2 -or $v2ActiveBefore"`. That condition lives at `Update-Spooler.ps1:521` and gates **registration verification**. The abort path is gated on a different flag entirely:

```
:414-418   if ($EnableV2) { ...; if ($v2ActiveBefore) { $EnableV2 = $false } }
:443-447   if ($EnableV2) { Invoke-V2Prepare ...; $cutoverStarted = $true }
:551       if (-not $commitComplete -and $cutoverStarted -and -not $WhatIf) { ...abort/rollback... }
```

`$cutoverStarted` is set **only** inside `if ($EnableV2)`, and `$EnableV2` is forced false for an already-V2 station at `:414-418`. So an old updater on an already-V2 station never reaches the deleted endpoints. On a still-V1 station, `Invoke-V2Prepare` 404s *before* `$cutoverStarted` and `$rollbackPrepared` are set, so nothing is swapped and the station is untouched. **Both cases fail safely.**

I matched a test assertion to the wrong source line and promoted a non-issue to the top of the report. The finding is downgraded to a documented trap in rev 2 rather than a defect, with the `:634`-vs-`:521` distinction written down so it does not get re-derived the same wrong way.

Everything below survived re-verification after that error, and I re-checked each one rather than assuming.

---

## 1. High

### H1 — One stale `'v1'` row permanently blocks the migration, and the plan forbids the only remedy

**Evidence.** No production code ever deletes a station row. The sole `DELETE FROM spooler_stations` in the tree is `backend/tests/integration/spoolerV2Compatibility.test.js:39`. Rows are auto-created as `'v1'` by `backend/services/printQueue.js:81`, `backend/services/spoolerAgents.js:32` and `:119`, and written *back* to `'v1'` by `rollbackStationToV1` (`spoolerAgents.js:379`). Decommissioning an agent (`spooler_agents.status='decommissioned'`) never touches the station row.

Rev 1 Task 3 step 1 adds a CHECK requiring `delivery_protocol='v2'`, which validates every row — live or dead. One retired station, one renamed `spooler_id`, one abandoned prepare, and the migration fails forever. The plan's only instruction is "Upgrade or repair that station using the compatible branch. Do not add V1 code back." For a machine that no longer exists there is nothing to upgrade, so the branch cannot be completed.

**Second half of the same defect, opposite direction.** Rev 1 claims the CHECK "fails if any station was not upgraded." It cannot see a station with no row at all: a configured, active printer whose `spooler_id` has never registered passes silently.

**Fix in rev 2.** Release gate items 6 and 7 add the two queries that find each case. Task 3 gains an owner-approved orphan delete scoped to rows with no `active`/`draining` agent, no active printer, and no non-terminal queue work — run as migration step 1, before the CHECK. The overstated CHECK claim is replaced with an explicit statement of what it does and does not prove.

### H2 — Deleting `printQueue.js` destroys the only writer of audit-report print status

**Evidence.** `updateAuditPrintStatus` (`backend/services/printQueue.js:44`) is the sole updater of `audit_report_documents.last_print_status / last_print_error / last_printed_at`, reached only from `settlePrintJob` (`:206`, `:246`). `backend/services/spoolerSync.js` — the V2 settle path — has no such write; its only `audit` reference is `audit_events` at `:170`. The column is set to `queued` at enqueue (`backend/routes/admin/auditReports.js:107`) and read into the admin listing (`:236`). Those reports print through `dispatchReceiptPrint` at `:115`, `:305`, `:344`, `:455`.

**Stated fairly:** this is **already broken for V2 stations today** — an audit report printed by a V2 station never leaves `queued`. The plan does not cause the regression. What it causes is permanence: it deletes the only implementation, with no task porting it and no task mentioning `audit_report_documents`.

**Fix in rev 2.** Named in the scope section as the one behavior V1 owns that V2 never implemented. Task 2 gains an explicit either/or: port the write into the V2 settle transaction (exact anchors given — `spoolerSync.js:115-118` must also select `payload`, and the write goes after the settle UPDATE at `:128-152`), or record owner approval for the loss and stop writing a `queued` value nothing will clear. A new final invariant makes silence not an option.

---

## 2. Medium

### M1 — Two owning files absent from Task 2's file list

`backend/routes/print.js` holds 3 of the 6 `enqueueAndProcessJobs` call sites (`:988`, `:1298`, `:1307`) and appears nowhere in rev 1. `backend/routes/admin/printers.js` owns the `rollback-v1` route to be deleted (`:252`) alongside the `drain` (`:210`) and `replace` (`:225`) routes to be kept; rev 1 named only "admin print-queue API", which is `backend/routes/admin/printQueue.js` — a different file.

*Fix:* rev 2 lists all 11 dispatch call sites by `file:line`, plus `admin/printers.js` and `backend/services/printerStatus.js` (whose `updatePrinterDeviceStatus` at `:85` exists only to guard V1 writes by protocol at `:97`, and is called only from the two deleted `server.js` sites).

### M2 — Test-deletion scope named 3 files; 11 are coupled

Unnamed in rev 1 but broken by Task 2: `backend/tests/integration/printQueue.test.js`, `backend/tests/unit/printDispatchOwnership.test.js`, `backend/tests/unit/spoolerRegistry.test.js`, `backend/tests/unit/spoolerDurableSeenStore.test.js`, `backend/tests/integration/spoolerV2Cutover.test.js`, and `pos-spooler-printer/tests/{poll-fallback,durable-seen-store,external-config}.test.js`.

None appears in any task's GREEN command, so they first surface at Task 4's single full run — where the plan's own rule ("pre-existing only if reproduced at branch base") gives no way to classify a legitimately obsolete suite. That is exactly the ambiguity that gets a real regression waved through.

*Fix:* rev 2 enumerates all of them for deletion inside Task 2, and Task 4 now states that no failure there should be explainable as "that test tested V1".

### M3 — Root `package.json` hard-codes a deleted test

`test:installer` lists `backend/tests/unit/spoolerRegistry.test.js`. `vitest run <missing file>` exits non-zero. Root `package.json` is in no task's file list in rev 1.

*Fix:* added to Task 1's file list, with a RED assertion that `test:installer` references only existing files, and `npm run test:installer` added to Task 4's gate.

### M4 — Task 4's mandatory harness calls a route Task 2 deletes

`backend/tests/manual/spoolerV2MixedJobsHarness.js:267` and `backend/tests/manual/spoolerV2LoadHarness.js:66` both POST `/api/spooler/v2/prepare`. Task 4 requires the 50-job mixed run; it 404s during setup. Neither file was in any file list.

*Fix:* both added to Task 2's file list; Task 4 notes the harness is updated there.

### M5 — `validate-schema-drift.js` compares two live databases and fails as written

`scripts/validate-schema-drift.js:19-23` diffs the `.env` database (`posapp`) against the `.env.test` database (`posapp_test`). Rev 1 runs it in Task 3 after dropping the column on a scratch target only, and Task 4's `npm run test:unit` re-runs it via `pretest:unit`. Both fail unless the dev database is migrated too — which the plan never instructs.

*Fix:* Task 3 states the precondition explicitly and flags the `pretest:unit` consequence.

### M6 — `baseline.sql` is sha256-pinned; Task 3 edits it without re-pinning

`deployment/database/manifest.json` pins `24cd18a5…`; `backend/tests/integration/installerBaseline.test.js:66` asserts the normalized hash matches. Rev 1's Task 3 said "baseline" but not the manifest. Task 3's own GREEN run catches this, so it is a completeness gap rather than an escape — but it sends the executor hand-editing the wrong file first.

*Fix:* `manifest.json` named in Task 3's file list with the enforcing test cited.

### M7 — Dropping the registration in-flight guard removes the last double-print interlock

`backend/services/spoolerAgents.js:167-173` (and `:142-148`) refuse registration with 409 `station_busy` when the station holds `agent_id IS NULL AND status IN ('processing','sent')`. Rev 1 said registration becomes "idempotent without prepare/transition checks" and never said to keep this.

The predicate is **identical to release-gate item 4** — the gate exists precisely because that condition is dangerous. Removing the runtime guard leaves the gate as the only defence, and a gate is a one-time snapshot. It costs one query.

*Fix:* promoted to a final invariant, restated in Task 2's ownership step, and added as a RED integration assertion and an adversarial-checklist item.

---

## 3. Low — traps rev 2 now records

- **`compiled_document_v1` and `posapp-fresh-baseline-v1` must survive.** The first is load-bearing in the kitchen idempotency key (`architecture.json` node 96: the key deliberately excludes it); the second is a manifest id. Rev 1 orders a mechanical `receiptDisplayV1.cjs` rename, and that pattern must not reach these.
- **`SPOOLER_KEY` looks like V1 config and is not.** It authenticates V1 sockets (`server.js:143`) and V1 poll (`backend/routes/spooler.js:39`), both deleted — *and* V2 bootstrap for `/register` and `/status` (`backend/routes/spoolerV2.js:23`), which stays. Removing it from `deployment/templates/pos.env.template` (asserted at `installerPackageContract.test.js:587`) bricks agent registration.
- **`--prepare` at `v2-server.js:98` is the platform-helper flag**, not V1 station prepare (`:103`). `installerPackageContract.test.js:732` asserts it.
- **Staff failed-print badge.** `broadcastFailedPrintJobsCount()` has three callers: `server.js:366` (V1 ack, deleted), `:610` (30-second dispatcher, deleted), `:813`. If `:813` is not on a post-V2-settle path, the badge freezes.
- **`receiptDisplayV1.cjs` has 8 referencing sites**, not the one rev 1 named. All are listed in rev 2 Task 1.
- **Task 3's RED assertion was weaker than its own goal.** It checked for `transitioning`/`rollback-v1`/`terminalize-v1` in runtime SQL but not for surviving `delivery_protocol` reads or writes — and `spoolerAgents.js:119` *inserts* the column, which is not branch vocabulary. Its integration GREEN would have caught it, so this is low, but the assertion now covers it directly.
- **Rev 1's deletion scan omitted every token after `v2-server.js`** — `ENABLEV2`, `spoolerRegistry`, `enqueueAndProcessJobs`, `dispatchClaimedPrintJobs`, `print_job_response`, `receiptDisplayV1`, `prepareStationCutover`, `abortStationPrepare`, `rollbackStationToV1`, `station_not_prepared`, and the four PowerShell cutover functions. The proof-of-deletion step could not catch leftovers of things the plan itself ordered removed. Rev 2's scan includes them and also covers `src` and `package.json`.

---

## 4. What rev 1 got right

Recorded so it does not get re-litigated:

- **The ≤2 s sync genuinely subsumes the deleted dispatcher.** `spoolerSync.js:206-212` claims `pending` plus due `failed`, a superset of what the 30-second retry loop covered for V2 stations. "Add no second channel" is correct.
- **Release-gate item 4 matches the real stranding predicate exactly** — the same one `spoolerAgents.js:167` uses. That was well chosen.
- **`durable-seen-store.js` and `poll-fallback.js` really are V1-only**, required solely by `pos-spooler-printer/server.js` and their own tests.
- **One-active-agent-per-station has a structural backstop**: `spooler_agents.active_station_key`, a STORED generated column under `UNIQUE KEY uq_spooler_agents_active_station` (`backend/migrations/2026-08-17-spooler-v2-agents-v1.sql:32-35`). The Task 2 assertion is not the only guard.
- **`npm run test:unit` does cover unit, integration and `src/**/*.spec.js`** (`vitest.config.mjs` include block), so the final gate's scope is adequate.
- **The CHECK-then-drop idiom is legitimate on MariaDB** — it validates existing rows and fails closed — and stays inside the `CLAUDE.md` prohibition on routines and `DELIMITER`.
- **The scan tokens `v1_drained` and `v1_stopped` are real**, not invented: `Update-Spooler.ps1`, `SpoolerLayerState.ps1`, `Repair-SpoolerStartup.ps1`.
- **Keeping `/api/spooler/v2` and `protocol_version = 2` is the right call**, for the reason given.

---

## 5. Rev 1 → rev 2 change map

| # | Change | Where |
| --- | --- | --- |
| H1 | Gate items 6 and 7 with runnable queries; owner-approved orphan delete as migration step 1; corrected CHECK claim | Release gate, Task 3 |
| H2 | Audit-status gap named in scope; port-or-record decision step; new final invariant | Scope, Task 2, Invariants |
| M1 | All 11 dispatch call sites by `file:line`; `admin/printers.js`; `printerStatus.js` | Task 2 files |
| M2 | 10 test files enumerated for deletion + 1 edit, inside Task 2 | Task 2 files |
| M3 | Root `package.json` added; RED assertion; `npm run test:installer` in the gate | Task 1, Task 4 |
| M4 | Both manual harnesses added | Task 2 files |
| M5 | Dev-DB precondition stated; `pretest:unit` consequence flagged | Task 3 |
| M6 | `deployment/database/manifest.json` named with its enforcing test | Task 3 files |
| M7 | In-flight guard promoted to invariant + RED assertion + checklist item | Invariants, Task 2 |
| — | `$EnableV2`-gated NSSM restore called out (`Update-Spooler.ps1:586`, `:605`) | Task 1 |
| — | Deletion scan extended by 14 tokens; `src` and `package.json` added to its roots | Task 4 |
| — | Architecture nodes/flows/invariants to remove listed by index | Task 4 |
| — | "Known traps" section added (old media, `SPOOLER_KEY`, `--prepare`, updater analysis) | New section |
| — | 7 new adversarial-checklist entries | Checklist |
| — | Gate item 8: no station retains a pre-cutoff package | Release gate |

---

## 6. Verdict

Rev 1 was well-shaped; its failures clustered in two places — **file lists written from memory rather than from a caller trace** (M1–M4, and the `receiptDisplayV1` undercount), and **the data states nobody creates on purpose** (H1's orphan rows, H2's never-implemented V2 behavior).

H1 and H2 are the two I would not start implementation without resolving. H1 can strand the branch at the last task with no legal way forward; H2 quietly converts a live-but-broken feature into a deleted one. Neither is visible from the happy path, which is why neither showed up in rev 1's own adversarial checklist.

Rev 2 addresses all nine findings. It authorizes no merge, push, deployment, or production migration, and Task 3's orphan delete remains gated on explicit owner approval.

---

## 7. Sol's review of rev 2, and the rev 3 corrections

Sol reviewed rev 2 and found **six defects introduced by my own corrections**. All six reproduce. A seventh surfaced while I was checking their second point. Rev 2 was not execution-ready; rev 3 is the result.

The pattern across five of the seven is the same one I criticised in rev 1 — **acting on a grep match instead of opening the file**. I built rev 2's test-deletion list from a token-coupling scan and never opened the test files; I built the architecture list from array positions printed by a throwaway script and never checked whether those positions were V1. That is worth stating plainly, because it means rev 1's defects and rev 2's defects have a common cause rather than being unrelated slips.

### S1 — The deletion scan was impossible to satisfy *(confirmed)*

Rev 2's single scan forbade `socket.io-client` while rooted at `package.json` and `src`. Root `package.json` declares both `socket.io` and `socket.io-client@^4.8.3`, and the client is what the preserved staff/POS sockets use — the same sockets the plan's own scope section says must not be touched. The scan also rooted at `backend`, which contains `backend/migrations/2026-08-17-spooler-v2-agents-v1.sql:11` — immutable applied history that legitimately keeps `delivery_protocol` — and forbade `v2-server.js`, which Task 1 explicitly *requires* the updater to keep referencing as the prior entry point.

Three of the scan's tokens could therefore never reach zero, which makes the whole proof-of-deletion step unrunnable.

**Rev 3:** split into Scan A (tokens with no legitimate survivor, roots narrowed to live code), Scan B (`delivery_protocol`, excluding migration history and the Hostinger fallback, including `baseline.sql`), and a table of the three tokens with required homes plus two scoped commands for them.

### S2 — `printDispatchOwnership.test.js` must be edited, not deleted *(confirmed)*

The file has ten cases. Exactly one — `:102`, "claims and emits each station only its own jobs" — is V1 socket dispatch. The other nine cover live behavior this branch must not regress: enqueue through the supplied transaction executor (`:12`), the trusted kitchen artifact at the durable enqueue seam (`:24`), compile-once per fresh kitchen payload (`:52`), server-only revision override (`:69`), forged receipt-test-marker stripping (`:85`), and three receipt-printer-selection cases (`:146`, `:151`, `:156`).

Deleting the file to remove one test would have silently dropped coverage of payload sanitization and printer routing.

**Rev 3:** tests are now split by disposition — delete outright, edit, or triage — with the surviving cases named.

### S3 — Audit-report status was left as an executor decision *(confirmed)*

Rev 2 offered "port it **or** record owner approval that the column is abandoned." Sol is right that this contradicts the no-regression goal, and the framing was wrong regardless: an executor should not be choosing whether a user-visible feature survives a cleanup. Sol's addition that the port must cover **both** outcomes is also correct — `printQueue.js` writes `printed` at `:206` and `failed` at `:246`, and rev 2's anchor text described only the success path, so a literal implementation would have left failed prints stuck at `queued`.

**Rev 3:** the port is mandatory, both outcomes specified with their source anchors, `auditDocumentIdFromPayload` (`printQueue.js:37`) named for reuse, and the invariant rewritten so abandonment is not an option.

### S4 — The orphan-station query was missing its third predicate *(confirmed)*

Rev 2's prose promised a delete scoped by "no active/draining agent, no active printer, and no non-terminal queue work." The query had only the first two. As written it would report a station as deletable while it still owned unresolved `pending`/`sent`/`local_accepted`/`cancel_requested` rows — turning a safety gate into the hazard it exists to prevent.

**Rev 3:** the queue join is added, terminal states sourced from `spoolerSync.js:3`, and the join covers rows routed through an inactive printer because `print_queue.spooler_id` is NULL until a row is claimed.

### S5 — Architecture cleanup used numeric array positions *(confirmed)*

Rev 2 said "nodes 47/49/99/100/169/191, and flows 14/21/26/27". Both `nodes` and `flows` carry stable `id` fields, and indices shift as entries are removed. Worse, several named positions are entries that must survive:

| Position | Stable id | What it actually is |
| --- | --- | --- |
| nodes[47] | `prn-print-queue-admin-route` | Admin print-queue API — **retained**, simplified |
| nodes[169] | `db-spooler-stations` | The station table — **retained**, description rewritten |
| flows[14] | `flow-standalone-spooler-install` | Install flow — **retained**, `/ENABLEV2=1` step removed |
| flows[26] | `flow-checkout-receipt-socket` | Checkout receipt printing — **retained**, no longer socket-delivered |

**Rev 3:** a disposition table keyed by stable `id`, marking each entry delete / rewrite / keep, with an instruction to re-derive the list before editing.

### S6 — Provenance *(confirmed)*

Corrected in the header above. HEAD is `da216b27`; the spooler fixes are in `b65491e6`.

### S7 — `printQueue.test.js` is not a blanket delete *(found while verifying S2)*

Checking Sol's S2 sent me through the rest of rev 2's deletion list, and `backend/tests/integration/printQueue.test.js:265` — "marks serialized audit documents printed or failed from spooler ACKs" — **is the only regression guard for the audit-status behavior S3 requires porting**. Rev 2 mandated deleting it in Task 2 while (in rev 3) mandating the port in the same task. Deleting the only test of the behavior you are being told to preserve is a self-cancelling instruction.

The file's other cases assert V1 lifecycle mechanics — lease-expiry reclaim (`:107`), `isNonRetryablePrintError` integrity/config dead-lettering (`:188`, `:244`), uncertain-outcome dead-lettering (`:167`), kitchen safe-retry timing (`:208`). Their V2 counterparts are `settleUpdate` and `failure_class`, and `spoolerV2Sync.test.js` currently covers permanent-failure dead-lettering (`:274`) and unknown-outcome rejection (`:241`) but **not** uncertain outcomes, integrity mismatch, or kitchen retry timing.

**Rev 3:** `:265` is rewritten against V2 settle as the port's guard; the rest are triaged case by case against the V2 suite before deletion, with the three uncovered behaviors named.

### Standing after rev 3

| Round | Findings | Source |
| --- | --- | --- |
| Rev 1 review | 2 High, 7 Medium/Low confirmed; 1 High retracted by me | me |
| Rev 2 review | 6 confirmed | Sol |
| Rev 2 self-check | 1 confirmed (S7) | me, while verifying S2 |

Two of my own claims have now been withdrawn across this branch — the old-updater HIGH in §0 and the `0a65e3c8` provenance — both from citing memory rather than reading the source. Rev 3 should be reviewed on the same assumption: check the anchors, do not trust them.

---

## 8. Sol's review of rev 3, and the rev 4 corrections

Eight more findings, all confirmed against the tree. Rev 3 closed the previous seven and introduced or left these.

### Standards

**St1 — the zero-hit scans included test files *(confirmed)*.** A contract test proves a token's absence by containing it: `installerPackageContract.test.js:731` currently asserts `toContain('ENABLEV2')` and becomes `not.toContain('ENABLEV2')`, string intact. The `spoolerV2OnlyContract.test.js` this plan *asks for* must name every V1 symbol it forbids. Rooting Scan A at `backend/tests` therefore guarantees hits that can only be "cleared" by weakening the assertions that prove the removal — the scan would actively work against its own purpose.

*Rev 4:* both scans exclude `**/tests/**`; the test tree gets a hand review instead, checking each occurrence is an absence assertion rather than a live dependency.

**St2 — my audit-status justification was factually wrong *(confirmed)*.** I wrote that `auditReports.js:236` "reads it back into the admin listing." Line 236 is a column list inside an `INSERT INTO audit_report_documents`, not a SELECT. No route selects or exposes `last_print_status`; the fields are write-only (`:107` `queued`, `:124` `failed`, `:236` insert default). I had that line in front of me in a grep result and assumed a read from surrounding context.

The port is still right, for a different reason: the system keeps stamping `queued` into a permanent audit record that no V2 path ever advances, so every V2-printed audit document accrues a false status forever. That is durable data rot in an audit table, not a UI regression.

*Rev 4:* justification rewritten in all three places; "user-visible" removed.

**St3 — test migration aimed at the wrong layer *(confirmed)*.** Rev 3 told the executor to check `spoolerV2Sync.test.js` for equivalents of integrity, uncertainty, and kitchen retry timing. Under V2 the server owns none of them: `spoolerSync.js:131` sets `next_retry_at = NULL` on every settle, so retry timing is not server behavior at all, and integrity and transport uncertainty are decided in `v2/printer-workers.js`, `v2/agent-runtime.js`, `v2/printer-transports.js` and `v2/job-store.js`.

*Rev 4:* a per-case port table sending `:188`, `:167`, `:208`/`:100` and `:244` to agent tests, deleting `:107` as V1 lease semantics, and keeping only `:265` in the backend sync suite because server settlement is where that write lives.

**Minor — `prn-printer-status`** is now a rewrite (retarget the node to `updatePrinterDeviceStatusesForStation`) rather than delete-and-recreate, which would churn a stable id for nothing.

**Minor — the count was wrong.** `printDispatchOwnership.test.js` has nine `it(` cases, not ten; removing `:102` retains **eight**. My enumeration listed eight while the prose claimed nine, which is how Sol caught it. Corrected in both documents.

### Spec

**Sp1 — gate item 8 was unprovable as written *(confirmed)*.** "No station retains a package older than this release" was to be proven from station telemetry, which reports what is *installed*, not what media exists on a USB stick, a share, or a release folder — and that media is precisely what re-creates a V1 station after cutoff.

*Rev 4:* the gate now requires the approved package version plus artifact SHA-256, written confirmation that earlier spooler installer and updater artifacts are withdrawn from every distribution location, and the per-station installed version only as a cross-check.

**Sp2 — `Repair-SpoolerStartup.ps1` was outside the entry-point contract *(confirmed)*.** It carries its own: `Set-SpoolerRepairEntryPoint` validates against `@('server.js','v2-server.js')` at `:37`, `:149` asserts the journal `targetScript` is `v2-server.js`, and `:241`/`:261`/`:274`/`:283` repoint either way. Rev 3 listed the file under Task 1 but wrote the compatibility requirement only for the updater, so the repair path could keep targeting a deleted entry point.

*Rev 4:* the contract explicitly covers the repair script — `v2-server.js` recognised only as a previous recoverable entry point, always targeting `server.js`.

**Sp3 — three suites were unclassified *(confirmed)*.** `pos-spooler-printer/tests/payload-integrity.test.js` (`require('../server')` at `:65`), `transport-boundary.test.js`, and `spooler-report-rendering.test.js` (`:153`) all load the V1 runtime, and rev 3 named none of them — leaving an executor to delete `server.js` and discover the breakage with no guidance. They protect integrity refusal, transport uncertainty, and renderer/raster/cut behavior, all of which survive in V2. They are also the only coverage for raster and cut on the affected report printer.

*Rev 4:* a table classifying each, with the instruction to re-point assertions at the durable agent — which after Task 1 *is* `../server`, so much of this is a harness change — and to remove V1-transport-specific assertions individually rather than bulk-deleting.

**Sp4 — `migrateLegacy()` survives inside V2 *(confirmed)*.** `pos-spooler-printer/v2/job-store.js:133`, called at `:183`, imports the V1 `seen-print-jobs.json` durable-seen file and quarantines `seen-print-jobs.v1.backup.json`. It is V1 residue living in the V2 runtime and rev 3 never mentioned it.

*Rev 4:* delete it, with the safety argument stated — gate item 2 requires every station to be on V2 already, so every station has run it once, and a station that has not is blocked by the gate rather than rescued by this function. Keeping it for one release is allowed **if** the owner says so explicitly; retaining it silently is not.

**Sp5 — the badge step was needlessly conditional *(confirmed)*.** `broadcastFailedPrintJobsCount()` has three callers: `:366` (V1 ack, deleted), `:610` (30-second dispatcher, deleted), and `:813`, which runs once inside the boot block. Deleting the first two leaves the badge computed at startup and never again. Rev 3 hedged with "if `:813` is not on a path that fires after a V2 settle" — it plainly is not.

*Rev 4:* a direct instruction to emit the count after a settle that changes queue state, explicitly not by reinstating a timer.

### Standing after rev 4

| Round | Findings | Source |
| --- | --- | --- |
| Rev 1 review | 2 High, 7 Medium/Low confirmed; 1 High retracted by me | me |
| Rev 2 review | 6 confirmed | Sol |
| Rev 2 self-check | 1 confirmed | me |
| Rev 3 review | 8 confirmed | Sol |

Three of my claims have now been withdrawn: the old-updater HIGH (§0), the `0a65e3c8` provenance (header), and "user-visible in the admin listing" (St2). All three came from citing something I had seen rather than re-reading it — a test assertion matched to the wrong source line, a commit hash from memory, and an INSERT column list read as a SELECT. The corrective is mechanical, not attitudinal: open the line, read the statement it belongs to, then write the claim.

---

## 9. Sol's review of rev 4, the rev 5 corrections, and the audit that should have existed

Ten findings from Sol, all confirmed. Two more found by auditing rev 5 mechanically instead of waiting for round six. The owner's objection — that these rounds keep producing the same class of defect — is correct, and this section ends with what was done about it rather than another apology.

### Sol's findings

**St1 (High) — Task 1 could not reach GREEN *(confirmed, and broader than reported)*.** `pos-spooler-printer/tests/run-tests.js` executes **every** `*.test.js` in its directory, so `npm --prefix pos-spooler-printer test` at the end of Task 1 runs all 26 spooler suites — while the dispositions for the broken ones sat in Task 2. Sol listed six affected suites. Checking the whole directory found **eight**: their six plus `receipt-display.test.js` (requires the pre-rename `receiptDisplayV1.cjs`) and `v2-job-store.test.js`, whose `seen-print-jobs*` fixtures at `:66`, `:67`, `:70`, `:141`, `:145`, `:148` break because rev 4 moved the `migrateLegacy()` deletion into Task 1.

*Rev 5:* all eight are dispositioned inside Task 1 as a table — delete, edit, or port — before its GREEN run.

**St2 (High) — Scan A still hit `__tests__` *(confirmed)*.** `--glob "!**/tests/**"` does not match `src/admin/pages/__tests__/`, whose `spoolerV2Settings.spec.js` carries `rollback-v1`, `terminalize-v1` and `delivery_protocol` today and will keep carrying them as absence assertions. Rev 4 fixed the exclusion for one naming convention and missed the other.

*Rev 5:* both globs on all four scans; the manual review names all three test roots.

**St3 (Medium) — the new deletion was outside the proof *(confirmed)*.** Rev 4 ordered `migrateLegacy()` deleted but never added `migrateLegacy` or `seen-print-jobs` to Scan A, so an implementation could leave the migration and its fixtures in place and still pass every stated gate.

*Rev 5:* both tokens added to Scan A.

**St4 (Low) — false anchor *(confirmed)*.** `printQueue.test.js:100` is mid-assertion inside the `:56` acknowledged-history case, not a kitchen-retry test. The `:100` came from `spoolerPoll.test.js`'s listing — two files' `it()` lines conflated in one note.

*Rev 5:* anchor removed; the retry port now points at existing V2 worker coverage in `v2-printer-workers.test.js`.

**Sp1 (High) — retired V2 stations deadlock the gate *(confirmed)*.** Gate item 1 demanded an active/draining agent for every station, while gate item 6's cleanup selected only `delivery_protocol <> 'v2'`. A retired station already at `v2`, with no active printer and only revoked agents, satisfies neither and blocks the release on a station nobody uses.

*Rev 5:* item 1 is scoped to stations referenced by an active printer, and the orphan query drops its protocol filter entirely — retired stations exist at both `v1` and `v2`, and that filter was the deadlock.

**Sp2 (Medium) — three cases unclassified *(confirmed)*.** The disposition table omitted `printQueue.test.js:34` (authoritative payload hash), `:56` (claimant ownership and durable acknowledged history), and `:129` (max-attempt dead-letter, retry-due still claimable). `:129` matters most: `spoolerSync.js:212` still re-claims due `failed` rows, so that is live server behavior.

*Rev 5:* all eight cases classified, split between backend and agent targets.

**Sp3 (Medium) — repair script outside the final proof *(confirmed)*.** Rev 4 required `Repair-SpoolerStartup.ps1` to honor the entry-point contract in Task 1, but the survivor table named only `Update-Spooler.ps1` and the scoped `v2-server.js` scan excluded `deployment/windows` altogether — so the proof could not tell a legitimate prior-entry reference from a stale repair target.

*Rev 5:* both scripts in the survivor table, `deployment/windows` included in the scan, and an explicit rule that `v2-server.js` may appear only as previous/rollback compatibility — never as a target entry point, journal `targetScript`, or `ValidateSet` default.

**Sp4 (Medium) — badge fix had no observable contract *(confirmed)*.** "Broadcast after settlement" is not implementable as stated, because `runAgentSync` confirms repeated terminal results idempotently (`spoolerV2Sync.test.js:223`) and a re-confirmation must not read as a new failure.

*Rev 5:* adopts Sol's design — a `queueStateChanged` result from the sync transaction driven by `affectedRows > 0` on the settle UPDATE, published through `req.io` after commit, with both assertions specified.

**Sp5 (Medium) — cleanup was optional *(confirmed)*.** Rev 4 let the executor keep `migrateLegacy()` "for one release." That is a product decision and the owner already asked for complete removal.

*Rev 5:* deletion is unconditional; an exception requires a written owner decision recorded before execution.

**Sp6 (Low) — safety claim overreached *(confirmed)*.** The updater analysis covers the current dual-runtime `Update-Spooler.ps1`, not artifacts predating its `v2ActiveBefore` handling.

*Rev 5:* the trap says exactly that, and points at gate item 8 as the real mitigation.

### Found by auditing rev 5 rather than waiting

- **`backend/tests/integration/printTemplates.test.js` was never classified in any revision.** It exercises `backend/routes/admin/printTemplates.js:227`, which loses its dispatch, and calls the surviving `enqueuePrintJobs` at `:362-364`. Now an edit, and in Task 2's GREEN list alongside `printDispatchOwnership.test.js` — every suite a task edits rather than deletes must be shown to survive that task.
- **Four leftovers in rev 5 itself**, caught by running the audit on the document: two scoped scans still missing a test-root exclusion, and two unqualified paths (`../receiptDisplayV1.cjs`, `admin/printTemplates.js`) that would have sent an executor guessing.

### The actual fix for the pattern

Four rounds produced defects of three kinds, all mechanically detectable, and I was finding them by reading rather than by checking. Rev 5 adds a **Plan self-audit** section with six checks, and they are now scripted and run against the document:

| Check | What it caught |
| --- | --- |
| Every `file:line` anchor resolves and the line says what the prose claims | the `:100` anchor, the `INSERT`-read-as-`SELECT`, three unqualified paths |
| Every task's GREEN passes using only work scheduled up to that task | St1 — the eight Task 1 suites |
| Every deleted symbol has all referrers handled in the same task or earlier | `printTemplates.test.js`, `v2-job-store.test.js` |
| Every zero-hit scan excludes `**/tests/**` *and* `**/__tests__/**` | St2, plus two leftovers in rev 5 |
| Every architecture entry addressed by stable `id` with a disposition | rev 2's array indices |
| No two gate items can deadlock on the same row | Sp1 |

Rev 5 passes all six. That does not make it correct — the checks are structural, and a claim can resolve cleanly and still be wrong, which is how "user-visible in the admin listing" survived two rounds. It does mean the next round should be about judgment rather than about anchors that do not resolve and commands that cannot run.

### Standing after rev 5

| Round | Findings | Source |
| --- | --- | --- |
| Rev 1 review | 2 High, 7 Medium/Low confirmed; 1 High retracted by me | me |
| Rev 2 review | 6 confirmed | Sol |
| Rev 2 self-check | 1 confirmed | me |
| Rev 3 review | 8 confirmed | Sol |
| Rev 4 review | 10 confirmed | Sol |
| Rev 5 self-audit | 2 confirmed (1 substantive, 4 leftovers) | me, scripted |

# Spooler V2 — independent review and fix handover

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued` (unmerged, unpushed; see §7 for the commits added by this review)
Author: independent reviewer
Audience: Sol

This is the consolidated record of everything I reviewed and everything I changed on top of Sol's remediation work. It exists so the review can be checked without replaying the conversation. The line-by-line detail of my own fixes lives in [`2026-08-18-spooler-v2-rev5-lock-and-ordering-fixes.md`](2026-08-18-spooler-v2-rev5-lock-and-ordering-fixes.md); this document is the map.

**Bottom line:** Sol's remediation was substantially correct — 13 of my 14 findings were genuinely closed, two of them better than I had proposed. One was not closed, and its replacement introduced a worse failure mode. The full repository suite passed at rev 5.0; later lock corrections received focused spooler, hostile-race, and architecture verification. It is **not** canary-approved: the physical-hardware gates remain open.

---

## 1. How this went, round by round

| Round | What happened | Outcome |
| --- | --- | --- |
| Rev 3 review | Four parallel hostile reviewers over runtime/journal, transport/helper, server protocol, installer/updater; every HIGH re-verified against source by me | 4 HIGH + 5 MEDIUM + 5 LOW/NOTE. Report: `2026-08-18-spooler-v2-remediation-rev3-adversarial-review.md` |
| Rev 4 verification | Checked Sol's rev-4 report against the code rather than the report's own claims | 13 of 14 fixed. 1 not fixed — verified by re-running my race harness in the production configuration |
| Rev 5 (this work) | Fixed the outstanding defect and two more found while verifying | 3 defects fixed, committed with evidence |
| Rev 5.1 | Sol reviewed my rev-5 fixes and found two defects in them | Both confirmed by reproduction and fixed; see §3.4 |

A pattern held across all three rounds and is worth stating plainly, because it is the useful lesson rather than a criticism: **each late fix closed its target defect correctly and moved a new one in behind it.** Every defect I found in rounds 4 and 5 lived in code that had just been written to fix something else.

---

## 2. Disposition of every rev-3 finding

Verified against source on the current tree, not against commit messages.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| T1 | HIGH | Untimed `verifyArtifactHash` inside the shared helper FIFO stalls every Windows printer on the station | **Fixed by Sol** — hoisted out of `serializeHelper`, given its own timeout |
| I1 | HIGH | Installer's ambiguous-recovery arm stops the service before disabling it | **Fixed by Sol** — arm removed; all disable sites now disable first |
| I2 | HIGH | `Install-Spooler.ps1` recovery entirely unjournaled | **Fixed by Sol** — durable Install journal, four phases |
| I3 | HIGH | Boot repair stops a healthy job-accepting V2 station, then loops forever on a 409 | **Fixed by Sol** — authority consulted first; accepted stations are restarted and confirmed via `Wait-SpoolerAcceptedV2`; journal cleared |
| R1 | MEDIUM→HIGH | State-root lock admits multiple owners on stale reclaim | **Not fixed in rev 4; fixed by me** — see §3.1 |
| T2 | MEDIUM | Helper death after the readiness check manufactures a false `uncertain` | **Fixed by Sol** — marker moved to `beforeWrite` with a post-marker re-check |
| S1 | MEDIUM | Cancellation channel had no production caller | **Fixed by Sol** — real route with `FOR UPDATE`, status allowlist, in-transaction audit |
| A1 | MEDIUM | Unclassified render error retries forever and never reports | **Fixed by Sol at the root cause** — `htmlForJob` errors now classified `permanent_safe` |
| I4 | MEDIUM | `Install-Spooler.ps1` never took the transaction mutex | **Fixed by Sol** |
| — | LOW | Transport tests never supplied `runExclusive`, so they exercised a fallback branch | **Fixed by Sol** |
| — | LOW | `fakeStore.retainArtifactForCleanup` missing the terminal guard | **Fixed by Sol** |
| — | LOW | C# watch generations shared one static stop flag | **Fixed by Sol** — per-generation counter |
| — | LOW | Stale "recycle the serial helper" assertion message | **Fixed by Sol** |
| — | NOTE | `status_disabled` unreachable | **Resolved** — field removed |

Two credits worth recording: the `beforeWrite` marker mechanism (T2) and the acceptance-aware repair that restarts and confirms a fresh sync (I3) are both better than what I proposed.

---

## 3. What I changed

Two commits. Nothing outside the spooler package was touched apart from one log line.

### 3.1 `cb6aa660` — an interrupted stale-lock reclaim no longer locks a station out permanently

**The situation.** Rev 4's first attempt at R1 was a no-op: it added a `staleReclaimAuthorized` flag, but `v2-server.js:74` passes `true` unconditionally, so every contender authorizes itself. Re-running my barrier harness in that exact configuration reproduced the original race 15/15. Commit `21c24df2` then replaced it with a deterministic **hard-link tombstone**, which genuinely closed the race — verified, 15/15 single owner.

**The defect I found.** The tombstone is durable and its path derives from the *stale owner*, which never changes. A process killed between `linkSync` and `unlinkSync(lockPath)` left a tombstone that every later start recomputed and hit `EEXIST` on — permanently:

```
after a crash mid-reclaim, three consecutive restarts:
  restart 1: STATE_ROOT_LOCKED  <-- station cannot start
  restart 2: STATE_ROOT_LOCKED  <-- station cannot start
  restart 3: STATE_ROOT_LOCKED  <-- station cannot start
```

The station never prints again without manual file deletion; NSSM restart-loops the agent; `Repair-SpoolerStartup.ps1` knows nothing about `agent.lock`; and no telemetry is emitted because the agent dies before it can sync. The window is sub-millisecond, but it needs only **one** crash rather than two racing starts, the consequence is unbounded and silent, and it is entered during recovery on a machine that has just proven it crashes. Every other path in this architecture self-heals; this one did not.

**Root cause.** A hard link necessarily carries the stale owner's identity, so a contender finding a tombstone cannot distinguish "someone is reclaiming right now" from "someone died reclaiming" — and the safe reading is permanent.

**The rev-5.0 fix, superseded by §3.4 and §3.5.** The tombstone became an `O_EXCL` file naming the **claimant**. That version distinguished live and dead claimants, but its shared create-before-write window was unsafe.

The rev-5.0 rule was:

> Clearing a tombstone never grants ownership. `agent.lock` alone decides ownership, and the resolver always fails the current start.

That reasoning was disproved in §3.4 and is retained here only as review history.

**A self-review pass caught the same bug class inside my own first version** of this fix, which returned `lockedError()` on an unreadable tombstone without clearing it — a narrower instance of exactly the lockout being fixed.

### 3.2 `cb6aa660` — the Windows serialization test asserted an ordering that T1's fix legitimately removed

`npm --prefix pos-spooler-printer test` failed about 1 run in 7. The visible crash was an unhandled `PLATFORM_HELPER_TIMEOUT`, which was a symptom: an assertion threw first, orphaning two in-flight `withTimeout` promises.

Because T1's fix correctly hoisted `verifyArtifactHash` out of the queue, two concurrent sends now join the helper queue **after** their artifact reads complete, so different printers enter Winspool in read-completion order rather than dispatch order. The test pinned dispatch order.

The assertion now tests **marker↔command correspondence** — the helper mock records which printer's command entered Winspool, the marker callbacks record which printer was marked, and the two sequences must match at each step. This is order-agnostic and a stronger statement of the actual paper-safety invariant than the ordering coincidence it replaced.

This is a deliberate judgement that the test was wrong and the code right. Cross-printer entry order is not a property anything depends on — `printer-workers` serializes per printer, so two jobs for the same printer are never concurrently in `send()`.

### 3.3 `edf19986` — the lock contender test could hang forever and strand processes

Found by observation: three `node.exe` processes from a test run were still alive **70 minutes** later.

The contender child attached a **second `readline` interface to the same stdin** after acquiring, so the first could consume the `RELEASE` line and the contender never exited. The parent's wait for that exit had no timeout, so parent and children held each other's pipes open indefinitely. (`waitForLine` was not at fault — it already carries a 3 s timeout; this was the one unbounded wait.)

Fixed with a single `readline` interface driving a two-state handler, and a bounded wait so the test fails loudly instead of hanging.

### 3.4 Rev 5.1 — two defects Sol found in my rev-5 fixes

Both confirmed by reproduction before changing anything, and both were real.

**High — the tombstone had a create-before-write window, so multiple owners were still possible.** My `O_EXCL` tombstone created the shared file first and wrote the claimant into it afterwards. Another contender could read that empty file as damaged and clear it, re-opening the claim to a third contender while the first reclaim was still running. The invariant I documented — *"clearing a tombstone never grants ownership"* — was wrong: it does not grant ownership to the clearer, but it re-opens the gate to someone else, and the two then race `unlink`+`create` exactly as before. Sol reproduced three contenders with two `ACQUIRED` and the surviving lock belonging to neither; I reproduced the gate re-opening with a single interposition at the empty-tombstone instant.

Fixed by removing the window rather than reasoning about it: the claimant is written to a private per-acquire file and then **hard-linked** into the shared path, so the content is complete before the shared name exists. This reintroduces the hard-link dependency on the state-root filesystem that the earlier version had shed — a deliberate trade, since `linkSync` is what makes exclusive publication atomic, and on a filesystem without it the reclaim fails closed rather than admitting two owners. The later claim that disk-damaged tombstones could be cleared safely was disproved in §3.5.

**Medium — the hostile test could still hang on failure.** Bounding the wait was not enough: the timeout only rejects, the harness catch sets `process.exitCode` rather than forcing exit, and node cannot drain its loop while pipes to a child blocked on stdin stay open. Contenders are now tracked and killed in the `finally`.

This is the reaping I had added in rev 5 and then removed as redundant. My experiment showing a contender exits on stdin close was correct but did not settle the question — the parent must exit for stdin to close, and it cannot exit while the child is alive. That is a fifth disproved hypothesis of mine, and the one that had already been written correctly before I argued myself out of it.

Sol's other three points were also correct and are addressed: `docs/architecture.json` still described a hard-link-of-the-lock tombstone and now describes the atomically-published claimant file; the evidence document claimed tombstones cannot accumulate, when a crash after installing the replacement lock and before unlinking leaves one inert file behind; and the duplicated exclusive owner-file write is now a single `writeOwnerFile` helper. The stale commits-ahead figure has been removed rather than restated, since it goes out of date on every commit.

### 3.5 Rev 5.2 — corrupt claims fail closed and abandoned private claims are cleaned

Atomic publication closed the partial-write race, but the resolver still cleared every unreadable shared tombstone. A deterministic test corrupted an already-published live claim; clearing it reopened the gate and two contenders returned `ACQUIRED`. Shared tombstones that are unreadable or lack a valid claimant now remain in place and fail closed. Only a complete tombstone naming a dead claimant is cleared.

Private `agent.lock.claim-*` files never grant ownership. Startup now removes dead or unreadable abandoned private claims and preserves live ones, so crashes before or immediately after `linkSync` no longer accumulate private files. A crash after the replacement lock is installed but before shared-tombstone cleanup can still leave one inert shared tombstone; this is documented rather than misreported as fully cleaned.

---

## 4. Method note — five of my own hypotheses were disproved by experiment

Recorded because it affects how much weight to give my recommendations, and because in each case shipping the untested idea would have introduced a defect:

| Hypothesis | Verdict |
| --- | --- |
| Holding the lock fd open makes Windows block deletion | **False.** libuv opens with `FILE_SHARE_DELETE`; unlink succeeds anyway |
| `renameSync` gives a single winner, so use it for the reclaim | **False in this sequence.** 7/15 trials produced two owners: the deterministic target means the loser's rename grabs the winner's *newly created* lock. My earlier proof of rename's single-winner property was run in isolation and never modelled the winner recreating the source |
| Comparing inodes distinguishes a crashed reclaim from a live one | **False.** Cannot tell them apart either; 2/15 trials ended with *zero* owners because a loser deleted the live winner's tombstone |
| Test children are stranded by a throwing parent, so kill them in `finally` / self-reap on stdin close | **Half wrong, and I removed the right half.** A contender does exit when its stdin closes, verified directly — which correctly led me to the hung parent. But I then deleted the `finally` reaping as redundant, and it was not: the parent cannot exit while the pipes are open, so the two deadlock. Sol caught it |
| Clearing a tombstone never grants ownership, so clearing an unreadable one is safe | **False.** It does not grant ownership to the clearer, but it re-opens the claim to a third contender mid-reclaim. Sol caught it; reproduced here before fixing |

The generalisable lesson: for concurrency and lifecycle bugs, verify a candidate fix **in the exact sequence it will run**, not as an isolated primitive. Three of the five failures above came from proving a primitive or a property in isolation and generalising it to a sequence where it does not hold. The last one is the sharpest: a correct experiment ("children exit on stdin close") answered a question I had not actually asked ("can the parent ever exit to close them?"), and I let the right code be deleted on the strength of it.

---

## 5. Verification

- **Full repository Vitest: 277/277 files, 2,994/2,994 tests** (1,227 s), run at rev 5.0. Rev 5.1 and rev 5.2 use focused spooler, hostile-race, and architecture gates because they touch only the lock protocol, its test, and documentation.
- Barrier race, four production-authorized contenders: **single owner 15/15**.
- Crash-recovery matrix — valid dead claimants recover on restart 2; malformed shared tombstones and live claimants fail closed; abandoned private claim files are cleaned; clean reclaim and live-owner exclusion pass.
- Forced-reversal experiment (24 MB artifact dispatched first, 64-byte second): confirms the reversal is real, the old ordering assertion **would fail**, and the new one holds end to end.
- `npm --prefix pos-spooler-printer test`: 12 consecutive clean runs before the third fix; green after.
- `node tests/v2-hostile-runtime.test.js` ×5 consecutive: passed, zero leftover processes.
- Rev 5.2 hostile runtime ×15: passed; the previously failing corrupt-live-tombstone schedule produced one owner and two fail-closed contenders; the complete spooler suite and architecture validation passed.
- Backend source-contract tests (`installerPackageContract`, `spoolerPackageContract`, `installerUpdateContract`): 88/88.
- `node --check` clean on all modified files.

Operational note: the suite takes a MySQL advisory lock in `backend/tests/globalSetup.mjs`, so a second concurrent Vitest run is refused at global setup rather than corrupting shared state. That guard worked correctly when I accidentally collided with my own background run. If a run is killed, its lock connection can survive in an orphaned `node` process and block the next run with `The posapp_test test database is already in use by another Vitest run`; clearing that PID is sufficient.

---

## 6. What remains open

**Physical gates — unchanged, and still required before any customer canary.** None of these can be satisfied from automated evidence:

- affected long-report printer, including its exact driver/firmware path;
- direct TCP thermal printer;
- Windows shared printer;
- write-only printer clone;
- paper-out and recovery behaviour on the target model;
- LocalMachine DPAPI identity across two physical machines;
- disk-full injection at each durable journal transition;
- interrupted fresh install, repair install, updater cutover, rollback and reboot on real Windows.

**Two inert residuals**, deliberately left alone:

- `backend/services/spoolerSync.js:230` gates the health tail on a `locked.status` read taken before the in-transaction decommission. The admin join excludes decommissioned agents, so nothing consumes the stale write.
- `pos-spooler-printer/v2/printer-transports.js:229` re-throws `STATUS_UNSUPPORTED` in a block where nothing throws it — dead code.

**One documented limitation of the lock fix:** recovery uses PID liveness, so if a crashed claimant's PID has been reused by an unrelated live process, the interrupted reclaim is not cleared until that PID exits. This degrades to "heals later" rather than "never heals", which is strictly better than the lockout it replaces. Node offers no portable process-start-time check to tighten it.

**One open question for you:** V1 and V2 resolve the same `SPOOLER_STATE_DIR` and share `<root>/artifacts`, but V1 never takes the state-root lock. `cleanup()` only deletes journal-referenced files, so this is orphan-artifact accumulation rather than corruption — but it means the lock does not exclude a V1 process on the same station, and the installer's legacy-service sweep is the only thing that does.

---

## 7. Commits

| Commit | Contents |
| --- | --- |
| `cb6aa660` | claimant-named tombstone with liveness recovery and cleanup; `error.reason` logged at startup; marker↔command correspondence in the transport test; interrupted-reclaim regression coverage |
| `edf19986` | single-`readline` contender and bounded exit wait in the lock test |
| `a0dcb629` | this handover document |
| rev 5.1 | atomic tombstone publication; contender reaping in the test `finally`; live publish-atomicity regression test; architecture map and evidence corrections |
| rev 5.2 working tree | corrupt shared tombstones fail closed; abandoned private claims cleaned; architecture and evidence corrected |

No merge, push, deployment, installer build, version bump, production migration, or customer-system action was performed.

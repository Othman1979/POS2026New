# Spooler V2 rev 5 — state-root lock reclaim and helper-entry ordering

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued`
Base: `21c24df2` (`fix(spooler-v2): serialize stale lock reclaim`)
Author: independent reviewer (for Sol's review)

Two defects fixed. Both were introduced by earlier remediation commits — each closed its target defect correctly and moved a new one in behind it.

Scope note: nothing outside these two mechanisms was touched. No installer, migration, server, or renderer change. No merge, push, deploy, or migration was performed.

---

## Fix 1 — an interrupted stale-lock reclaim no longer locks a station out permanently

### The defect (HIGH, proven)

`21c24df2` closed the state-root lock race correctly — verified, 15/15 barrier trials with four production-authorized contenders produced exactly one owner. It did so with a **hard-link tombstone** at `agent.lock.stale-<sha256(pid:boot_id)>`.

The tombstone is durable and its path is derived from the **stale owner**, which never changes. So a process that died between `linkSync` and `unlinkSync(lockPath)` left a tombstone that every later start recomputed, hit `EEXIST` on, and failed closed against — for the life of the installation:

```
after a crash mid-reclaim, three consecutive restarts:
  restart 1: STATE_ROOT_LOCKED  <-- station cannot start
  restart 2: STATE_ROOT_LOCKED  <-- station cannot start
  restart 3: STATE_ROOT_LOCKED  <-- station cannot start
```

Consequences: the station never prints again without manual file deletion; NSSM restart-loops the agent indefinitely; `Repair-SpoolerStartup.ps1` cannot help because it knows nothing about `agent.lock`; and no telemetry is emitted because the agent dies before it can sync.

The window is sub-millisecond, but three properties made it worth blocking on: the consequence is unbounded and silent, it needs only **one** crash rather than two racing starts, and it is entered during recovery on a machine that has just proven it crashes. Every other path in this recovery architecture self-heals; this was the one that did not.

The tombstone was also never removed on the success path, so one file accumulated per crash-recovery forever.

### Root cause

A hard link necessarily carries the **stale owner's** identity. A contender that finds one therefore cannot distinguish:

- another contender is reclaiming right now (must stay out), from
- a contender died midway through its reclaim (must recover).

Both look identical, so the safe reading — stay out — is the only one available, and it is permanent.

### The fix

Rev 5.0 changed the tombstone to a shared `O_EXCL` file naming the **claimant** instead of a hard link naming the stale owner. That historical implementation was superseded by rev 5.1 below.

```js
try {
    const descriptor = fs.openSync(stalePath, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
} catch (claimError) {
    if (claimError?.code === 'EEXIST') throw resolveStaleTombstone(stalePath);
    throw lockedError();
}
```

In rev 5.0, `resolveStaleTombstone` read the claimant and applied `processIsAlive`. Rev 5.1 retained that policy while changing publication, and rev 5.2 narrowed cleanup to complete tombstones naming dead claimants.

One residual, corrected from an earlier draft of this document which claimed tombstones can no longer accumulate: a crash *after* the replacement lock is installed but *before* the tombstone is unlinked leaves that one file behind permanently. It is inert — the stale owner it names is gone, so no later reclaim ever computes that path again — but it is not cleaned up. One file per crash landing in that specific window.

**A self-review pass caught the same bug class inside the first version of this fix.** A claimant killed between creating its tombstone and writing to it leaves the file unreadable, and the initial implementation returned `lockedError()` without clearing it — a narrower instance of exactly the permanent lockout being fixed. The rev-5.0 version then cleared unreadable or pid-less tombstones; rev 5.2 supersedes that unsafe policy.

**That correction was itself unsound, and Sol found it.** See "Correction — rev 5.1" below.

#### Correction — rev 5.1

The first version of this fix created the shared tombstone with `O_EXCL` and wrote the claimant into it afterwards, leaving a window in which the file existed but was empty. This document previously justified clearing unreadable tombstones with:

> Clearing a tombstone never grants ownership. Ownership is decided by `agent.lock` alone, and `resolveStaleTombstone` always fails the current start.

**That claim was wrong.** Clearing does not grant ownership to *the clearer* — but it re-opens the claim to a *third* contender while the original reclaim is still running, and the two then race `unlink`+`create` exactly as before. Sol reproduced three contenders where two returned `ACQUIRED` and the surviving lock belonged to neither of the ones that believed they held it. Reproduced here as well: with a single interposition at the empty-tombstone instant, contender B cleared the partial claim and contender C entered and acquired while A was still inside its reclaim.

The fix is to remove the window rather than to reason about it. The claimant is now written to a private file named for this acquire, then **hard-linked** into the shared path:

```js
const pendingPath = path.join(stateRoot, `agent.lock.claim-${owner.boot_id}`);
writeOwnerFile(pendingPath, owner);          // complete + fsynced before it is visible
fs.linkSync(pendingPath, stalePath);         // EEXIST => another contender holds the claim
```

Because the content is complete before the shared name exists, no contender can observe a partial tombstone. Rev 5.1 incorrectly concluded that an unreadable disk-damaged tombstone could therefore be cleared safely. Rev 5.2 disproved that assumption: corruption of an already-published live claim can occur while its claimant continues, so malformed shared ownership state must remain and fail closed.

This reintroduces a hard-link dependency on the state-root filesystem, which the previous version had removed. That is a deliberate trade: `linkSync` is the primitive that makes exclusive publication atomic, and it was already the mechanism in `21c24df2`. On a filesystem without hard links the reclaim fails closed rather than admitting two owners.

Verified after the change: no partial state is observable at publish time (asserted against the live publish, not a static fixture); the barrier race stays at single owner 15/15; and the whole crash-recovery matrix below still passes unchanged.

Atomic `linkSync` publication preserves the single-winner property: only one contender can publish the deterministic shared claim.

Two supporting details:

- The reclaim still re-reads `agent.lock` under the claim and requires `sameOwner(current, existing)` before removing it, so a lock that changed hands mid-reclaim is never destroyed.
- The interrupted case throws `STATE_ROOT_LOCKED` with `error.reason = 'interrupted_reclaim_cleared'`, and `v2-server.js` now logs the reason alongside the code. The error code itself is unchanged, so the C# helper's `STATE_ROOT_LOCKED` contract and the exit-73 mapping are untouched. An operator now sees one explained failed start followed by a successful one, instead of a bare repeated lock error.

### Why not `renameSync`

A previous review recommended replacing the reclaim with `renameSync`, on the grounds that the second racer gets `ENOENT`. **That recommendation was wrong, and testing caught it before it shipped**: a rename variant failed **7/15** barrier trials with two simultaneous owners. Because the target path is deterministic, the loser's rename moves the winner's *newly created* lock aside and it then creates its own. The earlier proof of rename's single-winner property was run in isolation and never modelled the winner recreating the source. The hard-link design was strictly better than the suggested replacement; only its recovery semantics needed changing.

An intermediate variant that distinguished the cases by comparing inodes was also built and rejected: it cannot tell a live concurrent winner from a crashed one either, and **2/15** trials ended with *zero* owners because a loser deleted the live winner's tombstone.

### Evidence

Barrier race, four contenders, `staleReclaimAuthorized: true` on all of them — exactly as `v2-server.js:74` calls it:

```
RESULT: single owner in all 15 trials
```

Crash-recovery matrix against the real module:

| Scenario | Result |
| --- | --- |
| A. crash after tombstone, before lock removed (**the brick case**) | restart 1 `STATE_ROOT_LOCKED (interrupted_reclaim_cleared)`, **restart 2 ACQUIRED** |
| B. crash after lock removed, before new lock written | restart 1 ACQUIRED |
| C. live concurrent claimant | contender excluded; live tombstone preserved |
| D. unreadable tombstone — zero-byte, truncated JSON, and valid-JSON-without-pid | `STATE_ROOT_LOCKED`; shared evidence retained for diagnosis |
| E. clean reclaim | ACQUIRED; state root contains only `agent.lock` |
| F. live owner, then release | second process excluded; reacquires after release |

Regression coverage added to `pos-spooler-printer/tests/v2-hostile-runtime.test.js` for A, C, D and E — the interrupted-reclaim case had no test at all, which is why it shipped. The gate now reports `interrupted_reclaim_recovers: true`.

### Known limitation (documented, not fixed)

Recovery uses PID liveness, so if the crashed claimant's PID has been reused by an unrelated live process, the interrupted reclaim is not cleared until that PID exits. This degrades to "heals later" rather than "never heals", which is strictly better than the permanent lockout it replaces. Node offers no portable process-start-time check to tighten it further.

---

## Fix 2 — the Windows serialization test asserted an ordering the T1 fix legitimately removed

### The defect (test defect, intermittent)

`npm --prefix pos-spooler-printer test` failed roughly 1 run in 7. The visible crash was an unhandled `PLATFORM_HELPER_TIMEOUT`, which is a **symptom**: an assertion in `v2-printer-transports.test.js` threw first, leaving two in-flight `withTimeout` promises with no handler. The real failure:

```
AssertionError: only the helper command entering Winspool may receive a transport marker
+ actual - expected
  [
+   'second'
-   'first'
  ]
```

### Root cause

The T1 fix correctly hoisted `verifyArtifactHash` out of the helper-exclusive queue. As a direct consequence, two concurrent `send()` calls now join the queue **after** their artifact reads complete, so the order in which different printers enter Winspool is decided by artifact-read completion, not by dispatch order. The test pinned dispatch order and so failed whenever the reads finished out of order.

The safety property the test *names* — only the command entering Winspool is marked — was never violated. The test over-specified.

### The fix

The assertion now tests correspondence rather than order, which is both correct and **stronger** than what it replaced: the helper mock records which printer's command entered Winspool, the marker callbacks record which printer was marked, and the test asserts the two sequences are equal at each step, plus that a queued print is never marked early and each print is marked exactly once.

This is a deliberate judgement that the test was wrong and the code was right. The reasoning: cross-printer entry order is not a property anything depends on — `printer-workers` serializes per printer, so two jobs for the *same* printer are never in `send()` concurrently — whereas marker↔command correspondence is the actual paper-safety invariant, and it is now asserted directly instead of being implied by an ordering coincidence.

### Evidence

Statistics first: **0 failures in 12 consecutive runs** of the full spooler package suite on the fixed tree, against 1 failure in 7 before.

Statistics are corroboration, not proof, so the ordering was then forced deterministically — job A dispatched first with a 24 MB artifact, job B second with a 64-byte artifact:

```
dispatch order        : Kitchen-1 then Receipt-1
entered Winspool first: Receipt-1
markers so far        : ["Receipt-1"]
OLD assertion  deepStrictEqual(markers, ['first'])  -> WOULD FAIL
NEW assertion  markers === entered                  -> passes
final markers : ["Receipt-1","Kitchen-1"]
final entered : ["Receipt-1","Kitchen-1"]
correspondence holds end-to-end: true
```

That confirms the reversal is real and reachable, that the old assertion was genuinely wrong, and that the replacement holds under the reversed order.

### Follow-up worth considering (not done here)

When an assertion throws mid-test, pending `withTimeout` timers reject with no handler and the crash output leads with `PLATFORM_HELPER_TIMEOUT` rather than the assertion. The real error is still printed first, so this is cosmetic, but it made the original failure look like a transport bug rather than a test bug. Left alone deliberately: adding blanket `.catch()` guards to the send promises would suppress genuine unhandled rejections, which is a worse trade.

---

---

## Fix 3 — the lock test could hang forever and strand node processes on the machine

### The defect (found by observation, not by testing)

Three `node.exe` processes from a spooler test run were still alive **70 minutes later**: one `v2-hostile-runtime.test.js` parent and its two lock contenders. They were found while investigating an unrelated question about a long-running task.

### Root cause

The contender child attached a **second `readline` interface to the same stdin** after acquiring the lock. Both interfaces are live, so the first one can consume the `RELEASE` line and the second never sees it — the contender then never releases and never exits. The parent's

```js
await new Promise(resolve => winningContender.once('exit', resolve));
```

had no timeout, so it waited on an exit that would never come. Parent and children all stayed alive indefinitely, holding each other's pipes open.

`waitForLine` was not at fault — it already carries a 3 s timeout. This was the one unbounded wait in the function.

### The fix

One `readline` interface handles both commands via a two-state handler, removing the race entirely; and the wait for the contender's exit is bounded at 3 s so the test fails loudly instead of hanging.

**Corrected in rev 5.1, again from Sol's review:** bounding the wait is not sufficient, because the timeout only *rejects*. The harness catch sets `process.exitCode` rather than forcing exit, and node cannot drain its loop while pipes to a child blocked on stdin are open — so a failing run still hung. The contenders are now tracked and killed in the `finally`.

This is the reaping I had added and then removed as redundant. My experiment showing "a contender exits on stdin close" was correct but did not settle the question: the parent has to exit for stdin to close, and the parent cannot exit while the child is alive. Demonstrated directly — the same harness without reaping is still running after 5 s, and with reaping exits with code 1.

### Two hypotheses tested and discarded first

This one is worth recording because both plausible fixes were wrong, and experiments — not reasoning — settled it:

1. *"An assertion that throws leaves the children stranded, so the `finally` should kill them."* Written, then discarded: when the parent exits for any reason its pipes close, and a child blocked on `readline` exits on its own. Verified by spawning the child both ways and closing stdin — **both exited**. The tracking set and killer were removed as dead weight.
2. *"The children should self-reap on stdin close."* Same experiment disproved it: they already do. The reason the orphans survived was that the parent was **not dead** — it was hung, holding the pipes open.

The evidence pointed at the parent, not the children, and only then did the double-`readline` race become visible.

## Files changed

| File | Change |
| --- | --- |
| `pos-spooler-printer/v2/state-root-lock.js` | atomically published claimant tombstone; malformed shared state fails closed; valid dead claimants recover; abandoned private claims are cleaned |
| `pos-spooler-printer/v2-server.js` | log `error.reason` alongside the code on fatal startup failure |
| `pos-spooler-printer/tests/v2-hostile-runtime.test.js` | interrupted-reclaim regression coverage; `interrupted_reclaim_recovers` and `tombstone_published_atomically` metrics; single-`readline` contender, bounded exit wait, and contender reaping in `finally` |
| `docs/architecture.json` | tombstone description corrected from hard-link-of-the-lock to atomically-published claimant file |
| `pos-spooler-printer/tests/v2-printer-transports.test.js` | marker↔command correspondence instead of dispatch order |

## Verification

- Barrier race, production config, 4 contenders: **single owner 15/15**.
- Crash-recovery matrix A–F: all pass (table above).
- Forced-reversal ordering experiment: old assertion fails, new assertion holds.
- `node tests/v2-printer-transports.test.js`: passed.
- `node tests/v2-hostile-runtime.test.js`: exit 0, `interrupted_reclaim_recovers: true`, `controlled_two_process_barrier: true`.
- `npm --prefix pos-spooler-printer test`: **12/12 consecutive clean runs**.
- `npx vitest run backend/tests/unit/installerPackageContract.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js`: **88/88 passed**. These are the only backend tests that reference the changed files, and they assert packaging and file presence rather than reclaim internals.
- `node --check` clean on all four modified files.
- **Full repository Vitest run: 277/277 files, 2,994/2,994 tests passed** (1,227 s), taken at rev 5.0. The rev 5.1 corrections touch only `state-root-lock.js`, the hostile test and the architecture map, so they were verified with the concerned files rather than another full run.
- rev 5.1: Sol's three-contender window reproduced against the pre-fix code and gone after it; publish-atomicity asserted against the live publish; hang reproduced without reaping (still running after 5 s) and gone with it (exits code 1); `npm run architecture:check` clean at 217 nodes, 59 flows, 446 steps.
- rev 5.2: corrupt-live-tombstone attack reproduced two owners before the fix, then produced one owner and two `STATE_ROOT_LOCKED` contenders after it; hostile runtime passed 15/15 repetitions with `corrupt_tombstone_fails_closed=true` and `abandoned_claims_cleaned=true`; the complete spooler suite, `npm run architecture`, `npm run architecture:check`, and `git diff --check` passed.
- `node tests/v2-hostile-runtime.test.js` ×5 consecutive: all passed, and zero contender or spooler-test processes remained afterwards.
- Orphan-reaping experiment: a contender exits on stdin close both before and after the discarded self-reap change, which is what identified the hung parent as the real cause.

One operational note for whoever runs these gates: the suite takes a single MySQL advisory lock in `backend/tests/globalSetup.mjs`, so a second concurrent Vitest run is refused at global setup rather than corrupting shared state. That guard did its job during this work. If a run is killed, its lock connection can survive in an orphaned `node` process and block the next run with `The posapp_test test database is already in use by another Vitest run`; clearing that orphan is enough.

## Unchanged and still open

The physical gates from the rev-4 report are untouched and still required before a customer canary: affected long-report printer, direct TCP printer, Windows shared printer, write-only clone, paper-out recovery, cross-machine DPAPI, disk-full injection at journal transitions, and interrupted install/update/rollback/reboot on real Windows.

Also still open from the prior review, deliberately not addressed here because both are inert:

- `backend/services/spoolerSync.js:230` gates the health tail on a `locked.status` read before the in-transaction decommission; the admin join excludes those rows, so nothing consumes it.
- `pos-spooler-printer/v2/printer-transports.js:229` re-throws `STATUS_UNSUPPORTED` in a block where nothing throws it — dead code.

The stale-reclaim path deliberately requires hard-link support for atomic publication. A `SPOOLER_STATE_DIR` on a filesystem without `link()` support fails closed rather than admitting concurrent owners.

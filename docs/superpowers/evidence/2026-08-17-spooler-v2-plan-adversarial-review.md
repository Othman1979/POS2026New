# Adversarial Review — Spooler V2 Local Print Agent Plan

**Date:** 2026-08-17
**Reviewed:** `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md` (per the brief's review prompt)
**Reviewer stance:** hostile to the newest boundaries; every load-bearing claim checked against the repository. Nothing implemented.

## Verdict

The architecture is the right shape and I endorse it: pull-only sync as the single delivery authority, a durable
local journal as the dedupe boundary, `local_accepted` as the no-reassignment line, per-printer lanes, and the
Winspool helper as a containment process. It genuinely closes the defect classes my lifecycle review proved
(permanent offline, in-flight duplicates, lease-expiry redelivery, PowerShell pile-up) rather than shrinking
their probability.

I found **three plan-level defects** — event sequences below violate stated invariants as the plan is written —
plus one load-bearing migration constraint and several judgment calls the owner should see. None of them
invalidates the architecture; all have small corrections.

---

## Confirmed plan defects

### D1 — Registration handshake can strand a station permanently (ownerless-identity crash window)

The plan (Task 1.1) has the **server** mint the agent and return the secret: "first registration creates one
active agent", "the bootstrap key may register only when that station has no active agent", and the agent
persists the DPAPI blob afterward (Task 2.2). The crash matrix (2.1) covers job boundaries only — identity
bootstrap has no crash row.

**Sequence that bricks a station:**
1. Fresh install syncs with the bootstrap key; server transaction commits an **active** `spooler_agents` row
   and returns the per-installation secret.
2. Agent crashes (or the HTTP response is lost, or the `agent.json` write hits disk-full) before the DPAPI
   blob is durably persisted.
3. Restart: no `agent.json` → agent attempts bootstrap again → rejected, because the station already has an
   active agent (the rule doing its job).
4. The station cannot register, cannot sync, and holds no identity. Recovery requires manual revocation —
   exactly the "technician visit" class V2 exists to eliminate. This is the identity-layer twin of the brief's
   own concern #1 (no window where neither side owns the thing).

**Smallest correction:** flip who mints the secret. The agent generates `agent_id` + secret locally, persists
the DPAPI blob **first**, then registers by presenting the hash. Registration becomes idempotent on
`agent_id`: crash-before-register leaves no server row (re-generate freely); crash-after-commit with a lost
response is healed by the next sync, which authenticates with the already-persisted secret. The
one-active-agent rule is unchanged — it now guards against a *different* `agent_id` claiming an occupied
station, which is the actual attack. Add identity-bootstrap rows to the crash matrix and the hostile gate.

### D2 — Same-identity dual process: duplicate physical prints with every invariant "satisfied"

The plan defends against a second installation with a **distinct** identity (rejected) and a **copied**
`agent.json` on a **different machine** (DPAPI unprotect fails). It has no defense against two V2 processes on
the **same machine sharing the same identity** — and this repo has documented exactly that field state: a
legacy node-windows service coexisting with the NSSM service (`pos-spooler-printer/install-service.js` vs
`Install-Spooler.ps1:146,219`, my review's U2). Both processes read the same valid DPAPI blob and the same
journal directory. Nothing in Task 2 takes an exclusive lock; atomic per-file renames make individual writes
safe but do nothing about two engines running the same journal.

**Sequence that double-prints:**
1. Processes A and B both start, both validate identity, both begin sync loops (the agent-row lock serializes
   requests but both authenticate as the *same* agent — serialization is not exclusion).
2. A's sync claims job 1 (`sent`); A's acceptance report is delayed one cycle.
3. B's sync replays the unaccepted `sent` row (the lost-response replay working as designed) → B also persists
   job 1 locally.
4. A and B each hold a durable local record for job 1; each renders and prints. Two tickets. Acceptance and
   result settlement are idempotent, so the server sees nothing wrong. The hostile-gate row "second
   installation uses the same station" never fires because there is only one identity.

**Smallest correction:** a single-instance guard is a precondition for workers: acquire an exclusive lock on
the state root at startup (Windows named mutex via the helper, or an `O_EXCL`-style lockfile with PID +
liveness check); the loser logs loudly, reports unhealthy, and exits without syncing. Add "two processes, same
identity, same machine" to the hostile gate table, and make the installer's legacy-service sweep a hard
precondition of V2 activation in Task 5.2.

### D3 — Cancellation has no delivery channel in the sync contract

The server state model adds `cancel_requested` and invariant-level language says the agent "must confirm before
transport" (state model; Task 4.3). But the documented sync contract (Task 1.3) carries only `accepted`,
`results`, `health`, `capacity` in the request and "confirmed accepts/results, new jobs, next-sync hint" in
the response. **No field ever tells the agent a cancellation was requested**, and the local state model's
`queued/rendered -> canceled` transition is unreachable for server-initiated cancels.

**Sequence:** admin cancels a `local_accepted` job → row sits in `cancel_requested` forever while the agent,
which can only learn about jobs it is offered, renders and prints it → agent reports `completed` → the state
machine has no defined transition out of `cancel_requested` for a success result.

**Smallest correction:** the sync **response** gains `cancel_requested: [queue_id, …]`; the agent durably
marks the local record, and confirms through the existing results channel with outcome `canceled`
(pre-transport) or its true outcome (transport already started). Server rule: any terminal result settles a
`cancel_requested` row, and a `canceled` outcome requires the agent's durable pre-transport confirmation —
which is precisely the boundary Task 4.3's UI wording already promises. One schema field, one settle rule.

### D4 — Migration constraint that must be stated, or the Hostinger fallback can lock the queue

Task 1.2 evolves the `print_queue` `status` enum. `print_queue` is a **never-delete** table
(`deployment/database/baseline.sql:697-728`). An enum change that reorders or inserts values forces a full
table rebuild — on the production Hostinger DB that is a long lock on the hottest print table, inside a
phpMyAdmin-imported fallback with no online-DDL tooling. Appending new values **at the end** of the enum (and
staying ≤255 members so storage stays 1 byte) is a metadata-only in-place change on MariaDB.

**Correction:** the plan (and Luna's migration brief) must pin: `local_accepted` and `cancel_requested` are
**appended after `canceled`**, never inserted or reordered, and the preflight should assert the current enum
order before altering. Also note `backend/routes/admin/printQueue.js:15` and the queue-health logger enumerate
statuses explicitly — Task 4 already modifies these files; the new statuses must be added there in the same
phase that can first produce them, not later.

---

## Checks that came back clean (attack attempted, no break found)

- **Lost-response replay + concurrent capacity-one syncs:** the agent-row lock plus replay-before-claim
  ordering returns at most one distinct outstanding row; a replayed row the agent already holds dedupes by
  `queue_id + idempotency_key` (crash test 2.1 requires it). Capacity subtraction under-claims transiently
  (one cycle) — safe direction, self-healing on the next accept confirmation. Not a defect.
- **V1 cannot touch V2 rows:** the V1 claim predicate enumerates its statuses explicitly
  ([printQueue.js:85-90](../../backend/services/printQueue.js)) — `local_accepted`/`cancel_requested` rows are
  invisible to every V1 claimant by construction. Verified, this is the single nicest compatibility property
  of the design.
- **Outcome-unknown recovery is reachable:** `AGENT_REPLACED_OUTCOME_UNKNOWN` rows land in `dead_letter`, and
  the manual reprint path already requires `acknowledged` or `dead_letter` sources
  (architecture map, admin print queue routes) — the operator recovery flow exists today.
- **Acceptance-and-result-in-one-sync ordering**, **outbox idempotency after server restore/rollback**,
  **revoked-agent-starts-later pauses before workers**, **updater rollback rules** — walked each; the stated
  transaction order and idempotent settle close them.
- **All 11 modified-file anchors exist** in the repo, including `docs/deferred-spooler-long-report-raster-corruption.md`
  and both admin routes. **.NET Framework 4.8 is in-box** on the supported Windows 10 22H2/11 floor — the
  helper needs no runtime install.
- **Package/runtime "no Socket.IO in V2" assertion** is testable exactly as written (dependency and
  runtime-connection inspection).

## Judgment calls I endorse — with the tensions named

1. **Pull-only, no V2 socket.** Right call; Star CloudPRNT is a real precedent. Tension to record: enqueue→
   delivery latency becomes 0–2 s idle-case instead of instant push. Fine for kitchens; say it in the plan.
2. **Fail-closed restart identity validation** (2.3: no printing until one successful sync after restart).
   Correct against revoked-agent-prints-stale-journal — but it means *restart during an internet outage stalls
   even durable accepted work* until connectivity returns. That is strictly better than V1 (which loses the
   work), but it partially contradicts the goal line "a server or Internet disconnect cannot erase accepted
   work" in spirit. Keep the behavior; add it to the goal text and the health UI so it is a documented state,
   not a surprise.
3. **Kitchen latency bound includes a non-preempted report render** (2.5) with a 30 s report render deadline
   class (3.x). Worst-case kitchen add-on of tens of seconds on a Celeron is accepted — state the number in
   the plan's definition of done so the canary measures it.
4. **Load harness at 1/10/50/100 agents** (1.4): good, but the deployment reality is one server per venue with
   1–5 stations. The gate that matters is **DB-pool budget per server**: each sync transaction (lock + 4–6
   statements at Hostinger's 5–30 ms/query) against the 10-connection pool with the 10 s acquire timeout.
   Publish the measured pool occupancy at the venue-realistic tier, not only the 100-agent vanity tier.
5. **Forced-replacement ambiguity** (1.5) is honest and correct — the plan nowhere claims physical
   at-most-once across replacement, and the gate rows enforce the wording.

## Corrections to the brief's corrections (for the record; V2 supersedes all of them)

- *"An in-flight Set dies with the process"* — true and irrelevant to the window it closed: the duplicate
  copies it deduped die with the same process, and the durable seen store owns the post-`transport_started`
  boundary. It was sufficient triage for its scope, not a correctness hole. The journal is still the better
  boundary.
- *"`destroy()` versus `end()` is not the established defect"* — my report itself refuted the truncation
  hypothesis and listed `end()` as free hygiene, not as the defect. No disagreement exists to correct.
- *"A 2.5-second occupant probe can evict a live Celeron"* — the measured worst event-loop stall was ~0.11 s
  (dev) / ~0.7 s extrapolated (Celeron), well inside 2.5 s; the *principled* objection (unbounded GC/swap
  pauses make any threshold evictable) is fair, and durable identity is the cleaner ownership primitive.
  Conceded on principle, not on the measurement.

## The one decision only the owner can make: the interim fleet

The plan explicitly supersedes my Section 5 triage and rejects narrow patches. Consequence: **every fielded
1.2.x station keeps the permanent-offline kill switch until its station-by-station V2 migration** — a
restart-race today still means a technician restart. If that exposure is unacceptable during the V2 build:
the one zero-touch, zero-eviction-risk mitigation is a **single server-side line: stop emitting
`spooler_rejected`** (keep the disconnect). Fielded clients then never trigger their kill switch; the rejected
client degrades to HTTP polling (its poll fallback is only disabled by that event or 401/403) and keeps
printing at 3–5 s latency instead of dying. It is triage, not architecture; it changes no ownership semantics;
and it is removable the day a station cuts to V2. Ship it or accept the exposure — either is coherent, but it
should be an explicit decision, not a side effect of superseding the old section.

## Physical gates — unchanged and correct

Gate 0's short/long discriminator remains the only honest path on the report-gibberish defect; nothing in this
review weakens or replaces it. The affected printer, one Windows share, one direct-TCP device, one write-only
clone, and one feedback-capable model remain mandatory before default-profile changes.

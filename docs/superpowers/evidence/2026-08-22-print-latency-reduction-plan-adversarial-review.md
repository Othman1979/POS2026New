# Print Latency Reduction Plan — End-to-End Adversarial Review

**Date:** 2026-08-22  
**Reviewed plan:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md`  
**Plan length:** 515 lines  
**Plan SHA-256:** `CD4C132F397AF997240D8B7C0F277E686CB9996D07C24DDACB0D6ABE7125506F`  
**Repository fixed point:** `master` at `c98a2eb10c778f5f9c2a748adf3665f3d351bd39`  
**Review mode:** Read-only source review plus focused hostile runtime experiments  
**Implementation status:** Nothing from the plan was executed

## Verdict

The plan is **not safe to execute in its current form**.

The durable print-safety invariants are stated correctly, and the plan does not intentionally alter ownership, leasing, cancellation, settlement, transport markers, or automatic retry-after-transport behavior. However, its proposed result-ready wake mechanism and 500 ms sync cadence conflict with the current runtime in four important ways:

1. a result wake can start a second authenticated sync while the first is still running;
2. a result wake can cancel deliberate network-failure backoff;
3. every successful sync wakes the printer status monitor, causing extra physical-lane probes;
4. every successful sync clears the worker's deferred store-failure guard, accelerating unhealthy render/disk retries.

The plan also cannot truthfully prove its stated subsecond goal using the current database timestamps or the proposed acceptance matrix.

## Review method and evidence

- Read all 515 plan lines from top to bottom.
- Checked every named production file, test file, schema field, environment template, architecture entry, and verification command.
- Traced the real composition from `pos-spooler-printer/server.js` into:
  - `pos-spooler-printer/v2/agent-runtime.js`
  - `pos-spooler-printer/v2/printer-workers.js`
  - `pos-spooler-printer/v2/status-monitor.js`
- Traced the server sync path through:
  - `backend/routes/spoolerV2.js`
  - `backend/services/spoolerSync.js`
  - `backend/services/spoolerAgents.js`
- Verified timestamp precision in `deployment/database/baseline.sql`.
- Checked actual integration-test helpers in `backend/tests/integration/spoolerV2Sync.test.js`.
- Ran a focused hostile runtime experiment against the real `createAgentRuntime` implementation. The first `sync()` call was held unresolved, then `runtime.wake()` was invoked. Result:

  ```json
  {"calls_before_release":2,"max_concurrent":2}
  {"final_calls":2,"max_concurrent":2}
  ```

  This proves the current wake path is not single-flight.

- Calculated the proposed latency floors using the plan's own figures:

  ```text
  warm isolated mean:       250 + 185 + 430 = 865 ms
  warm isolated p95:        475 + 185 + 430 = 1090 ms
  warm worst poll position: 500 + 185 + 430 = 1115 ms
  cold mean:                250 + 1461 + 430 = 2141 ms
  contended mean:           250 + 185 + 1266 = 1701 ms
  ```

## Standards findings

These findings cover executability, repository conventions, testing discipline, documentation, and evidence quality.

### S-H1 — Task 2 creates overlapping authenticated syncs

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:248-313`  
**Source evidence:**

- `pos-spooler-printer/v2/agent-runtime.js:18` stores only one `inFlight` reference.
- `pos-spooler-printer/v2/agent-runtime.js:33-39` starts `tick()` whenever a scheduled timer fires, without checking whether another tick is active.
- `pos-spooler-printer/v2/agent-runtime.js:223-224` makes `wake()` unconditionally schedule zero delay.

**Problem:** The plan says a wake during an in-flight sync is safely recovered later. The runtime instead starts another sync immediately. That can duplicate outbox bodies, consume limiter capacity, overlap same-agent DB transactions, overwrite `inFlight`, and let shutdown await only the newest request.

**Required correction:** Make the runtime single-flight. During an active tick, record one pending wake. After the active tick fully settles and `inFlight` is cleared, schedule exactly one immediate follow-up. Tests must prove maximum sync concurrency is one, multiple wakes coalesce, one prompt follow-up occurs, and shutdown waits for all work.

### S-H2 — Task 3's proposed integration tests are not executable

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:360-437`  
**Source evidence:**

- `backend/tests/integration/spoolerV2Sync.test.js:22` defines `register(...)`.
- `backend/tests/integration/spoolerV2Sync.test.js:37` defines `sync(agentId, secret, body)`.
- No `syncAs` helper or `agent` variable exists in the file.
- The test file is CommonJS, while the plan suggests import syntax.
- `backend/routes/spoolerV2.js:29-45` keeps rate-limit state in process memory, outside database cleanup.

**Problem:** The pasted tests fail before reaching the intended assertion. Adding a second throttle test with a reused identity can also inherit the limiter state from the existing test even after DB cleanup.

**Required correction:** Modify the existing dedicated rate-limit test once, using `register(...)`, `sync(...)`, and its unique `AGENT_RATE` identity. Use the file's actual CommonJS style and provide deterministic limiter reset or injected time.

### S-H3 — The proposed acceptance timings are not observable from `print_queue`

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:25-37,463-480`  
**Schema evidence:**

- `deployment/database/baseline.sql:731` — `created_at timestamp` without fractional precision.
- `deployment/database/baseline.sql:742` — `sent_at datetime` without fractional precision.
- `deployment/database/baseline.sql:743` — `acknowledged_at datetime` without fractional precision.
- `deployment/database/baseline.sql:749` — `accepted_at datetime` without fractional precision.

**Problem:** Whole-second timestamps cannot distinguish 100 ms from 900 ms or prove an enqueue-to-sent result of approximately 250 ms. They also cannot prove that a rounded two-second difference was exactly 2000 ms.

**Required correction:** Use monotonic millisecond timestamps in a focused evidence harness or structured runtime telemetry. A schema migration is unnecessary for this measurement.

### S-H4 — The unconditional subsecond goal conflicts with the plan's own timing floors

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:5,25-37,463-480`  
**Evidence:** The plan records a 1461 ms cold render and 1266–1293 ms same-device contention before adding polling and other work.

**Problem:** Only a warmed, isolated median receipt is plausibly under one second. Warm P95, cold start, and same-printer contention exceed it using the plan's own data.

**Required correction:** Define a warm, uncontended P50 target and separate budgets for warm P95/P99, cold start, same-printer contention, and low-end hardware.

### S-M1 — The rollback environment variable is undocumented

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:394-410,488-497`  
**Missing from:**

- `.env.example`
- `deployment/templates/pos.env.template`
- `deployment/templates/hostinger.env.template`

**Problem:** The plan describes `SPOOLER_SYNC_INTERVAL_MS` as an emergency rollback mechanism, but operators cannot discover its default, supported range, or meaning from supported templates.

**Required correction:** Add the default and range to relevant server templates and operator documentation, plus a focused configuration test.

### S-M2 — The plan incorrectly declares no architecture-map change

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:482-487`  
**Architecture evidence:**

- `docs/architecture.json:2899` — V2 local runtime flow.
- `docs/architecture.json:3103` — checkout/print settlement flow.
- `CLAUDE.md` requires the architecture map to remain the source of truth for major flow changes.

**Problem:** Task 2 adds a worker-result-to-runtime wake edge. Task 3 changes durable pull cadence and, through current composition, status-probe scheduling. Running the architecture check without updating the traced flow leaves the map incomplete.

**Required correction:** Update `docs/architecture.json`, regenerate `docs/architecture.html`, and run the architecture check.

### S-M3 — Focused RED/GREEN instructions repeatedly run the whole spooler suite

**Severity:** Medium  
**Plan evidence:** Full runner appears at plan lines 116, 137, 245, 286, 321, 448, and 471.

**Problem:** The spooler runner enumerates all 23 test files. This contradicts the project's proportional verification rule and the plan's own claim that the full suite runs once.

**Required correction:** Run the directly affected Node test file during each RED/GREEN cycle. Run `npm --prefix pos-spooler-printer test` once at the final gate.

### S-M4 — “Full suite exactly once” does not name an executable root command

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:463-471`  
**Problem:** Root `npm test` does not represent the complete repository Vitest/schema gate. The instruction is ambiguous and can produce a false green result.

**Required correction:** Name the exact intended final command, including `npm run test:unit` if the full Vitest/schema-drift gate is required.

### S-M5 — The limiter assertion does not protect the selected headroom

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:330-390`  
**Source evidence:**

- `backend/routes/spoolerV2.js:29-30` currently defines a ten-second window and maximum 40.
- `backend/routes/spoolerV2.js:40` resets only when elapsed time is greater than the window.
- `backend/routes/spoolerV2.js:45` rejects after count exceeds the maximum.

**Problem:** The plan implements 80 but tests only `>= 50`. Fifty gives no useful margin over its own 20 steady plus 30 urgent calculation. The exact boundary can also remain in the old bucket at 10,000 ms.

**Required correction:** Test the chosen policy or derived safety margin deterministically, including exact window boundaries.

### S-M6 — Load validation uses the wrong DB pool and only one agent

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:37,463-480`  
**Configuration evidence:**

- Local evidence used `DB_CONNECTION_LIMIT=50`.
- `deployment/templates/pos.env.template` uses 10.
- `deployment/templates/hostinger.env.template` uses 10.

**Problem:** The plan quadruples authenticated sync traffic, and every sync performs DB authentication and a transaction. One agent and a pool of 50 do not represent supported deployment conditions.

**Required correction:** Run 1–5 agents against pool limit 10 with sustained idle traffic and bursts. Assert bounded acquisition queues, no throttling, and healthy normal routes.

### S-M7 — A calculated printer-speed estimate is labeled as measured evidence

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:25-35`  
**Problem:** The approximately 430 ms physical-print value is calculated from pixel height, DPI, and rated printer speed. It is not a physical measurement.

**Required correction:** Label it as an estimate or measure paper motion on representative hardware.

### S-L1 — Task 1 duplicates an existing valid artifact persistence test

**Severity:** Low  
**Source evidence:** `backend/tests/integration/spoolerV2Sync.test.js:157-183` already settles valid artifact hash/byte values and verifies persistence.

**Required correction:** Extend the existing test with the missing invalid-input case rather than duplicating its valid path.

### S-L2 — Task 2's expected-failure prose is internally stale

**Severity:** Low  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:190-245`  
**Problem:** The plan says “both” tests fail although it supplies three test cases, and later refers to `wakes.length` even though `wakes` is numeric.

**Required correction:** Correct the prose and assertions so the executor can distinguish the intended RED result from a test-authoring error.

### S-L3 — “Every acknowledged row” is too broad

**Severity:** Low  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:473-480`  
**Problem:** Historical rows and rows settled by older agents can legitimately have null artifact fields.

**Required correction:** Scope the acceptance assertion to newly acknowledged rows settled by the updated canary agent.

## Specification and behavioral findings

These findings cover whether the proposed behavior achieves the stated latency goal without regressing connection stability, printer scheduling, or operational safety.

### P-C1 — 500 ms sync cadence also accelerates physical printer-status probes

**Severity:** Critical  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:326-457,505-507`  
**Source evidence:**

- `pos-spooler-printer/v2/agent-runtime.js:128-131` invokes `workers.wake()` after a successful sync.
- `pos-spooler-printer/server.js:121-123` composes that wake as both `workers.wake()` and `statusMonitor.wake()`.
- `pos-spooler-printer/v2/status-monitor.js:30-68` polls printers and uses `runExclusive(...)` for non-Windows probes.
- `pos-spooler-printer/v2/status-monitor.js:82-86` cancels the pending timer and schedules an immediate poll on every wake.
- `pos-spooler-printer/v2/printer-workers.js:221-234` owns the shared per-printer exclusive lane.

**Problem:** The plan says it does not touch physical-printer scheduling. In the real composition, every successful sync can accelerate status probing from once per two seconds to roughly twice per second. A slow or offline ESC/POS probe can hold the same printer lane and delay an arriving kitchen or receipt job. `status-monitor.poll()` also has no in-flight guard, so repeated wakes during an awaited probe can overlap poll loops and leave multiple timers.

**Required correction:** Decouple job-collection wakes from status-monitor wakes, or make status polling independently cadence-bounded and single-flight. Tests must prove 500 ms syncs do not increase probe frequency, overlapping polls cannot occur, and a slow probe cannot delay print work beyond the existing contract.

### P-H1 — Result-ready wakes cancel deliberate outage backoff

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:248-313`  
**Source evidence:**

- `pos-spooler-printer/v2/agent-runtime.js:33-35` clears the current timer whenever `schedule(...)` is called.
- `pos-spooler-printer/v2/agent-runtime.js:200-203` schedules the 2/5/10-second network-failure backoff with jitter.
- `pos-spooler-printer/v2/agent-runtime.js:223-224` lets `wake()` replace that backoff with zero delay.

**Problem:** If locally accepted jobs finish while the server or network is unavailable, each result notification cancels the containment delay and creates an immediate failed request. Multiple lanes can recreate reconnect bursts and WAF/server pressure.

**Required correction:** A result wake may expedite a healthy idle runtime but must never shorten active failure backoff. Preserve a backoff deadline, coalesce result notifications, and perform one retry when allowed. Test several result completions during an outage and assert one backed-off retry.

### P-H2 — The `accepted → acknowledged under ~100 ms` target measures the wrong interval

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:463-480`  
**Source evidence:**

- `backend/services/spoolerSync.js:81-105` records acceptance before local rendering and transport complete.
- `backend/services/spoolerSync.js:134` records acknowledgment only when the completed result returns.

**Problem:** Accepted-to-acknowledged includes render and physical transport. With the plan's own warm figures, that is already roughly 185 ms plus an estimated 430 ms before network settlement. Task 2 removes only the post-result waiting time.

**Required correction:** Measure result-ready-to-server-confirmed for settlement improvement. Measure enqueue-to-claim separately for polling improvement.

### P-H3 — The stated goal and acceptance matrix omit known slow paths

**Severity:** High  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:5,25-37,463-480`  
**Problem:** One warmed receipt and ten back-to-back receipts cannot establish customer-visible performance across cold Chromium startup, same-printer contention, mixed receipt/kitchen traffic, offline lanes, or low-end POS hardware.

**Required correction:** Record warm P50/P95/P99, cold start, same-printer contention, mixed receipt/kitchen bursts, offline-lane isolation, and Celeron-class evidence.

### P-H4 — The fourfold fleet traffic increase is not proven safe against the supported server pool

**Severity:** High  
**Source evidence:**

- `backend/services/spoolerAgents.js:83-94` performs agent authentication DB work.
- `backend/services/spoolerSync.js:60-67` begins transaction/locking work.
- `backend/services/spoolerSync.js:273` updates agent sync state.
- Deployment templates use a DB connection limit of 10.

**Problem:** At 500 ms, each active agent performs two authenticated sync transactions per second even when idle. The plan does not test the supported 1–5-agent venue shape against the actual pool budget.

**Required correction:** Run sustained 1-agent and 5-agent HTTP+MySQL probes with pool limit 10. Measure DB acquisition queue, transaction duration, root-route health, and throttling during idle and bursts.

### P-M1 — 500 ms syncs shorten deferred render/store-failure retries

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:326-457`  
**Source evidence:**

- `pos-spooler-printer/v2/printer-workers.js:149-153` places store-write failures in `deferredUntilWake`.
- `pos-spooler-printer/v2/printer-workers.js:237` skips deferred jobs.
- `pos-spooler-printer/v2/printer-workers.js:320-324` clears the entire deferred set on every worker wake.
- `pos-spooler-printer/v2/agent-runtime.js:128-131` calls worker wake after every successful sync.

**Problem:** The plan correctly avoids an immediate result hook for failed store writes, but global 500 ms sync traffic still clears that guard four times faster than today. On unhealthy disks or low-end machines this can repeatedly re-render or retry journal writes.

**Required correction:** Give deferred store failures a bounded minimum retry deadline independent of sync cadence, or prove via a disk-failure test that repeated 500 ms syncs cannot spin render/store work.

### P-M2 — The existing 50-job harness bypasses the changed runtime behavior

**Severity:** Medium  
**Evidence:** `scripts/spoolerV2MixedJobsHarness.js:272-293` hardcodes its own cadence and does not exercise `createAgentRuntime` plus result-ready wakes.

**Problem:** It cannot catch overlapping syncs, backoff cancellation, status-probe acceleration, or deferred-failure retries introduced by this plan.

**Required correction:** Extend or supplement it with the real runtime and 50 mixed jobs, including an offline lane. Capture CPU, RSS, event-loop delay, throttling, and lane progress.

### P-M3 — Rate-limit tests neither pin 80 nor prove sustained multi-agent behavior

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:330-437`  
**Problem:** The `>= 50` assertion permits regression to a ceiling with no margin. Eighty-one real HTTP requests inside a live ten-second window are timing-dependent and knowingly flaky.

**Required correction:** Use deterministic time or a directly tested limiter policy. Pin the intended default/range and test sustained idle plus 50-job bursts using unique agent identities.

### P-M4 — Release and installation handoff are absent

**Severity:** Medium  
**Evidence:** Agent Tasks 1–2 change `pos-spooler-printer/server.js` and V2 modules; Task 3 changes backend server behavior. The installer core allowlist already includes these spooler files, so a runtime dependency transition is not expected.

**Problem:** The plan does not record release versions/identity, prove updater payload contents, state server-versus-agent rollout order, or preserve the still-open physical-printer gates.

**Required correction:** Add version/release evidence, installer/updater contract checks, rollout order, one canary, and explicit physical-printer gates. Source tests alone do not authorize fleet rollout.

### P-M5 — Artifact bytes and `duration_ms` do not universally mean physical print time

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:60-137`  
**Transport evidence:**

- `pos-spooler-printer/v2/printer-transports.js:179-196` can complete TCP transport after bytes are sent while device status remains unknown.
- `pos-spooler-printer/v2/printer-transports.js:259-289` includes Windows helper and queue-drain behavior.

**Problem:** The fields are useful diagnostics, but their meanings depend on the transport. They do not directly measure paper burn time or the polling latency this plan targets.

**Required correction:** Store and report transport/status confidence with the metric. Describe artifact bytes as payload/paper-length approximation, not universal physical duration evidence.

### P-M6 — The planned tests can pass while production wiring is missing

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:294-321`  
**Source evidence:** `pos-spooler-printer/server.js:115-131` is the real composition seam.

**Problem:** Worker hook unit tests and a manually assembled runtime can pass without proving `server.js` connects the result hook to the safe runtime wake mechanism.

**Required correction:** Add a narrow composition/wiring assertion that exercises the production seam.

### P-M7 — Inactive agents inherit the same 500 ms cadence without benefit

**Severity:** Medium  
**Source evidence:** `pos-spooler-printer/v2/agent-runtime.js:165-183` schedules server-provided intervals for paused/revoked/decommissioned and active states.

**Problem:** Revoked, paused, or decommissioned agents cannot claim work, yet a global 500 ms response hint would make them perform two DB-backed syncs per second.

**Required correction:** Use fast cadence only for active/draining agents. Keep inactive statuses at a slower cadence such as five seconds.

### P-M8 — The fixed throttle response can override the rollback knob in the wrong direction

**Severity:** Medium  
**Plan evidence:** The plan permits `SPOOLER_SYNC_INTERVAL_MS` up to 5000 ms but proposes a fixed 2000 ms throttle response.

**Problem:** If an operator rolls normal cadence back to 5000 ms, throttling tells the agent to speed up to 2000 ms.

**Required correction:** Throttle guidance must never be faster than configured normal cadence, for example `max(configuredCadence, minimumThrottleDelay)`.

### P-M9 — Raising the limiter ceiling loosens containment without bounding urgent spin

**Severity:** Medium  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:330-457`  
**Source evidence:** `pos-spooler-printer/v2/agent-runtime.js:183` schedules zero delay whenever durable urgent work remains.

**Problem:** The plan doubles the ceiling from 40 to 80 while acknowledging the urgent-spin hazard but does not bound consecutive urgent cycles.

**Required correction:** Bound or coalesce consecutive urgent loops before loosening the ceiling, and prove failure/backoff containment remains effective.

### P-M10 — The final verification omits the mixed 50-job release harness

**Severity:** Medium  
**Problem:** Cadence and limiter behavior affect mixed receipt/kitchen traffic, but the final gate covers only one receipt and ten receipts.

**Required correction:** Run the mixed harness in local and disposable-live modes. Assert no duplicate settlement, no starvation, no throttling, and bounded DB occupancy.

### P-L1 — Baseline timing claims contain factual inaccuracies

**Severity:** Low  
**Plan evidence:** `docs/superpowers/plans/2026-08-21-print-latency-reduction.md:25-35`  
**Problem:** The cited rows are not all exactly 2000 ms; at least one is 3000 ms. The approximately 430 ms physical value is calculated from rated speed, not directly measured.

**Required correction:** Correct the row table and label calculated versus measured evidence explicitly.

### P-L2 — Task 1 observability does not itself reduce latency

**Severity:** Low  
**Problem:** Adding artifact bytes and hash is useful for diagnosis but changes neither polling, rendering, transport, nor settlement time.

**Required correction:** Keep Task 1 as an observability prerequisite, but do not credit it as a latency reduction in the goal or commit evidence.

### P-L3 — Invalid artifact evidence must use a newly claimed job

**Severity:** Low  
**Problem:** If invalid metadata is tested by settling an already-terminal row, unchanged null fields can create a false-positive result.

**Required correction:** Use a distinct freshly claimed and accepted job for the invalid metadata case.

### P-L4 — `duration_ms unchanged` requires a statistical baseline

**Severity:** Low  
**Problem:** One receipt is too noisy to prove unchanged rendering or transport duration.

**Required correction:** Compare representative samples or percentile bands under matched warm/cold conditions.

## Confirmed-safe or rejected hypotheses

The following concerns were checked and rejected; they should not be turned into unnecessary implementation work:

1. **No migration is required.** Artifact columns and server validation already exist.
2. **The five `recordResult` sites are real and correctly identified.**
3. **The result callback does not itself enter Chromium or printer lanes.** The scheduling problems occur in runtime composition, not inside the callback body.
4. **No ownership or settlement redesign is hidden in the plan.** `agent_id`, station ownership, leases, cancellation, transport markers, and terminal result mapping remain unchanged.
5. **The plan does not directly introduce automatic reprinting after an uncertain transport.**
6. **Old agents honor server `next_sync_ms`;** the proposed server-side lower clamp can affect them as intended.
7. **Existing artifact fields are structurally available on completed worker records.**
8. **No user-facing strings or database schema mutation are required by the intended latency work.**
9. **The successful-sync mid-flight result race can be resolved by rereading durable outbox/accepted state,** but only after the runtime is made single-flight and backoff-aware.

## Required plan corrections before execution

The plan should not be patched by changing only numbers. Its execution order should be corrected around these properties:

1. **Make runtime scheduling single-flight and backoff-aware.** Coalesce wakes; never bypass network-failure backoff.
2. **Separate scheduling domains.** Job-collection wakes must not wake status probes or clear deferred render/store-failure guards without their own deadlines.
3. **Define honest metrics.** Measure enqueue-to-claim and result-ready-to-confirmed with monotonic millisecond telemetry; scope the product target to warm/uncontended percentiles.
4. **Prove venue-realistic load.** Use 1–5 agents, pool limit 10, real runtime, mixed 50 jobs, low-end-machine telemetry, and deterministic limiter time.
5. **Repair the executor instructions.** Use real test helpers, focused RED/GREEN commands, one unambiguous final suite, architecture updates, environment templates, rollout identity, and physical canary gates.

## Finding count

- **Standards:** 4 High, 7 Medium, 3 Low — 14 findings.
- **Specification/behavior:** 1 Critical, 4 High, 10 Medium, 4 Low — 19 findings.
- **Total:** 33 findings.

The most dangerous defect is not a paper-duplication path; it is scheduler cross-coupling. As written, the latency change can overlap authenticated syncs, bypass outage containment, increase physical printer probing, and accelerate unhealthy render/store retries.

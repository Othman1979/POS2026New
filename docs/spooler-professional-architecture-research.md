# Spooler -- Professional Print Architecture: Research & Options

**Date:** 2026-07-05
**Purpose:** Evaluate how mature POS/print systems (Star CloudPRNT, Epson ePOS / Server Direct Print, Odoo IoT, PrintNode) architect receipt/kitchen printing, and turn our simple spooler into something professional: durable job tracking, timings (`acknowledged_at`), lost-ticket detection, reprint-from-history, and honest printer confirmation -- working in **both** cloud-hosted and fully-local (local MySQL) deployments, with cheap/generic Chinese ESC/POS printers.

> This is a **research + options** document, not an approved plan. It intentionally does not touch the cloud web app's general performance -- scope is the spooler and the print pipeline only.

---

## TL;DR -- Recommendation

Four independent research probes (CloudPRNT, PrintNode/queue-theory, Odoo/Epson, ESC/POS status) all converge on the **same** architecture:

> **A local bridge that owns a durable, DB-backed job queue with acknowledgement + idempotency + bounded retry, never deleting completed jobs -- designed for the dumb printer, treating smart printers as a bonus.**

The transport is a *separate* choice from where truth lives. The reference systems happen to favor a printer/agent-initiated **pull (poll)** transport for hostile networks -- but because the durable queue owns truth, the transport is swappable. **Our adopted design keeps WebSocket push as primary with a down-only poll fallback (O2b) -- not poll-only.** Once the queue owns truth (item 1), a dropped socket event can't lose a job, so we harden WS rather than replace it.

Concretely, in priority order:

1. **Stop deleting jobs on success. Make the queue the system of record.** Add `acknowledged_at` + timings + a proper state lifecycle; keep completed rows (archived, not deleted). This alone gives you tracking, lost-ticket detection, reprint-from-history, and audit -- and it's **identical in cloud and local-MySQL mode**. *(Biggest win, lowest risk, no transport change.)*
2. **Harden the WebSocket push; add HTTP poll only as a down-only fallback ("hybrid recovery").** Keep WS as primary (near-zero latency when healthy). Once O1 makes the DB the source of truth, a dropped socket event no longer loses a job -- so we tame WS (one-active guard, stop-reconnect-on-reject, bounded backoff, re-sync on reconnect, server watchdog) rather than replacing it. A poll endpoint drains pending jobs **only while the socket is down**, and sleeps on reconnect. *(See section 3b -- this supersedes the earlier "poll-only" idea, per Codex review + the documented root cause that WS works once reconnect storms stop.)*
3. **Add honest printer confirmation tiers.** Pre-flight status probe where the printer supports it; accept "tentative" + one-tap idempotent reprint + operator eyeball where it doesn't. *(The cheap-printer reality -- you cannot guarantee paper, so you guarantee cheap recovery.)*

---

## 1. How our spooler works today (grounded in code) + the gaps

**Path (verified in code):**

```
POS browser  --HTTPS POST /api/print-->  server (cloud OR local)
                                          |  printDispatch.enqueueAndProcessJobs:
                                          |    INSERT print_queue (status='pending')
                                          |    claimPrintJobs -> emit Socket.IO 'print_job'
   printer  <-- spooler (local Node) <----+  (push over persistent WebSocket)
                     |
                     +-- print_job_response {success} --> settlePrintJob -> DELETE row
```

**Current job model** (`backend/services/printQueue.js`):
`pending -> processing` (leased via `claimed_by`, `locked_until`, `attempts`, `last_error`) -> **`DELETE` on success** / `failed` on error. In-memory `completedJobsCache` (Set of last 100 `queue_id`s, lost on restart) guards duplicates.

**Transport** (`pos-spooler-printer/server.js`): the spooler is a **Socket.IO client** connecting outbound to `CLOUD_SERVER_URL` (a cloud URL today; `localhost` in a local install). Server **pushes** `print_job` events.

**Printers** (`printers` table): `type='network'` -> raw TCP port 9100; `type='windows'` -> `copy /B` to a Windows share. Success = "bytes written / copy returned."

### Gaps (what makes it "too simple")

| # | Gap | Consequence |
|---|-----|-------------|
| G1 | **Deletes job on success** | No history, no `acknowledged_at`, no audit, no reprint-from-history. Cannot answer "did table 5's kitchen ticket fire at 8:03?" |
| G2 | **"Success" = bytes accepted, not paper printed** | Jam / paper-out / cover-open still recorded as success. Silent lost tickets. |
| G3 | **No timings** | No `created_at -> acknowledged_at` latency, no per-printer p95, no way to prove/measure slowness. |
| G4 | **No lost-ticket detection** | A job that never prints just... vanishes (or sits `failed` with only a count). No watchdog. |
| G5 | **In-memory dedup only** | Restart loses dup protection; crash-after-print-before-ack can double-fire a kitchen ticket. |
| G6 | **No dead-letter / structured reprint** | Failed jobs have no deliberate, audited replay path. |
| G7 | **Push transport over persistent WebSocket** | Fragile on hostile venue networks (the Imunify360 / reconnect-storm class); a print that is physically a LAN job round-trips to the internet and back. |

---

## 2. What the professionals converge on

Four systems, one pattern. Sources at the end.

### 2.1 The queue is the system of record -- never delete (PrintNode)
- A print job is an **immutable record**; its **state is an append-only timeline** (`GET /printjobs/{id}/states` returns each transition with a timestamp + human message).
- States seen: `new -> queued -> sent_to_client -> done` (or `error`, `expired`, `deleted`). Duplicate `sent_to_client` is their **dup-detection** signal.
- Payload + `source` are retained -> **reprint** = re-create job from stored payload; **trace** = read the timeline.
- Deleting the row on success is the exact anti-pattern -- it throws away the only evidence the print happened.

### 2.2 Pull/poll transport, printer-or-agent initiated (Star CloudPRNT, Epson Server Direct Print)
- The device/agent is an **HTTP client** that POSTs to a server URL on an interval (~2-5s). Server replies "job ready / here it is" or "nothing." After printing, the client **confirms back** (DELETE `code=OK` in CloudPRNT; a print-result POST in Epson SDP).
- **Why it wins on bad networks:** outbound-only, short-lived HTTPS. No inbound port, no NAT hole, no persistent upgrade handshake, no reconnect storms. Looks like ordinary web traffic -> far less likely to trip WAF / Imunify360 / DPI that mangles `Upgrade: websocket`. Stateless, cache/LB-friendly.
- **Confirmation + health ride the poll:** paper-out / cover-open / offline are reported on every poll cycle, so the server sees printer health continuously, not just at job time.
- **Downsides:** latency floor = one poll interval (~2-5s); constant low-rate chatter even when idle (negligible for one venue; Star built an MQTT variant, "CloudPRNT Next," for fleet scale).

### 2.3 Local bridge owns the queue; design for the dumb printer (Odoo IoT, Epson)
- Odoo pushes **all device I/O to a local bridge** (IoT Box / Windows Virtual IoT) that sits on the store LAN, owns a **pending-job queue that retries until success**, and renders ESC/POS locally. The Odoo **server** can be cloud or self-hosted -- **hardware access is always local**. The only thing that "moves local" is the device-I/O bridge + queue, not the app logic.
- **Smart vs cheap:** smart printers (Epson TM-Intelligent) hold their own spooler and poll the cloud directly, no PC. Cheap ESC/POS printers are **dumb byte-sinks** -- something else must own queue, retry, rendering, status. **Design for the dumb printer; treat smart printers as an optional first-class target later** (e.g. an ePOS-XML renderer).

### 2.4 Cheap printers cannot honestly confirm -- so make recovery cheap (ESC/POS status research)
- Real confirmation needs a back-channel: **DLE EOT** (`10 04 n`, host-pulled real-time status: online/offline, cover-open `n=2` bit2, paper-end `n=2` bit5, error bit6, paper sensor `n=4`) or **ASB** (`GS a`, printer-pushed 4-byte status block on state change). Over raw TCP 9100 the socket is full-duplex: `write(DLE EOT)` then `read()` with a ~400 ms timeout.
- **But generic clones (Xprinter/Gprinter/ZJ/unbranded) are wildly inconsistent** -- many are effectively **write-only**: they never answer DLE EOT, or return garbage. USB clones often expose no read endpoint. **You must probe each model once and cache a capability flag.** "No reply" = **unknown**, never "printed."
- **SNMP** (`hrPrinterDetectedErrorState` OID `1.3.6.1.2.1.25.3.5.1.2.1`: noPaper/doorOpen/jammed/offline bits) works on *proper* network printers; most cheap 9100 boxes ship no SNMP agent.
- **Windows `copy /B` is fire-and-forget** -- zero device feedback. Better: `OpenPrinter`+`GetJob` (`JOB_INFO_2.Status`: PRINTED/ERROR/PAPEROUT), `GetPrinter` (`PRINTER_INFO_2.Status`), or `FindNextPrinterChangeNotification` -- but only as good as the driver + port monitor (useless for Generic/Text-Only over a dumb share).
- **Accepted best practice for cheap fleets:** (1) "bytes delivered" = tentative, journal every job; (2) **pre-flight status probe** -- the single highest-value addition; catches paper-out/cover-open/offline *before* the job is lost and alerts the operator; (3) post-send re-read where supported; (4) **one-tap idempotent reprint** (never re-charges / re-fires inventory); (5) operator eyeball is ground truth; (6) durable journal so a crash re-issues.

---

## 3. Concrete redesign for us

### 3a. Durable job model -- replace delete-on-success *(do this first)*

We already have half the schema (`claimed_by`, `locked_until`, `attempts`, `last_error`). Two ways to land it:

- **Pragmatic (recommended first step):** evolve `print_queue` -- **stop deleting**, add an `acknowledged` state + timing columns, add a nightly archival move. Add an optional `print_job_events` child table for the PrintNode-style timeline.
- **Fuller:** a dedicated `print_jobs` + `print_job_events` pair.

**State naming -- keep existing names, add new ones (do not rename first).** Current DB uses `pending` / `processing` / `failed`. A full rename to `queued`/`claimed`/... is avoidable churn across `claimPrintJobs`, `settlePrintJob`, queries, and tests. **Keep the existing three and ADD** `sent`, `acknowledged`, `dead_letter`, `canceled`. (The current success path DELETEs the row; it now becomes `acknowledged` and is kept.)

**Naming caution (cheap printers can't confirm paper):** the terminal success state is **`acknowledged`** = "the spooler's send function returned OK / bytes handed to the printer or OS" -- it is **NOT** proof paper came out. Real device truth lives in a **separate `device_status`** column and is only trustworthy for Tier-A printers (see O3). The UI must never render "printed" for a Tier-B (write-only) printer -- say **"sent"**.

Target columns (evolve `print_queue` in place; key additions in `** **`):

```sql
id                BIGINT PK
**idempotency_key** VARCHAR(160)  -- see "Idempotency key shapes" below -> UNIQUE
**order_id / ticket_id** BIGINT NULL   -- correlate a print back to its order/ticket
printer_id        VARCHAR(64)
**spooler_id / spooler_version** VARCHAR  -- which host+version handled it (regression triage)
payload           JSON/MEDIUMTEXT  -- the SAME JSON payload the WS path sends; KEEP for reprint
**payload_hash**    CHAR(64)       -- sha256(payload) -> dedupe + integrity
state             ENUM('pending','processing','sent','acknowledged','failed','dead_letter','canceled')
                                   -- pending/processing/failed EXIST; sent/acknowledged/dead_letter/canceled are new
**device_status**   ENUM('unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error') DEFAULT 'unknown'
                                   -- real printer truth from DLE EOT/ASB/SNMP (O3); Tier-B printers stay 'unknown'.
                                   -- NEVER surface as "printed" unless truly confirmed. (Enum is the reportable set;
                                   -- trim to what your actual fleet reports.)
attempts / max_attempts
locked_until      DATETIME(3)    -- existing lease
last_error        TEXT
created_at        DATETIME       -- REUSE the existing print_queue.created_at as queued-time (verify: SHOW COLUMNS); do NOT add a redundant queued_at
**first_attempt_at / sent_at / acknowledged_at / duration_ms**  -- the timings you lack
**next_retry_at**   DATETIME(3)    -- backoff schedule
UNIQUE KEY (idempotency_key)
KEY (state, locked_until)         -- claim scan
KEY (state, created_at)           -- watchdog / lost-ticket scan
```

Lifecycle (existing names + additions):

```
                 +---------> canceled              (order voided before print)
                 |
pending -> processing(leased) -> sent -> acknowledged   <- KEEP THE ROW ("spooler sent it", not "paper out")
   ^          |                    |
   |          v                    v
   +--(retry)<------------------  failed --(attempts >= max)--> dead_letter (retain ~14d)
        backoff via next_retry_at
```

**Idempotency key shapes (exact rules -- or you block valid reprints / allow duplicate kitchen tickets):**
- **Kitchen:** `kitchen:<print_batch_id>:<printer_id>:<payload_hash>` where **`print_batch_id` is a fresh id minted at each kitchen-fire event** (persist it on the fire). **Do not key on `held_order_id` alone** -- an open table fires many times over its life, and two *separate* fires with identical items (e.g. "1 burger" fired now, another "1 burger" fired 10 min later) would collapse to the same `held_order_id + payload_hash` key and the second ticket would be **silently deduped -> kitchen never gets it**. A per-fire `print_batch_id` makes each fire distinct while still deduping a network retry of the *same* fire. *(If the existing fire-kitchen path already emits a per-fire batch id, reuse it; otherwise add `print_batch_id`.)*
- **Receipt / reprint:** a **distinct** key that includes a reprint marker/counter, e.g. `receipt:<invoice_id>:<printer_id>:reprint:<n>`, so a legitimate reprint is **not** deduped against the original.
- **Reports (X/Z / audit):** `<audit_report_document_id>:<copy_label>` (original vs `REPRINT`) so an original and a reprint stay distinct.
- Rule: the key is **stable** for "the same intended fire" and **different** for "a deliberate new/reprint fire."

Operational payoffs, each directly answering a gap:
- **Lost-ticket watchdog (G4):** `state IN ('pending','processing','sent') AND acknowledged_at IS NULL AND created_at < NOW() - INTERVAL N SECOND` -> surface + alert. Stuck-lease: `state='processing' AND locked_until < NOW()` -> reclaim (bounded, else dead_letter).
- **Timings (G3):** `duration_ms = acknowledged_at - first_attempt_at`; per-printer p95, DLQ depth, oldest-unacknowledged age -> a small health dashboard.
- **Durable spooler-side dedup (G5) -- this is an O1 requirement, not only O2b.** The crash-after-print-before-ack window exists **today**: the server already re-dispatches expired-lease/`failed` jobs, and the only guard is the in-memory `completedJobsCache` (lost on restart). So the spooler needs a **durable** seen-set (small local file/SQLite keyed by `queue_id`/`idempotency_key`), checked **before** physical print, with the "printed" marker written **before** the ack. Without it, O1's watchdog/retry can double-print regardless of transport. `UNIQUE(idempotency_key)` on the server side complements this by making a re-enqueue a no-op.
- **Reprint (G1/G6):** re-fire the stored `payload` as a **new** row with a **distinct reprint idempotency key**; the original stays `acknowledged`. Reprint writes an `audit_events` row **in-txn** (matches atomic-audit policy, permission-gated) with: **`original_queue_id`, `new_queue_id`, `user_id`, `reason`, `printer_id`**.
- **Retention (name the owner):** a nightly **batched** archival -- a MySQL scheduled `EVENT` **or** a small maintenance script (decide which up front; **not** an ad-hoc giant `DELETE`) -- moves `acknowledged`/`canceled` older than 30-90 days to `print_jobs_archive`; keep `failed`/`dead_letter` longer (they're the incidents). Alternative: partition by `created_at` month and `DROP PARTITION`.

**Current deploy-mode note:** O1 spans two parts -- **(a) DB/server** (schema, stop-deleting, watchdog, dashboard) and **(b) the tracked `pos-spooler-printer/` package** (ACK timings, mark-printed-before-ack and the durable seen-set). Deploy the complete versioned package on every print machine; cloud and local-MySQL installs differ only through local environment configuration.

### 3b. Transport -- harden WebSocket push + down-only poll fallback ("hybrid recovery") *(strongly indicated)*

> **Decision (2026-07-05, after Codex review):** keep WebSocket push as primary and **harden** it; do **not** switch to poll-only. Rationale: WS push is near-zero latency when healthy, and once O1 makes the DB the source of truth, a dropped socket event no longer loses a job. The documented root cause ([[socket_403_root_cause]]) is that WS *works* at the venue -- the Imunify360 bans came from **reconnect storms**, not blocked WebSockets. So tame the storms and WS is viable. A poll endpoint exists only as an emergency drain while the socket is down. This is **hybrid recovery, not a hybrid lifecycle**: WS owns fast delivery, the DB owns truth, poll only drains pending jobs while WS is down.

**O2b -- harden the WS push:**
- **One-active-spooler guard with stale-heartbeat takeover.** Server rejects a *second* spooler for this single install -- **but only if the current active spooler's heartbeat is fresh** (within a grace window, e.g. 2x the heartbeat interval). If the previous socket died without the server noticing (no `disconnect` yet), a restart/new spooler with a stale-or-absent heartbeat **takes over** instead of being locked out forever.
- **Client stops reconnecting on reject/unauthorized** (fixes the infinite reject->reconnect loop that trips Imunify360).
- **Bounded reconnect backoff, no storm** (the actual documented root-cause fix).
- **Heartbeat with latency/ping**; ACK includes timings (feeds O1 dashboard).
- **Immediate re-sync on reconnect** -- reuse the existing `processPendingQueue(socket)` drain.
- **Server-side watchdog** for jobs stuck in `processing`/`sent` too long -> reclaim + re-dispatch (bounded -> dead_letter).
- **Admin alert** when spooler offline/unstable + an optional manual **"resend pending jobs"** button (admin/programmer only).

**Down-only poll fallback:**
- Spooler polls an HTTP endpoint **only** after the socket has been disconnected > ~5 s; it **sleeps again on reconnect**. Normal case: 0 added latency. Bad-network case: jobs still drain within a few seconds.
- The poll drain **must reuse the same `claimPrintJobs` lease and the same payload + ack path** -- no separate lifecycle. `POST /spooler/poll` -> server does a normal `claimPrintJobs` and returns the **same JSON print payload the WS path sends** (the spooler renders/sends via the identical local path -- the transport only changes *how the payload arrives*, never the payload or the rendering); spooler acks exactly like the socket path. *(The payload is JSON that the spooler renders locally -- it is not pre-rendered ESC/POS.)*
- **Poll-endpoint security:** authenticate with the **same `SPOOLER_KEY`** the socket uses (header + constant-time compare), **reject normal staff/customer sessions**, **rate-limit** it, and never expose job payloads to any staff/customer socket. It is a spooler-only channel, gated identically to the Socket.IO spooler handshake.

**Load-bearing invariants (or hybrid double-prints kitchen tickets):**
1. **Durable spooler-side dedup -- *already required by O1* (see section 3a), not new to O2b.** WS + fallback-poll + lease-reclaim are multiple delivery paths that can race the same job, but the crash-after-print-before-ack window exists even on today's WS-only path. The in-memory `completedJobsCache` is insufficient (lost on restart). The spooler must check a **durable** seen-set keyed on `queue_id`/`idempotency_key` **before physical print**, and write its "printed" marker **before** it acks -- so a reclaim/redelivery re-acks instead of reprinting.
2. **One claim authority.** Both WS-dispatch and poll-drain go through the **same** `claimPrintJobs` (`FOR UPDATE` + `locked_until`). That single lease is what prevents WS and poll from both handing out the same job.
3. **Watchdog + retried ack.** The server watchdog re-dispatches an expired-lease `processing` job; if the spooler actually printed but the ack dropped, invariant #1 + a retried ack are what keep the reclaim from reprinting.

**Both deploy modes:** local install = `localhost` (WS is trivially healthy, fallback effectively never fires); cloud install = WS primary with the poll safety net. Same code path.

### 3c. Printer confirmation -- capability tiers *(cheap-printer reality)*

Auto-detect once, cache a per-printer tier:
- **Tier A (trusted):** answers DLE EOT and/or SNMP.
  - **Network 9100:** before each job, `write(DLE EOT n=2/n=4)`, `read()` ~400 ms. Fault -> abort + surface exact cause (paper/cover/error). OK -> send. No reply -> demote to Tier B, stop probing. Optionally enable ASB and keep a reader for mid/post-job faults. One-time SNMP `hrPrinterDetectedErrorState` probe; if it answers, prefer it.
  - **Windows:** if reachable as a raw socket/USB endpoint, bypass `copy /B` and run DLE EOT directly; else submit RAW via spooler and poll `GetJob`/`GetPrinter`/WMI status.
- **Tier B (dumb / write-only):** accept `copy /B` / TCP-write gives no truth -> job stays **tentative**; rely on one-tap idempotent reprint + operator confirm.

The **pre-flight probe is the biggest single win**: it turns the three most common failures (paper-out, cover-open, offline) from "silent lost receipt" into "blocked before the job, operator told."

---

## 4. Options ranked (effort vs payoff)

| Option | Scope | Effort | Payoff | Notes |
|--------|-------|--------|--------|-------|
| **O1 -- Durable history + timings + reprint** | 3a: DB + spooler ACK | **Low-Med** | **High** | Fixes G1,G3,G4,G5,G6. Works both deploy modes now. **Start here.** |
| **O2b -- Hardened WS push + down-only poll fallback** | 3b | Med | High (reliability) | Fixes G7. Keep WS primary (0 latency when healthy); tame reconnect storms (the documented root cause); poll drains only while socket down. Ship after O1. |
| **O3 -- Printer status tiers** | 3c | Med | Med-High | Fixes G2. Pre-flight probe first; full ASB later. |
| **O4 -- Structured payload + late render + ePOS renderer** | render layer | High | Med | Enables native smart-printer (ePOS/SDP) targets + deterministic reprints. Future. |

Recommended sequence: **O1 -> O2b -> O3**, each independently shippable and reversible. O4 is a later strategic bet if you want to sell "no-PC smart printer" setups.

---

## 5. What's salvageable from the earlier (rejected) performance plan

The `2026-07-05-spooler-performance-hardening.md` plan aimed at the wrong bottleneck (rendering), but parts feed directly into this:

- **Keep & repurpose:** the job-timing helper (its Task 2) and the health cache / one-active-spooler enforcement (its Task 4) -- these become the timings + dashboard for O1. The XSS hardening (its Task 8) is still worth doing on its own security merits.
- **Superseded:** its durable-JSON-file dup store (Task 6) -> replaced by the **DB-backed** durable history in O1 (better: queryable, one system of record, works both modes).
- **Dead:** the native ESC/POS kitchen fast-path (Task 5) -- confirmed unusable because item names are almost entirely **Arabic** and thermal ESC/POS text can't shape Arabic.
- **Still open, unrelated:** whether to git-track `pos-spooler-printer/` (it's deliberately ignored today). Any spooler edits below still follow the manual-deploy `docs/SPOOLER-CHANGES.md` pattern until that decision is made.

---

## 6. Open questions before committing

1. **O1 persistence shape:** evolve `print_queue` in place (stop deleting, add columns) vs. a fresh `print_jobs` + `print_job_events` timeline table. Recommendation: evolve first, add the events table if per-transition history is wanted.
2. **O2b fallback trigger:** socket-down threshold before the poll fallback wakes (~5 s?) and poll interval while down (~2-3 s?). *(Decision made: hybrid recovery -- WS primary, poll only while down. Remaining tuning is just these numbers.)*
3. **Durable spooler-side dedup store:** where the spooler keeps its "already printed" seen-set (small local file/SQLite/JSON keyed by `queue_id`) -- the invariant that stops hybrid delivery paths from double-printing.
4. **Watchdog timeout:** how long a job may sit in `sent`/`processing` before the server reclaims/alerts.
5. **Reprint governance:** should reprint be permission-gated + audited like void/refund (recommended, matches existing atomic-audit policy)?
6. **Retention window:** how long to keep `acknowledged` jobs hot before archiving (30 / 60 / 90 days)?
7. **Printer fleet reality:** which exact printer models are in the field? Determines how much of Tier-A confirmation is even reachable.

---

## Sources

**Pull-based cloud printing (Star CloudPRNT):**
- Protocol guide -- https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/protocol-guide.html
- POST JSON response / request (status, ASB) -- https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/protocol-reference/http-method-reference/server-polling-post/json-response.html
- CloudPRNT Next / MQTT -- https://starmicronics.com/cloudprnt-web-cloud-online-pos-receipt-printing-sdk-developers/
- Server-side reference impl -- https://github.com/star-micronics/cloudprnt-sdk

**Job lifecycle / observability (PrintNode + queue theory):**
- PrintNode API (printjob fields, states endpoint) -- https://www.printnode.com/en/docs/api/curl
- Background job/queue patterns 2026 -- https://www.digitalapplied.com/blog/background-job-queue-patterns-2026-engineering-reference
- Dead-letter queues / poison messages -- https://www.task-queues.com/queue-fundamentals-architecture/dead-letter-queues-poison-messages/

**Local-vs-cloud bridge (Odoo + Epson):**
- Odoo IoT -- connect a printer -- https://www.odoo.com/documentation/19.0/applications/general/iot/devices/printer.html
- Epson Server Direct Print -- https://download4.epson.biz/sec_pubs/pos/reference_en/technology/server_direct_print.html
- Epson ePOS-Print API manual (PDF) -- https://files.support.epson.com/pdf/pos/bulk/tm-i_epos-print_um_en_revk.pdf
- Node ref impl (Epson SDP + Star CloudPRNT queue) -- https://github.com/BadChoice/cloudPrint

**Printer status / confirmation (ESC/POS):**
- Epson real-time commands / DLE EOT / GS a (ASB) -- https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/realtime_commands.html
- ESC/POS status bit tables -- https://escpos.readthedocs.io/en/latest/reliance_status.html
- SNMP Printer MIB (hrPrinterDetectedErrorState) -- https://www.rfc-editor.org/rfc/rfc3805.html
- Windows spooler status APIs (GetJob / JOB_INFO_2) -- https://learn.microsoft.com/en-us/windows/win32/printdocs/getjob
- Port 9100 raw printing (bidirectional back-channel) -- https://www.papercut.com/blog/print_tips/what-is-so-important-about-port_9100/

# Printing system discussion audit

- Status: audit only — no code changed
- Recorded: 2026-08-19
- Scope: stack, rendering, security, multi-terminal support, terminal-to-spooler binding, busy-restaurant connection behavior
- Method: read the verified architecture map, then confirmed the live V2 sources. Ratings are for the **current V2 path**, not the historical Socket.IO spooler.
- Related: `docs/printing-runbook.md`, `docs/architecture.json` (print/spooler flows), `docs/deferred-spooler-long-report-raster-corruption.md`, `docs/superpowers/evidence/2026-08-17-spooler-v2-release-gate.md`

This file is a discussion brief. It is not a build plan and it does not approve work.

---

## 1. Scores

**Overall: 7.8 / 10** for an on-prem restaurant POS print system with `print_method=backend`, unique `SPOOLER_ID` per print PC, and kitchen printers on USB or Ethernet.

It is not a live-socket “fire and hope” stack. It is a durable pull-sync agent with an explicit no-duplicate rule after transport starts. Remaining points are ops footguns, one serial Chromium renderer, and the honest limit that “bytes handed over” is not “paper came out.”

| Axis | Score | One-line verdict |
|---|---|---|
| Stack | **8.0** | Right architecture: enqueue → MySQL → authenticated HTTP pull → local journal → raster → serial transport |
| Rendering | **7.5** | Solid receipt/kitchen path; reports and one Chromium page are the weak spots |
| Security | **8.0** | Strong job/money/identity controls; shared site key + optional HTTP are the holes |
| Multi-terminal | **8.5** | Designed for N cashiers + M print PCs; ownership is enforced in SQL |
| Terminal ↔ spooler binding | **7.0** | Spooler↔printer is excellent; cashier browser↔receipt printer is `localStorage` |
| Busy-restaurant connection | **8.0** on LAN+USB/Ethernet; **~5.5** if TCP printers ride congested Wi‑Fi | Blips delay work; they do not drop the queue or uncharge the sale |

### How to read the overall number

Use **7.8** only when all of these are true in the restaurant:

1. Admin settings `print_method` is `backend`.
2. Every print PC has a unique `SPOOLER_ID`.
3. Kitchen printers are USB or wired Ethernet, not guest/staff Wi‑Fi TCP:9100.
4. POS server and spoolers share a LAN (or a stable private path). Internet may drop; LAN must not.

If `print_method` is still `browser`, score the **live product** closer to **4 / 10** for kitchen: register checkout will not send grill tickets through this stack at all.

---

## 2. What the system actually is

### 2.1 The live path (V2 only)

Socket.IO is **not** the print delivery path. V1 claim/emit/poll files are gone. `backend/tests/unit/spoolerV2OnlyContract.test.js` locks that contract.

```
Cashier browser
    POST /api/print          (staff cookie; call-center rejected)
POS server
    rebuild paid/kitchen from MySQL
    sanitize user text
    compile receipt/kitchen document
    INSERT print_queue (idempotency_key UNIQUE)
Print PC Windows service  (pos-spooler-printer v1.2.8)
    helper mutex + state-root lock
    DPAPI agent identity
    POST /api/spooler/v2/sync every ~2s (or immediately when busy)
    fsync local journal
    Chromium screenshot → 256-row thermal raster
    TCP:9100 or Winspool helper
    report completed / permanent / uncertain on next sync
Staff UI
    last_sync_at health, failed-job badge, audited reprint
```

Checkout does **not** wait for paper. The sale commits first. Print is best-effort after that.

### 2.2 Two different “terminals”

People mix these up. They are not the same object.

| Thing | What it is | How it binds |
|---|---|---|
| POS terminal | Browser on a cashier/waiter PC or tablet | Staff session cookie; optional registered-browser login. Receipt printer pick is `localStorage.pos_receipt_printer_id`. |
| Print station / spooler | Windows service on a machine that can reach printers | `SPOOLER_ID` in `spooler.env` + `printers.spooler_id` + one agent UUID + DPAPI secret. |
| Kitchen printer | Physical grill/expo/bar printer | Category → `printer_categories` → `printers.spooler_id`. Not the cashier’s receipt pick. |
| Receipt printer | Physical customer printer | Cashier-selected printer id among **all** active receipt printers. |

A cashier on Terminal B can sell an order whose kitchen ticket prints on the kitchen-pass PC and whose receipt prints on the front-counter printer. That is intended.

### 2.3 What “acknowledged” means

`acknowledged` means the spooler finished send: TCP wrote the artifact, or Winspool accepted the job. It does **not** mean paper came out, the cover was closed, or the cook saw the ticket.

`write_only` printers (the common default) never upgrade that to paper confirmation.

---

## 3. Stack — 8.0

### 3.1 Evidence

| Piece | Where | What it proves |
|---|---|---|
| V2-only entry | `pos-spooler-printer/server.js` | Production fails without `CLOUD_SERVER_URL` and `SPOOLER_KEY`. Wires helper, lock, identity, journal, sync, renderer, per-printer workers. |
| Pull interval | `pos-spooler-printer/v2/agent-runtime.js` (`BACKOFF_MS = [2000, 5000, 10000]`, idle sync ~2s, urgent sync 0) | Outage backoff is bounded. Busy stations poll immediately while work is outstanding. |
| Claim ownership | `backend/services/spoolerSync.js:214-223` | `JOIN printers p ... WHERE p.spooler_id = ? AND q.agent_id IS NULL`. Station cannot take another station’s jobs. |
| Never auto-reassign | architecture invariant + `replaceAgent()` in `backend/services/spoolerAgents.js:158` | Dead agent’s in-flight rows become `dead_letter` / outcome unknown. They are not given to the next PC. |
| Capacity | `SPOOLER_MAX_LOCAL_JOBS` default 50; server clamps claim capacity to 50 | Backpressure: a stuck station stops taking new work. Other stations continue. |
| V1 removal | `backend/tests/unit/spoolerV2OnlyContract.test.js` | No `emit('print_job')`, no `/api/spooler` V1, no spooler Socket.IO handshake. |
| Install model | `docs/printing-runbook.md`, `deployment/spooler/POSAPP-Spooler.iss` | Server installer does not embed Chromium. Each print PC gets `POSAPP-Spooler-Setup.exe`. |

Stack components on each print PC:

- Node 20/22
- Puppeteer `chrome-headless-shell`
- `node-canvas`
- `PosSpoolerPlatform.exe` (.NET helper: mutex, DPAPI, raw Winspool, printer notifications)
- Journal under `C:\ProgramData\POS-Spooler`

### 3.2 Why this is the right stack

Arabic mixed with Latin, custom HTML templates, and 80mm thermal printers do not survive a naïve ESC/POS string dump. Raster-from-HTML is the expensive-but-correct choice.

Pull HTTP plus a local fsync journal is the correct reliability model for a restaurant LAN. A live socket that dies mid-rush is the model this stack replaced.

### 3.3 Why it is not a 9

- Heavy: Chromium + canvas + helper on every print PC. Fine on a dedicated counter PC. Painful on a weak tablet used as both POS and spooler.
- Default product setting still `print_method=browser` (`backend/routes/system.js:59`). Until an admin flips it, the stack above is unused for register kitchen and receipts.
- `docs/SPOOLER-CHANGES.md` still describes Socket.IO as the primary path and HTTP poll as a 5s fallback. That is historical. Do not use it in a discussion as current behavior.
- `CLOUD_SERVER_URL` is a misleading name. It is just the POS origin. On-prem it should be the LAN URL.

### 3.4 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Leave the stack | The restaurant is on-prem Windows, Arabic receipts matter, you already install the standalone spooler | None |
| B. Flip default `print_method` to `backend` for new installs | You want the rated system to be the shipped system | Small settings/migration change; train anyone still using browser print |
| C. Decouple kitchen from `print_method` | You want grill tickets even if receipts stay `window.print()` | Small checkout change; kitchen becomes mandatory backend |
| D. Rewrite tickets as raw ESC/POS | You want to drop Chromium | Large; Arabic shaping and custom templates get worse |

**Suggestion to discuss first:** B + C. Do not rewrite the stack.

---

## 4. Rendering — 7.5

### 4.1 Evidence

| Piece | Where | What it proves |
|---|---|---|
| Compiled receipt/kitchen | `backend/services/printDocumentCompiler.js`, `pos-spooler-printer/renderDocument.js` | Server builds `compiled_document_v1`. Allowlisted tags/attrs. No `javascript:`, no remote `src`, no script/iframe. |
| Chromium hardening | `pos-spooler-printer/v2/artifact-renderer.js:439-441` | `setJavaScriptEnabled(false)`; every request aborted. |
| Banded raster | same file, `clipRows: 256`; `pos-spooler-printer/thermal-raster.js` | Tall pages are cut into 256-row `GS v 0` bands. One job → one alert sequence → one cut. |
| Serial renderer | `createArtifactRenderer` `serial` queue; architecture invariant | At most one active Chromium page. |
| Kitchen first | `pos-spooler-printer/v2/printer-workers.js` `priority()` | Kitchen / void / follow-up = 0, receipt = 1, reports = 2. |
| Long-report defect | `docs/deferred-spooler-long-report-raster-corruption.md` | Mitigation implemented. Affected printer **not** physically re-verified. |
| Release gate | runbook V2 gate + `backend/tests/manual/spoolerV2MixedJobsHarness.js` | 20 kitchen + 20 receipt + 10 report, zero duplicate transport markers, offline printer must not block other lanes. Physical USB/TCP/paper-out matrix is separate. |

### 4.2 What is good

- Receipts and kitchen tickets are documents, not client HTML pasted into a printer.
- 576-dot / 80mm target is explicit.
- Artifacts are hash-addressed and hashed again immediately before send (`verifyArtifactHash` in `printer-transports.js`).
- Arabic warmup string exists (`اختبار`) so the first real ticket is less likely to be the font cold-start.

### 4.3 What is weak

1. **Reports are still a giant HTML branch** in `artifact-renderer.js` (X/Z, audit, daily, expenses). They do not use the compiled-document allowlist path.
2. **`GS v 0` is obsolete and model-dependent.** Epson documents finite vertical limits. The 256-row mitigation is the conservative universal fix. One customer still needs a short-vs-long physical print to close the defect.
3. **One Chromium page is a rush-hour queue.** Kitchen is first *in the waiting list*. If a tall Z-report is already rendering, kitchen waits for that page (up to `SPOOLER_RENDER_TIMEOUT_MS`, default 30s).
4. **Typeface is Helvetica/Arial.** Arabic works through Chromium fallback, not a first-class Arabic receipt face.
5. **Ack ≠ paper.** Status probes skip while a lane is busy. `write_only` stays `unknown`.

### 4.4 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Close the long-report ticket with a physical short/long print on the affected model | You have that printer available | One on-site test; no code if it passes |
| B. Pause reports while kitchen is queued, or render reports only when kitchen/receipt queues are empty | Saturday night Z-reports starve tickets | Small scheduler change |
| C. Second Chromium page for reports | You refuse to wait | More RAM/CPU on weak PCs; fights the “one page” invariant |
| D. Move reports onto the compiled-document path | You want the same XSS/size guards as receipts | Medium compiler work |
| E. Switch tall reports to Epson newer graphics commands | 256-row `GS v 0` still fails on that model | Hardware-specific; only after A fails |

**Suggestion:** A first (evidence, not code). B if kitchens complain about Z-report stalls. Do not add a second browser until a Saturday night measurement says one page is the bottleneck.

---

## 5. Security — 8.0

### 5.1 Evidence — controls that hold

| Control | Where |
|---|---|
| Paid receipt rebuilt from DB | `backend/routes/print.js` receipt branch; architecture convention |
| ESC/POS injection stripped | `backend/services/printText.js` `sanitizePrintString` |
| Kitchen/held ownership + call-center rejected | `print.js` `rejectCallCenterRole`; kitchen IDOR checks |
| Bootstrap key timing-safe | `backend/routes/spoolerV2.js` `constantTimeEquals` |
| Agent token hashed, 32-byte secret, DPAPI | `spoolerAgents.js` `tokenMatchesHash`; `agent-identity.js` |
| Station lock + unique agent | `registerAgent` `409 station_occupied` / `station_busy` |
| Claim only owned printers | `spoolerSync.js` SQL join on `p.spooler_id` |
| Transport-started ⇒ no auto-retry | `job-store.js` `recoverTransportStarted`; kitchen invariant |
| Chromium cannot talk to the network | `artifact-renderer.js` request abort |
| Compiled HTML allowlist | `renderDocument.js` |
| Sync rate limit | 40 requests / 10s per agent; batch 100 |
| Production fail-closed | `assertProductionConfig` |
| Audited reprint, append-only queue | `printReprint.js`; never `DELETE FROM print_queue` |
| Redacted diagnostics | runbook: no payloads, secrets, tokens, raw logs |

### 5.2 Evidence — holes

| Hole | Where | Blast radius |
|---|---|---|
| One shared `SPOOLER_KEY` for the site | runbook, every `spooler.env` | Any print PC has the bootstrap secret. Attacker can register a **new** unused `SPOOLER_ID` and call `/status`. They cannot claim another station’s jobs without that station’s agent secret or an admin force-replace. |
| HTTP allowed | `sync-client.js` `/^https?:\/\//` | Agent token is sent as `x-agent-token` every ~2s. Open Wi‑Fi can replay it and impersonate that station. |
| Cashier can list every printer | `backend/routes/admin.js:13-22` GET `/api/admin/printers` is any authenticated user | Names, types, network IPs visible to every cashier. |
| Cashier can target any receipt printer | `printDispatch.selectReceiptPrinter`; client sends `receipt_printer_id` | Receipts can be sent to another counter on purpose or by stale `localStorage`. |
| Browser print bypass | `useTerminal.js` `printMethod === 'browser'` | `window.print()` skips queue, sanitizer path still exists only if they use backend. Kitchen on register checkout does not fire. |
| No TLS pin | `http-client.js` is timeout-only fetch | A LAN attacker who can MITM HTTP/HTTPS without pin can steal the agent token. |
| In-memory rate limit | `spoolerV2.js` `Map` | Fine for one POS process. Resets on restart. |

### 5.3 Threats that are already closed

- Forging a cheaper paid receipt via the print API.
- Injecting `ESC @` / cut / drawer kick through an item name.
- A second PC silently taking the kitchen queue by connecting with the same key.
- Replaying a kitchen job after the printer may already have started (that becomes dead-letter, not a second steak).
- Chromium following a URL in a malicious product name.

### 5.4 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Require HTTPS for `CLOUD_SERVER_URL` in production | POS already has TLS (hosted or LAN cert) | Small; breaks raw `http://192.168…` installs unless you issue a cert |
| B. Per-station bootstrap key instead of one site key | You worry about one stolen `spooler.env` | Installer + admin UX |
| C. Bind receipt printer to registered-browser credential | You already enforce device login and want “this iPad always prints here” | Medium; must handle replacement browsers |
| D. Stop returning network IPs on cashier printer GET | You only need id + display name + role in the POS picker | Small DTO change |
| E. Leave as-is on a private LAN with no guest SSID | Typical single-shop on-prem | Accept residual LAN risk |

**Suggestion:** E is acceptable for a closed LAN. If any POS or spooler URL is reachable from guest Wi‑Fi or the public internet, do A before anything clever. C is a product decision, not a security emergency.

---

## 6. Multi-terminal support — 8.5

### 6.1 What works

- N cashier browsers can checkout at once. They only need the POS HTTP API. They do not hold a print socket.
- Kitchen routing is per category, then parent category fallback (`kitchenPrintRouting.js`).
- Bundles flatten; the parent row never prints.
- Each physical printer is one serial lane. Two printers on one PC move at the same time. One offline printer must not block the other (release-gate requirement).
- Held / table kitchen is server-authoritative (`HeldOrderKitchenDispatch.js`) and **fails closed** if a line has no printer.
- Idempotency: kitchen key is `kitchen:{batch}:{printerId}:{hash}` with compiled HTML excluded so a recompile is not a second ticket.

### 6.2 What is uneven

| Path | Unrouted item (no kitchen printer) | Kitchen enqueue failure |
|---|---|---|
| Held / table / subscription | 422, order does not proceed | Held path treats queue conflict as 409 |
| Register `POST /api/print` kitchen | **Silent drop** (`d-unrouted-kitchen-items-silent`) | Toast only; sale already charged |
| Register checkout kitchen call | Same as above | **Not awaited** (`orderSessionStore.js:2293-2295`) |

So: table service is stricter than walk-in register. That is the opposite of what a busy counter wants if categories are mis-tagged.

### 6.3 Capacity under load

- Server claims at most 50 jobs per sync per agent.
- Agent advertises `max(0, 50 - localActive)`.
- Kitchen retries locally at 1s, 2s, then every 5s with **no attempt cap** (`retryDelays` last value repeats).
- A dead kitchen printer will sit in the local journal and eventually fill the 50 slots. That station stops claiming. Other stations are unaffected.

That is correct backpressure. It is also how a Saturday-night “kitchen PC is wedged” incident looks: that station goes quiet; the admin print-queue card should show depth and last sync.

### 6.4 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Fail register kitchen the same way held kitchen fails | You would rather block or warn than lose a grill item | Small; need a cashier-visible message |
| B. Await register kitchen enqueue (or retry once) before leaving checkout | Silent toast after the modal closes is not enough | Small; do not block the charged sale |
| C. Cap local retries then dead-letter + badge | A dead printer should not sit forever in the 50-slot journal | Small worker change |
| D. Leave it | Kitchen printers are reliable and categories are always mapped | Accept silent drops and wedged stations |

**Suggestion:** A + B. C only after a real wedged-printer incident.

---

## 7. Terminal binding to the spooler — 7.0

This axis is two scores glued together.

### 7.1 Print PC ↔ printers — ~9 / 10

Evidence:

- `SPOOLER_ID` is a stable station id (`primary`, `terminal-b`, `kitchen-pass`).
- Admin assigns `printers.spooler_id` (`backend/routes/admin/printers.js` `normalizeSpoolerId`).
- Helper takes a Global kernel mutex; Node takes the state-root lock via exclusive hard-link (`state-root-lock.js`).
- `agent.json` is UUID + LocalMachine DPAPI ciphertext. Copying ProgramData to another PC does not yield a working secret.
- Second live agent on the same `SPOOLER_ID` is rejected.
- Replacement: drain (finish owned work) or force-replace (revoke + terminalize unknown). Installer does not auto-force-replace.

This is real machine binding.

### 7.2 Cashier browser ↔ receipt printer — ~5.5 / 10

Evidence:

- `src/pos/useTerminal.js:22` `localStorage.pos_receipt_printer_id`
- Same key is read from admin reports, shifts, orders reprint, table splits, order notes
- `resolveReceiptPrinter` accepts **any** active receipt printer id
- If zero receipt printers: 400. If one: auto-pick. If many and none selected: 409 “Select a receipt printer for this terminal.”
- Not stored on `auth_sessions`. Not stored on the registered-browser credential.

So “this iPad is bound to the patio printer” is a human habit, not a server fact. Clear site data, a new Chrome profile, or a cloned shortcut opens the picker problem again. A waiter can also send a receipt to the other counter.

Kitchen does **not** use this pick. Kitchen follows category → printer → station.

### 7.3 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Keep localStorage | Staff are trained; one receipt printer, or they set it once per PC | None |
| B. Remember last printer on the registered-browser row | Device login is already enforced | Medium |
| C. Remember last printer on the Windows machine name / a station cookie | You want binding without WebAuthn | Medium; weaker than B |
| D. One receipt printer per `SPOOLER_ID` and auto-pick by “nearest station” | Each counter has exactly one receipt printer on its own spooler | Needs a definition of “nearest”; usually overkill |
| E. Server rejects a receipt printer that is not on a configured allow-list for that browser | You have fraud/misprint problems | Product + admin UX |

**Suggestion:** A is fine for a one-counter shop. B is the right next step if you already force registered browsers. Do not invent a new “POS terminal id” just for printing.

---

## 8. Busy restaurant: will the connection drop and cause damage?

### 8.1 Short answer

**No live print connection exists to lose.** Delivery is HTTP pull + disk journal.

- The **sale does not unwind** if print fails.
- **Already-queued MySQL jobs do not vanish** if Wi‑Fi blips.
- **Already-accepted local jobs keep printing** if the server is unreachable.
- A blip **during the write** does not auto-reprint. It becomes **unknown / dead-letter**. A human must look at the printer, then audited reprint.

That last rule is the one that saves you from two grill tickets. It is also the one that looks like “the system lost a ticket” if nobody checks the paper.

### 8.2 Failure matrix

| Failure | System behavior | Floor experience | Damage if nobody reprints |
|---|---|---|---|
| POS ↔ server blip **after** checkout | Sale committed. Receipt/kitchen enqueue may toast. Register kitchen is fire-and-forget. | Paid order, maybe no paper | Missed receipt or missed grill ticket |
| Spooler ↔ server blip | Local journal continues. New jobs stay `pending`. Backoff 2s → 5s → 10s. Urgent work resyncs immediately when the link returns. | 2–10s delay, then catch-up | None if the link returns |
| Internet down, LAN up, server on LAN | Selling and printing continue (runbook acceptance item) | Normal | None |
| Server hosted, internet down | New enqueue/sync fail. Already-local jobs still print. | New tickets stop | New orders have no new tickets until WAN returns |
| USB unplug, then replug | Connect/render = transient retry. Other printers continue. | Delay on that station | None once replugged |
| Cable yanked **while writing** | `uncertain` → dead-letter. No auto-retry. | Partial ticket possible | Duplicate if staff reprint without looking; miss if they do not reprint |
| Spooler crash after transport started | Restart recovers as `AGENT_RESTART_AFTER_TRANSPORT` uncertain | Same as above | Same |
| One kitchen printer dead all night | Local retries fill up to 50; station stops claiming | That station goes quiet | Backlog stays in MySQL for other recovery |
| Every PC power-cycles together | 0–2s startup jitter, then sync | Brief pile-on, kitchen first | None if printers come up |
| Two PCs share `SPOOLER_ID` | Second rejected | New PC prints nothing | Jobs stay on the first PC |
| `print_method=browser` | Kitchen on register checkout does not call the spooler | No grill ticket | Silent process failure, not a network failure |
| Category has no kitchen printer (register path) | Item omitted from every ticket | Cook never sees it | Silent miss |

### 8.3 Timing a cashier will feel

Idle station: up to **~2 seconds** from enqueue to the next pull, plus render (usually well under 1s for a ticket), plus TCP/Winspool.

Busy station: pull is immediate (`schedule(0)` while accepts/outbox/jobs exist). Bottleneck becomes Chromium (serial) and the physical printer.

TCP printer defaults (`printer-transports.js`):

- connect 5s (retry-safe)
- write idle 3s (after first byte: **uncertain**)
- total 15s, scaled up for large artifacts

Kitchen/receipt local retry: 1s, 2s, then every 5s, unlimited.

### 8.4 Topology that survives Saturday night

Safe:

- POS server on LAN (or a stable private link).
- Each print PC on Ethernet.
- Kitchen printers USB to that PC, or Ethernet TCP:9100 on the **printer VLAN / same switch**, not the guest SSID.
- Unique `SPOOLER_ID`.
- `print_method=backend`.

Unsafe (this is where “connection lost mid-rush” stories come from):

- Epson/Star on `192.168.x.x:9100` joined to the same 2.4 GHz staff/guest Wi‑Fi as phones.
- Spooler installed on a laptop that sleeps.
- One Chromium on a weak all-in-one that is also the POS browser, printing Z-reports during service.
- Hosted POS with no LAN fallback, and the shop’s WAN is the same radio as the printers.

The protocol is built for the safe topology. It cannot make a Wi‑Fi thermal reliable.

### 8.5 Discussion options

| Option | Do this if | Cost |
|---|---|---|
| A. Standardize USB/Ethernet printers; ban Wi‑Fi TCP:9100 | You care about kitchen more than cable aesthetics | Hardware / cabling |
| B. Keep a LAN POS even if admin is hosted | WAN drops must not stop tickets | Architecture / deploy |
| C. Visible “queued / sent / unknown” on the cashier toast | Staff currently treat enqueue success as “it printed” | Small UI |
| D. Dead-letter badge already exists — train reprint, do not auto-retry kitchen | You want zero duplicate steaks | Training, not code |
| E. Second renderer / faster poll | You measured >2s kitchen delay on LAN | Probably not the real problem |

**Suggestion:** A + D. If cashiers think “queued” means “printed,” add C. Do not add a live socket back.

---

## 9. Suggested discussion order

Use this as the meeting agenda. Decide in this order; later items depend on earlier ones.

### Block 1 — is the rated system even on?

1. What is `print_method` in production?
2. Is every print PC on the standalone spooler package, unique `SPOOLER_ID`, printers assigned in Admin → Printers?
3. Are kitchen printers USB/Ethernet, or Wi‑Fi TCP?

If 1 is `browser` or 3 is Wi‑Fi, stop talking about protocol scores. Fix those first.

### Block 2 — product rules

4. Should register kitchen fail closed like held kitchen when a category has no printer?
5. Should kitchen fire even when receipts stay browser-print?
6. Is `localStorage` receipt-printer pick acceptable, or should it follow the registered browser?

### Block 3 — failure UX

7. When a job is `uncertain` / dead-letter, who looks at the printer before reprint? (Admin print-queue already has audited reprint.)
8. Do cashiers need a stronger “queued, not printed” message?
9. After a print-PC replacement, is drain vs force-replace understood? Force-replace **will** mark in-flight work unknown.

### Block 4 — only if Block 1 is clean

10. Physical short vs long report on the printer that printed garbage.
11. HTTPS for spooler sync.
12. Hide printer IPs from cashier GET.
13. Pause Z-reports while kitchen is queued.

### Explicit non-goals unless someone brings a measurement

- Bring Socket.IO print delivery back.
- Auto-retry kitchen after transport started.
- Auto-reassign jobs to another station.
- Second Chromium by default.
- Per-model printer firmware special cases before the physical long-report test.

---

## 10. Suggested decisions (straw man)

These are recommendations to argue with, not approved work.

| ID | Recommendation | Why |
|---|---|---|
| S1 | Treat `print_method=backend` as the supported restaurant mode. Change the default for new installs. | The 7.8 score is fiction until this is on. |
| S2 | Fire kitchen from checkout regardless of receipt print method. | Grill tickets must not depend on customer-copy preference. |
| S3 | Surface unrouted kitchen items on **every** path, including register `POST /api/print`. | Architecture defect `d-unrouted-kitchen-items-silent`. |
| S4 | Do not auto-retry after transport started. Train reprint. | Duplicate kitchen tickets are worse than a manual reprint. |
| S5 | Cabling standard: USB or Ethernet to kitchen printers. | Wi‑Fi TCP:9100 is the real Saturday-night failure, not HTTP poll. |
| S6 | Keep pull-sync. Do not restore V1 sockets. | The connection-loss question is already answered by the journal. |
| S7 | Keep receipt pick in `localStorage` until device login is enforced everywhere; then bind it to the registered browser. | YAGNI until two counters share staff and misprints happen. |
| S8 | Close long-report raster with a physical test before more raster code. | Mitigation exists; hardware proof does not. |
| S9 | Require HTTPS for spooler sync only if the URL leaves a private LAN. | Closed LAN + HTTP is a known residual; guest/WAN HTTP is not acceptable. |
| S10 | Ignore stale Socket.IO language in `docs/SPOOLER-CHANGES.md` during this discussion. | It describes a deleted path. |

---

## 11. Evidence index

Primary sources used for this brief:

- `docs/architecture.json` — invariants, `flow-spooler-v2-*`, `flow-checkout-receipt-socket` (name is historical; steps are HTTP enqueue + sync), `flow-kitchen-station-routing`, defects `d-unrouted-kitchen-items-silent`, `d-legacy-kitchen-dead-code`
- `docs/printing-runbook.md` — deploy, `SPOOLER_ID`, ack semantics, V2 health, release gate
- `docs/deferred-spooler-long-report-raster-corruption.md` — long-report status
- `pos-spooler-printer/server.js` — V2 process wiring
- `pos-spooler-printer/v2/agent-runtime.js` — pull loop, backoff, capacity
- `pos-spooler-printer/v2/sync-client.js` — HTTP + bootstrap/agent headers
- `pos-spooler-printer/v2/job-store.js` — fsync journal, transport-started recovery
- `pos-spooler-printer/v2/artifact-renderer.js` — Chromium, 256-row clips
- `pos-spooler-printer/v2/printer-workers.js` — kitchen-first, lanes, unbounded local retry
- `pos-spooler-printer/v2/printer-transports.js` — TCP/Winspool marker + uncertain writes
- `pos-spooler-printer/v2/agent-identity.js` — DPAPI secret
- `backend/routes/spoolerV2.js` — register/sync auth and rate limit
- `backend/services/spoolerSync.js` — claim join, lease 120s, settle outcomes
- `backend/services/spoolerAgents.js` — bind, drain, force-replace
- `backend/services/printDispatch.js` — enqueue + receipt printer pick
- `backend/services/kitchenPrintRouting.js` — category routing + silent unrouted list
- `backend/routes/print.js` — staff print API
- `backend/routes/system.js` — default `print_method`
- `src/pos/useTerminal.js` — localStorage printer, browser vs backend
- `src/pos/stores/orderSessionStore.js` — checkout then best-effort print; kitchen gated on backend mode
- `backend/tests/unit/spoolerV2OnlyContract.test.js` — V1 is gone
- `backend/tests/manual/spoolerV2MixedJobsHarness.js` — mixed load + offline lane

Line numbers drift. Treat every `file:line` as a starting point and confirm by symbol name.

---

## 12. What this brief is not

- Not a claim that paper-out is detected on typical `write_only` printers.
- Not a claim that the affected long-report printer is fixed in the field.
- Not a penetration test of LAN HTTP.
- Not installer or Hostinger deploy evidence.
- Not permission to change code. If you want implementation after this discussion, say which of S1–S10 to take.

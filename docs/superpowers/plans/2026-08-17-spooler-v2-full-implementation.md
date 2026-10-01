# Spooler V2 Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-08-17

**Status:** Complete executor plan; not executed

**Supersedes:** The partial server-only executor draft.

**Goal:** Implement the complete V2 system defined by `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md` (rev 2.1): the server ledger and pull protocol, installed Windows agent, durable local execution journal, bounded renderer, TCP/Winspool transports, capability-aware status, admin operations, installer/updater cutover and rollback, and the hostile release gate — while preserving fielded V1 stations until each station is explicitly migrated.

**Architecture:** One authenticated HTTP sync interface is the only V2 delivery authority. The server owns assignment history in `print_queue`; the installed agent owns execution after a job is atomically journaled under ProgramData. A persistent Windows helper owns the machine mutex, DPAPI, and Winspool seam; per-printer workers share one bounded renderer but never share transport queues. The claimant is `agent:<agent_id>` forever, and neither a timeout nor an update may convert an uncertain physical outcome into an automatic reprint.

**Tech Stack:** Node 22/CommonJS, Express/mysql2/Vitest on the server, Node filesystem and built-in `fetch` in the Windows agent, Puppeteer/canvas/ESC-POS rendering already installed, a small .NET Framework Winspool/DPAPI helper compiled with the Windows `csc.exe`, Vue 3 admin UI, PowerShell/NSSM installer and layered updater.

**Execution sequencing:** This is the single executor plan. Tasks 1–6 land the dormant compatible server foundation. Tasks 7–13 build and package the installed agent, status/admin surfaces, atomic cutover, rollback, and release evidence. There are no follow-up implementation plans hiding the remaining scope. Optional Task 0 is the separately owner-gated V1 emergency triage and is skipped by default.

## Global Constraints

- Migration files are written ONLY by custom agent `luna_max` (`.codex/agents/luna-max.toml`) per `CLAUDE.md`. Draft stage = dated evidence migration only. `.auto.sql` + manifest entry + Hostinger fallback happen ONLY after explicit owner approval. The main agent verifies Luna's output independently.
- Current chain tip (verify at execution with `node -e "const m=require('./backend/migrations/auto-manifest.json');console.log(m.migrations.at(-1).name, m.migrations.at(-1).checksum)"`): `2026-08-13-webauthn-registered-device-access-v1` / `20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09`.
- The `print_queue` status enum gains `local_accepted`, `cancel_requested` **appended after `canceled`**, as an isolated `ALTER TABLE … ALGORITHM=INSTANT, LOCK=NONE` that must FAIL if INSTANT is unavailable. Never reorder, never combine with other DDL.
- Tests: `npx vitest run <files>` — exactly ONE vitest process at a time (shared `posapp_test`). Focused files during implementation; the full suite exactly once before completion.
- Lifecycle and throttling decisions for a correctly authenticated V2 agent are HTTP 200 and in-band (`agent_status`, `throttled`); 4xx is reserved for failed authentication/request shape, while unexpected server failures remain honest 5xx.
- A V2 station transition is durable and atomic: registration and V1 claiming serialize on the same station row; revocation/replacement never silently re-enables V1.
- The V2 application package contains no Socket.IO client delivery path. V1 and V2 may coexist across different stations, never on the same station.
- Reuse `renderDocument.js`, `report-html.js`, `thermal-raster.js`, `printer-alerts.js`, and `http-client.js`; do not add another renderer or HTTP library.
- Every task that creates or changes a major boundary updates `docs/architecture.json` with implemented `file:line` symbols, regenerates `docs/architecture.html` with `npm run architecture`, and passes `npm run architecture:check` before that task's commit. Tasks 7–12 name the exact boundary to add; Task 13 reconciles the complete end-to-end flow.
- No merge, push, deploy, production migration, or Hostinger mutation in any step. Commit locally only.
- The secret never appears in logs, error messages, or DB — only its SHA-256 hex.

## Parent-plan coverage

| Rev 2.1 scope | Executor task |
|---|---|
| Hardware/report Gate 0 | Pre-execution Gate 0 and Task 13 physical gate |
| Optional V1 emergency triage | Optional Task 0, skipped by default |
| Server protocol, schema, identity, sync, cancellation, replacement | Tasks 1–6 |
| Single-instance lock, DPAPI identity, durable local inbox/outbox, offline recovery | Tasks 7–8 |
| Per-printer scheduling, bounded renderer, Winspool helper, TCP hardening | Tasks 9–10 |
| Report compatibility, status, admin recovery, diagnostics | Task 11 |
| Installer/updater continuity, atomic cutover, rollback | Task 12 |
| Idle load, 50 mixed jobs, crash/updater/physical hostile gates, architecture | Tasks 6 and 13 |

Nothing in rev 2.1 Tasks 2–5 is deferred to another implementation plan.

---

## Pre-execution Gate 0 — Freeze the report/printer evidence

Before Task 1, collect from the affected installation without copying customer data: installed spooler version; exact printer model, driver, port, processor, paper width, and configured Windows/direct-TCP path; a sanitized log around one short receipt and one 200-row X/Z/items report; and the byte length/SHA-256 of both artifacts. Print each identical sanitized artifact through the current V1 direct-TCP path and current Windows `copy /B` path (do not mislabel it as Winspool; Task 13 supplies that comparison). Record the matrix and paper photographs in `docs/superpowers/evidence/2026-08-17-spooler-v2-report-printer-gate.md` and the existing deferred issue.

Decision is strict:

- current-version short and long both pass: no compatibility setting or schema is added;
- short passes and long fails identically on both paths: authorize one controlled 128-row `GS v 0` experiment; only a repeatable paper pass may justify adding that single profile to Task 1's migration/schema/UI scope;
- direct TCP passes and Windows fails: rendering is exonerated; Task 10's Winspool path is the correction;
- both paths fail or printer language is unknown: the hardware/profile issue remains open and blocks claiming that defect fixed.

If the installation is temporarily unavailable, server/agent implementation may proceed with the current default profile unchanged, but no compatibility field is added and Task 13 cannot close the report defect. This is an evidence gate, not permission to guess.

Conditional delta, only if the 128-row paper experiment passes: Task 1's normal/auto/fallback migration adds one isolated `ALTER TABLE printers ADD COLUMN raster_profile ENUM('gs_v0_256','gs_v0_128') NOT NULL DEFAULT 'gs_v0_256', ALGORITHM=INSTANT, LOCK=NONE`; seed/baseline/schema validation gain that exact column; Task 9 selects band height only from that enum; Task 11 exposes the selector with the affected-model evidence note. If the experiment does not pass, this entire delta is absent.

---

## Task 1 — Schema: durable station protocol, `spooler_agents`, and `print_queue` evolution (draft stage)

**Files:**
- Luna writes: `backend/migrations/2026-08-17-spooler-v2-agents-v1.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/database/baseline.sql`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`

**Interfaces — Produces:** table `spooler_stations` as the durable V1/V2 ownership authority; table `spooler_agents` as installation identity history; `print_queue` columns `agent_id CHAR(36) NULL`, `accepted_at DATETIME NULL`, `last_error_code VARCHAR(64) NULL`, `last_failure_class ENUM('transient_safe','permanent_safe','uncertain') NULL`, `artifact_hash CHAR(64) NULL`, `artifact_bytes INT UNSIGNED NULL`; statuses `local_accepted`, `cancel_requested`; index `idx_print_queue_agent_claim (agent_id, status, locked_until, id)`.

- [ ] **Step 1: Find the exemplar migration commit** so every authority file is changed the way the house does it:

```bash
git log --oneline -S "2026-08-13-webauthn-registered-device-access-v1" -- backend/services/schemaValidation.js backend/tests/fixtures/seed.js deployment/database/baseline.sql
```

Read that commit's diff (`git show <hash>`). Mirror its file-set shape exactly (seed drop-list + CREATE, baseline CREATE placement, `REQUIRED_COUNTS` keys + information_schema subqueries, schema-authority test expectations).

- [ ] **Step 2: Dispatch Luna** to write the draft evidence migration with exactly this SQL contract (Luna decides formatting, not content; no `.auto.sql`, no manifest, no fallback at this stage):

```sql
CREATE TABLE IF NOT EXISTS spooler_stations (
  spooler_id VARCHAR(96) NOT NULL,
  delivery_protocol ENUM('v1','transitioning','v2') NOT NULL DEFAULT 'v1',
  v2_activated_at DATETIME DEFAULT NULL,
  first_v2_accepted_at DATETIME DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS spooler_agents (
  agent_id CHAR(36) NOT NULL,
  spooler_id VARCHAR(96) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL DEFAULT '',
  agent_version VARCHAR(40) DEFAULT NULL,
  protocol_version INT NOT NULL DEFAULT 2,
  status ENUM('active','draining','revoked','decommissioned') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  last_error VARCHAR(255) DEFAULT NULL,
  local_queue_depth INT DEFAULT NULL,
  health_summary VARCHAR(255) DEFAULT NULL,
  active_station_key VARCHAR(96) GENERATED ALWAYS AS
    (CASE WHEN status IN ('active','draining') THEN spooler_id ELSE NULL END) STORED,
  PRIMARY KEY (agent_id),
  UNIQUE KEY uq_spooler_agents_active_station (active_station_key),
  KEY idx_spooler_agents_station (spooler_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Isolated statement. MUST fail closed if INSTANT is unavailable; never INPLACE/COPY.
ALTER TABLE print_queue
  MODIFY COLUMN status ENUM('pending','processing','sent','acknowledged','failed',
    'dead_letter','canceled','local_accepted','cancel_requested') NOT NULL DEFAULT 'pending',
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: nullable trailing columns (INSTANT-eligible).
ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS agent_id CHAR(36) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS accepted_at DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_failure_class ENUM('transient_safe','permanent_safe','uncertain') DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_hash CHAR(64) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS artifact_bytes INT UNSIGNED DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

-- Separate statement: index build (INPLACE is the proven-safe algorithm for ADD INDEX).
ALTER TABLE print_queue
  ADD KEY IF NOT EXISTS idx_print_queue_agent_claim (agent_id, status, locked_until, id),
  ALGORITHM=INPLACE, LOCK=NONE;
```

Design notes Luna must preserve: **no** foreign key from `print_queue.agent_id` to `spooler_agents` (hot never-delete table; agent rows are never deleted, only revoked — a dangling reference is impossible by policy, and FK DDL on `print_queue` cannot be INSTANT). `spooler_stations` is separate because station protocol must survive agent revocation/replacement; storing it on the active-agent row would silently re-enable V1 during replacement. The preflight (risk warrants one here) is a single SELECT returning `ok=1` only when the current `print_queue` status enum is exactly `'pending','processing','sent','acknowledged','failed','dead_letter','canceled'` in that order (read `information_schema.COLUMNS.COLUMN_TYPE`).

- [ ] **Step 3: Update `backend/tests/fixtures/seed.js`** — add `'spooler_agents'` and `'spooler_stations'` to the drop list (agents before stations, with the other printer tables, [seed.js:59](../../../backend/tests/fixtures/seed.js)); add CREATE statements identical to the baseline contract above; update the seeded `print_queue` CREATE to the new enum + columns + index.

- [ ] **Step 4: Update `deployment/database/baseline.sql`** — add the same CREATE statements for `spooler_stations` then `spooler_agents` next to `printers`/`print_queue`; extend the `print_queue` CREATE ([baseline.sql:697-728](../../../deployment/database/baseline.sql)) with the appended enum values, six new columns, and `idx_print_queue_agent_claim`.

- [ ] **Step 5: Update `backend/services/schemaValidation.js`** — following the exemplar commit's pattern, add REQUIRED_COUNTS keys and matching information_schema subqueries:

```text
spooler_stations_table: 1          (TABLES where TABLE_NAME='spooler_stations')
spooler_stations_columns: 5        (COLUMNS of spooler_stations)
spooler_agents_table: 1            (TABLES where TABLE_NAME='spooler_agents')
spooler_agents_columns: 13         (COLUMNS of spooler_agents excluding active_station_key)
spooler_agent_statuses: 1          (status enum is exactly active,draining,revoked,decommissioned in order)
spooler_agents_generated_column: 1 (active_station_key is STORED GENERATED with the active/draining CASE expression)
spooler_agents_generated_unique: 1 (STATISTICS where INDEX_NAME='uq_spooler_agents_active_station')
spooler_agents_indexes: 2          (exact unique active_station_key and nonunique spooler_id index definitions)
print_queue_v2_columns: 6          (COLUMNS agent_id, accepted_at, last_error_code, last_failure_class,
                                    artifact_hash, artifact_bytes)
print_queue_v2_statuses: 1         (COLUMNS where TABLE_NAME='print_queue' AND COLUMN_NAME='status'
                                    AND COLUMN_TYPE LIKE "%'canceled','local_accepted','cancel_requested')%")
```

Bump `print_queue_columns` from 20 to 26 and `print_queue_indexes` from 5 to 6. Do **not** change `MIGRATION_NAME`/`MIGRATION_CHECKSUM` at draft stage — that pin moves only when the approved migration enters the manifest (post-approval step, with Luna's computed checksum).

- [ ] **Step 6: Run the schema authority test** — RED first (before seed edits) is impractical here because seed and validation move together; instead prove the guard works by running once with `print_queue_v2_statuses: 1` while seed still has the old enum (expect FAIL), then complete Steps 3–4 and expect PASS:

```bash
npx vitest run backend/tests/unit/schemaAuthority.test.js
```

- [ ] **Step 7: Verify the draft migration on a scratch DB** (smallest relevant upgrade, per house workflow): create a scratch DB from the current baseline **minus** this change, apply Luna's draft file, assert the three required `print_queue` ALTERs plus the conditional Gate-0 printer ALTER (when authorized) succeed and `SHOW CREATE TABLE` matches the new baseline. Fail closed on any INSTANT refusal.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/2026-08-17-spooler-v2-agents-v1.sql backend/tests/fixtures/seed.js deployment/database/baseline.sql backend/services/schemaValidation.js backend/tests/unit/schemaAuthority.test.js
git commit -m "feat(spooler-v2): add station ownership, agent identity, and V2 queue states"
```

---

## Task 2 — Agent identity service + registration route

**Files:**
- Create: `backend/services/spoolerAgents.js`
- Create: `backend/routes/spoolerV2.js` (registration only in this task; sync added in Task 3)
- Modify: `server.js` (mount `/api/spooler/v2` next to the existing spooler mount)
- Create: `backend/tests/unit/spoolerAgentAuth.test.js`
- Create: `backend/tests/integration/spoolerV2Sync.test.js` (registration describe-block in this task)

**Interfaces — Produces:**
- `registerAgent(db, { agentId, spoolerId, tokenHash, name, agentVersion })` → `{ ok: true, status, stationProtocol }` | throws `{ statusCode, code }`; it atomically serializes against V1 claims, refuses an in-flight V1 station, and durably switches the station to V2.
- `prepareStationCutover(db, spoolerId)` → `{ stationProtocol, inFlight }`; it changes `v1` to `transitioning` under the same station-row lock used by V1 claims, so no new V1 work can start while the old agent drains.
- `authenticateAgent(db, { agentId, token })` → agent row (any status) or `null`
- `requireAgentAuth` Express middleware setting `req.agent`
- Route `POST /api/spooler/v2/register` guarded by the existing bootstrap `SPOOLER_KEY`

- [ ] **Step 1: Write the failing registration tests** in `backend/tests/integration/spoolerV2Sync.test.js`:

```js
const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const AGENT_RATE = '44444444-4444-4444-8444-444444444444';
const SECRET_A = 'secret-token-a';
const SECRET_B = 'secret-token-b';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function prepare(spoolerId) {
    return request(app)
        .post('/api/spooler/v2/prepare')
        .set('x-spooler-key', 'test-spooler-key')
        .send({ spooler_id: spoolerId });
}

async function register(agentId, spoolerId, secret, extra = {}) {
    await prepare(spoolerId);
    return request(app)
        .post('/api/spooler/v2/register')
        .set('x-spooler-key', 'test-spooler-key')
        .send({
            protocol_version: 2,
            agent_id: agentId,
            spooler_id: spoolerId,
            token_hash: hash(secret),
            name: 'Test Agent',
            agent_version: '2.0.0',
            ...extra
        });
}

function sync(agentId, secret, body = {}) {
    return request(app)
        .post('/api/spooler/v2/sync')
        .set('x-agent-id', agentId)
        .set('x-agent-token', secret)
        .send({ protocol_version: 2, accepted: [], results: [], health: {}, capacity: 1, ...body });
}

describe('spooler V2 registration', () => {
    beforeAll(async () => { process.env.SPOOLER_KEY = 'test-spooler-key'; await seedDatabase(); });
    afterAll(async () => { await pool.end(); });
    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
    });

    it('first registration activates one agent; repeat is idempotent', async () => {
        expect((await register(AGENT_A, 'station-1', SECRET_A)).status).toBe(201);
        const repeat = await register(AGENT_A, 'station-1', SECRET_A);
        expect(repeat.status).toBe(200);
        const [[row]] = await pool.query('SELECT status, token_hash FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(row.status).toBe('active');
        expect(row.token_hash).toBe(hash(SECRET_A));
    });

    it('a different agent cannot register onto an occupied station', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const second = await register(AGENT_B, 'station-1', SECRET_B);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('station_occupied');
    });

    it('registration atomically activates V2 and refuses a station with in-flight V1 work', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Busy', 'kitchen', 'windows', 'Busy', 'station-busy')"
        );
        const [queue] = await pool.query(
            `INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type,
                                      spooler_id, claimed_by)
             VALUES ('{}', 'sent', 'registration-busy', REPEAT('b', 64), ?, 'kitchen',
                     'station-busy', 'poll:station-busy')`,
            [printer.insertId]
        );
        const blocked = await register(AGENT_A, 'station-busy', SECRET_A);
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('station_busy');
        const [[blockedStation]] = await pool.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ?',
            ['station-busy']
        );
        expect(blockedStation.delivery_protocol).toBe('transitioning');
        await pool.query("UPDATE print_queue SET status = 'failed', claimed_by = NULL WHERE id = ?", [queue.insertId]);
        expect((await register(AGENT_A, 'station-busy', SECRET_A)).status).toBe(201);
        const [[station]] = await pool.query(
            'SELECT delivery_protocol, v2_activated_at FROM spooler_stations WHERE spooler_id = ?',
            ['station-busy']
        );
        expect(station.delivery_protocol).toBe('v2');
        expect(station.v2_activated_at).not.toBeNull();
    });

    it('an existing agent_id with a different token_hash is rejected', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        expect((await register(AGENT_A, 'station-1', SECRET_B)).status).toBe(401);
    });

    it('a bad bootstrap key or malformed identity never creates a row', async () => {
        const badKey = await request(app).post('/api/spooler/v2/register')
            .set('x-spooler-key', 'wrong-key')
            .send({ protocol_version: 2, agent_id: AGENT_A, spooler_id: 'station-1', token_hash: hash(SECRET_A) });
        expect(badKey.status).toBe(401);
        expect((await register('not-a-uuid', 'station-1', SECRET_A)).status).toBe(400);
        expect((await register(AGENT_A, 'bad id!', SECRET_A)).status).toBe(400);
        const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM spooler_agents');
        expect(Number(n)).toBe(0);
    });

});
```

And `backend/tests/unit/spoolerAgentAuth.test.js`:

```js
const { isValidAgentId, isValidStationId, isValidTokenHash, tokenMatchesHash } = require('../../services/spoolerAgents');

describe('spooler agent identity validation', () => {
    it('accepts a v4 UUID and rejects everything else', () => {
        expect(isValidAgentId('11111111-1111-4111-8111-111111111111')).toBe(true);
        expect(isValidAgentId('11111111111141118111111111111111')).toBe(false);
        expect(isValidAgentId('')).toBe(false);
    });
    it('station ids reuse the V1 spooler id grammar', () => {
        expect(isValidStationId('kitchen-2')).toBe(true);
        expect(isValidStationId('.leading-dot')).toBe(false);
        expect(isValidStationId('x'.repeat(97))).toBe(false);
    });
    it('token hashes are 64 lowercase hex chars and compare constant-time', () => {
        expect(isValidTokenHash('a'.repeat(64))).toBe(true);
        expect(isValidTokenHash('A'.repeat(64))).toBe(false);
        expect(tokenMatchesHash('secret-token-a',
            require('crypto').createHash('sha256').update('secret-token-a').digest('hex'))).toBe(true);
        expect(tokenMatchesHash('secret-token-b', 'a'.repeat(64))).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/unit/spoolerAgentAuth.test.js backend/tests/integration/spoolerV2Sync.test.js` — expect module-not-found / 404 failures.

- [ ] **Step 3: Implement `backend/services/spoolerAgents.js`:**

```js
const crypto = require('crypto');

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;   // same grammar as V1 (server.js io.use)
const HASH_RE = /^[0-9a-f]{64}$/;

const isValidAgentId = value => AGENT_ID_RE.test(String(value || ''));
const isValidStationId = value => STATION_RE.test(String(value || ''));
const isValidTokenHash = value => HASH_RE.test(String(value || ''));

function tokenMatchesHash(token, storedHash) {
    const actual = crypto.createHash('sha256').update(String(token || '')).digest();
    const expected = Buffer.from(String(storedHash || ''), 'hex');
    return expected.length === 32 && crypto.timingSafeEqual(actual, expected);
}

function httpError(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

async function prepareStationCutover(db, spoolerId) {
    if (!isValidStationId(spoolerId)) {
        throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            "INSERT IGNORE INTO spooler_stations (spooler_id, delivery_protocol) VALUES (?, 'v1')",
            [spoolerId]
        );
        const [[station]] = await conn.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        if (station.delivery_protocol === 'v1') {
            await conn.query(
                "UPDATE spooler_stations SET delivery_protocol = 'transitioning' WHERE spooler_id = ?",
                [spoolerId]
            );
        }
        const [[{ in_flight: inFlight }]] = await conn.query(
            `SELECT COUNT(*) AS in_flight FROM print_queue
              WHERE spooler_id = ? AND agent_id IS NULL AND status IN ('processing','sent')`,
            [spoolerId]
        );
        await conn.commit();
        return {
            stationProtocol: station.delivery_protocol === 'v2' ? 'v2' : 'transitioning',
            inFlight: Number(inFlight)
        };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

async function registerAgent(db, { agentId, spoolerId, tokenHash, name = '', agentVersion = null }) {
    if (!isValidAgentId(agentId) || !isValidStationId(spoolerId) || !isValidTokenHash(tokenHash)) {
        throw httpError(400, 'invalid_identity', 'A valid agent_id, spooler_id, and token_hash are required.');
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            "INSERT IGNORE INTO spooler_stations (spooler_id, delivery_protocol) VALUES (?, 'v1')",
            [spoolerId]
        );
        const [[station]] = await conn.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        const [[existing]] = await conn.query(
            'SELECT agent_id, spooler_id, token_hash, status FROM spooler_agents WHERE agent_id = ? FOR UPDATE',
            [agentId]
        );
        if (existing) {
            if (existing.token_hash !== tokenHash) throw httpError(401, 'token_mismatch', 'Unknown agent credentials.');
            if (existing.spooler_id !== spoolerId) throw httpError(409, 'station_mismatch', 'Agent is bound to another station.');
            await conn.commit();
            return { ok: true, created: false, status: existing.status, stationProtocol: station.delivery_protocol };
        }
        if (station.delivery_protocol === 'v1') {
            throw httpError(409, 'station_not_prepared', 'Prepare and drain the V1 station before registration.');
        }
        const [[{ in_flight: inFlight }]] = await conn.query(
            `SELECT COUNT(*) AS in_flight FROM print_queue
              WHERE spooler_id = ? AND agent_id IS NULL AND status IN ('processing','sent')`,
            [spoolerId]
        );
        if (Number(inFlight) > 0) {
            throw httpError(409, 'station_busy', 'V1 work is still in flight for this station.');
        }
        await conn.query(
            `INSERT INTO spooler_agents (agent_id, spooler_id, token_hash, name, agent_version)
             VALUES (?, ?, ?, ?, ?)`,
            [agentId, spoolerId, tokenHash, String(name).slice(0, 120), agentVersion ? String(agentVersion).slice(0, 40) : null]
        );
        await conn.query(
            "UPDATE spooler_stations SET delivery_protocol = 'v2', v2_activated_at = COALESCE(v2_activated_at, UTC_TIMESTAMP()) WHERE spooler_id = ?",
            [spoolerId]
        );
        await conn.commit();
        return { ok: true, created: true, status: 'active', stationProtocol: 'v2' };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'station_occupied', 'This station already has an active agent.');
        throw error;
    } finally {
        conn.release();
    }
}

async function authenticateAgent(db, { agentId, token }) {
    if (!isValidAgentId(agentId)) return null;
    const [[agent]] = await db.query(
        `SELECT a.agent_id, a.spooler_id, a.token_hash, a.status,
                s.delivery_protocol AS station_protocol
           FROM spooler_agents a
           JOIN spooler_stations s ON s.spooler_id = a.spooler_id
          WHERE a.agent_id = ?`,
        [agentId]
    );
    if (!agent || !tokenMatchesHash(token, agent.token_hash)) return null;
    return agent;
}

module.exports = {
    isValidAgentId, isValidStationId, isValidTokenHash, tokenMatchesHash,
    prepareStationCutover, registerAgent, authenticateAgent, httpError
};
```

- [ ] **Step 4: Implement `backend/routes/spoolerV2.js`** (registration + auth middleware; the sync handler body arrives in Task 3):

```js
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { prepareStationCutover, registerAgent, authenticateAgent } = require('../services/spoolerAgents');

function constantTimeEquals(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireBootstrapKey(req, res, next) {
    const configured = process.env.SPOOLER_KEY || '';
    if (!configured || !constantTimeEquals(req.get('x-spooler-key'), configured)) {
        return res.status(401).json({ success: false, code: 'bad_bootstrap_key' });
    }
    next();
}

// Authenticated-agent limiter. Never key a denial control from an unauthenticated header.
const syncRateLimits = new Map();
const SYNC_WINDOW_MS = 10000;
const SYNC_MAX = 40;
function agentRateLimit(req, res, next) {
    const key = `agent:${req.agent.agent_id}`;
    const now = Date.now();
    for (const [storedKey, stored] of syncRateLimits) {
        if (now - stored.start > SYNC_WINDOW_MS) syncRateLimits.delete(storedKey);
    }
    let entry = syncRateLimits.get(key);
    if (!entry || now - entry.start > SYNC_WINDOW_MS) {
        entry = { start: now, count: 0 };
        syncRateLimits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > SYNC_MAX) {
        return res.json({
            success: true,
            throttled: true,
            agent_status: req.agent.status,
            station_protocol: req.agent.station_protocol,
            confirmed_accepted: [],
            confirmed_results: [],
            cancel_requested: [],
            jobs: [],
            next_sync_ms: 5000
        });
    }
    next();
}

router.post('/prepare', requireBootstrapKey, async (req, res, next) => {
    try {
        const result = await prepareStationCutover(pool, req.body?.spooler_id);
        res.json({
            success: true,
            station_protocol: result.stationProtocol,
            in_flight: result.inFlight
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code });
        next(error);
    }
});

router.post('/register', requireBootstrapKey, async (req, res, next) => {
    try {
        const result = await registerAgent(pool, {
            agentId: req.body?.agent_id,
            spoolerId: req.body?.spooler_id,
            tokenHash: req.body?.token_hash,
            name: req.body?.name,
            agentVersion: req.body?.agent_version
        });
        res.status(result.created ? 201 : 200).json({
            success: true,
            status: result.status,
            station_protocol: result.stationProtocol
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code });
        next(error);
    }
});

async function requireAgentAuth(req, res, next) {
    try {
        const agent = await authenticateAgent(pool, {
            agentId: req.get('x-agent-id'),
            token: req.get('x-agent-token')
        });
        if (!agent) return res.status(401).json({ success: false, code: 'unauthorized_agent' });
        req.agent = agent;
        next();
    } catch (error) { next(error); }
}

module.exports = { router, requireAgentAuth, agentRateLimit };
```

Mount in `server.js` beside the existing spooler routes at current `server.js:655`:

```js
const spoolerV2Routes = require('./backend/routes/spoolerV2');
app.use('/api/spooler/v2', spoolerV2Routes.router);
```

- [ ] **Step 5: Run to green** (the sync-specific tests in the file stay red until Task 3 — run the registration describe-block plus the unit file):

```bash
npx vitest run backend/tests/unit/spoolerAgentAuth.test.js backend/tests/integration/spoolerV2Sync.test.js -t "registration"
```

- [ ] **Step 6: Server-phase checkpoint.** Run `git diff --check` and inspect only the Task 2 diff. Do not commit an architecture-changing half-protocol; Tasks 2–5 land together after the complete server flow and architecture map exist.

---

## Task 3 — The sync lifecycle (claim, accept, settle, replay, cancel)

**Files:**
- Create: `backend/services/spoolerSync.js`
- Modify: `backend/routes/spoolerV2.js` (add `POST /sync`)
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`

**Interfaces — Produces:** `runAgentSync(db, agent, { accepted, results, health, capacity })` → `{ agentStatus, stationProtocol, confirmedAccepted, confirmedResults, cancelRequested, jobs, nextSyncMs }`. V2 claimant string is `` `agent:${agent.agent_id}` ``. Result outcomes: `completed | permanent_failure | uncertain | canceled` (transient failures never leave the agent).

- [ ] **Step 1: Write the failing sync tests** (append to `spoolerV2Sync.test.js`; helper `insertJob` inserts a printer bound to the station and a pending queue row, following [spoolerSocketTransport.test.js:61-73](../../../backend/tests/integration/spoolerSocketTransport.test.js)):

```js
async function insertJob(spoolerId, key) {
    const [printer] = await pool.query(
        "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES (?, 'kitchen', 'windows', ?, ?)",
        [`P-${key}`, `W-${key}`, spoolerId]
    );
    const payload = { print_type: 'kitchen', printer_id: printer.insertId, printer_name: `P-${key}`, data: { print_batch_id: key } };
    const [queue] = await pool.query(
        "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', ?, REPEAT('a', 64), ?, 'kitchen')",
        [JSON.stringify(payload), key, printer.insertId]
    );
    return queue.insertId;
}

describe('spooler V2 sync lifecycle', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        await pool.query("DELETE FROM print_queue");
        await pool.query("DELETE FROM printer_categories");
        await pool.query("DELETE FROM printers");
    });

    it('authenticates with the raw secret, not its hash, and updates last_sync_at', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const res = await sync(AGENT_A, SECRET_A);
        expect(res.status).toBe(200);
        expect(res.body.agent_status).toBe('active');
        expect((await sync(AGENT_A, hash(SECRET_A))).status).toBe(401);
        expect((await sync(AGENT_A, 'wrong')).status).toBe(401);
        const [[row]] = await pool.query('SELECT last_sync_at FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(row.last_sync_at).not.toBeNull();
    });

    it('claims to sent, accepts to local_accepted, settles to acknowledged — all under agent claimant', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-happy');

        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(first.body.jobs.map(j => j.queue_id)).toEqual([queueId]);
        let [[row]] = await pool.query('SELECT status, claimed_by, agent_id FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('sent');
        expect(row.claimed_by).toBe(`agent:${AGENT_A}`);
        expect(row.agent_id).toBe(AGENT_A);

        const second = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        expect(second.body.confirmed_accepted).toEqual([queueId]);
        [[row]] = await pool.query('SELECT status, accepted_at, locked_until FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('local_accepted');
        expect(row.accepted_at).not.toBeNull();
        expect(row.locked_until).toBeNull();

        const third = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed', device_status: 'ok', duration_ms: 90,
                        artifact_hash: 'c'.repeat(64), artifact_bytes: 1024 }]
        });
        expect(third.body.confirmed_results).toEqual([queueId]);
        [[row]] = await pool.query('SELECT status, artifact_hash, artifact_bytes FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('acknowledged');
        expect(row.artifact_hash).toBe('c'.repeat(64));
        expect(Number(row.artifact_bytes)).toBe(1024);
    });

    it('replays an unaccepted sent row immediately — no lease wait, no duplicate claim', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-replay');
        await sync(AGENT_A, SECRET_A);                      // claims; response "lost" (agent reports nothing)
        const replay = await sync(AGENT_A, SECRET_A);       // immediately after — lease is nowhere near expired
        expect(replay.body.jobs.map(j => j.queue_id)).toEqual([queueId]);
        const [[row]] = await pool.query('SELECT attempts FROM print_queue WHERE id = ?', [queueId]);
        expect(Number(row.attempts)).toBe(1);               // replay is not a re-claim
    });

    it('two concurrent capacity-one syncs return at most one distinct job in total', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await insertJob('station-1', 'v2-conc-1');
        await insertJob('station-1', 'v2-conc-2');
        const [a, b] = await Promise.all([sync(AGENT_A, SECRET_A, { capacity: 1 }), sync(AGENT_A, SECRET_A, { capacity: 1 })]);
        const distinct = new Set([...a.body.jobs, ...b.body.jobs].map(j => j.queue_id));
        expect(distinct.size).toBe(1);
    });

    it('acceptance and result in one sync apply in order; repeated results are idempotent', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-one-shot');
        const first = await sync(AGENT_A, SECRET_A);
        const oneShot = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }],
            results: [{ queue_id: queueId, outcome: 'completed' }]
        });
        expect(oneShot.body.confirmed_accepted).toEqual([queueId]);
        expect(oneShot.body.confirmed_results).toEqual([queueId]);
        const resend = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }],   // acceptance replayed after terminal
            results: [{ queue_id: queueId, outcome: 'completed' }]
        });
        expect(resend.body.confirmed_accepted).toEqual([queueId]);  // idempotent even after terminal
        expect(resend.body.confirmed_results).toEqual([queueId]);   // confirmed, not re-applied
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('acknowledged');
    });

    it('never settles an unaccepted job or an unknown result outcome', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-invalid-result');
        await sync(AGENT_A, SECRET_A);
        const premature = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed' }]
        });
        expect(premature.body.confirmed_results).toEqual([]);
        const unknown = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'made_up_outcome' }]
        });
        expect(unknown.body.confirmed_results).toEqual([]);
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('sent');
    });

    it('cancel of a sent row stays ambiguous, is delivered via sync, and settles by agent outcome', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-cancel');
        await sync(AGENT_A, SECRET_A);                       // sent — response may have arrived
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        const outcome = await requestPrintJobCancellation(pool, queueId);
        expect(outcome).toBe('cancel_requested');            // NOT 'canceled': sent is outcome-ambiguous
        let [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('cancel_requested');

        const next = await sync(AGENT_A, SECRET_A);
        expect(next.body.cancel_requested).toEqual([queueId]);
        await sync(AGENT_A, SECRET_A, { results: [{ queue_id: queueId, outcome: 'canceled' }] });
        [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('canceled');

        const completedId = await insertJob('station-1', 'v2-cancel-but-completed');
        await sync(AGENT_A, SECRET_A);
        expect(await requestPrintJobCancellation(pool, completedId)).toBe('cancel_requested');
        await sync(AGENT_A, SECRET_A, { results: [{ queue_id: completedId, outcome: 'completed' }] });
        [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [completedId]);
        expect(row.status).toBe('acknowledged');   // true terminal outcome wins; never pretend it was canceled
    });

    it('cancel of a pending row is immediate; permanent_failure and uncertain dead-letter with class', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const pendingId = await insertJob('station-1', 'v2-cancel-pending');
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        expect(await requestPrintJobCancellation(pool, pendingId)).toBe('canceled');

        const failId = await insertJob('station-1', 'v2-perm');
        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: first.body.jobs.map(j => ({ queue_id: j.queue_id, payload_hash: j.payload_hash })),
            results: [{ queue_id: failId, outcome: 'permanent_failure', error_code: 'PRINTER_CONFIG_INVALID', failure_class: 'permanent_safe' }]
        });
        const [[row]] = await pool.query('SELECT status, last_failure_class FROM print_queue WHERE id = ?', [failId]);
        expect(row.status).toBe('dead_letter');
        expect(row.last_failure_class).toBe('permanent_safe');
    });

    it('a revoked agent gets agent_status revoked and zero jobs, not an HTTP error', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await insertJob('station-1', 'v2-revoked');
        await pool.query("UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE agent_id = ?", [AGENT_A]);
        const res = await sync(AGENT_A, SECRET_A);
        expect(res.status).toBe(200);
        expect(res.body.agent_status).toBe('revoked');
        expect(res.body.jobs).toEqual([]);
    });

    it('throttles an authenticated runaway agent in-band without manufacturing an auth failure', async () => {
        await register(AGENT_RATE, 'rate-station', 'rate-secret');
        let response;
        for (let i = 0; i < 41; i += 1) response = await sync(AGENT_RATE, 'rate-secret');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            throttled: true,
            agent_status: 'active',
            station_protocol: 'v2',
            jobs: [],
            next_sync_ms: 5000
        });
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/integration/spoolerV2Sync.test.js` — the new describe-block fails (no sync route/service).

- [ ] **Step 3: Implement `backend/services/spoolerSync.js`:**

```js
const V2_LEASE_SECONDS = 120;   // meaningful only before acceptance; replay ignores it
const V2_NEXT_SYNC_MS = 2000;
const TERMINAL = new Set(['acknowledged', 'dead_letter', 'canceled']);

const agentClaimant = agentId => `agent:${agentId}`;

async function requestPrintJobCancellation(db, queueId) {
    // Only pending work is provably still server-owned. Everything sent or beyond
    // is outcome-ambiguous and must wait for the owning agent's terminal result.
    const [immediate] = await db.query(
        "UPDATE print_queue SET status = 'canceled', last_seen_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'",
        [queueId]
    );
    if (immediate.affectedRows > 0) return 'canceled';
    const [requested] = await db.query(
        "UPDATE print_queue SET status = 'cancel_requested', last_seen_at = UTC_TIMESTAMP() WHERE id = ? AND status IN ('sent', 'local_accepted')",
        [queueId]
    );
    if (requested.affectedRows > 0) return 'cancel_requested';
    const [[row]] = await db.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
    return row ? row.status : null;
}

function settleUpdate(outcome, failureClass) {
    if (outcome === 'completed') return { status: 'acknowledged', acknowledged: true };
    if (outcome === 'canceled') return { status: 'canceled', requiresCancelRequested: true };
    if (outcome === 'permanent_failure') return { status: 'dead_letter', failureClass: failureClass || 'permanent_safe' };
    if (outcome === 'uncertain') return { status: 'dead_letter', failureClass: 'uncertain' };
    return null;
}

async function runAgentSync(db, agent, { accepted = [], results = [], health = {}, capacity = 0 } = {}) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        // 1. Global lock order is station row, then agent row, then queue rows.
        const [[station]] = await conn.query(
            'SELECT delivery_protocol, first_v2_accepted_at FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [agent.spooler_id]
        );
        const [[locked]] = await conn.query(
            'SELECT agent_id, spooler_id, status FROM spooler_agents WHERE agent_id = ? FOR UPDATE',
            [agent.agent_id]
        );
        const claimant = agentClaimant(locked.agent_id);
        const response = {
            agentStatus: locked.status,
            stationProtocol: station.delivery_protocol,
            confirmedAccepted: [], confirmedResults: [], cancelRequested: [], jobs: [],
            nextSyncMs: V2_NEXT_SYNC_MS
        };

        // 2. Acceptances: sent -> local_accepted (hash must match); cancel_requested keeps its status.
        for (const item of accepted) {
            const queueId = Number(item?.queue_id);
            if (!Number.isInteger(queueId) || queueId < 1) continue;
            const [moved] = await conn.query(
                `UPDATE print_queue SET status = 'local_accepted', accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP()), locked_until = NULL
                  WHERE id = ? AND agent_id = ? AND status = 'sent' AND (payload_hash IS NULL OR payload_hash = ?)`,
                [queueId, locked.agent_id, String(item?.payload_hash || '')]
            );
            if (moved.affectedRows > 0) {
                await conn.query(
                    'UPDATE spooler_stations SET first_v2_accepted_at = COALESCE(first_v2_accepted_at, UTC_TIMESTAMP()) WHERE spooler_id = ?',
                    [locked.spooler_id]
                );
                response.confirmedAccepted.push(queueId);
                continue;
            }
            const [[row]] = await conn.query('SELECT status, agent_id FROM print_queue WHERE id = ?', [queueId]);
            if (row && row.agent_id === locked.agent_id) {
                if (row.status === 'cancel_requested') {
                    await conn.query('UPDATE print_queue SET accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP()) WHERE id = ?', [queueId]);
                    response.confirmedAccepted.push(queueId);
                } else if (row.status === 'local_accepted' || TERMINAL.has(row.status)) {
                    response.confirmedAccepted.push(queueId);   // idempotent, including already-terminal
                }
            }
        }

        // 3. Results: idempotent settlement under the agent claimant.
        for (const item of results) {
            const queueId = Number(item?.queue_id);
            if (!Number.isInteger(queueId) || queueId < 1) continue;
            const [[row]] = await conn.query(
                'SELECT status, claimed_by FROM print_queue WHERE id = ? AND agent_id = ?',
                [queueId, locked.agent_id]
            );
            if (!row) continue;
            if (TERMINAL.has(row.status)) { response.confirmedResults.push(queueId); continue; }
            const plan = settleUpdate(String(item?.outcome || ''), item?.failure_class);
            if (!plan) continue;
            if (plan.requiresCancelRequested && row.status !== 'cancel_requested') continue;   // 'canceled' only answers a cancel request
            if (!plan.requiresCancelRequested && !['local_accepted','cancel_requested'].includes(row.status)) continue;
            const [settled] = await conn.query(
                `UPDATE print_queue SET status = ?, claimed_by = NULL, locked_until = NULL, next_retry_at = NULL,
                        acknowledged_at = CASE WHEN ? = 'acknowledged' THEN UTC_TIMESTAMP() ELSE acknowledged_at END,
                        last_error = ?, last_error_code = ?, last_failure_class = ?,
                        artifact_hash = ?, artifact_bytes = ?,
                        device_status = ?, duration_ms = ?, spooler_version = ?, last_seen_at = UTC_TIMESTAMP()
                  WHERE id = ? AND agent_id = ? AND status NOT IN ('acknowledged','dead_letter','canceled')`,
                [
                    plan.status, plan.status,
                    item?.error_code ? String(item.error_code).slice(0, 1000) : null,
                    item?.error_code ? String(item.error_code).slice(0, 64) : null,
                    plan.failureClass || null,
                    /^[0-9a-f]{64}$/.test(String(item?.artifact_hash || '')) ? String(item.artifact_hash) : null,
                    Number.isInteger(Number(item?.artifact_bytes)) && Number(item.artifact_bytes) >= 0 && Number(item.artifact_bytes) <= 16 * 1024 * 1024
                        ? Number(item.artifact_bytes) : null,
                    ['unknown','ok','offline','paper_low','paper_out','cover_open','jammed','error'].includes(item?.device_status) ? item.device_status : 'unknown',
                    Number.isFinite(Number(item?.duration_ms)) ? Math.max(0, Number(item.duration_ms)) : null,
                    health?.agent_version ? String(health.agent_version).slice(0, 64) : null,
                    queueId, locked.agent_id
                ]
            );
            if (settled.affectedRows > 0) response.confirmedResults.push(queueId);
        }

        if (locked.status === 'draining' && health?.drain_complete === true && Number(health?.local_queue_depth) === 0) {
            const [[{ unresolved }]] = await conn.query(
                `SELECT COUNT(*) AS unresolved FROM print_queue
                  WHERE agent_id = ? AND status IN ('processing','sent','local_accepted','cancel_requested')`,
                [locked.agent_id]
            );
            if (Number(unresolved) === 0) {
                await conn.query(
                    "UPDATE spooler_agents SET status = 'decommissioned' WHERE agent_id = ? AND status = 'draining'",
                    [locked.agent_id]
                );
                await conn.query(
                    `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value)
                     VALUES ('spooler_agent_decommissioned', NULL, 'spooler_agent', NULL, ?, ?)`,
                    [
                        JSON.stringify({ agent_id: locked.agent_id, spooler_id: locked.spooler_id, status: 'draining' }),
                        JSON.stringify({ agent_id: locked.agent_id, spooler_id: locked.spooler_id, status: 'decommissioned' })
                    ]
                );
                response.agentStatus = 'decommissioned';
            }
        }

        if (locked.status === 'active' && station.delivery_protocol === 'v2') {
            // 4. Cancel deliveries, then replay of unaccepted sent rows.
            const [cancels] = await conn.query(
                "SELECT id FROM print_queue WHERE agent_id = ? AND status = 'cancel_requested' ORDER BY id ASC",
                [locked.agent_id]
            );
            response.cancelRequested = cancels.map(row => row.id);

            const [replayRows] = await conn.query(
                `SELECT q.id, q.payload, q.idempotency_key, q.payload_hash, q.printer_id, q.print_type
                   FROM print_queue q WHERE q.agent_id = ? AND q.status = 'sent' ORDER BY q.id ASC`,
                [locked.agent_id]
            );

            // 5. Claim only the remaining capacity for this station's printers.
            const remaining = Math.max(0, Math.min(Number(capacity) || 0, 50) - replayRows.length);
            let claimedRows = [];
            if (remaining > 0) {
                const [rows] = await conn.query(
                    `SELECT q.id, q.payload, q.idempotency_key, q.payload_hash, q.printer_id, q.print_type
                       FROM print_queue q JOIN printers p ON p.id = q.printer_id AND p.is_active = 1
                      WHERE p.spooler_id = ? AND q.agent_id IS NULL AND (
                            q.status = 'pending'
                            OR (q.status = 'failed' AND (q.next_retry_at IS NULL OR q.next_retry_at <= UTC_TIMESTAMP()))
                      ) ORDER BY q.id ASC LIMIT ? FOR UPDATE`,
                    [locked.spooler_id, remaining]
                );
                if (rows.length > 0) {
                    await conn.query(
                        `UPDATE print_queue SET status = 'sent', claimed_by = ?, agent_id = ?, spooler_id = ?,
                                locked_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
                                attempts = COALESCE(attempts, 0) + 1,
                                first_attempt_at = COALESCE(first_attempt_at, UTC_TIMESTAMP()),
                                sent_at = COALESCE(sent_at, UTC_TIMESTAMP()), last_seen_at = UTC_TIMESTAMP()
                          WHERE id IN (?)`,
                        [claimant, locked.agent_id, locked.spooler_id, V2_LEASE_SECONDS, rows.map(row => row.id)]
                    );
                    claimedRows = rows;
                }
            }
            response.jobs = [...replayRows, ...claimedRows].map(parseQueueRow);
        }

        const localQueueDepth = Number(health?.local_queue_depth);
        const boundedLocalQueueDepth = Number.isInteger(localQueueDepth) && localQueueDepth >= 0 && localQueueDepth <= 10000
            ? localQueueDepth : null;
        const oldestJobAgeMs = Number(health?.oldest_local_job_age_ms);
        const summary = JSON.stringify({
            renderer: ['ready','starting','degraded','failed','paused'].includes(health?.renderer) ? health.renderer : 'unknown',
            helper: ['ready','starting','degraded','failed','paused'].includes(health?.helper) ? health.helper : 'unknown',
            oldest_local_job_age_ms: Number.isInteger(oldestJobAgeMs) && oldestJobAgeMs >= 0 && oldestJobAgeMs <= 31536000000
                ? oldestJobAgeMs : null
        });
        await conn.query(
            'UPDATE spooler_agents SET last_sync_at = UTC_TIMESTAMP(), local_queue_depth = ?, health_summary = ? WHERE agent_id = ?',
            [
                boundedLocalQueueDepth,
                summary,
                locked.agent_id
            ]
        );
        await conn.commit();
        return response;
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

function parseQueueRow(row) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return { ...payload, queue_id: row.id, idempotency_key: row.idempotency_key || payload.idempotency_key, payload_hash: row.payload_hash ?? null };
}

module.exports = { runAgentSync, requestPrintJobCancellation, agentClaimant };
```

`backend/services/printQueue.js:26` keeps `parsePayload` private; use `parseQueueRow` above and do not add a speculative import.

- [ ] **Step 4: Add the sync route** to `backend/routes/spoolerV2.js`:

```js
const { runAgentSync } = require('../services/spoolerSync');

router.post('/sync', requireAgentAuth, agentRateLimit, async (req, res, next) => {
    try {
        const result = await runAgentSync(pool, req.agent, {
            accepted: Array.isArray(req.body?.accepted) ? req.body.accepted : [],
            results: Array.isArray(req.body?.results) ? req.body.results : [],
            health: req.body?.health || {},
            capacity: req.body?.capacity
        });
        res.json({
            success: true,
            agent_status: result.agentStatus,
            station_protocol: result.stationProtocol,
            confirmed_accepted: result.confirmedAccepted,
            confirmed_results: result.confirmedResults,
            cancel_requested: result.cancelRequested,
            jobs: result.jobs,
            next_sync_ms: result.nextSyncMs
        });
    } catch (error) { next(error); }
});
```

- [ ] **Step 5: Run to green** — `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerAgentAuth.test.js`

- [ ] **Step 6: Server-phase checkpoint.** Run `git diff --check`; do not commit until the V1 gate, replacement lifecycle, and architecture update in Task 5 are complete.

---

## Task 4 — V1 station gate + status-surface compatibility

**Files:**
- Modify: `backend/services/printQueue.js` (`claimPrintJobs`)
- Modify: `backend/routes/admin/printQueue.js` (status list, [line 15](../../../backend/routes/admin/printQueue.js))
- Modify: `backend/services/printQueueWatchdog.js:1` (`WATCHED_STATES`)
- Create: `backend/tests/integration/spoolerV2Compatibility.test.js`

**Interfaces — Consumes:** Task 1 schema, Task 2 registration. **Produces:** V1 delivery fully disabled for every station whose durable `spooler_stations.delivery_protocol` is `v2`, regardless of active-agent replacement state, everywhere V1 claims (socket connect `processPendingQueue`, 30 s dispatcher, HTTP `/api/spooler/poll`) — all three route through `claimPrintJobs`.

- [ ] **Step 1: Write the failing compatibility tests:**

```js
const request = require('supertest');
const crypto = require('crypto');
const { io: createClient } = require('socket.io-client');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { claimPrintJobs } = require('../../services/printQueue');

const AGENT = '33333333-3333-4333-8333-333333333333';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('V2 station ownership disables V1 delivery', () => {
    let baseUrl;
    beforeAll(async () => {
        process.env.SPOOLER_KEY = 'test-spooler-key';
        await seedDatabase();
        if (!server.listening) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        await new Promise(resolve => io.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
    });

    async function seedStation(spoolerId, key) {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES (?, 'kitchen', 'windows', ?, ?)",
            [`P-${key}`, `W-${key}`, spoolerId]
        );
        const payload = { print_type: 'kitchen', printer_id: printer.insertId, printer_name: `P-${key}`, data: { print_batch_id: key } };
        const [queue] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', ?, REPEAT('b', 64), ?, 'kitchen')",
            [JSON.stringify(payload), key, printer.insertId]
        );
        return queue.insertId;
    }

    it('V1 socket and poll get nothing for a V2 station; a V1-only station is unaffected', async () => {
        await pool.query(
            'INSERT INTO spooler_agents (agent_id, spooler_id, token_hash) VALUES (?, ?, ?)',
            [AGENT, 'v2-station', hash('s')]
        );
        await pool.query(
            "INSERT INTO spooler_stations (spooler_id, delivery_protocol, v2_activated_at) VALUES ('v2-station', 'v2', UTC_TIMESTAMP())"
        );
        await seedStation('v2-station', 'gate-v2');
        const v1QueueId = await seedStation('v1-station', 'gate-v1');

        // Service level: the shared claim function is the single gate.
        expect(await claimPrintJobs(pool, { spoolerId: 'v2-station', claimantId: 'poll:v2-station' })).toEqual([]);
        expect((await claimPrintJobs(pool, { spoolerId: 'v1-station', claimantId: 'poll:v1-station' })).map(j => j.queue_id)).toEqual([v1QueueId]);

        // HTTP poll level.
        const poll = await request(app).post('/api/spooler/poll')
            .set('x-spooler-key', 'test-spooler-key')
            .send({ spooler_id: 'v2-station', limit: 10 });
        expect(poll.status).toBe(200);
        expect(poll.body.jobs).toEqual([]);

        // Socket level: a V1 client for the V2 station connects but is never fed.
        const client = createClient(baseUrl, {
            transports: ['websocket'], reconnection: false,
            auth: { type: 'spooler', spooler_key: 'test-spooler-key', spooler_id: 'v2-station', spooler_name: 'Old', spooler_version: '1.2.8' }
        });
        let delivered = false;
        client.on('print_job', () => { delivered = true; });
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('connect_error', reject);
        });
        await wait(400);
        client.disconnect();
        expect(delivered).toBe(false);

        // A revoked V2 agent must NOT re-enable V1; station protocol survives agent lifecycle.
        await pool.query("UPDATE spooler_agents SET status = 'revoked' WHERE agent_id = ?", [AGENT]);
        expect(await claimPrintJobs(pool, { spoolerId: 'v2-station', claimantId: 'poll:v2-station' })).toEqual([]);
    });
});
```

The last assertion pins the durable cutover rule: agent revocation/replacement never changes station protocol. The only V1 rollback is the explicit, audited pre-first-acceptance rollback in Task 5.

- [ ] **Step 2: Run to verify failure** — the service-level assertion fails (V1 claim still returns the V2 station's job).

- [ ] **Step 3: Implement the gate** in `claimPrintJobs` immediately after `beginTransaction()` and before selecting queue rows. Registration and V1 claiming must lock the same station row, so either the last V1 claim commits first and registration sees it as in-flight, or registration commits V2 first and the V1 claim returns no jobs:

```js
await conn.query(
    "INSERT IGNORE INTO spooler_stations (spooler_id, delivery_protocol) VALUES (?, 'v1')",
    [spoolerId]
);
const [[station]] = await conn.query(
    'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
    [spoolerId]
);
if (station.delivery_protocol !== 'v1') {
    await conn.commit();
    return [];
}
```

The existing claim query keeps parameter order `[spoolerId, limit]`. This single station-row lock gates all three V1 delivery paths because `processPendingQueue` (`server.js`), `dispatchClaimedPrintJobs` (`printDispatch.js`) and `/api/spooler/poll` (`routes/spooler.js`) all call `claimPrintJobs`.

- [ ] **Step 4: Add the two appended statuses to the V1-visible surfaces** — `backend/routes/admin/printQueue.js:15` gains `'local_accepted', 'cancel_requested'` in its `WHERE status IN (…)` list; grep `printQueueWatchdog.js` for its status enumeration and add both there with the semantics: `local_accepted`/`cancel_requested` count as in-flight (not stuck) while younger than 10 minutes, like `sent`.

- [ ] **Step 5: Run to green** — `npx vitest run backend/tests/integration/spoolerV2Compatibility.test.js`, then the neighbors that exercise V1 claims: `npx vitest run backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js`

- [ ] **Step 6: Server-phase checkpoint.** Run `git diff --check`; keep this uncommitted with Tasks 2–3 until Task 5 maps and commits the complete server authority change.

---

## Task 5 — Honest replacement and revocation

**Files:**
- Modify: `backend/services/spoolerAgents.js` (add `replaceAgent`)
- Modify: `backend/routes/admin/printers.js` (admin endpoint; requireAdmin is already the router's guard — follow the file's existing route pattern)
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces — Produces:** `requestAgentDrain(db, { spoolerId, actorUserId })` -> `{ agentId, status: 'draining' }`; `replaceAgent(db, { spoolerId, force, actorUserId })` → `{ revokedAgentId, terminalizedCount }` | throws `httpError(409, 'agent_reachable' | 'no_active_agent')`; `rollbackStationToV1(db, { spoolerId, actorUserId })` succeeds only before the first V2 acceptance and with no unresolved V2 rows. Routes: `POST /api/admin/printers/spooler-agents/:spoolerId/drain`, forced `/replace`, and guarded `/rollback-v1`.

Scope note: this task delivers refuse-while-reachable plus the forced path with atomic audit. The graceful drain of rev 2.1 §1.5 (old agent enters `decommissioned` and confirms an empty journal through sync) requires agent cooperation; Tasks 8 and 12 consume the `decommissioned` state and server hooks shipped here.

- [ ] **Step 1: Write the failing tests** (append to `spoolerV2Sync.test.js`):

```js
describe('spooler V2 replacement', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
    });

    it('forced replacement revokes the old agent and terminalizes every unresolved row as outcome-unknown', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const sentId = await insertJob('station-1', 'rep-sent');
        const acceptedId = await insertJob('station-1', 'rep-accepted');
        const cancelId = await insertJob('station-1', 'rep-cancel');
        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(first.body.jobs).toHaveLength(3);
        await sync(AGENT_A, SECRET_A, { accepted: [
            { queue_id: acceptedId, payload_hash: first.body.jobs.find(j => j.queue_id === acceptedId).payload_hash },
            { queue_id: cancelId, payload_hash: first.body.jobs.find(j => j.queue_id === cancelId).payload_hash }
        ] });
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        await requestPrintJobCancellation(pool, cancelId);

        const { replaceAgent } = require('../../services/spoolerAgents');
        const result = await replaceAgent(pool, { spoolerId: 'station-1', force: true, actorUserId: 1 });
        expect(result.revokedAgentId).toBe(AGENT_A);
        expect(result.terminalizedCount).toBe(3);

        // Atomic-audit policy: the replacement is audited in the same transaction.
        const [[audit]] = await pool.query(
            "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'spooler_agent_replaced' AND entity_type = 'spooler_agent'"
        );
        expect(Number(audit.n)).toBe(1);

        const [rows] = await pool.query(
            'SELECT id, status, last_error_code FROM print_queue WHERE id IN (?) ORDER BY id',
            [[sentId, acceptedId, cancelId]]
        );
        for (const row of rows) {
            expect(row.status).toBe('dead_letter');
            expect(row.last_error_code).toBe('AGENT_REPLACED_OUTCOME_UNKNOWN');
        }

        // The old agent still authenticates but is told it is revoked and gets nothing.
        const res = await sync(AGENT_A, SECRET_A);
        expect(res.body.agent_status).toBe('revoked');
        expect(res.body.jobs).toEqual([]);

        // The replacement registers cleanly and NEVER receives the old rows.
        expect((await register(AGENT_B, 'station-1', SECRET_B)).status).toBe(201);
        const fresh = await sync(AGENT_B, SECRET_B, { capacity: 10 });
        expect(fresh.body.jobs).toEqual([]);
        expect(fresh.body.cancel_requested).toEqual([]);
    });

    it('replacement without force fails while the old agent synced recently', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await sync(AGENT_A, SECRET_A);
        const { replaceAgent } = require('../../services/spoolerAgents');
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: false }))
            .rejects.toMatchObject({ statusCode: 409, code: 'agent_reachable' });
    });

    it('a stale active or draining agent still requires explicit forced-replacement confirmation', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await pool.query(
            "UPDATE spooler_agents SET status = 'draining', last_sync_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE agent_id = ?",
            [AGENT_A]
        );
        const { replaceAgent } = require('../../services/spoolerAgents');
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: false }))
            .rejects.toMatchObject({ statusCode: 409, code: 'force_required' });
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: true, actorUserId: 1 }))
            .resolves.toMatchObject({ revokedAgentId: AGENT_A });
    });

    it('normal replacement drains without accepting new work, then decommissions safely', async () => {
        await register(AGENT_A, 'drain-station', SECRET_A);
        const queueId = await insertJob('drain-station', 'drain-one');
        const first = await sync(AGENT_A, SECRET_A);
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        const { requestAgentDrain } = require('../../services/spoolerAgents');
        expect(await requestAgentDrain(pool, { spoolerId: 'drain-station', actorUserId: 1 }))
            .toMatchObject({ agentId: AGENT_A, status: 'draining' });
        const drained = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed' }],
            health: { local_queue_depth: 0, drain_complete: true },
            capacity: 10
        });
        expect(drained.body.jobs).toEqual([]);
        expect(drained.body.agent_status).toBe('decommissioned');
        const [[decommissionAudit]] = await pool.query(
            "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'spooler_agent_decommissioned'"
        );
        expect(Number(decommissionAudit.n)).toBe(1);
        expect((await register(AGENT_B, 'drain-station', SECRET_B)).status).toBe(201);
    });

    it('rolls back to V1 only before first V2 acceptance', async () => {
        await register(AGENT_A, 'rollback-safe', SECRET_A);
        const { rollbackStationToV1 } = require('../../services/spoolerAgents');
        await expect(rollbackStationToV1(pool, { spoolerId: 'rollback-safe', actorUserId: 1 }))
            .resolves.toMatchObject({ stationProtocol: 'v1' });
        let [[station]] = await pool.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ?', ['rollback-safe']
        );
        expect(station.delivery_protocol).toBe('v1');
        const [[rolledBackAgent]] = await pool.query('SELECT status FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(rolledBackAgent.status).toBe('revoked');

        await register(AGENT_B, 'rollback-locked', SECRET_B);
        const queueId = await insertJob('rollback-locked', 'rollback-accepted');
        const first = await sync(AGENT_B, SECRET_B);
        await sync(AGENT_B, SECRET_B, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        await expect(rollbackStationToV1(pool, { spoolerId: 'rollback-locked', actorUserId: 1 }))
            .rejects.toMatchObject({ statusCode: 409, code: 'v2_rollback_locked' });
        [[station]] = await pool.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ?', ['rollback-locked']
        );
        expect(station.delivery_protocol).toBe('v2');
    });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `replaceAgent`** in `spoolerAgents.js`:

```js
const REACHABLE_WINDOW_SECONDS = 30;   // ~15 sync intervals; a live agent syncs every 2-5 s

async function requestAgentDrain(db, { spoolerId, actorUserId = null }) {
    if (!isValidStationId(spoolerId)) throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[station]] = await conn.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ? FOR UPDATE', [spoolerId]
        );
        if (!station || station.delivery_protocol !== 'v2') throw httpError(409, 'station_not_v2', 'This station is not owned by V2.');
        const [[agent]] = await conn.query(
            "SELECT agent_id FROM spooler_agents WHERE spooler_id = ? AND status = 'active' FOR UPDATE", [spoolerId]
        );
        if (!agent) throw httpError(409, 'no_active_agent', 'This station has no active agent.');
        await conn.query("UPDATE spooler_agents SET status = 'draining' WHERE agent_id = ?", [agent.agent_id]);
        await conn.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value)
             VALUES ('spooler_agent_drain_requested', ?, 'spooler_agent', NULL, ?, ?)`,
            [actorUserId ?? null, JSON.stringify({ agent_id: agent.agent_id, status: 'active' }), JSON.stringify({ agent_id: agent.agent_id, status: 'draining' })]
        );
        await conn.commit();
        return { agentId: agent.agent_id, status: 'draining' };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

async function replaceAgent(db, { spoolerId, force = false, actorUserId = null }) {
    if (!isValidStationId(spoolerId)) throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[station]] = await conn.query(
            'SELECT delivery_protocol FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        if (!station || station.delivery_protocol !== 'v2') {
            throw httpError(409, 'station_not_v2', 'This station is not owned by V2.');
        }
        const [[agent]] = await conn.query(
            `SELECT agent_id, status, last_sync_at FROM spooler_agents
              WHERE spooler_id = ? AND status IN ('active','draining') FOR UPDATE`,
            [spoolerId]
        );
        if (!agent) throw httpError(409, 'no_active_agent', 'This station has no active agent.');
        const [[{ recent }]] = await conn.query(
            'SELECT (last_sync_at IS NOT NULL AND last_sync_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)) AS recent FROM spooler_agents WHERE agent_id = ?',
            [REACHABLE_WINDOW_SECONDS, agent.agent_id]
        );
        if (!force) {
            if (Number(recent) === 1) {
                throw httpError(409, 'agent_reachable', 'The current agent is reachable; use the drain flow.');
            }
            throw httpError(409, 'force_required', 'The current agent is unreachable; confirm that the old terminal is stopped before forced replacement.');
        }
        await conn.query(
            "UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE agent_id = ?",
            [agent.agent_id]
        );
        const [terminalized] = await conn.query(
            `UPDATE print_queue SET status = 'dead_letter', claimed_by = NULL, locked_until = NULL, next_retry_at = NULL,
                    last_error = 'Agent replaced; outcome unknown. Resolve by audited manual reprint or cancel.',
                    last_error_code = 'AGENT_REPLACED_OUTCOME_UNKNOWN',
                    last_failure_class = 'uncertain', last_seen_at = UTC_TIMESTAMP()
              WHERE agent_id = ? AND status IN ('processing', 'sent', 'local_accepted', 'cancel_requested')`,
            [agent.agent_id]
        );
        // Atomic-audit policy: destructive lifecycle changes audit in-transaction and roll back on failure
        // (column set per backend/services/auditEvents.js:141-143; entity_id is BIGINT, so the
        // CHAR(36) agent_id travels in the JSON values and entity_id stays NULL).
        await conn.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value)
             VALUES ('spooler_agent_replaced', ?, 'spooler_agent', NULL, ?, ?)`,
            [
                actorUserId ?? null,
                JSON.stringify({ status: agent.status, spooler_id: spoolerId, agent_id: agent.agent_id }),
                JSON.stringify({ status: 'revoked', agent_id: agent.agent_id, forced: Boolean(force), terminalized: terminalized.affectedRows })
            ]
        );
        await conn.commit();
        return { revokedAgentId: agent.agent_id, terminalizedCount: terminalized.affectedRows };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

async function rollbackStationToV1(db, { spoolerId, actorUserId = null }) {
    if (!isValidStationId(spoolerId)) throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[station]] = await conn.query(
            'SELECT delivery_protocol, first_v2_accepted_at FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        if (!station || station.delivery_protocol === 'v1') {
            await conn.commit();
            return { stationProtocol: 'v1', revokedAgentId: null };
        }
        const [[agent]] = await conn.query(
            "SELECT agent_id FROM spooler_agents WHERE spooler_id = ? AND status IN ('active','draining') FOR UPDATE",
            [spoolerId]
        );
        const [[{ unresolved }]] = await conn.query(
            `SELECT COUNT(*) AS unresolved FROM print_queue
              WHERE spooler_id = ? AND agent_id IS NOT NULL
                AND status IN ('processing','sent','local_accepted','cancel_requested')`,
            [spoolerId]
        );
        if (station.first_v2_accepted_at || Number(unresolved) > 0) {
            throw httpError(409, 'v2_rollback_locked', 'V2 accepted work; rollback must restore V2 or remain paused.');
        }
        if (agent) {
            await conn.query(
                "UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE agent_id = ?",
                [agent.agent_id]
            );
        }
        await conn.query(
            "UPDATE spooler_stations SET delivery_protocol = 'v1', v2_activated_at = NULL WHERE spooler_id = ?",
            [spoolerId]
        );
        await conn.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value)
             VALUES ('spooler_station_rolled_back_v1', ?, 'spooler_station', NULL, ?, ?)`,
            [
                actorUserId ?? null,
                JSON.stringify({ spooler_id: spoolerId, delivery_protocol: station.delivery_protocol }),
                JSON.stringify({ spooler_id: spoolerId, delivery_protocol: 'v1', revoked_agent_id: agent?.agent_id || null })
            ]
        );
        await conn.commit();
        return { stationProtocol: 'v1', revokedAgentId: agent?.agent_id || null };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}
```

Export all three functions, and insert these complete admin routes before `backend/routes/admin/printers.js:207`:

```js
const { requestAgentDrain, replaceAgent, rollbackStationToV1 } = require('../../services/spoolerAgents');

router.post('/spooler-agents/:spoolerId/drain', async (req, res, next) => {
    try {
        const result = await requestAgentDrain(require('../../config/db'), {
            spoolerId: req.params.spoolerId,
            actorUserId: req.user?.id ?? null
        });
        res.json({ success: true, agent_id: result.agentId, status: result.status });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
        next(error);
    }
});

router.post('/spooler-agents/:spoolerId/replace', async (req, res, next) => {
    try {
        if (req.body?.force === true && req.body?.confirm_old_terminal_stopped !== true) {
            return res.status(400).json({ success: false, code: 'confirmation_required',
                message: 'Forced replacement requires confirming the old terminal is stopped; its outcome-unknown jobs need manual resolution.' });
        }
        const result = await replaceAgent(require('../../config/db'), {
            spoolerId: req.params.spoolerId,
            force: req.body?.force === true,
            actorUserId: req.user?.id ?? null
        });
        res.json({ success: true, revoked_agent_id: result.revokedAgentId, terminalized_count: result.terminalizedCount });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
        next(error);
    }
});

router.post('/spooler-agents/:spoolerId/rollback-v1', async (req, res, next) => {
    try {
        if (req.body?.confirm_no_v2_paper !== true) {
            return res.status(400).json({ success: false, code: 'confirmation_required' });
        }
        const result = await rollbackStationToV1(require('../../config/db'), {
            spoolerId: req.params.spoolerId,
            actorUserId: req.user?.id ?? null
        });
        res.json({ success: true, station_protocol: result.stationProtocol, revoked_agent_id: result.revokedAgentId });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
        next(error);
    }
});
```

The dead-lettered rows are recoverable through the existing manual reprint path (reprint accepts `acknowledged`/`dead_letter` sources — that flow and its audit already exist).

- [ ] **Step 4: Run to green** — `npx vitest run backend/tests/integration/spoolerV2Sync.test.js`

- [ ] **Step 5: Map the complete server phase.** Add nodes for `backend/routes/spoolerV2.js`, `backend/services/spoolerAgents.js`, and `backend/services/spoolerSync.js`; trace prepare → register → sync claim → local acceptance → settlement/cancellation → drain/forced replacement; map the V1 gate in `claimPrintJobs`; and add the durable-station/no-dual-delivery invariant with implemented `file:line` references. Run:

```bash
npm run architecture
npm run architecture:check
```

- [ ] **Step 6: Commit the complete server protocol phase**

```bash
git add backend/services/spoolerAgents.js backend/services/spoolerSync.js backend/services/printQueue.js backend/services/printQueueWatchdog.js backend/routes/spoolerV2.js backend/routes/admin/printers.js backend/routes/admin/printQueue.js server.js backend/tests/unit/spoolerAgentAuth.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Compatibility.test.js docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): durable pull protocol, station gate, and honest replacement"
```

---

## Task 6 — Server-foundation verification, load evidence, and architecture map

**Files:**
- Create: `backend/tests/manual/spoolerV2LoadHarness.js`
- Create: `docs/superpowers/evidence/2026-08-17-spooler-v2-sync-load.md`

- [ ] **Step 1: Focused end-to-end run** (one vitest process):

```bash
npx vitest run backend/tests/unit/spoolerAgentAuth.test.js backend/tests/unit/spoolerRegistry.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Compatibility.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js
```

- [ ] **Step 2: Recheck the architecture committed with Task 5:**

```bash
npm run architecture:check
```

- [ ] **Step 3: Measure the sync load budget** (rev 2.1 §1.4). Create `backend/tests/manual/spoolerV2LoadHarness.js` (manual script, not part of the vitest suite):

```js
// Usage: node backend/tests/manual/spoolerV2LoadHarness.js <agentCount> <seconds>
// Destructive to the disposable .env.test database only; never point .env.test at customer data.
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { seedDatabase } = require('../fixtures/seed');
const agents = Number(process.argv[2] || 5);
const seconds = Number(process.argv[3] || 60);
const latencies = [];

function listen(server) {
    return new Promise((resolve, reject) => {
        const failed = error => reject(error);
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', failed);
            resolve();
        });
    });
}

async function postJson(base, path, headers, body) {
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    if (response.status >= 300) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`);
    return response.status;
}

async function main() {
    if (!Number.isInteger(agents) || agents < 1 || !Number.isFinite(seconds) || seconds < 1) {
        throw new Error('agentCount and seconds must be positive numbers.');
    }
    if (!String(process.env.DB_NAME || '').endsWith('_test')) {
        throw new Error('Refusing to seed: .env.test DB_NAME must end with _test.');
    }
    await seedDatabase();
    const key = process.env.SPOOLER_KEY;
    if (!key) throw new Error('SPOOLER_KEY must exist in .env.test.');
    const pool = require('../../config/db');
    const { server, io } = require('../../../server');

    let eventLoop;
    let onAcquire;
    let onRelease;
    try {
        await listen(server);
        const base = `http://127.0.0.1:${server.address().port}`;
        const runId = crypto.randomBytes(6).toString('hex');
        const ids = [];
        for (let i = 0; i < agents; i++) {
            const agentId = crypto.randomUUID();
            const secret = crypto.randomBytes(24).toString('hex');
            const spoolerId = `load-${runId}-${i}`;
            await postJson(base, '/api/spooler/v2/prepare', { 'x-spooler-key': key }, { spooler_id: spoolerId });
            await postJson(base, '/api/spooler/v2/register', { 'x-spooler-key': key }, {
                protocol_version: 2,
                agent_id: agentId,
                spooler_id: spoolerId,
                token_hash: crypto.createHash('sha256').update(secret).digest('hex'),
                name: `Load ${i}`
            });
            ids.push({ agentId, secret });
        }

        let inUse = 0;
        let peakInUse = 0;
        onAcquire = () => { inUse += 1; peakInUse = Math.max(peakInUse, inUse); };
        onRelease = () => { inUse -= 1; };
        pool.on('acquire', onAcquire);
        pool.on('release', onRelease);
        eventLoop = monitorEventLoopDelay({ resolution: 20 });
        eventLoop.enable();
        const before = pool.connectionTelemetrySnapshot();
        const workloadStarted = performance.now();
        const deadline = Date.now() + seconds * 1000;

        await Promise.all(ids.map(async ({ agentId, secret }, index) => {
            await new Promise(resolve => setTimeout(resolve, (index * 400) % 2000));
            while (Date.now() < deadline) {
                const started = performance.now();
                await postJson(base, '/api/spooler/v2/sync', {
                    'x-agent-id': agentId,
                    'x-agent-token': secret
                }, { protocol_version: 2, accepted: [], results: [], health: {}, capacity: 1 });
                latencies.push(performance.now() - started);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }));

        eventLoop.disable();
        const elapsedSeconds = (performance.now() - workloadStarted) / 1000;
        const after = pool.connectionTelemetrySnapshot();
        const delta = Object.fromEntries(Object.keys(after).map(name => [name, after[name] - before[name]]));
        latencies.sort((a, b) => a - b);
        const percentile = q => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * q))]);
        console.log(JSON.stringify({
            agents,
            seconds,
            syncs: latencies.length,
            request_rate_per_second: Number((latencies.length / elapsedSeconds).toFixed(2)),
            p50_ms: percentile(0.50),
            p95_ms: percentile(0.95),
            p99_ms: percentile(0.99),
            pool: { ...delta, peak_in_use: peakInUse, active_at_end: inUse },
            event_loop_delay_ms: {
                mean: Number((eventLoop.mean / 1e6).toFixed(2)),
                p95: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
                max: Number((eventLoop.max / 1e6).toFixed(2))
            }
        }));
    } finally {
        eventLoop?.disable();
        if (onAcquire) pool.off('acquire', onAcquire);
        if (onRelease) pool.off('release', onRelease);
        await new Promise(resolve => io.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
    }
}
main().catch(error => { console.error(error); process.exit(1); });
```

Run it at 1, 5, 10, 50, and 100 agents for 60 s each. Each process recreates only `posapp_test`, starts its own ephemeral HTTP server, measures the existing pool directly, and closes all handles. Record the five JSON results in `docs/superpowers/evidence/2026-08-17-spooler-v2-sync-load.md`. **Acceptance bar:** at 1 and 5 agents, `p95_ms < 1000`, `pool.enqueued = 0`, `pool.connectionErrors = 0`, `pool.active_at_end = 0`, `pool.peak_in_use <= 5`, and event-loop p95 delay is below 100 ms. The 10/50/100 tiers must finish without request failure or leaked connections; they are headroom evidence, not a production capacity promise. If the machine cannot meet those numbers, stop and report the measured bottleneck rather than changing the two-second product interval by intuition.

- [ ] **Step 3b: Build the server checkpoint**; the one full-suite run is reserved for Task 13 after the installed agent and updater exist:

```bash
npm run build
```

Do not run the full suite here. On a focused failure, rerun only that file after correction.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/manual/spoolerV2LoadHarness.js docs/superpowers/evidence/2026-08-17-spooler-v2-sync-load.md
git commit -m "test(spooler-v2): measure sync latency and database-pool budget"
```

---

## Task 7 — Windows platform helper, single-instance lock, and agent-minted identity

**Files:**
- Create: `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`
- Create: `pos-spooler-printer/v2/platform-helper.js`
- Create: `pos-spooler-printer/v2/agent-identity.js`
- Create: `pos-spooler-printer/tests/v2-agent-identity.test.js`
- Create: `pos-spooler-printer/tests/v2-platform-helper.test.js`
- Modify: `scripts/build-installers.ps1`
- Modify: `backend/tests/unit/spoolerPackageContract.test.js`

**Interfaces — Produces:**
- `startPlatformHelper({ executable, stateRoot, onEvent })` -> `{ request(command, payload), close(), exited }`; the helper owns one Windows named mutex for its entire lifetime and forwards unsolicited Winspool status events separately from request responses.
- `loadOrCreateIdentity({ stateRoot, protector })` -> `{ agentId, secret }`; only the DPAPI ciphertext is written to disk.
- Helper commands in this task: `protect` and `unprotect`. Task 10 extends the same protocol with Winspool commands; do not create a second helper.

- [ ] **Step 1: Write RED identity tests** using a temporary directory and a fake protector:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrCreateIdentity } = require('../v2/agent-identity');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-identity-'));
    const protector = {
        protect: async value => Buffer.from(value).toString('base64'),
        unprotect: async value => Buffer.from(value, 'base64')
    };
    const first = await loadOrCreateIdentity({ stateRoot: root, protector });
    const second = await loadOrCreateIdentity({ stateRoot: root, protector });
    assert.strictEqual(second.agentId, first.agentId);
    assert.deepStrictEqual(second.secret, first.secret);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(typeof saved.protected_secret, 'string');
    assert(!fs.readFileSync(path.join(root, 'agent.json'), 'utf8').includes(first.secret.toString('hex')));
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
    fs.rmSync(root, { recursive: true, force: true });
    console.log('v2-agent-identity tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
```

Also simulate the crash boundaries with an injected `beforeRename` hook: a crash before rename leaves no identity and regenerates safely; a crash after rename reloads the same identity. The server-side response-loss case remains pinned by Task 2's idempotent registration test.

- [ ] **Step 2: Run RED:** `node pos-spooler-printer/tests/v2-agent-identity.test.js` -> module-not-found.

- [ ] **Step 3: Implement `agent-identity.js`** with one durable file:

```js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function loadOrCreateIdentity({ stateRoot, protector, beforeRename = async () => {} }) {
    const file = path.join(stateRoot, 'agent.json');
    fs.mkdirSync(stateRoot, { recursive: true });
    // The helper mutex is already held, so these can only be debris from a killed prior process.
    for (const name of fs.readdirSync(stateRoot)) {
        if (name.startsWith('agent.json.') && name.endsWith('.tmp')) {
            fs.rmSync(path.join(stateRoot, name), { force: true });
        }
    }
    if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !UUID_V4.test(String(saved.agent_id || '')) || typeof saved.protected_secret !== 'string') {
            throw new Error('AGENT_IDENTITY_INVALID');
        }
        const secret = await protector.unprotect(saved.protected_secret);
        if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('AGENT_IDENTITY_INVALID');
        return { agentId: saved.agent_id, secret };
    }
    const identity = { agentId: crypto.randomUUID(), secret: crypto.randomBytes(32) };
    const saved = {
        version: 1,
        agent_id: identity.agentId,
        protected_secret: await protector.protect(identity.secret)
    };
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    let renamed = false;
    try {
        fs.writeFileSync(fd, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        await beforeRename();
        fs.renameSync(tmp, file);
        renamed = true;
        return identity;
    } finally {
        if (!renamed) fs.rmSync(tmp, { force: true });
    }
}

module.exports = { loadOrCreateIdentity };
```

- [ ] **Step 4: Implement one persistent Windows helper.** `PosSpoolerPlatform.cs` canonicalizes the state root with `Path.GetFullPath`, trims trailing separators, uppercases invariantly (Windows path identity is case-insensitive), then acquires `Global\\POSAPP-Spooler-V2-<SHA256(canonical state root)>` before writing its first stdout line. If already owned, write `{"type":"fatal","code":"STATE_ROOT_LOCKED"}` and exit 73. For each newline-delimited JSON request, echo its numeric `id` and either `result` or `error`. `protect`/`unprotect` use `ProtectedData` with `DataProtectionScope.LocalMachine`. The helper never logs request payloads. Compile with the Windows-inbox .NET Framework compiler:

```powershell
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /optimize+ /target:exe /out:$helperExe /r:System.Web.Extensions.dll /r:System.Security.dll `
    (Join-Path $repo 'pos-spooler-printer\windows-helper\PosSpoolerPlatform.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helperExe)) { throw 'Winspool platform helper compilation failed.' }
```

`platform-helper.js` owns process framing: a `Map` by request id, a 10-second request deadline, rejection of every pending request on child exit, and `close()` that ends stdin then kills after two seconds. Its `protector` adapter base64-encodes plaintext only in memory:

```js
const helper = await startPlatformHelper({ executable, stateRoot });
const protector = {
    protect: async bytes => (await helper.request('protect', { value: Buffer.from(bytes).toString('base64') })).value,
    unprotect: async value => Buffer.from((await helper.request('unprotect', { value })).value, 'base64')
};
```

- [ ] **Step 5: Prove the Windows-only boundaries:** one helper starts; a second against the same state root exits 73; another Windows account on the same machine can decrypt only if it can read the ACL-protected file; copied ciphertext fails on a second machine/VM. Unit tests fake protection, but the two-machine result is a required installer evidence row.

- [ ] **Step 6: Package the helper** in the spooler application layer and add an exact-inventory contract. Do not add a Node native dependency or another runtime layer.

- [ ] **Step 7: Run GREEN:** `npm --prefix pos-spooler-printer test` and `npx vitest run backend/tests/unit/spoolerPackageContract.test.js`.

- [ ] **Step 8: Map the Windows helper, mutex, and DPAPI identity boundary; regenerate/check architecture; then commit:**

```bash
git add pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs pos-spooler-printer/v2/platform-helper.js pos-spooler-printer/v2/agent-identity.js pos-spooler-printer/tests/v2-agent-identity.test.js pos-spooler-printer/tests/v2-platform-helper.test.js scripts/build-installers.ps1 backend/tests/unit/spoolerPackageContract.test.js docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): durable machine identity and exclusive Windows platform helper"
```

---

## Task 8 — Durable local job journal and the only V2 sync runtime

**Files:**
- Create: `pos-spooler-printer/v2/job-store.js`
- Create: `pos-spooler-printer/v2/sync-client.js`
- Create: `pos-spooler-printer/v2/agent-runtime.js`
- Create: `pos-spooler-printer/v2-server.js`
- Create: `pos-spooler-printer/tests/v2-job-store.test.js`
- Create: `pos-spooler-printer/tests/v2-sync-runtime.test.js`
- Modify: `pos-spooler-printer/package.json`

**Interfaces — Produces:**
- `openJobStore({ stateRoot })` -> `{ accept(job), get(id), requestCancel(id), markRendered(id, artifact), markTransportStarted(id), recordResult(id, result), confirmAccepted(ids), confirmResults(ids), unconfirmedAccepted(), outbox(), runnable(), health() }`.
- `createSyncClient({ baseUrl, agentId, secret, bootstrapKey, spoolerId, agentVersion, fetchFn })` -> `{ prepare(), register(), sync(body) }`.
- `createAgentRuntime({ store, syncClient, worker, clock })` -> `{ start(), stop(), wake(), health() }`; startup order is helper lock -> identity -> prepare/register -> validated sync -> workers.

- [ ] **Step 1: Write RED job-store tests** covering every durable boundary:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../v2/job-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-jobs-'));
const job = { queue_id: 41, idempotency_key: 'job-41', payload_hash: 'a'.repeat(64), printer_id: 7, print_type: 'kitchen' };
let store = openJobStore({ stateRoot: root });
assert.strictEqual(store.accept(job).state, 'queued');
assert.strictEqual(store.accept(job).state, 'queued');
assert.throws(() => store.accept({ ...job, payload_hash: 'b'.repeat(64) }), /PAYLOAD_IDENTITY_CONFLICT/);
store.markRendered(41, { path: 'artifacts/41.bin', hash: 'c'.repeat(64), bytes: 100 });
store.markTransportStarted(41);
store = openJobStore({ stateRoot: root });
assert.strictEqual(store.get(41).state, 'uncertain');
assert.strictEqual(store.runnable().length, 0);
assert.strictEqual(store.outbox()[0].outcome, 'uncertain');
store.confirmResults([41]);
assert.strictEqual(store.outbox().length, 0);
fs.rmSync(root, { recursive: true, force: true });
console.log('v2-job-store tests passed');
```

Extend the test with injected write/rename failures at `accept`, `rendered`, `transport_started`, `result`, and confirmation. The old or new complete file must survive; a partial file must never be read as a job. Disk-full/ACL failures before acceptance return no acceptance; failures at or after the transport marker create `uncertain` and never runnable work. Pin retention with a fake clock: confirmed terminal metadata at 13 days remains; at 15 days it is deleted with its artifact; active, retrying, uncertain, quarantined, and unconfirmed rows survive regardless of age.

- [ ] **Step 2: Run RED:** `node pos-spooler-printer/tests/v2-job-store.test.js` -> module-not-found.

- [ ] **Step 3: Implement one-file-per-job storage.** The root is exactly the installer-owned `SPOOLER_STATE_DIR` (`C:\ProgramData\POS-Spooler\state` by default); V2 must reject a missing, relative, or noncanonical override rather than creating durable state under the application directory. Its contents are:

```text
jobs/active/<queue-id>-<sha256(idempotency-key)>.json
jobs/archive/
artifacts/
quarantine/
agent.json
seen-print-jobs.v1.backup.json
```

Every mutation calls this single writer; there is no growing global JSON file:

```js
function writeAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}
```

The stored schema is fixed at version 1: `{ version, queue_id, idempotency_key, payload_hash, printer_id, print_type, state, job, artifact, result, accepted_confirmed, created_at, updated_at }`. Valid states are `queued`, `rendered`, `retry_wait`, `transport_started`, `completed`, `permanent_failure`, `uncertain`, `canceled`. On load, `transport_started` becomes `uncertain` with an outbox result; terminal rows remain until the server confirms their result, then move atomically to `archive`. A daily cleanup removes only confirmed terminal archive metadata older than 14 days and its artifact. It never ages out active, retrying, uncertain, quarantined, or unconfirmed work.

`requestCancel(id)` writes a durable cancel tombstone even when the payload was never received. It returns `canceled` only from `queued`, `rendered`, or an absent-payload tombstone; it returns the true terminal state after `transport_started`.

- [ ] **Step 4: Migrate `seen-print-jobs.json` once.** Completed V1 records become archived terminal records; `printing` records become `uncertain`; copy the original byte-for-byte to `seen-print-jobs.v1.backup.json`; write a versioned migration marker only after every converted file is durable. A restart resumes conversion idempotently.

- [ ] **Step 5: Write RED sync-runtime tests** with an in-memory `fetchFn`: lost register response heals; lost successful sync response reaccepts the same local job; accepted/result outbox entries survive restart; `draining` stops new intake but finishes local jobs and reports `drain_complete` only after results are confirmed; a revoked/decommissioned response persists pause before another worker call; an offline startup never starts workers; recovery triggers immediate sync; backoff is exactly 2s, 5s, then 10s cap.

- [ ] **Step 6: Implement `sync-client.js`** using existing `fetchWithTimeout`, not another library. Requests are JSON with `x-agent-id` and the raw secret held only in memory. `prepare()` is used only during installer cutover. Startup tries authenticated `sync()` first; only an `unauthorized_agent` response invokes idempotent `register()` once and then retries sync. This heals a lost registration response without making every healthy restart depend on the shared bootstrap secret. An existing-row token mismatch, revoked/decommissioned response, or repeated 401 pauses visibly and never replaces identity. Network/5xx failures back off; the agent never exits.

- [ ] **Step 7: Implement the runtime loop** in this order:

```js
async function applySyncResponse(store, response) {
    store.confirmAccepted(response.confirmed_accepted || []);
    store.confirmResults(response.confirmed_results || []);
    for (const queueId of response.cancel_requested || []) store.requestCancel(queueId);
    const accepted = [];
    for (const job of response.jobs || []) {
        const record = store.accept(job);          // fsync + rename happens here
        accepted.push({ queue_id: record.queue_id, payload_hash: record.payload_hash });
    }
    return accepted;
}

function syncBody(store, capacity, health) {
    return {
        protocol_version: 2,
        accepted: store.unconfirmedAccepted(),
        results: store.outbox(),
        health,
        capacity
    };
}
```

The next sync is immediate while accepts/results remain or jobs were returned; otherwise two seconds (startup jitter applies once, not to every interval). Capacity equals free durable local slots, never memory queue length. After the required successful startup identity sync, already-accepted local work continues through ordinary server/network outages while results remain durable in the outbox; an outage never blocks a local printer lane. Worker completion only mutates the local store and wakes sync; it never calls a separate ACK endpoint. On `draining`, capacity is zero while already-local workers continue; health sends `drain_complete: true` only when no runnable/active job or unconfirmed result remains. On `revoked`/`decommissioned`, workers stop before another transport and the paused state persists.

- [ ] **Step 8: Make `v2-server.js` the V2-only entry point.** It loads the existing env file, starts the platform helper, loads identity, constructs store/client/runtime, and installs SIGTERM/SIGINT shutdown. It must not import `socket.io-client`, `poll-fallback.js`, or legacy `server.js`. Add `start:v2` to `package.json` only for local tests; installers choose the entry point explicitly.

- [ ] **Step 9: Run GREEN:** `npm --prefix pos-spooler-printer test`; then grep the V2 graph: `rg "socket\.io|print_job|/api/spooler/poll" pos-spooler-printer/v2-server.js pos-spooler-printer/v2` must return no delivery code.

- [ ] **Step 10: Map the V2 entry point, journal, and sync-runtime boundary; regenerate/check architecture; then commit:**

```bash
git add pos-spooler-printer/v2/job-store.js pos-spooler-printer/v2/sync-client.js pos-spooler-printer/v2/agent-runtime.js pos-spooler-printer/v2-server.js pos-spooler-printer/tests/v2-job-store.test.js pos-spooler-printer/tests/v2-sync-runtime.test.js pos-spooler-printer/package.json docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): durable local journal and pull-only agent runtime"
```

---

## Task 9 — Per-printer scheduling and bounded artifact rendering

**Files:**
- Create: `pos-spooler-printer/v2/artifact-renderer.js`
- Create: `pos-spooler-printer/v2/printer-workers.js`
- Create: `pos-spooler-printer/tests/v2-artifact-renderer.test.js`
- Create: `pos-spooler-printer/tests/v2-printer-workers.test.js`
- Create: `pos-spooler-printer/tests/fixtures/v2-report-200-rows.js` (sanitized deterministic Arabic/all-sections fixture)
- Modify: `pos-spooler-printer/server.js` (mechanical extraction only; V1 imports the shared renderer)
- Modify: `pos-spooler-printer/tests/spooler-report-rendering.test.js`
- Modify: `pos-spooler-printer/tests/transport-boundary.test.js`

**Interfaces — Produces:**
- `createArtifactRenderer({ stateRoot, puppeteer, canvas, limits })` -> `{ render(job), warm(), close(), health() }`; `render` returns `{ path, hash, bytes, width, height }` and never touches a printer.
- `createPrinterWorkers({ store, renderer, transportFor, now })` -> `{ start(), stop(), wake(), health() }`; one serial lane exists per physical printer, while the shared render queue prioritizes kitchen work not yet rendering.

- [ ] **Step 1: Consume Gate 0; do not repeat or reinterpret it.** Attach its artifact hashes and chosen branch to the Task 9 test evidence. The default remains the current 256-row `GS v 0` profile unless Gate 0 physically authorized the single 128-row alternative. Task 13 repeats the same artifacts through the finished V2 transports.

- [ ] **Step 2: Write RED renderer tests.** The sanitized 200-row fixture contains Arabic shaping, every report section, and multiple band boundaries. Pin: receipt, kitchen, and that report all use the same HTML-to-monochrome-raster compiler; artifact files are written before transport; maximum width is 576 px; each screenshot/canvas clip is at most 256 rows; no full-height screenshot, full-height RGBA canvas, all-document raster array, or growing `Buffer.concat` exists; output bytes and total rendered height are bounded; active pages never exceed one on the low-end profile; a hung `setContent` closes the page, kills/recycles the browser, writes no artifact, and the next kitchen job succeeds; one artifact contains exactly one cut and at most one configured drawer kick. Feed the same completed report artifact to fake TCP and fake Winspool adapters and assert the submitted SHA-256/byte count are identical.

Use the existing Puppeteer/canvas fakes from `spooler-report-rendering.test.js`; do not invent a second browser harness. Required acceptance assertions:

```js
const report = await renderer.render(reportJob);
assert(fs.existsSync(report.path));
assert.strictEqual(sha256(fs.readFileSync(report.path)), report.hash);
assert(report.bytes <= 16 * 1024 * 1024);
assert.strictEqual(harness.maxActivePages, 1);
assert.strictEqual(countBytes(fs.readFileSync(report.path), Buffer.from([0x1d, 0x56])), 1);
```

- [ ] **Step 3: Extract, do not duplicate, the current proven document compilers.** Move browser launch/warmup/recycle, report HTML selection, `renderReceiptDocument`, `renderKitchenDocument`, and `resolveCompiledDocument` from `server.js` into `v2/artifact-renderer.js`. Delete `BufferConnector`; do not move it. Replace full-height `renderHtmlToRasterBands` with a bounded clip loop and an artifact-file connector. V1 `server.js` imports the shared module so all existing receipt/report tests remain valid. Keep the existing launch/warmup/render deadlines and low-resource Chromium flags.

The deep renderer interface accepts a job and returns one immutable artifact. Internally it:
1. validates/normalizes the target-independent document;
2. renders exactly one page but screenshots it top-to-bottom in at most 256-row clips;
3. converts one clip into ESC/POS raster bands, writes those bands to the temporary artifact with backpressure, then releases the screenshot/image/canvas before capturing the next clip (or uses the physically proven compatibility profile only);
4. appends drawer kick once for eligible customer receipts;
5. appends cut once;
6. incrementally hashes and writes `<stateRoot>/artifacts/<queue-id>-<hash>.bin` through one fsynced temporary stream and atomic rename; no complete-document byte buffer is retained;
7. returns metadata and releases the page.

The renderer must reject `COMPILED_DOCUMENT_INVALID`, `RENDER_TIMEOUT`, `ARTIFACT_TOO_LARGE`, and `ARTIFACT_WRITE_FAILED` as pre-transport permanent/transient-safe failures. `Promise.race` alone is forbidden: the timeout handler closes the page and recycles the browser before another job advances.

- [ ] **Step 4: Write RED scheduling tests** with fake renderer/transports:
  - two jobs for one printer never overlap transport;
  - jobs for two printers may transport concurrently;
  - a kitchen job overtakes a queued report whose render has not started;
  - an already rendering/transporting report is never preempted;
  - an offline printer lane retries locally without blocking another printer;
  - with 50 mixed jobs, every queue id appears in exactly one lane and no lane exceeds one active transport.

- [ ] **Step 5: Implement the scheduler with two small queues.** `priority(job)` is `0` for kitchen/void/follow-up tickets, `1` for receipts, `2` for reports. The global render queue sorts `[priority, created_at, queue_id]`; after rendering, the immutable artifact moves to its printer lane. Each lane awaits only its own transport. Kitchen/receipt transient-safe retries use 1s, 2s, then a 5s cap; background reports use 2s, 5s, 10s, then a 30s cap. Attempts stay observable but never discard an offline-printer job. Permanent failures record a terminal result. Uncertain failures never re-enter a runnable queue.

```js
const priority = job => job.print_type === 'kitchen' || job.data?.void_ticket
    ? 0
    : job.print_type === 'receipt' ? 1 : 2;

function compareJobs(a, b) {
    return priority(a.job) - priority(b.job)
        || Date.parse(a.created_at) - Date.parse(b.created_at)
        || a.queue_id - b.queue_id;
}
```

- [ ] **Step 6: Preserve V1 behavior.** Run every existing spooler renderer, receipt-display, payload-integrity, and transport-boundary test. The extraction commit may move code but must not change customer/kitchen output, drawer count, cut count, or current pre-transport retry classification.

- [ ] **Step 7: Run GREEN:** `npm --prefix pos-spooler-printer test`.

- [ ] **Step 8: Map the bounded renderer and per-printer scheduler; regenerate/check architecture; then commit:**

```bash
git add pos-spooler-printer/v2/artifact-renderer.js pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/tests/v2-artifact-renderer.test.js pos-spooler-printer/tests/v2-printer-workers.test.js pos-spooler-printer/tests/fixtures/v2-report-200-rows.js pos-spooler-printer/server.js pos-spooler-printer/tests/spooler-report-rendering.test.js pos-spooler-printer/tests/transport-boundary.test.js docs/architecture.json docs/architecture.html
git commit -m "refactor(spooler): one bounded artifact renderer and per-printer V2 scheduler"
```

---

## Task 10 — Raw TCP/Winspool transports and capability-aware printer status

**Files:**
- Create: `pos-spooler-printer/v2/printer-transports.js`
- Create: `pos-spooler-printer/v2/status-monitor.js`
- Create: `pos-spooler-printer/tests/v2-printer-transports.test.js`
- Create: `pos-spooler-printer/tests/v2-status-monitor.test.js`
- Modify: `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`
- Modify: `pos-spooler-printer/v2/platform-helper.js`
- Modify: `pos-spooler-printer/v2/printer-workers.js`
- Modify: `pos-spooler-printer/server.js` (V1 delivery reuses the same bounded transport adapters; delivery protocol remains V1)

**Interfaces — Produces:**
- `createTcpTransport({ net, connectMs, totalMs })` and `createWindowsTransport({ helper, totalMs })`; each exposes `send({ printer, artifact, markTransportStarted })` and `probe(printer)`.
- Transport result `{ success, confidence: 'bytes_sent'|'os_accepted'|'device_confirmed'|'unknown', deviceStatus, durationMs }`.
- `createStatusMonitor({ store, transportFor, intervalMs: 2000 })` returns health snapshots without writing probe bytes during an artifact transport.

- [ ] **Step 1: Write RED transport tests** using fake sockets/helper:
  - DNS/config/connect refusal before marker -> `transient_safe`, zero writes;
  - marker persistence failure -> `uncertain`, zero writes;
  - timeout/error after marker or after helper submission -> `uncertain`, never retry automatically;
  - successful TCP performs one transport attempt, streams ordered bounded chunks with backpressure, persists exactly one marker before the first chunk, and returns `bytes_sent`, not paper printed;
  - successful Winspool submission returns `os_accepted` with a Windows job id;
  - helper exit/hang kills and restarts the helper, keeps the main status loop alive, and marks only its active job uncertain;
  - the immutable artifact SHA-256 is rechecked immediately before marker/write.

Core assertion:

```js
await transport.send({
    printer,
    artifact,
    markTransportStarted: () => store.markTransportStarted(queueId)
});
assert.deepStrictEqual(events, ['preflight', 'hash', 'marker', 'first-byte']);
```

- [ ] **Step 2: Implement TCP with owned deadlines.** Normalize the address once and reject unless `net.isIP(host)` is 4 or 6; port must be an integer 1–65535. Connect deadline is five seconds; write-idle deadline is three seconds; total stream deadline is fifteen seconds. Preflight completes before `markTransportStarted`; marker completes before the first chunk. On success call `socket.end()` only after the final chunk drains, then destroy on close/deadline. No status probe may share the socket.

```js
async function sendTcp({ net, host, port, artifact, markTransportStarted }) {
    if (!net.isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw classified('PRINTER_CONFIG_INVALID', 'permanent_safe');
    }
    await verifyArtifactHash(artifact.path, artifact.hash);
    const socket = new net.Socket();
    await connectWithDeadline(socket, port, host, 5000);
    await markTransportStarted();
    await streamFileWithBackpressure(socket, artifact.path, { chunkBytes: 64 * 1024, idleMs: 3000, totalMs: 15000 });
    return { success: true, confidence: 'bytes_sent', deviceStatus: 'unknown' };
}
```

- [ ] **Step 3: Extend the one C# helper**, retaining mutex and DPAPI commands. Add newline JSON commands:
  - `print_raw { printer_name, artifact_path, artifact_sha256 }` -> open file with `FileShare.Read`, hash it, `OpenPrinter`, `StartDocPrinter` with datatype `RAW`, `StartPagePrinter`, loop `WritePrinter` until every byte is accepted, `EndPagePrinter`, `EndDocPrinter`; return Windows job id and accepted byte count;
  - `printer_status { printer_name }` -> `GetPrinter` level 2 mapped to `unknown|ok|offline|paper_low|paper_out|cover_open|jammed|error`;
  - `watch_printers { printer_names }` -> replace the helper's subscription set, perform one initial `GetPrinter` snapshot, then use `FindFirstPrinterChangeNotification`/`FindNextPrinterChangeNotification` on background watcher threads and emit unsolicited `{"type":"event","event":"printer_status",...}` lines. Serialize every stdout write behind one lock so events cannot corrupt request framing; close notification handles during helper shutdown.

Every native handle closes in `finally`. A partial `WritePrinter`, native exception after `StartDocPrinter`, helper deadline, or helper death is `uncertain`. Never resend that artifact automatically. Cancellation is local-only before `transport_started`; once submitted to Winspool, the agent reports completion or uncertainty and never claims that an OS cancel proves paper did not print. The Node adapter sends only the ACL-protected artifact path/hash, not base64 print bytes, which keeps long reports out of JSON memory. `platform-helper.js` routes lines with a numeric `id` to pending requests and `type:event` lines to `onEvent`; on helper restart it reissues the current `watch_printers` set.

- [ ] **Step 4: Write RED status tests.** Pin:
  - a direct-TCP `write_only` printer never claims healthy; it reports `unknown` plus its last reachability/transport fact;
  - `escpos_status` issues DLE EOT only while its printer lane is idle and disables probing after unsupported/garbage replies;
  - Windows status comes from helper/Winspool and is labeled OS-reported;
  - TCP-open alone is reachability, not printer health;
  - a probe arriving during print is skipped, never interleaved.

- [ ] **Step 5: Implement status monitoring behind the same printer lane.** The lane exposes `runExclusive(kind, fn)`; printing queues, direct-TCP probes skip when busy. Windows printers consume the helper's notification stream (plus its initial snapshot) rather than launching or polling an external process. Map facts without inflation:
  - `device_confirmed`: a supported printer protocol returned a valid state;
  - `os_accepted`: Winspool accepted the raw job;
  - `bytes_sent`: TCP write completed;
  - `unknown`: no trustworthy feedback.

Health sent through sync contains only station/printer ids, capabilities, states, timestamps, queue depth, renderer/helper state, durations, and error codes. It contains no artifact bytes, receipt data, customer names, keys, or env values.

- [ ] **Step 6: Run GREEN:** `npm --prefix pos-spooler-printer test` plus the Windows helper integration test on Windows 10 22H2.

- [ ] **Step 7: Map TCP, Winspool, and capability-status boundaries; regenerate/check architecture; then commit:**

```bash
git add pos-spooler-printer/v2/printer-transports.js pos-spooler-printer/v2/status-monitor.js pos-spooler-printer/tests/v2-printer-transports.test.js pos-spooler-printer/tests/v2-status-monitor.test.js pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs pos-spooler-printer/v2/platform-helper.js pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/server.js docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): bounded raw transports and capability-aware printer status"
```

---

## Task 11 — Server health ingestion, clear admin controls, diagnostics, and report closure

**Files:**
- Modify: `backend/services/spoolerSync.js`
- Modify: `backend/routes/admin/printQueue.js`
- Modify: `backend/routes/admin/printers.js`
- Modify: `backend/services/printerStatus.js`
- Create: `backend/tests/integration/spoolerV2Health.test.js`
- Modify: `src/admin/pages/Settings.vue`
- Create: `src/admin/pages/__tests__/spoolerV2Settings.spec.js`
- Modify: `src/shared/i18n/en.json`
- Modify: `src/shared/i18n/ar.json`
- Modify: `docs/printing-runbook.md`
- Modify: `docs/deferred-spooler-long-report-raster-corruption.md`

**Interfaces — Produces:** `/api/admin/print-queue/health` returns both V1 registry state and V2 durable-agent/station state; admin replacement/rollback actions remain explicit and audited; `/api/admin/print-queue/diagnostics` downloads redacted JSON only.

- [ ] **Step 1: Write RED backend health tests.** A sync containing two printer states must update only printers assigned to that agent's station. Malformed/oversized health is bounded and cannot change another station. The health endpoint must return:

```json
{
  "stations": [{
    "spooler_id": "primary",
    "delivery_protocol": "v2",
    "agent_id": "uuid",
    "agent_status": "active",
    "last_sync_at": "timestamp",
    "local_queue_depth": 2,
    "oldest_local_job_age_ms": 3500,
    "renderer": "ready",
    "helper": "ready",
    "last_error": null
  }]
}
```

Recent rows include `local_accepted` and `cancel_requested`, `agent_id`, `last_error_code`, and `last_failure_class`. V2 connectivity comes from `last_sync_at` freshness, not Socket.IO registry membership.
The station query also returns `last_artifact_submission_at` and `last_acknowledged_at` from bounded aggregate queries over indexed queue ownership; it never infers either fact from agent connectivity.

- [ ] **Step 2: Ingest health inside the sync transaction.** The agent sends printer deltas (initial snapshot, then changes), not all printers every two seconds. Accept at most 64 rows and deduplicate by integer printer id. Add `updatePrinterDeviceStatusesForStation(db, { spoolerId, statuses, source })` to `printerStatus.js`: one ownership SELECT for all ids and one bounded CASE UPDATE for only owned, changed rows—never one query per printer. Reuse the existing normalization sets. Store only bounded `{renderer,helper,oldest_local_job_age_ms}` in `spooler_agents.health_summary`; `last_error` accepts only an agent-produced stable code matching `^[A-Z0-9_:-]{1,64}$`; structured printer facts stay in existing printer-status columns. A malformed or other-station fact is dropped and listed by stable code in `health_warnings`; it cannot reject accepted/results processing or mutate another station. Tests assert the health phase uses at most two SQL statements for 64 rows.

- [ ] **Step 3: Write RED Vue tests** pinning a cashier-readable flow:
  - V1 and V2 station cards say protocol, online/offline/paused, last sync, local queue count, renderer/helper state;
  - status confidence is visible (`Device confirmed`, `Windows accepted`, `Bytes sent`, `Unknown`) and never says paper printed;
  - normal replacement requests drain and shows `Draining` until the agent confirms an empty journal;
  - forced replacement requires the old-terminal-stopped confirmation and warns about outcome-unknown jobs;
  - V1 rollback appears only when server says it is allowed;
  - `local_accepted` reads `Stored on terminal`; `cancel_requested` reads `Cancellation pending`;
  - both graphite and light themes retain contrast; all new English keys exist in Arabic catalog with natural product copy.

- [ ] **Step 4: Modify the existing Print Queue tab only.** Do not add another page or duplicate printer management. Replace the single socket-based spooler card with one compact card per returned station. Add replacement/rollback buttons inside the selected station card. Keep recent jobs and printer status tables; add confidence and agent columns only where data exists. Poll health every five seconds only while the tab is visible; stop on unmount/tab change.

The action handlers call the existing admin routes and always refresh health after success/failure. They do not optimistically claim replacement or cancellation succeeded.

Add one cutover-recovery action shown only while a station is `transitioning` with stranded V1 `processing`/`sent` rows. `POST /api/admin/print-queue/stations/:spoolerId/terminalize-v1` requires body `{ confirm_old_v1_service_stopped: true, reason }`, locks the station first, refuses unless its protocol is `transitioning`, and atomically moves only `agent_id IS NULL` `processing`/`sent` rows to `dead_letter` with `last_error_code='V1_CUTOVER_OUTCOME_UNKNOWN'`, `last_failure_class='uncertain'`, plus one audit event containing row ids and reason. The UI states that paper outcome is unknown and offers audited manual reprint only after the operator verifies the old service cannot print. The installer never invokes this endpoint automatically.

- [ ] **Step 5: Add a redacted diagnostics endpoint.** Response/download fields are exact: server/spooler versions, station/agent ids, protocol/status timestamps, configured printer driver/port/capability, queue counts by state, oldest ages, timing percentiles already stored, last 100 error codes/classes, artifact hashes/sizes, helper/renderer lifecycle timestamps. Explicitly omit `payload`, compiled documents, item/customer names, phone/address, bootstrap key, agent token/hash, `spooler.env`, URLs containing credentials, and raw logs.

- [ ] **Step 6: Close the report defect only with evidence.** Update the deferred issue with Task 9 Gate 0 artifacts. If a physically proven profile was required, expose only its proven fields in printer settings and document the exact affected model. If no profile was required, record that the V2 helper's raw byte path fixed the Windows corruption. Never mark the issue closed from unit tests alone.

- [ ] **Step 7: Run GREEN:** `npx vitest run backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/printQueueHealthApi.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js`; then `npm run build:admin`.

- [ ] **Step 8: Map server health ingestion, admin recovery, and diagnostics; regenerate/check architecture; then commit:**

```bash
git add backend/services/spoolerSync.js backend/routes/admin/printQueue.js backend/routes/admin/printers.js backend/services/printerStatus.js backend/tests/integration/spoolerV2Health.test.js src/admin/pages/Settings.vue src/admin/pages/__tests__/spoolerV2Settings.spec.js src/shared/i18n/en.json src/shared/i18n/ar.json docs/printing-runbook.md docs/deferred-spooler-long-report-raster-corruption.md docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): honest station health, recovery controls, and redacted diagnostics"
```

---

## Task 12 — Installer/updater packaging, atomic station cutover, and rollback

**Files:**
- Modify: `deployment/windows/Install-Spooler.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `deployment/windows/SpoolerLayerState.ps1`
- Modify: `deployment/windows/Repair-SpoolerStartup.ps1`
- Modify: `deployment/tools/spooler-layer-manifest.js`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `scripts/build-installers.ps1`
- Modify: `backend/routes/spoolerV2.js` (prepare abort + authenticated self-rollback)
- Modify: `backend/services/spoolerAgents.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`
- Create: `backend/tests/integration/spoolerV2Cutover.test.js`

**Interfaces — Produces:** updater switch `-EnableV2`; V2 entry point ownership in NSSM; byte-for-byte preservation of env and state; two safe rollback interfaces: bootstrap abort while still `transitioning`, authenticated self-rollback after registration but before first acceptance.

**Hard precondition:** the Post-approval migration steps must be explicitly approved, completed, and verified before building a V2 cutover package or canary. Tasks 7–11 may be developed/tested locally against fixtures while that approval is pending; Task 12 may not cross this gate.

- [ ] **Step 1: Write RED server cutover tests.** Pin the complete state machine:

```text
v1 --prepare--> transitioning --register--> v2
transitioning --bootstrap abort with zero active agent--> v1
v2 --authenticated self rollback before first acceptance--> v1
v2 --any rollback after first acceptance--> 409 v2_rollback_locked
v2 --replace/revoke--> v2
```

Race test: start one V1 `claimPrintJobs` transaction and one prepare request concurrently. Exactly one ordering is allowed: the claim commits and prepare reports it in-flight, or prepare commits first and claim returns empty. Never both a new V1 claim and V2 activation.

- [ ] **Step 2: Add the two installer recovery routes.** `POST /api/spooler/v2/abort-prepare` uses `requireBootstrapKey`, accepts `spooler_id`, locks the station, and changes `transitioning` to `v1` only when there is no active agent and `first_v2_accepted_at IS NULL`. `POST /api/spooler/v2/rollback-self` uses `requireAgentAuth` and calls `rollbackStationToV1` for `req.agent.spooler_id`; it succeeds only before first acceptance and audits the agent id. Neither endpoint accepts a caller-selected agent id.

- [ ] **Step 3: Write RED installer/update contracts.** Exact assertions:
  - V2 application inventory contains `v2-server.js`, `v2/**`, and `bin/PosSpoolerPlatform.exe`;
  - application-only update keeps the existing runtime identity when package dependencies/browser id did not change;
  - `spooler.env` SHA-256 before/after is identical;
  - `state/agent.json`, `state/jobs`, `state/artifacts`, `state/quarantine`, archive, logs, and diagnostics are outside application cleanup and rollback roots;
  - service executable ownership remains exact NSSM + packaged Node; V2 changes only AppParameters from `server.js` to `v2-server.js`;
  - updater refuses cutover when it finds zero or more than one owned/legacy spooler service;
  - the Inno package accepts only explicit `/ENABLEV2=1` during the canary period and passes `-EnableV2` to the owned PowerShell install/update command; absence keeps V1;
  - every interruption phase yields old coherent V1, new coherent V2, or paused recovery—never both services.

- [ ] **Step 4: Package without a runtime transition.** The helper executable and new JS files are application-layer files. Node dependencies and Chromium are unchanged; therefore the ordinary V2 application update must not copy `node_modules` or `.cache`. `spooler-layer-manifest.js` hashes the helper and V2 files into `application.id`; runtime id stays unchanged. Only a later dependency/browser change may build a runtime-transition package.

- [ ] **Step 5: Implement the exclusive legacy-service sweep.** Before V2 prepare, enumerate the exact registered executable and NSSM parameters for `POS Print Spooler`, then search only the known legacy node-windows service names/daemon executable paths already encoded in installer ownership tests. Required result is exactly one runnable spooler service. Stop/delete an owned legacy duplicate only after resolving its absolute executable under the expected Program Files/legacy daemon roots. Unknown services are a hard stop, not deletion targets.

- [ ] **Step 6: Implement the cutover transaction in `Update-Spooler.ps1 -EnableV2`:**
  1. validate package/layer hashes and snapshot env/state identities;
  2. verify server supports `/api/spooler/v2/prepare`;
  3. run the exclusive service sweep;
  4. call prepare with `SPOOLER_KEY` from the in-memory parsed env; never log headers/body;
  5. leave V1 running while polling prepare until `in_flight == 0`; a 60-second timeout aborts prepare and leaves V1 untouched unless an authenticated admin separately used the explicit outcome-unknown recovery action from Task 11, after which the updater may be rerun;
  6. disable service auto-start, stop V1, and persist journal phase `v1_stopped`;
  7. stage/swap application files and helper, keep runtime/env/state untouched, set NSSM parameters to `v2-server.js`;
  8. start V2; wait for service running plus server health showing this `agent_id`, protocol `v2`, and one successful sync;
  9. restore automatic startup, write installed-layer identity and cutover phase `v2_verified`;
  10. cleanup rollback files only after verification.

- [ ] **Step 7: Implement interruption handling:**
  - before registration: stop staged V2 if present, call bootstrap abort, restore V1 application/parameters, start V1;
  - after registration but before first local acceptance: stop the V2 service first (releasing the helper mutex), run packaged Node `v2-server.js --rollback-v1` so the same DPAPI identity authenticates and requests self-rollback, wait for a successful V1 protocol response, then restore/start V1;
  - after first acceptance or if rollback state cannot be proven: restore the last working V2 application or leave the service disabled/paused with recovery instructions; never start V1;
  - updater rollback never rewrites or downgrades a V2 journal.

Persist phase names in the existing updater transaction journal: `cutover_prepared`, `v1_drained`, `v1_stopped`, `v2_application_active`, `v2_registered`, `v2_verified`. `SpoolerLayerState.ps1` implements the phase operations; `Repair-SpoolerStartup.ps1` must accept those exact phases and recover each deterministically after a reboot or killed updater.

- [ ] **Step 8: Fresh installer behavior.** During canary releases, fresh installs remain V1 unless invoked with the explicit V2 switch. After two stable V2 releases and owner approval, change the fresh default to V2; still run prepare/register even on an empty station so server ownership is durable. Never auto-convert an existing station during an ordinary application update.

- [ ] **Step 9: Run GREEN:**

```bash
npx vitest run backend/tests/integration/spoolerV2Cutover.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/spoolerPackageContract.test.js
```

Then run the existing Windows sandbox validation for fresh V1, explicit V2 cutover, interrupted pre-registration rollback, interrupted post-registration/pre-acceptance rollback, and post-acceptance paused recovery.

- [ ] **Step 10: Map installer cutover and rollback recovery; regenerate/check architecture; then commit:**

```bash
git add deployment/windows/Install-Spooler.ps1 deployment/windows/Update-Spooler.ps1 deployment/windows/SpoolerLayerState.ps1 deployment/windows/Repair-SpoolerStartup.ps1 deployment/tools/spooler-layer-manifest.js deployment/spooler/POSAPP-Spooler.iss scripts/build-installers.ps1 backend/routes/spoolerV2.js backend/services/spoolerAgents.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/integration/spoolerV2Cutover.test.js docs/architecture.json docs/architecture.html
git commit -m "feat(spooler-v2): package atomic station cutover and acceptance-aware rollback"
```

---

## Task 13 — Full hostile release gate, canary evidence, architecture, and completion

**Files:**
- Create: `pos-spooler-printer/tests/v2-hostile-runtime.test.js`
- Create: `backend/tests/manual/spoolerV2MixedJobsHarness.js`
- Create: `docs/superpowers/evidence/2026-08-17-spooler-v2-release-gate.md`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Modify: `docs/printing-runbook.md`

- [ ] **Step 1: Run the automated hostile matrix.** Every row must record command, commit, machine profile, result, and captured metrics:

| Scenario | Required result |
|---|---|
| V2 package/runtime inspection | No Socket.IO connection, V1 poll, or alternate delivery path is reachable from `v2-server.js` |
| 1/5/10/50/100 idle agents | Measured request rate, p95 sync latency, event-loop delay, and DB occupancy stay within recorded budget; 1–5 agents is the acceptance tier |
| HTTP timeout/401/403/500/server restart | Accepted local jobs remain durable; auth/revocation pauses; network/5xx recovers automatically |
| Lost registration/sync/result response | Same identity/job/result resumes; no new claimant and no duplicate transport |
| Concurrent capacity-one syncs | At most one distinct outstanding job |
| Crash at every local transition | Pre-transport work is retryable; post-marker work is uncertain; no partial file becomes runnable |
| Second process/state-root copy | Same-machine mutex rejects second process; cross-machine DPAPI decrypt fails |
| Cancel before/after response, acceptance, render, marker | Only durable pre-marker cancellation reports canceled; all ambiguity remains visible |
| Replacement with `sent`, `local_accepted`, `cancel_requested` | Every unresolved old row becomes outcome-unknown; new agent receives none |
| Revoked old agent returns | It syncs before workers, remains paused, and transports nothing |
| V1 claim races prepare/register | Station-row serialization yields one owner, never dual delivery |
| Helper/browser hang or death | Owned child is killed/recycled; main runtime/status survives; active post-marker job is uncertain |
| Probe during transport | Probe skips; no byte interleaving |
| Offline printer then recovery | Safe local retry drains promptly without blocking another printer |
| Interrupted updater at every journal phase | Coherent V1, coherent V2, or paused recovery; env/identity/jobs survive byte-for-byte |

- [ ] **Step 2: Run the required 50-job mixed harness.** Seed exactly 20 kitchen tickets, 20 customer receipts, and 10 long reports across at least three printers. Hold one printer offline for 15 seconds while another receives kitchen work, then recover it. Acceptance criteria:
  - 50 unique server queue ids and 50 durable local identities;
  - every id ends acknowledged, explicit permanent/uncertain terminal, or remains safe local retry during the observation window;
  - zero duplicate transport markers/artifact submissions/cuts;
  - kitchen work on another printer is not delayed by the offline lane or report transport;
  - recovered printer begins draining kitchen/receipt work within the 5-second cap (reports within 30 seconds);
  - memory, CPU, event-loop delay, helper count, Chrome count, DB connections, p50/p95/p99 pickup-to-accept and pickup-to-transport are recorded.

The harness fails if `accounted !== 50`, if any queue id has transport count >1, if more than one Chrome/helper process exists, or if the venue-realistic DB pool reaches its acquire timeout.

- [ ] **Step 3: Run the physical matrix:** affected long-report printer, one Windows USB/shared printer, one direct TCP printer, one cheap write-only clone, and paper-out/cover-open on one feedback-capable model. Print receipt, kitchen, and 200-row report. Record artifact hashes and photographs without customer content. Physical failure cannot be waived by unit tests.

- [ ] **Step 4: Update architecture only after symbols exist.** Map server register/prepare/sync/cutover, local journal, renderer, printer lanes, platform helper, transports/status, admin health, and updater recovery. Pin invariants: stable claimant, durable station protocol, no V2 Socket.IO path, local acceptance no reassignment, transport marker before bytes/submission, uncertain never autoreprints, state-root singleton, and env/state preservation. Use implemented file:line references only.

- [ ] **Step 5: Run proportional final verification in one process at a time:**

```bash
npm --prefix pos-spooler-printer test
npm run build
npx vitest run
npm run architecture
npm run architecture:check
git diff --check
```

If the full suite exposes only a documented pre-existing failure, record exact command/output and prove the changed focused suites independently; do not relabel a new failure as pre-existing.

- [ ] **Step 6: Write the release-gate evidence.** Include all automated/physical rows, the measured worst-case kitchen delay behind a non-preempted report render, open hardware limitations, rollback evidence, and the exact canary decision. Do not claim paper confirmation on write-only devices.

- [ ] **Step 7: Commit:**

```bash
git add pos-spooler-printer/tests/v2-hostile-runtime.test.js backend/tests/manual/spoolerV2MixedJobsHarness.js docs/superpowers/evidence/2026-08-17-spooler-v2-release-gate.md docs/architecture.json docs/architecture.html docs/printing-runbook.md
git commit -m "test(spooler-v2): complete hostile, mixed-load, physical, and rollback release gates"
```

- [ ] **Step 8: Stop.** Do not merge, push, deploy, migrate production, rebuild customer installers, or activate a customer station without a new explicit instruction. After an explicitly authorized canary, retain V1 for two stable V2 releases before a separate reviewed removal.

---

## Optional Task 0 (OWNER-GATED, SKIPPED BY DEFAULT) — V1 fleet triage

**Skip unless the owner explicitly approves in the execution turn** (rev 2.1 "Optional Task 0"). If approved:

- [ ] **Step 1: RED test** in `backend/tests/integration/spoolerSocketTransport.test.js` — connect occupant A (spooler id `triage-exp`), then B with the same id: B receives **no** `spooler_rejected` event and is disconnected with reason `io server disconnect`; a client with the fielded handler shape (poll scheduler spy) keeps `disabled: false`.
- [ ] **Step 2:** In `server.js`'s spooler connection branch, delete only the line `socket.emit('spooler_rejected', { reason: registration.reason });` — keep the `logger.warn` and `socket.disconnect(true)`.
- [ ] **Step 3:** `npx vitest run backend/tests/integration/spoolerSocketTransport.test.js` to green.
- [ ] **Step 4:** Commit separately:

```bash
git add server.js backend/tests/integration/spoolerSocketTransport.test.js
git commit -m "fix(spooler): stop emitting spooler_rejected so fielded clients degrade to polling (interim triage, remove with V1)"
```

---

## Post-approval migration steps (BLOCKED on explicit owner approval — do not start without it)

1. After explicit approval, and before Task 12/canary, dispatch Luna to produce the Hostinger-safe `.auto.sql` from the verified draft (the two `CREATE TABLE IF NOT EXISTS` statements, the same three isolated `print_queue` ALTERs, the Gate-0-authorized isolated printer-profile ALTER if and only if that branch was proven, and ledger `INSERT INTO schema_migrations` as the final statement), the ordered manifest entry requiring the execution-time verified current predecessor/checksum, and the verbatim fallback block between `-- BEGIN/END AUTO MIGRATION` markers in `deployment/database/hostinger-manual-migrations.sql`.
2. Update `schemaValidation.js` `MIGRATION_NAME`/`MIGRATION_CHECKSUM` to the new tip in the same commit.
3. Verify: scratch-DB upgrade from the exact predecessor floor, manifest order/hash checks, fallback parity with `.auto.sql`, current-DB no-op where accessible. Fail closed on any checksum conflict.
4. This does not deploy anything; production application happens only on explicit instruction.

## Adversarial completion checklist

- [ ] Registration crash sequence (server row committed, response lost) heals via authenticated sync — proven by the idempotent-repeat test, and no code path returns a secret.
- [ ] `sent` rows never move to another claimant: no code path except `replaceAgent` and the agent's own sync touches a row whose `agent_id` is set — grep `print_queue` writers for `agent_id IS NOT NULL` violations.
- [ ] `local_accepted` is absent from every automatic claim predicate (V1 `claimPrintJobs`, V2 sync claim) — grep both SQL strings.
- [ ] `requestPrintJobCancellation` can never return `'canceled'` for a row whose payload may be on an agent (`sent` and beyond) — test-pinned.
- [ ] V1 claim and V2 prepare/register lock the same durable station row; socket, dispatcher, and poll cannot claim after `transitioning`/`v2`, and agent revocation never changes protocol.
- [ ] Concurrent syncs cannot over-claim — Promise.all test pins one distinct row at capacity 1.
- [ ] No V2 code emits to or reads from Socket.IO — grep the server V2 modules, `v2-server.js`, and `pos-spooler-printer/v2` for `io`, `print_job`, and the V1 poll route.
- [ ] The platform helper owns exactly one state-root mutex and is the only DPAPI/Winspool adapter; no secret is persisted or logged in plaintext.
- [ ] Every accepted local job has one atomic file; `transport_started` restart recovery is uncertain and never runnable.
- [ ] Renderer output is immutable, hashed, bounded, and complete before transport; a timeout closes/recycles the browser rather than merely racing it.
- [ ] Printer execution is serial per physical printer and independent across printers; probes never interleave bytes.
- [ ] The 50-job mixed harness accounts for all 50 ids with zero duplicate transport, cut, or loss and proves another-printer kitchen work is not blocked.
- [ ] Updater recovery preserves `spooler.env`, agent identity, journal, artifacts, archive, logs, and exact runtime/application layer identities at every phase.
- [ ] Full suite green exactly once against master baseline; build green; `npm run architecture:check` green; `git diff --check` clean.
- [ ] Nothing merged, pushed, deployed; migration chain untouched until the post-approval block is explicitly authorized.

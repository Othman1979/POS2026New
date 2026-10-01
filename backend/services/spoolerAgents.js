const crypto = require('crypto');
const { commitAndPublishSpoolerSyncWake } = require('./spoolerSyncWake');
const { appendAuditEvent } = require('./auditEvents');

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
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

// Live "this machine cannot register" signal for the admin health view. An agent
// stuck on station_mismatch retries every 10 s, so each refusal refreshes an entry
// here; one that stops retrying (healed, fixed, powered off) expires on its own. It
// is deliberately not stored in spooler_agents.last_error, which carries safety
// faults such as PRINTER_RECOVERY_REQUIRED, and needs no schema change or write.
const STATION_MISMATCH_TTL_MS = 60 * 1000;
const stationMismatches = new Map();
// Bumped only when the visible mismatch picture really changes (appears, changes
// station or kind, clears), so a route can announce it once instead of per request.
let stationMismatchVersion = 0;
const currentStationMismatchVersion = () => stationMismatchVersion;

// Station ids compare case-insensitively (the columns are utf8mb4_general_ci), so the
// map is keyed by the lower-cased id and carries the id as the agent spelled it.
const stationKey = spoolerId => String(spoolerId).toLowerCase();

// state: 'healing' (the agent will retry by itself) or 'blocked' (a person must act).
// Only an agent that says it is healing, and has nothing unfinished on the server, is
// believed; an older agent that says nothing cannot heal, so it counts as blocked.
function noteStationMismatch({ agentId, requestedStation, reportedState, serverUnfinished }) {
    if (!isValidAgentId(agentId) || !isValidStationId(requestedStation)) return;
    const state = reportedState === 'healing' && !(serverUnfinished > 0) ? 'healing' : 'blocked';
    const previous = stationMismatches.get(agentId);
    const station = String(requestedStation);
    const expired = previous && previous.at < Date.now() - STATION_MISMATCH_TTL_MS;
    if (!previous || expired || previous.state !== state || previous.requestedStation !== station) stationMismatchVersion += 1;
    stationMismatches.set(agentId, { requestedStation: station, state, at: Date.now() });
}

function clearStationMismatchForAgent(agentId) {
    if (stationMismatches.delete(agentId)) stationMismatchVersion += 1;
}

function clearStationMismatchForStation(spoolerId) {
    for (const [agentId, entry] of stationMismatches) {
        if (stationKey(entry.requestedStation) === stationKey(spoolerId)) {
            stationMismatches.delete(agentId);
            stationMismatchVersion += 1;
        }
    }
}

// Lower-cased station id -> { station, state } for entries seen within the TTL.
function activeStationMismatches() {
    const cutoff = Date.now() - STATION_MISMATCH_TTL_MS;
    const stations = new Map();
    for (const [agentId, entry] of stationMismatches) {
        if (entry.at < cutoff) {
            stationMismatches.delete(agentId);
            continue;
        }
        const key = stationKey(entry.requestedStation);
        const known = stations.get(key);
        if (!known || entry.state === 'blocked') stations.set(key, { station: entry.requestedStation, state: entry.state });
    }
    return stations;
}

// Rows the server has committed to this agent identity that are not settled. A saved
// identity must not be replaced while any exist, or their outcome is orphaned.
// idx_print_queue_agent_claim (agent_id, status, ...) serves this count.
async function countServerUnfinished(db, agentId) {
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS unfinished FROM print_queue
          WHERE agent_id = ? AND status IN ('processing','sent','local_accepted','cancel_requested')`,
        [agentId]
    );
    return Number(row.unfinished);
}

async function registerAgent(db, { agentId, spoolerId, tokenHash, name = '', agentVersion = null, reportedMismatchState = null }) {
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
        await conn.query(
            'SELECT spooler_id FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        const [[existing]] = await conn.query(
            'SELECT agent_id, spooler_id, token_hash, status, last_error FROM spooler_agents WHERE agent_id = ? FOR UPDATE',
            [agentId]
        );
        if (existing) {
            if (existing.token_hash !== tokenHash) {
                throw httpError(401, 'token_mismatch', 'Unknown agent credentials.');
            }
            if (existing.spooler_id !== spoolerId) {
                throw httpError(409, 'station_mismatch', 'Agent is bound to another station.');
            }
            await conn.commit();
            clearStationMismatchForStation(spoolerId);
            return { created: false, status: existing.status, stationProtocol: 'v2' };
        }
        const [[{ in_flight: inFlight }]] = await conn.query(
            `SELECT COUNT(*) AS in_flight FROM print_queue
              WHERE spooler_id = ? AND agent_id IS NULL AND status IN ('processing','sent')`,
            [spoolerId]
        );
        if (Number(inFlight) > 0) {
            throw httpError(409, 'station_busy', 'Un-owned in-flight work is still in progress for this station.');
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
        clearStationMismatchForStation(spoolerId);
        return { created: true, status: 'active', stationProtocol: 'v2' };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        if (error.code === 'station_mismatch') {
            // Count on the connection already held: a one-connection pool would otherwise
            // starve here and the agent would never see the count.
            try { error.serverUnfinished = await countServerUnfinished(conn, agentId); } catch (_) {}
            noteStationMismatch({ agentId, requestedStation: spoolerId, reportedState: reportedMismatchState, serverUnfinished: error.serverUnfinished });
        }
        if (error.code === 'ER_DUP_ENTRY') {
            throw httpError(409, 'station_occupied', 'This station already has an active agent.');
        }
        throw error;
    } finally {
        conn.release();
    }
}

async function authenticateAgent(db, { agentId, token }) {
    if (!isValidAgentId(agentId)) return null;
    const [[agent]] = await db.query(
        `SELECT a.agent_id, a.spooler_id, a.token_hash, a.status
           FROM spooler_agents a
          WHERE a.agent_id = ?`,
        [agentId]
    );
    if (!agent || !tokenMatchesHash(token, agent.token_hash)) return null;
    return agent;
}

async function getStationStatus(db, spoolerId) {
    if (!isValidStationId(spoolerId)) {
        throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    }
    const [[row]] = await db.query(
        `SELECT s.first_v2_accepted_at,
                a.agent_id, a.status AS agent_status, a.last_sync_at
           FROM spooler_stations s
           LEFT JOIN spooler_agents a
             ON a.spooler_id = s.spooler_id AND a.status IN ('active','draining')
          WHERE s.spooler_id = ?
          ORDER BY a.created_at DESC
          LIMIT 1`,
        [spoolerId]
    );
    if (!row) return { stationProtocol: 'v2', agentId: null, agentStatus: null, lastSyncAt: null, firstAcceptedAt: null };
    return {
        stationProtocol: 'v2',
        agentId: row.agent_id || null,
        agentStatus: row.agent_status || null,
        lastSyncAt: row.last_sync_at || null,
        firstAcceptedAt: row.first_v2_accepted_at || null
    };
}

const REACHABLE_WINDOW_SECONDS = 30;

async function requestAgentDrain(db, { spoolerId, actorUserId = null }) {
    if (!isValidStationId(spoolerId)) {
        throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            'SELECT spooler_id FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        const [[agent]] = await conn.query(
            "SELECT agent_id FROM spooler_agents WHERE spooler_id = ? AND status = 'active' FOR UPDATE",
            [spoolerId]
        );
        if (!agent) throw httpError(409, 'no_active_agent', 'This station has no active agent.');
        await conn.query("UPDATE spooler_agents SET status = 'draining' WHERE agent_id = ?", [agent.agent_id]);
        await appendAuditEvent(conn, {
            eventType: 'spooler_agent_drain_requested',
            userId: actorUserId,
            entityType: 'spooler_agent',
            oldValue: { agent_id: agent.agent_id, status: 'active' },
            newValue: { agent_id: agent.agent_id, status: 'draining' }
        });
        await commitAndPublishSpoolerSyncWake(conn);
        return { agentId: agent.agent_id, status: 'draining' };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

async function replaceAgent(db, { spoolerId, force = false, actorUserId = null }) {
    if (!isValidStationId(spoolerId)) {
        throw httpError(400, 'invalid_identity', 'A valid spooler_id is required.');
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            'SELECT spooler_id FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [spoolerId]
        );
        const [[agent]] = await conn.query(
            `SELECT agent_id, status, last_sync_at,
                    (last_sync_at IS NOT NULL AND last_sync_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)) AS recent
               FROM spooler_agents
              WHERE spooler_id = ? AND status IN ('active','draining') FOR UPDATE`,
            [REACHABLE_WINDOW_SECONDS, spoolerId]
        );
        if (!agent) throw httpError(409, 'no_active_agent', 'This station has no active agent.');
        if (!force) {
            if (Number(agent.recent) === 1) {
                throw httpError(409, 'agent_reachable', 'The current agent is reachable; use the drain flow.');
            }
            throw httpError(409, 'force_required', 'Confirm that the old terminal is stopped before forced replacement.');
        }

        await conn.query(
            "UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE agent_id = ?",
            [agent.agent_id]
        );
        const [terminalized] = await conn.query(
            `UPDATE print_queue
                SET status = 'dead_letter', claimed_by = NULL, locked_until = NULL, next_retry_at = NULL,
                    last_error = 'Agent replaced; outcome unknown. Resolve by audited manual reprint or cancel.',
                    last_error_code = 'AGENT_REPLACED_OUTCOME_UNKNOWN',
                    last_failure_class = 'uncertain', last_seen_at = UTC_TIMESTAMP()
              WHERE agent_id = ? AND status IN ('processing','sent','local_accepted','cancel_requested')`,
            [agent.agent_id]
        );
        await appendAuditEvent(conn, {
            eventType: 'spooler_agent_replaced',
            userId: actorUserId,
            entityType: 'spooler_agent',
            oldValue: { status: agent.status, spooler_id: spoolerId, agent_id: agent.agent_id },
            newValue: {
                status: 'revoked',
                agent_id: agent.agent_id,
                forced: true,
                terminalized: terminalized.affectedRows
            }
        });
        await commitAndPublishSpoolerSyncWake(conn);
        return { revokedAgentId: agent.agent_id, terminalizedCount: terminalized.affectedRows };
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

module.exports = {
    isValidAgentId,
    isValidStationId,
    isValidTokenHash,
    tokenMatchesHash,
    registerAgent,
    noteStationMismatch,
    clearStationMismatchForAgent,
    currentStationMismatchVersion,
    activeStationMismatches,
    countServerUnfinished,
    authenticateAgent,
    getStationStatus,
    requestAgentDrain,
    replaceAgent,
    httpError
};

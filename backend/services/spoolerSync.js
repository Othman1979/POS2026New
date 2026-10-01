const V2_LEASE_SECONDS = 120;
// Agents clamp this hint to [500, 5000]. Older agents do not, so the server-side
// clamp is load-bearing and must never advertise below 500.
const V2_NEXT_SYNC_MS = Math.min(
    Math.max(Number(process.env.SPOOLER_SYNC_INTERVAL_MS) || 500, 500),
    5000
);
const V2_IDLE_SYNC_MS = 5000;
const WORKING_AGENT_STATUSES = new Set(['active', 'draining']);
const TERMINAL = new Set(['acknowledged', 'dead_letter', 'canceled']);
const DEVICE_STATUSES = new Set(['unknown', 'ok', 'offline', 'paper_low', 'paper_out', 'cover_open', 'jammed', 'error']);
const HEALTH_STATES = new Set(['ready', 'starting', 'degraded', 'failed', 'paused', 'unknown']);
const RENDERERS = new Set(['typst', 'chromium']);
const TRANSPORT_MODES = new Set(['tcp', 'notification', 'poll', 'poll_fallback']);
const HEALTH_ERROR_RE = /^[A-Z0-9_:-]{1,64}$/;
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1000;
const { updatePrinterDeviceStatusesForStation, publishAcceptedStaffPrinterHealth } = require('./printerStatus');
const { updateAuditPrintStatus } = require('./auditPrintStatus');
const { conflictingPrinterIds } = require('./printerOwnership');
const { STATION_FRESH_MS } = require('./printQueueWatchdog');

// An unchanged agent row is not rewritten more often than this; every consumer reads
// last_sync_at through a 30 s window.
const AGENT_ROW_REFRESH_SECONDS = 10;
const STATION_FRESH_SECONDS = STATION_FRESH_MS / 1000;

const agentClaimant = agentId => `agent:${agentId}`;

async function requestPrintJobCancellation(db, queueId) {
    const [immediate] = await db.query(
        "UPDATE print_queue SET status = 'canceled', last_seen_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'",
        [queueId]
    );
    if (immediate.affectedRows > 0) return 'canceled';
    const [requested] = await db.query(
        "UPDATE print_queue SET status = 'cancel_requested', last_seen_at = UTC_TIMESTAMP() WHERE id = ? AND status IN ('sent','local_accepted')",
        [queueId]
    );
    if (requested.affectedRows > 0) return 'cancel_requested';
    const [[row]] = await db.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
    return row ? row.status : null;
}

function settleUpdate(outcome, failureClass) {
    if (outcome === 'completed') return { status: 'acknowledged' };
    if (outcome === 'canceled') return { status: 'canceled', requiresCancelRequested: true };
    if (outcome === 'permanent_failure') {
        return { status: 'dead_letter', failureClass: failureClass === 'uncertain' ? 'uncertain' : 'permanent_safe' };
    }
    if (outcome === 'uncertain') return { status: 'dead_letter', failureClass: 'uncertain' };
    return null;
}

// Spoolers from 1.2.23 render only nativeLayout (1.2.22 and older still render the compiled
// HTML/CSS through Chromium), so only those get the lean payload. The compiled markup stays in the
// stored payload for the browser preview and audits. The agent compares only the server-supplied
// payload_hash string and never rehashes the payload.
const NATIVE_ONLY_SPOOLER = [1, 2, 23];

function acceptsLeanPayload(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(String(version || '').trim());
    if (!match) return false;
    for (let i = 0; i < 3; i += 1) {
        const part = Number(match[i + 1]);
        if (part !== NATIVE_ONLY_SPOOLER[i]) return part > NATIVE_ONLY_SPOOLER[i];
    }
    return true;
}

function withoutCompiledMarkup(payload) {
    const compiled = payload?.data?.compiled_document_v1;
    if (!compiled || typeof compiled !== 'object' || (compiled.html === undefined && compiled.css === undefined)) return payload;
    const { html, css, ...native } = compiled;
    return { ...payload, data: { ...payload.data, compiled_document_v1: native } };
}

function parseQueueRow(row, lean) {
    const stored = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const payload = lean ? withoutCompiledMarkup(stored) : stored;
    return {
        ...payload,
        queue_id: row.id,
        idempotency_key: row.idempotency_key || payload.idempotency_key,
        payload_hash: row.payload_hash ?? null
    };
}

function normalizeHealthState(value) {
    const state = typeof value === 'object' && value !== null ? value.state : value;
    return HEALTH_STATES.has(state) ? state : 'unknown';
}

function normalizeHealthError(value) {
    const error = String(value || '').trim();
    return HEALTH_ERROR_RE.test(error) ? error : null;
}

function normalizeTiming(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > MAX_TIMING_MS) return null;
    return Math.round(number);
}

async function runAgentSync(db, agent, { accepted = [], results = [], health = {}, capacity = 0, kitchenCapacity = capacity, blockedPrinterIds = health?.blocked_printer_ids } = {}) {
    const shouldIngestHealth = health !== null;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            'SELECT spooler_id FROM spooler_stations WHERE spooler_id = ? FOR UPDATE',
            [agent.spooler_id]
        );
        const [[locked]] = await conn.query(
            'SELECT agent_id, spooler_id, status, agent_version, name, last_error, local_queue_depth, health_summary, last_sync_at, TIMESTAMPDIFF(SECOND, last_sync_at, UTC_TIMESTAMP()) AS sync_age_seconds FROM spooler_agents WHERE agent_id = ? FOR UPDATE',
            [agent.agent_id]
        );
        const response = {
            agentStatus: locked.status,
            stationProtocol: 'v2',
            confirmedAccepted: [],
            confirmedResults: [],
            cancelRequested: [],
            healthWarnings: [],
            blockedPrinterIds: [],
            jobs: [],
            nextSyncMs: WORKING_AGENT_STATUSES.has(locked.status) ? V2_NEXT_SYNC_MS : V2_IDLE_SYNC_MS,
            queueStateChanged: false,
            // Claims, accepts and a real printer-status change alter what the admin queue view
            // shows without settling a job; the route announces them as print_queue_updated.
            queueViewChanged: false,
            // First sync after the station was seen offline: the watchdog re-announces liveness.
            // Only working agents refresh last_sync_at, so a decommissioned agent that keeps
            // syncing must not wake the watchdog on every sync.
            stationRecovered: WORKING_AGENT_STATUSES.has(locked.status)
                && (locked.sync_age_seconds === null || Number(locked.sync_age_seconds) > STATION_FRESH_SECONDS)
        };

        let stationAcceptanceRecorded = false;
        const printedPrinterIds = new Set();
        for (const item of accepted) {
            const queueId = Number(item?.queue_id);
            if (!Number.isInteger(queueId) || queueId < 1) continue;
            const [moved] = await conn.query(
                `UPDATE print_queue
                    SET status = 'local_accepted',
                        accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP()),
                        locked_until = NULL
                  WHERE id = ? AND agent_id = ? AND status = 'sent'
                    AND (payload_hash IS NULL OR payload_hash = ?)`,
                [queueId, locked.agent_id, String(item?.payload_hash || '')]
            );
            if (moved.affectedRows > 0) {
                if (!stationAcceptanceRecorded) {
                    await conn.query(
                        'UPDATE spooler_stations SET first_v2_accepted_at = COALESCE(first_v2_accepted_at, UTC_TIMESTAMP()) WHERE spooler_id = ?',
                        [locked.spooler_id]
                    );
                    stationAcceptanceRecorded = true;
                }
                response.confirmedAccepted.push(queueId);
                response.queueViewChanged = true;
                continue;
            }
            const [[row]] = await conn.query('SELECT status, agent_id FROM print_queue WHERE id = ?', [queueId]);
            if (!row || row.agent_id !== locked.agent_id) continue;
            if (row.status === 'cancel_requested') {
                await conn.query(
                    'UPDATE print_queue SET accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP()) WHERE id = ?',
                    [queueId]
                );
                response.confirmedAccepted.push(queueId);
            } else if (row.status === 'local_accepted' || TERMINAL.has(row.status)) {
                response.confirmedAccepted.push(queueId);
            }
        }

        for (const item of results) {
            const queueId = Number(item?.queue_id);
            if (!Number.isInteger(queueId) || queueId < 1) continue;
            const update = settleUpdate(String(item?.outcome || ''), item?.failure_class);
            const [[row]] = await conn.query(
                'SELECT status, payload, agent_id, reprint_of_queue_id, printer_id FROM print_queue WHERE id = ?',
                [queueId]
            );
            if (!row) {
                if (update) response.confirmedResults.push(queueId);
                continue;
            }
            if (row.agent_id !== locked.agent_id) continue;
            if (TERMINAL.has(row.status)) {
                // The live acknowledgement already stamped the printer inside its settlement
                // transaction, so a replay must not: a late pre-move acknowledgement would
                // otherwise stamp a printer that has since moved.
                response.confirmedResults.push(queueId);
                continue;
            }
            if (!update) continue;
            if (update.requiresCancelRequested && row.status !== 'cancel_requested') continue;
            if (!update.requiresCancelRequested && !['local_accepted', 'cancel_requested'].includes(row.status)) continue;
            const artifactBytes = Number(item?.artifact_bytes);
            const [settled] = await conn.query(
                `UPDATE print_queue
                    SET status = ?, claimed_by = NULL, locked_until = NULL, next_retry_at = NULL,
                        acknowledged_at = CASE WHEN ? = 'acknowledged' THEN UTC_TIMESTAMP() ELSE acknowledged_at END,
                        last_error = ?, last_error_code = ?, last_failure_class = ?,
                        artifact_hash = ?, artifact_bytes = ?, device_status = ?, duration_ms = ?,
                        render_duration_ms = ?, local_duration_ms = ?, renderer = ?, transport_mode = ?,
                        spooler_version = ?, last_seen_at = UTC_TIMESTAMP()
                  WHERE id = ? AND agent_id = ?
                    AND status NOT IN ('acknowledged','dead_letter','canceled')`,
                [
                    update.status,
                    update.status,
                    item?.error_code ? String(item.error_code).slice(0, 1000) : null,
                    item?.error_code ? String(item.error_code).slice(0, 64) : null,
                    update.failureClass || null,
                    /^[0-9a-f]{64}$/.test(String(item?.artifact_hash || '')) ? String(item.artifact_hash) : null,
                    Number.isInteger(artifactBytes) && artifactBytes >= 0 && artifactBytes <= 16 * 1024 * 1024
                        ? artifactBytes
                        : null,
                    DEVICE_STATUSES.has(item?.device_status) ? item.device_status : 'unknown',
                    Number.isFinite(Number(item?.duration_ms)) ? Math.max(0, Number(item.duration_ms)) : null,
                    normalizeTiming(item?.render_duration_ms),
                    normalizeTiming(item?.local_duration_ms),
                    RENDERERS.has(item?.renderer) ? item.renderer : null,
                    TRANSPORT_MODES.has(item?.transport_mode) ? item.transport_mode : null,
                    health?.agent_version ? String(health.agent_version).slice(0, 64) : null,
                    queueId,
                    locked.agent_id
                ]
            );
            if (settled.affectedRows > 0) {
                response.confirmedResults.push(queueId);
                response.queueStateChanged = true;
                if (update.status === 'acknowledged' && row.printer_id) printedPrinterIds.add(Number(row.printer_id));
                const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
                await updateAuditPrintStatus(conn, payload, {
                    success: update.status === 'acknowledged',
                    error: item?.error_code || null
                });
                const parentId = Number(row.reprint_of_queue_id);
                if (update.status === 'acknowledged' && Number.isInteger(parentId) && parentId > 0) {
                    await conn.query(
                        `UPDATE print_queue
                            SET status = 'acknowledged',
                                acknowledged_at = COALESCE(acknowledged_at, UTC_TIMESTAMP()),
                                locked_until = NULL,
                                next_retry_at = NULL,
                                last_seen_at = UTC_TIMESTAMP()
                          WHERE id = ? AND status = 'dead_letter'`,
                        [parentId]
                    );
                }
            }
        }

        if (shouldIngestHealth && locked.status === 'draining' && health?.drain_complete === true && Number(health?.local_queue_depth) === 0) {
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
                response.nextSyncMs = V2_IDLE_SYNC_MS;
            }
        }

        const mayDeliverOwned = ['active', 'draining'].includes(locked.status);
        const mayClaimNew = locked.status === 'active';
        if (mayDeliverOwned) {
            response.blockedPrinterIds = await conflictingPrinterIds(conn, locked.spooler_id);
            const [cancels] = await conn.query(
                "SELECT id FROM print_queue WHERE agent_id = ? AND status = 'cancel_requested' ORDER BY id ASC",
                [locked.agent_id]
            );
            response.cancelRequested = cancels.map(row => row.id);

            const [replayRows] = await conn.query(
                `SELECT id, payload, idempotency_key, payload_hash, printer_id, print_type
                   FROM print_queue
                  WHERE agent_id = ? AND status = 'sent'
                  ORDER BY id ASC`,
                [locked.agent_id]
            );
            const requestedCapacity = Number(capacity);
            const boundedCapacity = Number.isFinite(requestedCapacity)
                ? Math.max(0, Math.min(Math.trunc(requestedCapacity), 50))
                : 0;
            const requestedKitchenCapacity = Number(kitchenCapacity);
            const boundedKitchenCapacity = Number.isFinite(requestedKitchenCapacity)
                ? Math.max(0, Math.min(Math.trunc(requestedKitchenCapacity), 50))
                : boundedCapacity;
            const totalRemaining = Math.max(0, boundedKitchenCapacity - replayRows.length);
            const generalRemaining = Math.max(0, boundedCapacity - replayRows.length);
            let claimedRows = [];
            const excludedIds = [...new Set([...(Array.isArray(blockedPrinterIds) ? blockedPrinterIds : [])
                .slice(0, 64).map(Number).filter(id => Number.isSafeInteger(id) && id > 0), ...response.blockedPrinterIds])];
            const blockedClause = excludedIds.length ? ' AND p.id NOT IN (?)' : '';
            const blockedValues = excludedIds.length ? [excludedIds] : [];
            if (mayClaimNew && totalRemaining > 0) {
                const [kitchenRows] = await conn.query(
                    `SELECT STRAIGHT_JOIN q.id, q.payload, q.idempotency_key, q.payload_hash, q.printer_id, q.print_type
                       FROM printers p
                       JOIN print_queue q FORCE INDEX (idx_print_queue_owner_claim)
                         ON q.printer_id = p.id
                      WHERE p.spooler_id = ? AND p.is_active = 1 AND q.agent_id IS NULL${blockedClause}
                        AND q.print_type = 'kitchen'
                        AND (q.status = 'pending'
                          OR (q.status = 'failed' AND (q.next_retry_at IS NULL OR q.next_retry_at <= UTC_TIMESTAMP())))
                      ORDER BY q.id ASC LIMIT ? FOR UPDATE`,
                    [locked.spooler_id, ...blockedValues, totalRemaining]
                );
                const ordinaryLimit = Math.min(generalRemaining, totalRemaining - kitchenRows.length);
                let ordinaryRows = [];
                if (ordinaryLimit > 0) {
                    [ordinaryRows] = await conn.query(
                        `SELECT STRAIGHT_JOIN q.id, q.payload, q.idempotency_key, q.payload_hash, q.printer_id, q.print_type
                           FROM printers p
                           JOIN print_queue q FORCE INDEX (idx_print_queue_owner_claim)
                             ON q.printer_id = p.id
                          WHERE p.spooler_id = ? AND p.is_active = 1 AND q.agent_id IS NULL${blockedClause}
                            AND (q.print_type IS NULL OR q.print_type <> 'kitchen')
                            AND (q.status = 'pending'
                              OR (q.status = 'failed' AND (q.next_retry_at IS NULL OR q.next_retry_at <= UTC_TIMESTAMP())))
                          ORDER BY q.id ASC LIMIT ? FOR UPDATE`,
                        [locked.spooler_id, ...blockedValues, ordinaryLimit]
                    );
                }
                claimedRows = [...kitchenRows, ...ordinaryRows];
                if (claimedRows.length > 0) {
                    response.queueViewChanged = true;
                    await conn.query(
                        `UPDATE print_queue
                            SET status = 'sent', claimed_by = ?, agent_id = ?, spooler_id = ?,
                                locked_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
                                attempts = COALESCE(attempts, 0) + 1,
                                first_attempt_at = COALESCE(first_attempt_at, UTC_TIMESTAMP()),
                                sent_at = COALESCE(sent_at, UTC_TIMESTAMP()),
                                last_seen_at = UTC_TIMESTAMP()
                          WHERE id IN (?)`,
                        [agentClaimant(locked.agent_id), locked.agent_id, locked.spooler_id, V2_LEASE_SECONDS, claimedRows.map(row => row.id)]
                    );
                }
            }
            const lean = acceptsLeanPayload(health?.agent_version || locked.agent_version);
            response.jobs = [...replayRows, ...claimedRows].map(row => parseQueueRow(row, lean));
        }

        let acceptedPrinterHealth = [];
        if (shouldIngestHealth && ['active', 'draining'].includes(locked.status)) {
            const statusResult = await updatePrinterDeviceStatusesForStation(conn, {
                spoolerId: locked.spooler_id,
                statuses: health?.printers,
                source: 'agent'
            });
            acceptedPrinterHealth = statusResult.accepted || [];
            if (statusResult.updated > 0) response.queueViewChanged = true;
            response.healthWarnings.push(...statusResult.warnings);
            const rawHealthError = String(health?.last_error || '').trim();
            const parsedHealthError = normalizeHealthError(rawHealthError);
            const recovered = health?.recovery_required === 0 && locked.last_error === 'PRINTER_RECOVERY_REQUIRED';
            const healthError = parsedHealthError || (recovered ? null : locked.last_error);
            if (rawHealthError && !healthError) response.healthWarnings.push('HEALTH_LAST_ERROR_INVALID');
            const localQueueDepth = Number(health?.local_queue_depth ?? health?.active);
            const rawAgentName = typeof health?.agent_name === 'string' ? health.agent_name.trim() : '';
            const agentName = rawAgentName ? rawAgentName.slice(0, 120) : null;
            const oldestJobAgeMs = Number(health?.oldest_local_job_age_ms);
            const quarantined = Number(health?.quarantined);
            const rejectedJobCodes = [...new Set((Array.isArray(health?.rejected_jobs) ? health.rejected_jobs : [])
                .map(row => String(row?.error_code || ''))
                .filter(code => ['JOB_IDENTITY_INVALID', 'PAYLOAD_IDENTITY_CONFLICT'].includes(code)))]
                .slice(0, 2);
            const healthSummary = JSON.stringify({
                renderer: normalizeHealthState(health?.renderer),
                helper: normalizeHealthState(health?.helper),
                oldest_local_job_age_ms: Number.isInteger(oldestJobAgeMs) && oldestJobAgeMs >= 0 && oldestJobAgeMs <= 31536000000
                    ? oldestJobAgeMs
                    : null,
                quarantined: Number.isInteger(quarantined) && quarantined >= 0 && quarantined <= 10000 ? quarantined : 0,
                rejected_job_codes: rejectedJobCodes,
                cleanup_error: health?.cleanup_error === 'JOURNAL_CLEANUP_FAILED' ? 'JOURNAL_CLEANUP_FAILED' : null
            });
            const nextDepth = Number.isInteger(localQueueDepth) && localQueueDepth >= 0 && localQueueDepth <= 10000 ? localQueueDepth : null;
            const nextVersion = typeof health?.agent_version === 'string' ? health.agent_version.slice(0, 40) : null;
            const storedSummary = typeof locked.health_summary === 'string' ? locked.health_summary : JSON.stringify(locked.health_summary);
            const unchanged = locked.sync_age_seconds !== null
                && Number(locked.sync_age_seconds) < AGENT_ROW_REFRESH_SECONDS
                && locked.local_queue_depth === nextDepth
                && storedSummary === healthSummary
                && (locked.last_error ?? null) === (healthError ?? null)
                && (nextVersion === null || nextVersion === locked.agent_version)
                && (agentName === null || agentName === locked.name);
            if (!unchanged) await conn.query(
                'UPDATE spooler_agents SET last_sync_at = UTC_TIMESTAMP(), local_queue_depth = ?, health_summary = ?, last_error = ?, agent_version = COALESCE(?, agent_version), name = COALESCE(?, name) WHERE agent_id = ?',
                [
                    nextDepth,
                    healthSummary,
                    healthError,
                    nextVersion,
                    agentName,
                    locked.agent_id
                ]
            );
        }
        // "Last printed" lives on the printer so it outlives the daily queue purge. One bounded
        // statement inside the settlement transaction, so the stamp commits or rolls back with the
        // acknowledgement. At most one write per printer per minute however many jobs settle. It is
        // a primary-key update of the few printers this sync settled; the station's claim SELECT
        // ... FOR UPDATE already locks the printers it claims from, and any other printer here is a
        // single-row PK update, so no new contention.
        if (printedPrinterIds.size > 0) {
            const [stamped] = await conn.query(
                `UPDATE printers SET last_printed_at = UTC_TIMESTAMP()
                  WHERE id IN (?) AND (last_printed_at IS NULL OR last_printed_at < UTC_TIMESTAMP() - INTERVAL 60 SECOND)`,
                [[...printedPrinterIds]]
            );
            if (Number(stamped?.affectedRows || 0) > 0) response.queueViewChanged = true;
        }
        await conn.commit();
        if (acceptedPrinterHealth.length > 0) publishAcceptedStaffPrinterHealth(acceptedPrinterHealth);
        return response;
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        throw error;
    } finally {
        conn.release();
    }
}

module.exports = {
    runAgentSync,
    requestPrintJobCancellation,
    agentClaimant,
    normalizeHealthState,
    normalizeHealthError,
    V2_NEXT_SYNC_MS,
    V2_IDLE_SYNC_MS
};

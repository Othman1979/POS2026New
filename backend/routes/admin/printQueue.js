const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const { getPrintQueueHealth, FAILED_BADGE_STATES, unresolvedFailedCondition, STATION_FRESH_MS } = require('../../services/printQueueWatchdog');
const { reprintQueueJob, REPRINTABLE_STATES } = require('../../services/printReprint');
const { NETWORK_OWNER_CONFLICT_SQL } = require('../../services/printerOwnership');
const { listPrinterStatuses } = require('../../services/printerStatus');
const { activeStationMismatches } = require('../../services/spoolerAgents');
const { requestPrintJobCancellation } = require('../../services/spoolerSync');
const { commitAndPublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
const { appendAuditEvent } = require('../../services/auditEvents');
const serverPackage = require('../../../package.json');

const STATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FRESH_SYNC_MS = STATION_FRESH_MS;
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1000;

function boundedMilliseconds(value) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= MAX_TIMING_MS ? number : null;
}

function elapsedMilliseconds(start, end) {
    if (!start || !end) return null;
    const elapsed = new Date(end).getTime() - new Date(start).getTime();
    return boundedMilliseconds(elapsed);
}

function summarizeTimings(values) {
    const sorted = values.map(boundedMilliseconds).filter(value => value !== null).sort((a, b) => a - b);
    const percentile = ratio => sorted.length === 0
        ? null
        : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
    return {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        sample_size: sorted.length
    };
}

function timingStages(rows) {
    const localOverhead = rows.map(row => {
        const local = boundedMilliseconds(row.local_duration_ms);
        const render = boundedMilliseconds(row.render_duration_ms);
        const transport = boundedMilliseconds(row.duration_ms);
        if (local === null || render === null || transport === null) return null;
        return Math.max(0, local - render - transport);
    });
    return {
        server_queue: summarizeTimings(rows.map(row => elapsedMilliseconds(row.created_at, row.sent_at))),
        server_to_local_accept: summarizeTimings(rows.map(row => elapsedMilliseconds(row.sent_at, row.accepted_at))),
        render: summarizeTimings(rows.map(row => row.render_duration_ms)),
        local_overhead: summarizeTimings(localOverhead),
        transport: summarizeTimings(rows.map(row => row.duration_ms)),
        local_total: summarizeTimings(rows.map(row => row.local_duration_ms)),
        end_to_end: summarizeTimings(rows.map(row => elapsedMilliseconds(row.created_at, row.acknowledged_at)))
    };
}

function groupedTimings(rows) {
    const groups = new Map();
    for (const row of rows) {
        const identity = [row.spooler_id, row.agent_id, row.printer_id, row.print_type, row.renderer, row.transport_mode]
            .map(value => value ?? '').join('\u0000');
        if (!groups.has(identity)) groups.set(identity, []);
        groups.get(identity).push(row);
    }
    return [...groups.values()].map(group => ({
        spooler_id: group[0].spooler_id || null,
        agent_id: group[0].agent_id || null,
        printer_id: group[0].printer_id == null ? null : Number(group[0].printer_id),
        print_type: group[0].print_type || null,
        renderer: group[0].renderer || null,
        transport_mode: group[0].transport_mode || null,
        sample_size: group.length,
        stages: timingStages(group)
    })).sort((left, right) => right.sample_size - left.sample_size
        || String(left.spooler_id).localeCompare(String(right.spooler_id))
        || Number(left.printer_id || 0) - Number(right.printer_id || 0));
}

function parseHealthSummary(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function stationIsOnline(lastSyncAt, agentStatus) {
    if (!['active', 'draining'].includes(agentStatus) || !lastSyncAt) return false;
    if (lastSyncAt instanceof Date) {
        const timestamp = lastSyncAt.getTime();
        return Number.isFinite(timestamp) && Date.now() - timestamp <= FRESH_SYNC_MS;
    }
    const normalized = String(lastSyncAt).includes('T') ? String(lastSyncAt) : String(lastSyncAt).replace(' ', 'T');
    const timestamp = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`).getTime();
    return Number.isFinite(timestamp) && Date.now() - timestamp <= FRESH_SYNC_MS;
}

async function listV2StationHealth() {
    const [conflicts] = await pool.query(`SELECT DISTINCT p.spooler_id FROM printers p WHERE p.is_active = 1 AND (${NETWORK_OWNER_CONFLICT_SQL})`);
    const conflictingStations = new Set(conflicts.map(row => row.spooler_id));
    // Stations a machine keeps asking to register for with an identity that belongs to
    // another station (a live signal, see spoolerAgents.activeStationMismatches).
    const mismatchedStations = activeStationMismatches();
    const [printerRows] = await pool.query('SELECT name, spooler_id FROM printers WHERE is_active = 1 ORDER BY name ASC');
    // Station ids are case-insensitive in the database (utf8mb4_general_ci), so every
    // join done here in JavaScript uses the lower-cased id.
    const stationKey = spoolerId => String(spoolerId).toLowerCase();
    const printerNamesByStation = new Map();
    for (const printer of printerRows) {
        const key = stationKey(printer.spooler_id);
        if (!printerNamesByStation.has(key)) printerNamesByStation.set(key, []);
        printerNamesByStation.get(key).push(printer.name);
    }
    const [rows] = await pool.query(`
        SELECT s.spooler_id, s.first_v2_accepted_at,
               a.agent_id, a.name AS agent_name, a.status AS agent_status, a.agent_version, a.last_sync_at,
               a.local_queue_depth, a.health_summary, a.last_error,
               COALESCE(activity.last_artifact_submission_at, NULL) AS last_artifact_submission_at,
               COALESCE(activity.last_acknowledged_at, NULL) AS last_acknowledged_at,
               COALESCE(unresolved.unresolved_count, 0) AS unresolved_count
          FROM spooler_stations s
          LEFT JOIN spooler_agents a
            ON a.spooler_id = s.spooler_id
           AND a.status IN ('active', 'draining')
          LEFT JOIN (
                SELECT spooler_id, MAX(accepted_at) AS last_artifact_submission_at,
                       MAX(acknowledged_at) AS last_acknowledged_at
                  FROM print_queue
                 WHERE spooler_id IS NOT NULL AND agent_id IS NOT NULL
                   AND (accepted_at IS NOT NULL OR acknowledged_at IS NOT NULL)
                   AND COALESCE(accepted_at, acknowledged_at) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
                 GROUP BY spooler_id
          ) activity ON activity.spooler_id = s.spooler_id
          LEFT JOIN (
                SELECT spooler_id, COUNT(*) AS unresolved_count
                  FROM print_queue
                 WHERE spooler_id IS NOT NULL AND agent_id IS NOT NULL
                   AND status IN ('processing', 'sent', 'local_accepted', 'cancel_requested')
                 GROUP BY spooler_id
          ) unresolved ON unresolved.spooler_id = s.spooler_id
         ORDER BY s.spooler_id ASC`);
    // A station named by a mismatch may have no station row yet (none is created until
    // an agent registers), but its printers still cannot print.
    for (const [key, { station }] of mismatchedStations) {
        if (!rows.some(row => stationKey(row.spooler_id) === key)) rows.push({ spooler_id: station });
    }
    return rows.map(row => {
        const summary = parseHealthSummary(row.health_summary);
        const agentStatus = row.agent_status || 'missing';
        const online = stationIsOnline(row.last_sync_at, agentStatus);
        return {
            spooler_id: row.spooler_id,
            agent_id: row.agent_id || null,
            // The printer form labels its station picker with this; it falls back to
            // the id, which is what an agent registers when SPOOLER_NAME is unset.
            name: row.agent_name || row.spooler_id,
            agent_status: agentStatus,
            agent_version: row.agent_version || null,
            last_sync_at: row.last_sync_at || null,
            online,
            paused: ['revoked', 'decommissioned', 'missing'].includes(agentStatus),
            local_queue_depth: Number.isInteger(Number(row.local_queue_depth)) ? Number(row.local_queue_depth) : null,
            oldest_local_job_age_ms: Number.isInteger(Number(summary.oldest_local_job_age_ms)) ? Number(summary.oldest_local_job_age_ms) : null,
            renderer: summary.renderer || 'unknown',
            helper: summary.helper || 'unknown',
            quarantined: Number.isInteger(Number(summary.quarantined)) ? Number(summary.quarantined) : 0,
            rejected_job_codes: Array.isArray(summary.rejected_job_codes) ? summary.rejected_job_codes.slice(0, 2) : [],
            cleanup_error: summary.cleanup_error === 'JOURNAL_CLEANUP_FAILED' ? summary.cleanup_error : null,
            last_error: conflictingStations.has(row.spooler_id) ? 'PRINTER_ENDPOINT_OWNERSHIP_CONFLICT' : row.last_error || null,
            // Separate from last_error so a recovery fault is never hidden by it.
            station_mismatch: mismatchedStations.has(stationKey(row.spooler_id)),
            // 'healing': the agent will retry by itself. 'blocked': a person has to act.
            station_mismatch_state: mismatchedStations.get(stationKey(row.spooler_id))?.state || null,
            printers: (printerNamesByStation.get(stationKey(row.spooler_id)) || []).slice(0, 20),
            last_artifact_submission_at: row.last_artifact_submission_at || null,
            last_acknowledged_at: row.last_acknowledged_at || null
        };
    });
}

async function listRecentQueueRows(limit = 25) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    const [rows] = await pool.query(
        `SELECT id, status, print_type, printer_id, device_status, attempts,
                max_attempts, created_at, sent_at, acknowledged_at, duration_ms,
                last_error, reprint_of_queue_id, spooler_version, spooler_id,
                agent_id, accepted_at, last_error_code, last_failure_class,
                artifact_hash, artifact_bytes, render_duration_ms, local_duration_ms,
                renderer, transport_mode
           FROM print_queue
          WHERE status IN ('pending', 'processing', 'sent', 'local_accepted', 'cancel_requested', 'failed', 'dead_letter', 'acknowledged')
          ORDER BY id DESC
          LIMIT ?`,
        [boundedLimit]
    );
    return rows.map(row => ({
        ...row,
        confidence: row.status === 'cancel_requested'
            ? 'cancel_requested'
            : row.status === 'local_accepted'
            ? 'stored_on_terminal'
            : row.status === 'acknowledged'
                ? 'bytes_sent'
                : 'unknown'
    }));
}

// "Last printed" is stamped on the printer when the server settles a job as acknowledged
// (printers.last_printed_at, so it survives the daily queue purge). The last error is one index
// seek per printer on (printer_id, status, locked_until, id). Dead letters settle in near id
// order, so the newest id is the last error; it is advisory, not an exact settlement clock.
async function listPrinterActivity(db) {
    const [rows] = await db.query(
        `SELECT p.id, p.last_printed_at, e.last_error_code, e.last_seen_at AS last_error_at
           FROM printers p
           LEFT JOIN print_queue e ON e.id = (
                SELECT q.id FROM print_queue q FORCE INDEX (idx_print_queue_owner_claim)
                 WHERE q.printer_id = p.id AND q.status = 'dead_letter' AND q.locked_until IS NULL
                 ORDER BY q.id DESC LIMIT 1)
          WHERE p.is_active = 1`
    );
    return new Map(rows.map(row => [Number(row.id), row]));
}

async function listPrintersWithActivity(db) {
    const [printers, activity] = await Promise.all([listPrinterStatuses(db), listPrinterActivity(db)]);
    return printers.map(printer => ({
        ...printer,
        last_printed_at: activity.get(Number(printer.id))?.last_printed_at || null,
        last_error_code: activity.get(Number(printer.id))?.last_error_code || null,
        last_error_at: activity.get(Number(printer.id))?.last_error_at || null
    }));
}

router.get('/print-queue/health', async (req, res, next) => {
    try {
        const summary = await getPrintQueueHealth(pool);
        const recent = await listRecentQueueRows(req.query.limit);
        const stations = await listV2StationHealth();
        const printers = await listPrintersWithActivity(pool);

        res.json({
            success: true,
            summary,
            recent,
            printers,
            spooler: {
                active: stations.some(station => station.online),
                count: stations.filter(station => station.online).length,
                socket_id: null
            },
            stations
        });
    } catch (err) {
        next(err);
    }
});

router.get('/print-queue/diagnostics', async (req, res, next) => {
    try {
        const [summary, printers, durableStations] = await Promise.all([
            getPrintQueueHealth(pool),
            listPrintersWithActivity(pool),
            listV2StationHealth()
        ]);
        const [timingRows] = await pool.query(
            `SELECT id, spooler_id, agent_id, printer_id, print_type,
                    created_at, sent_at, accepted_at, acknowledged_at,
                    duration_ms, render_duration_ms, local_duration_ms,
                    renderer, transport_mode
               FROM print_queue
              WHERE acknowledged_at IS NOT NULL
              ORDER BY id DESC LIMIT 1000`
        );
        const [errorRows] = await pool.query(
            `SELECT id, spooler_id, last_error_code, last_failure_class, device_status, created_at
               FROM print_queue
              WHERE last_error_code IS NOT NULL
              ORDER BY id DESC LIMIT 100`
        );
        const [artifactRows] = await pool.query(
            `SELECT id, spooler_id, artifact_hash, artifact_bytes, created_at
               FROM print_queue
              WHERE artifact_hash IS NOT NULL
              ORDER BY id DESC LIMIT 100`
        );
        const [queueStateRows] = await pool.query(
            `SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
               FROM print_queue
              GROUP BY status`
        );
        const now = Date.now();
        const queueCounts = queueStateRows.map(row => ({
            status: row.status,
            count: Number(row.count || 0),
            oldest_created_at: row.oldest_created_at || null
        }));
        const oldestAges = Object.fromEntries(queueCounts.map(row => [row.status, row.oldest_created_at
            ? Math.max(0, now - new Date(row.oldest_created_at).getTime())
            : null]));
        const stations = durableStations;
        const diagnostics = {
            generated_at: new Date().toISOString(),
            server_version: serverPackage.version,
            spooler_version: stations.find(station => station.agent_version)?.agent_version || null,
            stations,
            printers: printers.map(printer => ({
                id: printer.id,
                name: printer.name,
                role: printer.role,
                type: printer.type,
                spooler_id: printer.spooler_id,
                network_ip: printer.network_ip,
                network_port: printer.network_port,
                windows_name: printer.windows_name,
                status_capability: printer.status_capability,
                device_status: printer.device_status,
                status_checked_at: printer.status_checked_at,
                status_source: printer.status_source,
                last_printed_at: printer.last_printed_at,
                last_error_code: printer.last_error_code,
                last_error_at: printer.last_error_at
            })),
            queue: {
                counts: queueCounts,
                oldest_age_ms: oldestAges
            },
            timings_ms: {
                ...summarizeTimings(timingRows.map(row => row.duration_ms)),
                stages: timingStages(timingRows),
                groups: groupedTimings(timingRows)
            },
            errors: errorRows.map(row => ({
                queue_id: row.id,
                spooler_id: row.spooler_id,
                error_code: row.last_error_code,
                failure_class: row.last_failure_class,
                device_status: row.device_status,
                created_at: row.created_at
            })),
            artifacts: artifactRows.map(row => ({
                queue_id: row.id,
                spooler_id: row.spooler_id,
                artifact_hash: row.artifact_hash,
                artifact_bytes: row.artifact_bytes,
                created_at: row.created_at
            }))
        };
        res.setHeader('Content-Disposition', 'attachment; filename="print-queue-diagnostics.json"');
        res.json(diagnostics);
    } catch (err) {
        next(err);
    }
});

// Backs the POS failed-print bell. Deliberately narrow: the badge count already reaches
// the terminal over the `failed_print_jobs_count` socket event, so a cashier only fetches
// this when they open the panel. It reports the same states that count towards that badge,
// so the number on the bell and the rows behind it can never disagree.
//
// `reprintable` is computed here rather than in the UI. 'failed' rows are still being
// retried by the agent, so they are shown - a cashier needs to know the ticket exists -
// but they carry no reprint action, and the server would reject one anyway.
router.get('/print-queue/failed', async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            `SELECT q.id, q.print_type, q.status, q.attempts, q.max_attempts,
                    q.last_error_code, q.last_failure_class, q.created_at,
                    q.printer_id, q.reprint_of_queue_id,
                    p.name AS printer_name,
                    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.data.invoice_display_no')) AS invoice_display_no,
                    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.data.order_display_no')) AS order_display_no,
                    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.data.table_number')) AS table_number
               FROM print_queue q
               LEFT JOIN printers p ON p.id = q.printer_id
              WHERE ${unresolvedFailedCondition('q')}
              ORDER BY q.id DESC
              LIMIT 50`,
            [FAILED_BADGE_STATES]
        );
        res.json({
            success: true,
            jobs: rows.map(row => ({ ...row, reprintable: REPRINTABLE_STATES.includes(row.status) }))
        });
    } catch (err) {
        next(err);
    }
});

router.post('/print-queue/:queueId/reprint', async (req, res, next) => {
    try {
        const job = await reprintQueueJob(pool, {
            originalQueueId: req.params.queueId,
            user: req.user,
            reason: req.body?.reason,
            confirmUncertain: req.body?.confirm_uncertain === true,
            io: req.io
        });
        res.json({ success: true, job });
    } catch (err) {
        next(err);
    }
});

router.post('/print-queue/:queueId/cancel', async (req, res, next) => {
    const queueId = Number(req.params.queueId);
    if (!Number.isInteger(queueId) || queueId < 1) {
        return res.status(404).json({ success: false, code: 'PRINT_JOB_NOT_FOUND', message: 'Print job not found.' });
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[job]] = await conn.query('SELECT id, status FROM print_queue WHERE id = ? FOR UPDATE', [queueId]);
        if (!job) {
            const error = new Error('Print job not found.');
            error.code = 'PRINT_JOB_NOT_FOUND';
            error.statusCode = 404;
            throw error;
        }
        if (!['pending', 'sent', 'local_accepted'].includes(job.status)) {
            const error = new Error('Print job cannot be canceled in its current state.');
            error.code = 'PRINT_JOB_NOT_CANCELABLE';
            error.statusCode = 409;
            throw error;
        }
        const outcome = await requestPrintJobCancellation(conn, queueId);
        const eventType = outcome === 'canceled'
            ? 'spooler_print_job_canceled'
            : 'spooler_print_job_cancellation_requested';
        await appendAuditEvent(conn, {
            eventType,
            userId: req.user?.id ?? null,
            entityType: 'print_queue',
            entityId: queueId,
            oldValue: { queue_id: queueId, status: job.status },
            newValue: { queue_id: queueId, status: outcome }
        });
        if (outcome === 'cancel_requested') await commitAndPublishSpoolerSyncWake(conn);
        else await conn.commit();
        try {
            req.io?.to('staff').emit('print_queue_updated', { queueId, status: outcome });
        } catch (_) {
            // Browser notification is best-effort after the durable cancellation.
        }
        res.json({ success: true, queue_id: queueId, outcome });
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        if (err.statusCode) {
            return res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
        }
        next(err);
    } finally {
        conn.release();
    }
});

module.exports = router;

const WATCHED_STATES = ['pending', 'processing', 'sent', 'local_accepted', 'cancel_requested', 'failed', 'dead_letter'];
const FAILED_BADGE_STATES = ['failed', 'dead_letter'];
const DEFAULT_STALE_MS = 120000;
// A station that has not synced within this window shows Offline in the admin health view.
const STATION_FRESH_MS = 30 * 1000;

function normalizePrintQueueHealthRows(rows) {
    return rows.map(row => ({
        status: row.status,
        count: Number(row.count || 0),
        oldest_created_at: row.oldest_created_at || null
    }));
}

// A failed job that has been reprinted is represented by the newest retained row in that
// chain. Successful settlement acknowledges its direct parent, and the bounded purge
// reconciles any older dead-letter ancestors before acknowledged links expire. Until then,
// this condition prevents one print intent from appearing more than once in the badge.
//
// Existence of any reprint is the test, not its outcome. If the reprint also failed, the
// reprint row is itself failed and gets counted in the original's place, so the work
// surfaces exactly once; and a chain of reprints collapses to its newest link, which is
// the only one anybody can act on. The alias is caller-supplied code, never user input.
function unresolvedFailedCondition(alias = 'print_queue') {
    return `${alias}.status IN (?) AND NOT EXISTS (
                SELECT 1 FROM print_queue reprint WHERE reprint.reprint_of_queue_id = ${alias}.id
            )`;
}

async function getFailedPrintJobsCount(db) {
    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM print_queue WHERE ${unresolvedFailedCondition()}`,
            [FAILED_BADGE_STATES]
        );
        return Number(rows[0]?.count || 0);
    } catch (err) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return 0;
        throw err;
    }
}

// Latest failed-badge count seen by the server, so a connecting socket is answered from
// memory. Reads are numbered when they start: the watchdog and the post-settlement route
// read independently, and a read that started earlier must never overwrite the result of
// one that started later, whatever order they finish in.
// "Observed" is what the last read saw (answers connecting sockets); "published" is what the
// last successful publish delivered, so a failed emit is retried by the next refresh.
let latestFailedCount = null;
let publishedFailedCount = null;
let startedReads = 0;
let appliedRead = 0;
function getLatestFailedPrintJobsCount() {
    return latestFailedCount;
}
function recordFailedPrintJobsCount(count) {
    const next = Number(count);
    if (next === latestFailedCount) return false;
    latestFailedCount = next;
    return true;
}
// Reads the count, applies it unless a later-started read already landed, and calls
// publish(count) whenever the count differs from the last one published. If publish throws,
// the count stays unpublished and the error propagates. Returns the count it read.
async function refreshFailedPrintJobsCount(db, publish) {
    const read = ++startedReads;
    const count = await getFailedPrintJobsCount(db);
    if (read < appliedRead) return count;
    appliedRead = read;
    recordFailedPrintJobsCount(count);
    if (count !== publishedFailedCount) {
        publish?.(count);
        publishedFailedCount = count;
    }
    return count;
}
// Forget the cache and discard every read still in flight (they started before this).
function resetLatestFailedPrintJobsCount() {
    latestFailedCount = null;
    publishedFailedCount = null;
    appliedRead = startedReads + 1;
}

async function getPrintQueueHealth(db) {
    try {
        const [rows] = await db.query(
            `SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
               FROM print_queue
              WHERE status IN (?)
              GROUP BY status`,
            [WATCHED_STATES]
        );
        return normalizePrintQueueHealthRows(rows);
    } catch (err) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return [];
        throw err;
    }
}

function createPrintQueueHealthLogger(logger) {
    let lastSignature = '';
    return function logHealthChange(rows) {
        const signature = JSON.stringify(normalizePrintQueueHealthRows(rows));
        if (signature === lastSignature) return false;
        lastSignature = signature;
        logger.warn({ print_queue: JSON.parse(signature) }, 'Print queue health changed.');
        return true;
    };
}

async function getStalePrintStations(db, { staleMs = DEFAULT_STALE_MS } = {}) {
    const staleSeconds = Math.max(1, Math.round(Number(staleMs) / 1000));
    try {
        const [rows] = await db.query(
            // Driven from printers, NOT spooler_stations: a station row is only ever
            // created by registerAgent (spoolerAgents.js:32) and no FK requires one, so
            // joining through it would silently hide a printer whose agent never came up
            // - precisely the station whose work piles up unseen.
            `SELECT p.spooler_id, a.last_sync_at, COUNT(q.id) AS queued
               FROM printers p
               INNER JOIN print_queue q
                 ON q.printer_id = p.id
                AND q.status IN ('pending','sent','local_accepted','cancel_requested')
               LEFT JOIN spooler_agents a
                 ON a.spooler_id = p.spooler_id AND a.status IN ('active','draining')
              WHERE a.agent_id IS NULL
                 OR a.last_sync_at IS NULL
                 OR a.last_sync_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
              GROUP BY p.spooler_id, a.last_sync_at`,
            [staleSeconds]
        );
        return rows.map(row => ({
            spooler_id: row.spooler_id,
            last_sync_at: row.last_sync_at || null,
            queued: Number(row.queued || 0)
        }));
    } catch (err) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return [];
        throw err;
    }
}

// Which running stations the health view shows offline, and when the next online one would
// cross the line. Idle stations count too (unlike getStalePrintStations, which needs queued
// work), so a crashed idle station is announced by the same server-side pass.
async function getStationLiveness(db, { freshMs = STATION_FRESH_MS } = {}) {
    const freshSeconds = Math.round(freshMs / 1000);
    try {
        const [rows] = await db.query(
            `SELECT spooler_id, TIMESTAMPDIFF(SECOND, last_sync_at, UTC_TIMESTAMP()) AS age_seconds
               FROM spooler_agents
              WHERE status IN ('active','draining')`
        );
        const offline = [];
        let nextCheckMs = null;
        for (const row of rows) {
            const age = row.age_seconds === null || row.age_seconds === undefined ? null : Number(row.age_seconds);
            if (age === null || age > freshSeconds) {
                offline.push(String(row.spooler_id));
                continue;
            }
            const due = (freshSeconds - age + 1) * 1000;
            if (nextCheckMs === null || due < nextCheckMs) nextCheckMs = due;
        }
        return { offline: offline.sort(), nextCheckMs };
    } catch (err) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return { offline: [], nextCheckMs: null };
        throw err;
    }
}

function createStationLivenessBroadcaster(emit) {
    let lastSignature = null;
    return function broadcastIfChanged(offline) {
        const signature = offline.join(',');
        if (signature === lastSignature) return false;
        const first = lastSignature === null;
        lastSignature = signature;
        // The first pass only records the baseline; no client has a different view yet.
        if (first) return false;
        emit();
        return true;
    };
}

function stalePrintStationsSignature(stations) {
    return (Array.isArray(stations) ? stations : []).map(row => String(row.spooler_id)).sort().join(',');
}

function createStalePrintStationsBroadcaster(emit) {
    let lastSignature = null;
    return function broadcastIfChanged(stations) {
        const list = Array.isArray(stations) ? stations : [];
        const signature = stalePrintStationsSignature(list);
        if (signature === lastSignature) return false;
        lastSignature = signature;
        emit({ stations: list });
        return true;
    };
}

module.exports = {
    WATCHED_STATES,
    FAILED_BADGE_STATES,
    createPrintQueueHealthLogger,
    createStalePrintStationsBroadcaster,
    createStationLivenessBroadcaster,
    getStationLiveness,
    STATION_FRESH_MS,
    getFailedPrintJobsCount,
    getLatestFailedPrintJobsCount,
    recordFailedPrintJobsCount,
    refreshFailedPrintJobsCount,
    resetLatestFailedPrintJobsCount,
    unresolvedFailedCondition,
    getPrintQueueHealth,
    getStalePrintStations,
    normalizePrintQueueHealthRows
};

const { getBusinessDate, addBusinessDays, getBusinessDayRange, formatDbTimestamp } = require('../utils/businessDate');
const { CHECKOUT_PRINT_GRACE_MS } = require('./printJobIdentity');

const BATCH_SIZE = 500;
const STARTUP_DELAY_MS = 60_000;
const FULL_BATCH_DELAY_MS = 2_000;
const ERROR_RETRY_MS = 300_000;

function createPrintQueuePurge({
    db,
    logger,
    now = () => new Date(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
}) {
    let running = false;
    let timer = null;
    let inFlight = null;
    let cycleDeleted = 0;

    function currentTime() {
        const value = now();
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
            throw new Error('Print queue purge clock must return a valid Date.');
        }
        return value;
    }

    async function reconcileSuccessfulReprintParents() {
        const [rows] = await db.query(
            `SELECT parent.id
               FROM print_queue parent
               JOIN print_queue child ON child.reprint_of_queue_id = parent.id
              WHERE parent.status = 'dead_letter'
                AND child.status = 'acknowledged'
              LIMIT ${BATCH_SIZE}`
        );
        const ids = [...new Set(rows.map(row => Number(row.id)))]
            .filter(id => Number.isSafeInteger(id) && id > 0);
        if (!ids.length) return 0;
        await db.query(
            `UPDATE print_queue
                SET status = 'acknowledged',
                    acknowledged_at = COALESCE(acknowledged_at, UTC_TIMESTAMP()),
                    locked_until = NULL,
                    next_retry_at = NULL,
                    last_seen_at = UTC_TIMESTAMP()
              WHERE id IN (?) AND status = 'dead_letter'`,
            [ids]
        );
        return ids.length;
    }

    async function runMaintenanceBatch() {
        const reconciled = await reconcileSuccessfulReprintParents();
        if (reconciled > 0) return { deleted: 0, reconciled };
        // Keep rows inside the checkout-print grace too, so a receipt printed just before the
        // cutoff still deduplicates a replay of its checkout id (print.js isFirstCheckoutPrint).
        const dayStart = getBusinessDayRange(getBusinessDate(currentTime())).start;
        const graceEdge = formatDbTimestamp(new Date(currentTime().getTime() - CHECKOUT_PRINT_GRACE_MS));
        const cutoff = graceEdge < dayStart ? graceEdge : dayStart;
        const [result] = await db.query(
            `DELETE FROM print_queue
              WHERE status='acknowledged'
                AND created_at < ?
                AND acknowledged_at IS NOT NULL
                AND acknowledged_at < ?
              ORDER BY created_at,id
              LIMIT ${BATCH_SIZE}`,
            [cutoff, cutoff]
        );
        return { deleted: Number(result?.affectedRows) || 0, reconciled: 0 };
    }

    async function runBatch() {
        const { deleted } = await runMaintenanceBatch();
        return deleted;
    }

    function nextBoundaryDelay() {
        const current = currentTime();
        const nextBusinessDate = addBusinessDays(getBusinessDate(current), 1);
        const nextStartSql = getBusinessDayRange(nextBusinessDate).start;
        const nextStartMs = Date.parse(`${nextStartSql.replace(' ', 'T')}Z`);
        return Math.max(1000, nextStartMs - current.getTime() + 60_000);
    }

    function logCycle() {
        if (cycleDeleted > 0) {
            logger.info?.({ deleted: cycleDeleted }, 'Acknowledged print queue purge completed.');
        }
        cycleDeleted = 0;
    }

    function schedule(delay) {
        if (!running || timer !== null) return;
        timer = setTimeoutFn(() => {
            timer = null;
            if (!running || inFlight) return undefined;
            inFlight = (async () => {
                try {
                    const { deleted, reconciled } = await runMaintenanceBatch();
                    cycleDeleted += deleted;
                    if (!running) {
                        logCycle();
                        return;
                    }
                    if (reconciled > 0 || deleted === BATCH_SIZE) {
                        schedule(FULL_BATCH_DELAY_MS);
                    } else {
                        logCycle();
                        schedule(nextBoundaryDelay());
                    }
                } catch (error) {
                    logCycle();
                    logger.warn?.({ err: error }, 'Acknowledged print queue purge failed.');
                    if (running) schedule(ERROR_RETRY_MS);
                } finally {
                    inFlight = null;
                }
            })();
            return inFlight;
        }, delay);
        timer?.unref?.();
    }

    function start() {
        if (running) return;
        running = true;
        schedule(STARTUP_DELAY_MS);
    }

    async function stop() {
        running = false;
        if (timer !== null) {
            clearTimeoutFn(timer);
            timer = null;
        }
        if (inFlight) await inFlight;
    }

    return { start, stop, runBatch };
}

module.exports = { createPrintQueuePurge };

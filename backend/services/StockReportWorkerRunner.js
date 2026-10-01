'use strict';

const generations = require('./StockReportGenerationService');
const worker = require('./StockReportWorker');
const { hasSourcePressure } = require('./StockReportInvalidation');

const PENDING_MS = 500;
const IDLE_MS = 10_000;

function createStockReportWorkerRunner({
    pool,
    logger,
    ensureCoverage = (nextPool, period) => generations.ensureCoverage(nextPool, period),
    runOne = (nextPool, options) => worker.runOne(nextPool, options),
    sourcePressure = hasSourcePressure,
    isEnabled = async nextPool => {
        const [rows] = await nextPool.query("SELECT setting_value FROM settings WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        return rows.some(row => row.setting_value === '1');
    },
    backfillBalances = (nextPool,afterId) => require('./RecipeLedgerService').backfillWorkingBalances(nextPool,{afterId}),
    backfillNeeded = async nextPool => {
        const [[row]] = await nextPool.query(`SELECT
            EXISTS(SELECT 1 FROM stock_report_backfill WHERE complete=0) OR
            EXISTS(SELECT 1 FROM ingredients WHERE working_initialized=0) AS needed`);
        return Boolean(Number(row.needed));
    },
    pendingMs = PENDING_MS,
    idleMs = IDLE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
} = {}) {
    let started = false;
    let timer = null;
    let inFlight = null;
    let abort = null;
    let covered = false;
    let balanceAfterId = 0;

    function clearTimer() {
        if (timer === null) return;
        clearTimeoutFn(timer);
        timer = null;
    }

    function schedule(delay) {
        if (!started) return;
        clearTimer();
        timer = setTimeoutFn(() => {
            timer = null;
            return tick();
        }, delay);
        timer?.unref?.();
    }

    async function tick() {
        if (!started) return undefined;
        if (inFlight) return inFlight;
        abort = new AbortController();
        const request = (async () => {
            try {
                if (sourcePressure()) return {status:'deferred'};
                if (!await isEnabled(pool)) { covered = false; balanceAfterId = 0; return {status:'disabled'}; }
                if (covered && await backfillNeeded(pool)) {
                    covered = false;
                    // Covers new ingredients and restored/reset identities below the old cursor.
                    balanceAfterId = 0;
                }
                if (!covered) {
                    const coverage=await ensureCoverage(pool, {});
                    const balances=await backfillBalances(pool,balanceAfterId);
                    if(balances.after_id!=null)balanceAfterId=balances.after_id;
                    covered = coverage.complete !== false && balances.complete !== false;
                    if (!covered) return {status:'backfill'};
                }
                return await runOne(pool, { signal: abort.signal });
            } catch (error) {
                if (abort.signal.aborted) return { status: 'cancelled' };
                logger.warn({ err: error }, 'Stock report worker failed.');
                covered = false;
                return { status: 'error' };
            }
        })();
        inFlight = request;
        let result;
        try {
            result = await request;
        } finally {
            if (inFlight === request) inFlight = null;
            abort = null;
        }
        if (!started) return result;
        const pending = result?.status && !['idle', 'cleaned', 'cancelled', 'error', 'disabled'].includes(result.status);
        schedule(pending ? pendingMs : idleMs);
        return result;
    }

    function start() {
        if (started) return inFlight || Promise.resolve(undefined);
        started = true;
        covered = false;
        balanceAfterId = 0;
        return tick();
    }

    async function stop() {
        if (!started && !inFlight) return;
        started = false;
        clearTimer();
        abort?.abort();
        if (inFlight) await inFlight.catch(() => {});
    }

    return { start, stop };
}

module.exports = { createStockReportWorkerRunner };

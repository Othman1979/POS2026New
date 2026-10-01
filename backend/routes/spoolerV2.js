const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const logger = require('../config/logger');
const {
    registerAgent,
    noteStationMismatch,
    clearStationMismatchForAgent,
    currentStationMismatchVersion,
    countServerUnfinished,
    authenticateAgent,
    getStationStatus
} = require('../services/spoolerAgents');
const { runAgentSync, V2_NEXT_SYNC_MS } = require('../services/spoolerSync');
const { refreshFailedPrintJobsCount } = require('../services/printQueueWatchdog');
const { spoolerSyncWakeHub } = require('../services/spoolerSyncWake');

const router = express.Router();

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

const syncRateLimits = new Map();
const SYNC_WINDOW_MS = 10000;
// A 500 ms steady cadence spends 20 requests per window. Keep three more shares for
// prompt accept/result traffic during a rush.
const SYNC_MAX = 80;
const V2_THROTTLE_SYNC_MS = Math.max(2000, V2_NEXT_SYNC_MS);
const SYNC_BATCH_MAX = 100;
// Idle agents hold for up to 6 s: 6 s hold + 2 s reserve for a follow-up sync stays inside the
// 9 s response budget and the agent's 10 s request timeout. Older agents ask for 1.5 s.
const V2_SYNC_WAIT_MAX_MS = 6000;
const V2_POST_HOLD_SYNC_MS = 500;
const V2_SYNC_RESPONSE_BUDGET_MS = 9000;
const V2_SECOND_SYNC_RESERVE_MS = 2000;

function boundedWaitMs(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) return 0;
    return Math.min(parsed, V2_SYNC_WAIT_MAX_MS);
}

function boundedCapacity(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(Math.trunc(parsed), 50)) : 0;
}

function mayHoldIdleSync(syncBody, result) {
    return syncBody.waitMs > 0
        && syncBody.accepted.length === 0
        && syncBody.results.length === 0
        && Number(syncBody.health?.local_queue_depth) === 0
        && Number(syncBody.health?.worker_active) === 0
        && (syncBody.capacity > 0 || syncBody.kitchenCapacity > 0)
        && ['active', 'draining'].includes(result.agentStatus)
        && result.confirmedAccepted.length === 0
        && result.confirmedResults.length === 0
        && result.cancelRequested.length === 0
        && result.healthWarnings.length === 0
        && result.jobs.length === 0
        && result.queueStateChanged === false;
}

async function orchestrateAgentSync({ agent, syncBody, signal, elapsedMs, syncFn, wakeHub }) {
    const since = wakeHub.generation();
    const first = await syncFn(agent, {
        accepted: syncBody.accepted,
        results: syncBody.results,
        health: syncBody.health,
        capacity: syncBody.capacity,
        kitchenCapacity: syncBody.kitchenCapacity
    });
    if (signal.aborted) return { result: first, held: false, aborted: true };
    if (!mayHoldIdleSync(syncBody, first)) return { result: first, held: false, aborted: false };

    const holdMs = Math.min(
        syncBody.waitMs,
        Math.max(0, V2_SYNC_RESPONSE_BUDGET_MS - V2_SECOND_SYNC_RESERVE_MS - elapsedMs())
    );
    if (holdMs <= 0) return { result: first, held: false, aborted: false };

    const reason = await wakeHub.waitForChange(agent.agent_id, since, { timeoutMs: holdMs, signal });
    // `idleHeld` tells current agents a full idle hold elapsed with nothing to do, so they
    // re-poll at once instead of waiting a cadence. Older agents ignore it.
    const recovery = { ...first, nextSyncMs: V2_POST_HOLD_SYNC_MS, idleHeld: reason === 'timeout' };
    if (signal.aborted) return { result: recovery, held: true, aborted: true };
    if (reason !== 'changed') return { result: recovery, held: true, aborted: false };
    if (V2_SYNC_RESPONSE_BUDGET_MS - elapsedMs() < V2_SECOND_SYNC_RESERVE_MS) {
        return { result: recovery, held: true, aborted: false };
    }

    const second = await syncFn(agent, {
        accepted: [],
        results: [],
        health: null,
        blockedPrinterIds: syncBody.health?.blocked_printer_ids,
        capacity: syncBody.capacity,
        kitchenCapacity: syncBody.kitchenCapacity
    });
    return {
        result: {
            ...second,
            // What the first pass changed (a printer status, a recovered station) is still owed to staff.
            queueViewChanged: Boolean(first.queueViewChanged || second.queueViewChanged),
            stationRecovered: Boolean(first.stationRecovered),
            nextSyncMs: V2_POST_HOLD_SYNC_MS
        },
        held: true,
        aborted: signal.aborted
    };
}

function spoolerSyncLifecycle(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const controller = new AbortController();
    const startedAt = Number.isFinite(req.spoolerSyncStartedAt) ? req.spoolerSyncStartedAt : performance.now();
    const cleanup = () => {
        req.off('aborted', abort);
        res.off('finish', cleanup);
        res.off('close', close);
    };
    const abort = () => {
        if (!controller.signal.aborted) controller.abort();
        cleanup();
    };
    const close = () => {
        if (!res.writableEnded) abort();
        else cleanup();
    };
    req.once('aborted', abort);
    res.once('finish', cleanup);
    res.once('close', close);
    req.spoolerSyncLifecycle = {
        signal: controller.signal,
        elapsedMs: () => performance.now() - startedAt
    };
    if (req.aborted) return abort();
    next();
}

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
            station_protocol: 'v2',
            confirmed_accepted: [],
            confirmed_results: [],
            cancel_requested: [],
            health_warnings: [],
            jobs: [],
            next_sync_ms: V2_THROTTLE_SYNC_MS
        });
    }
    next();
}

// Admin screens learn about a mismatch appearing, changing or clearing from the same
// staff signal as queue changes. Only a real change of the stored state announces.
function announceMismatchChange(req, versionBefore) {
    if (currentStationMismatchVersion() === versionBefore) return;
    try {
        req.io?.to('staff').emit('print_queue_updated', { source: 'station_mismatch' });
    } catch (error) {
        logger.warn({ err: error }, 'Failed to publish station mismatch update.');
    }
}

router.post('/register', requireBootstrapKey, async (req, res, next) => {
    const versionBefore = currentStationMismatchVersion();
    res.once('finish', () => announceMismatchChange(req, versionBefore));
    try {
        if (Number(req.body?.protocol_version) !== 2) {
            return res.status(400).json({ success: false, code: 'unsupported_protocol' });
        }
        const result = await registerAgent(pool, {
            agentId: req.body?.agent_id,
            spoolerId: req.body?.spooler_id,
            tokenHash: req.body?.token_hash,
            name: req.body?.name,
            agentVersion: req.body?.agent_version,
            reportedMismatchState: req.body?.mismatch_state
        });
        res.status(result.created ? 201 : 200).json({
            success: true,
            status: result.status,
            station_protocol: result.stationProtocol
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, code: error.code, server_unfinished: error.serverUnfinished });
        }
        next(error);
    }
});

router.post('/status', requireBootstrapKey, async (req, res, next) => {
    try {
        const result = await getStationStatus(pool, req.body?.spooler_id);
        res.json({
            success: true,
            station_protocol: result.stationProtocol,
            agent_id: result.agentId,
            agent_status: result.agentStatus,
            last_sync_at: result.lastSyncAt,
            first_v2_accepted_at: result.firstAcceptedAt
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
    } catch (error) {
        next(error);
    }
}

async function requireConfiguredStation(req, res, next) {
    const versionBefore = currentStationMismatchVersion();
    const submitted = req.body?.spooler_id;
    // Agents released before this field is temporarily omitted continue working.
    // Every current agent sends it, so changing SPOOLER_ID while retaining an old
    // agent.json fails before rate limiting, settlement, health writes, or claims.
    if (submitted != null && String(submitted) !== String(req.agent.spooler_id)) {
        // Tell the agent how much work the server still holds for this identity, so it
        // never swaps identity while a claimed job's outcome could be orphaned. When the
        // count cannot be read the field is omitted and the agent treats that as unknown.
        let serverUnfinished;
        try { serverUnfinished = await countServerUnfinished(pool, req.agent.agent_id); } catch (error) {
            logger.warn({ err: error }, 'Failed to count unfinished work for a station mismatch.');
        }
        noteStationMismatch({
            agentId: req.agent.agent_id,
            requestedStation: submitted,
            reportedState: req.body?.mismatch_state,
            serverUnfinished
        });
        announceMismatchChange(req, versionBefore);
        return res.status(409).json({ success: false, code: 'station_mismatch', server_unfinished: serverUnfinished });
    }
    clearStationMismatchForAgent(req.agent.agent_id);
    announceMismatchChange(req, versionBefore);
    next();
}

router.post('/sync', spoolerSyncLifecycle, requireAgentAuth, requireConfiguredStation, agentRateLimit, async (req, res, next) => {
    try {
        if (Number(req.body?.protocol_version) !== 2) {
            return res.status(400).json({ success: false, code: 'unsupported_protocol' });
        }
        const syncBody = {
            waitMs: boundedWaitMs(req.body?.wait_ms),
            accepted: Array.isArray(req.body?.accepted) ? req.body.accepted.slice(0, SYNC_BATCH_MAX) : [],
            results: Array.isArray(req.body?.results) ? req.body.results.slice(0, SYNC_BATCH_MAX) : [],
            health: req.body?.health || {},
            capacity: boundedCapacity(req.body?.capacity),
            kitchenCapacity: req.body?.kitchen_capacity === undefined
                ? boundedCapacity(req.body?.capacity)
                : boundedCapacity(req.body?.kitchen_capacity)
        };
        const outcome = await orchestrateAgentSync({
            agent: req.agent,
            syncBody,
            signal: req.spoolerSyncLifecycle.signal,
            elapsedMs: req.spoolerSyncLifecycle.elapsedMs,
            syncFn: (agent, input) => runAgentSync(pool, agent, input),
            wakeHub: spoolerSyncWakeHub
        });
        const result = outcome.result;
        const queueActivity = result.queueStateChanged
            || result.jobs.length > 0
            || result.cancelRequested.length > 0
            || result.confirmedAccepted.length > 0
            || result.queueViewChanged
            || result.stationRecovered;
        if (queueActivity) req.app.get('printQueueWatchdog')?.wake();
        if (result.queueStateChanged || result.queueViewChanged) {
            try {
                req.io?.to('staff').emit('print_queue_updated', {
                    source: result.queueStateChanged ? 'agent_settlement' : 'agent_activity'
                });
            } catch (error) {
                logger.warn({ err: error }, 'Failed to publish print queue update.');
            }
        }
        if (outcome.aborted || res.writableEnded) return;
        // Deliver committed claims before unrelated staff badge I/O can delay them.
        res.json({
            success: true,
            agent_status: result.agentStatus,
            station_protocol: 'v2',
            confirmed_accepted: result.confirmedAccepted,
            confirmed_results: result.confirmedResults,
            cancel_requested: result.cancelRequested,
            health_warnings: result.healthWarnings,
            blocked_printer_ids: result.blockedPrinterIds || [],
            jobs: result.jobs,
            next_sync_ms: result.nextSyncMs,
            ...(result.idleHeld ? { held: true } : {})
        });
        if (result.queueStateChanged && req.io) {
            try {
                await refreshFailedPrintJobsCount(pool, count => req.io.to('staff').emit('failed_print_jobs_count', count));
            } catch (error) {
                logger.error({ err: error }, 'Failed to publish settled print queue count.');
            }
        }
    } catch (error) {
        next(error);
    }
});

module.exports = {
    router,
    requireBootstrapKey,
    requireAgentAuth,
    requireConfiguredStation,
    agentRateLimit,
    orchestrateAgentSync,
    spoolerSyncLifecycle,
    boundedWaitMs,
    boundedCapacity,
    SYNC_MAX,
    SYNC_WINDOW_MS,
    V2_THROTTLE_SYNC_MS,
    V2_SYNC_WAIT_MAX_MS,
    V2_POST_HOLD_SYNC_MS,
    V2_SYNC_RESPONSE_BUDGET_MS,
    V2_SECOND_SYNC_RESERVE_MS
};

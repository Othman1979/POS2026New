const diagnosticsChannel = require('node:diagnostics_channel');
const { attachDatabasePoolAcquireTimeout } = require('./databasePoolAcquireTimeout');

const COMMAND_DISCONNECT_CODES = new Set([
    'ECONNABORTED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETRESET',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_SEQUENCE_TIMEOUT'
]);

function isCommandDisconnect(error) {
    return Boolean(error?.fatal) || COMMAND_DISCONNECT_CODES.has(String(error?.code || ''));
}

function createDatabaseRuntime({
    mysql,
    poolOptions,
    logger,
    attachAcquireTimeout = attachDatabasePoolAcquireTimeout,
    maintenance = {}
}) {
    const corePool = mysql.createPool(poolOptions);
    attachAcquireTimeout(corePool, { logger });
    const pool = corePool.promise();
    const leased = new Set();
    const probeConnections = new Set();
    const openConnections = new Set();
    const counters = {
        created: 0,
        acquired: 0,
        released: 0,
        enqueued: 0,
        connectionErrors: 0,
        idleDisconnects: 0,
        activeDisconnects: 0,
        commandDisconnects: 0,
        probeDisconnects: 0,
        probeAttempts: 0,
        probeSuccesses: 0,
        probeFailures: 0,
        peakInUse: 0
    };
    const quietIntervalMs = maintenance.quietIntervalMs ?? 30_000;
    const pingTimeoutMs = maintenance.pingTimeoutMs ?? 3_000;
    const retryDelayMs = maintenance.retryDelayMs ?? 500;
    const degradedIntervalMs = maintenance.degradedIntervalMs ?? 5_000;
    const setTimeoutFn = maintenance.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = maintenance.clearTimeoutFn ?? clearTimeout;
    const now = maintenance.now ?? Date.now;

    let started = false;
    let maintenanceStopped = true;
    let state = 'stopped';
    let lastSuccessAt = null;
    let lastFailureAt = null;
    let timer = null;
    let retryTimer = null;
    let resolveRetry = null;
    let inFlightProbe = null;
    let lastActivityAt = now();
    const seenCommandFailureContexts = new WeakSet();

    const commandTraceHandlers = (operation) => ({
        start() {},
        end() {},
        asyncStart() {},
        asyncEnd() {},
        error(context) {
            if (!started || !context || typeof context !== 'object' ||
                seenCommandFailureContexts.has(context) || !isCommandDisconnect(context.error)) return;
            seenCommandFailureContexts.add(context);
            counters.commandDisconnects += 1;
            const error = context.error;
            try {
                logger?.error?.({
                    event: 'database_command_connection_error',
                    operation,
                    code: String(error?.code || 'UNKNOWN'),
                    fatal: Boolean(error?.fatal),
                    pid: process.pid,
                    uptime_seconds: Math.floor(process.uptime())
                }, 'Database command failed because its connection was lost.');
            } catch (_) {
                // Diagnostics must never interfere with the command's own rejection path.
            }
        }
    });
    const commandTraces = [
        {
            channel: diagnosticsChannel.tracingChannel('mysql2:query'),
            handlers: commandTraceHandlers('query')
        },
        {
            channel: diagnosticsChannel.tracingChannel('mysql2:execute'),
            handlers: commandTraceHandlers('execute')
        }
    ];

    const snapshot = () => Object.freeze({
        ...counters,
        inUse: leased.size,
        openConnections: openConnections.size,
        state,
        lastSuccessAt,
        lastFailureAt
    });

    corePool.on('connection', (connection) => {
        counters.created += 1;
        openConnections.add(connection);
        let removed = false;
        const markRemoved = () => {
            if (removed) return;
            removed = true;
            openConnections.delete(connection);
            leased.delete(connection);
            probeConnections.delete(connection);
        };
        connection.once('end', markRemoved);
        connection.on('error', (error) => {
            counters.connectionErrors += 1;
            const code = String(error?.code || 'UNKNOWN');
            const fatal = Boolean(error?.fatal);
            if (probeConnections.has(connection)) {
                counters.probeDisconnects += 1;
            } else if (leased.has(connection)) {
                counters.activeDisconnects += 1;
                logger?.warn({
                    event: 'database_active_connection_error', code, fatal,
                    pid: process.pid, uptime_seconds: Math.floor(process.uptime())
                }, 'Active database connection failed.');
            } else {
                counters.idleDisconnects += 1;
                logger?.debug?.({
                    event: 'database_idle_connection_closed', code, fatal,
                    pid: process.pid, uptime_seconds: Math.floor(process.uptime())
                }, 'Idle database connection closed.');
            }
            markRemoved();
        });
        connection.query("SET time_zone = '+00:00'");
    });
    corePool.on('acquire', (connection) => {
        lastActivityAt = now();
        counters.acquired += 1;
        leased.add(connection);
        counters.peakInUse = Math.max(counters.peakInUse, leased.size);
    });
    corePool.on('release', (connection) => {
        lastActivityAt = now();
        counters.released += 1;
        leased.delete(connection);
    });
    corePool.on('enqueue', () => { counters.enqueued += 1; });

    const markUnexpectedProbeFailure = (error) => {
        if (maintenanceStopped) return;
        lastFailureAt = new Date(now()).toISOString();
        const shouldLog = state !== 'degraded';
        state = 'degraded';
        if (!shouldLog) return;
        try {
            logger?.error?.({
                event: 'database_runtime_probe_failed',
                code: String(error?.code || 'UNKNOWN')
            }, 'Database connection maintenance failed unexpectedly.');
        } catch (_) {
            // A diagnostic failure must not become an unhandled rejection.
        }
    };

    const schedule = (delayMs) => {
        if (!started || maintenanceStopped || timer) return;
        timer = setTimeoutFn(() => {
            timer = null;
            inFlightProbe = runProbe()
                .catch(markUnexpectedProbeFailure)
                .finally(() => {
                    inFlightProbe = null;
                    if (started && !maintenanceStopped) {
                        schedule(state === 'degraded' ? degradedIntervalMs : quietIntervalMs);
                    }
                });
        }, delayMs);
        timer.unref?.();
    };

    const waitForRetry = () => new Promise((resolve) => {
        resolveRetry = resolve;
        retryTimer = setTimeoutFn(() => {
            retryTimer = null;
            resolveRetry = null;
            resolve(true);
        }, retryDelayMs);
        retryTimer.unref?.();
    });

    const cancelRetry = () => {
        if (retryTimer) clearTimeoutFn(retryTimer);
        retryTimer = null;
        const resolve = resolveRetry;
        resolveRetry = null;
        resolve?.(false);
    };

    const pingOne = async () => {
        let connection;
        let deadline;
        let released = false;
        try {
            counters.probeAttempts += 1;
            connection = await pool.getConnection();
            if (!started || maintenanceStopped) {
                connection.destroy();
                return null;
            }
            // mysql2 emits acquire before this promise resolves. From this point
            // forward probe errors are exact; the earlier handoff remains
            // conservatively visible as active without using private driver state.
            probeConnections.add(connection.connection);
            await Promise.race([
                connection.ping(),
                new Promise((_, reject) => {
                    deadline = setTimeoutFn(() => {
                        const error = new Error('Database warm-connection ping timed out.');
                        error.code = 'DB_WARM_PING_TIMEOUT';
                        reject(error);
                    }, pingTimeoutMs);
                    deadline.unref?.();
                })
            ]);
            if (!started || maintenanceStopped) {
                connection.destroy();
                return null;
            }
            counters.probeSuccesses += 1;
            connection.release();
            released = true;
            return true;
        } catch (error) {
            connection?.destroy();
            if (!started || maintenanceStopped) return null;
            counters.probeFailures += 1;
            return false;
        } finally {
            if (deadline) clearTimeoutFn(deadline);
            if (released && connection?.connection) {
                probeConnections.delete(connection.connection);
            }
        }
    };

    const runProbe = async () => {
        if (!started || maintenanceStopped) return;
        if (leased.size > 0) return;

        const targetIntervalMs = state === 'degraded'
            ? degradedIntervalMs
            : quietIntervalMs;
        const remainingQuietMs = targetIntervalMs - (now() - lastActivityAt);
        if (remainingQuietMs > 0) {
            schedule(remainingQuietMs);
            return;
        }

        let succeeded = await pingOne();
        if (succeeded === null) return;
        if (!succeeded) {
            const retryAllowed = await waitForRetry();
            if (!retryAllowed || !started || maintenanceStopped) return;
            succeeded = await pingOne();
            if (succeeded === null) return;
        }

        if (succeeded) {
            const recovered = state === 'degraded';
            state = 'healthy';
            lastSuccessAt = new Date(now()).toISOString();
            if (recovered) {
                logger?.info?.({
                    event: 'database_runtime_recovered',
                    probeAttempts: counters.probeAttempts,
                    probeFailures: counters.probeFailures
                }, 'Database connection maintenance recovered.');
            }
            return;
        }

        lastFailureAt = new Date(now()).toISOString();
        if (state !== 'degraded') {
            logger?.warn?.({
                event: 'database_runtime_degraded',
                probeAttempts: counters.probeAttempts,
                probeFailures: counters.probeFailures
            }, 'Database connection maintenance is degraded.');
        }
        state = 'degraded';
    };

    const start = () => {
        if (started) return false;
        started = true;
        maintenanceStopped = false;
        for (const trace of commandTraces) trace.channel.subscribe(trace.handlers);
        state = 'healthy';
        lastSuccessAt = new Date(now()).toISOString();
        lastActivityAt = now();
        schedule(quietIntervalMs);
        return true;
    };
    const stopMaintenance = async () => {
        maintenanceStopped = true;
        if (timer) clearTimeoutFn(timer);
        timer = null;
        cancelRetry();
        if (inFlightProbe) await inFlightProbe;
    };
    const stop = async () => {
        if (!started && state === 'stopped') return;
        await stopMaintenance();
        started = false;
        for (const trace of commandTraces) trace.channel.unsubscribe(trace.handlers);
        state = 'stopped';
    };

    return Object.freeze({ pool, start, stopMaintenance, stop, snapshot });
}

module.exports = { createDatabaseRuntime };

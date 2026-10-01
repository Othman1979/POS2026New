const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { printerEndpoint } = require('./printer-endpoint');

const VERSION = 1;
// How long a settled job's identity is kept so a re-sent queue_id is still recognised.
// The server never re-sends an id whose result it confirmed (only rows it still holds as
// 'sent' are replayed, and a reprint is a new row), so this is margin, not a working window:
// three days covers a business day plus the server's purge horizon with room to spare.
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['completed', 'permanent_failure', 'uncertain', 'canceled']);
const RUNNABLE = new Set(['queued', 'rendered', 'retry_wait']);

function validateStateRoot(stateRoot) {
    if (!stateRoot
        || !path.isAbsolute(stateRoot)
        || path.normalize(stateRoot) !== stateRoot
        || path.resolve(stateRoot) !== stateRoot) {
        throw new Error('SPOOLER_STATE_DIR_INVALID');
    }
    return stateRoot;
}

function identityHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fileName(queueId, idempotencyKey) {
    return `${queueId}-${identityHash(idempotencyKey)}.json`;
}

// `durable` fsyncs the record before it replaces the old one. A record that guards against a
// duplicate print (accept, transport marker, result) must survive power loss; a write the
// server can re-derive is only renamed into place.
function writeAtomic(file, value, operation, beforeRename, { durable = true } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    let renamed = false;
    try {
        try {
            fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
            if (durable) fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        beforeRename(operation, file);
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(temporary, file);
                break;
            } catch (error) {
                if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
                // Windows can briefly lock the destination. Retry only this
                // atomic journal replacement, never transport or unlinking the
                // old record. No delay on success; contention waits total <=70ms.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (2 ** attempt));
            }
        }
        renamed = true;
    } finally {
        if (!renamed) fs.rmSync(temporary, { force: true });
    }
}

// What a settled job needs to be recognised again after the server has its result:
// identity, final state and timestamps. Never the payload or the rendered artifact.
function compactRecord(record) {
    const compact = {
        version: record.version,
        compact: 1,
        queue_id: record.queue_id,
        idempotency_key: record.idempotency_key,
        payload_hash: record.payload_hash,
        printer_id: record.printer_id ?? null,
        print_type: record.print_type,
        state: record.state,
        job: null,
        artifact: record.artifact || null,
        result: record.result
            ? { queue_id: record.queue_id, outcome: record.result.outcome, error_code: record.result.error_code ?? null }
            : null,
        accepted_confirmed: record.accepted_confirmed,
        created_at: record.created_at,
        updated_at: record.updated_at
    };
    if (record.endpoint_recovered_at) compact.endpoint_recovered_at = record.endpoint_recovered_at;
    return compact;
}

// An uncertain job whose endpoint is still held keeps its full record: recovery needs it.
function compactable(record) {
    return TERMINAL.has(record.state) && !(record.state === 'uncertain' && !record.endpoint_recovered_at);
}

function outcomeState(outcome) {
    if (outcome === 'completed') return 'completed';
    if (outcome === 'permanent_failure') return 'permanent_failure';
    if (outcome === 'uncertain') return 'uncertain';
    if (outcome === 'canceled') return 'canceled';
    throw new Error('JOB_RESULT_INVALID');
}

function openJobStore({ stateRoot, now = () => Date.now(), beforeRename = () => {} } = {}) {
    const root = validateStateRoot(stateRoot);
    const activeDirectory = path.join(root, 'jobs', 'active');
    const archiveDirectory = path.join(root, 'jobs', 'archive');
    const artifactsDirectory = path.join(root, 'artifacts');
    const quarantineDirectory = path.join(root, 'quarantine');
    const runtimeStateFile = path.join(root, 'agent-runtime.json');
    for (const directory of [activeDirectory, archiveDirectory, artifactsDirectory, quarantineDirectory]) {
        fs.mkdirSync(directory, { recursive: true });
        for (const name of fs.readdirSync(directory)) {
            if (name.endsWith('.tmp')) fs.rmSync(path.join(directory, name), { force: true });
        }
    }

    const entries = new Map();
    const activeEntries = new Map();
    const endpointHolds = new Map();
    const endpointPrinters = new Map();

    // A settled, server-confirmed job is kept as its compact identity record only. Unresolved
    // transports keep their full record.
    function compactArchive(entry) {
        if (!entry.archived || entry.compact || !compactable(entry.record)) return;
        entry.record = compactRecord(entry.record);
        entry.compact = true;
    }

    function fullRecord(entry) {
        if (!entry) return null;
        if (!entry.compact) return entry.record;
        const record = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
        if (record.version !== VERSION || Number(record.queue_id) !== Number(entry.record.queue_id)
            || record.idempotency_key !== entry.record.idempotency_key || record.payload_hash !== entry.record.payload_hash
            || record.state !== entry.record.state) throw new Error('JOB_ARCHIVE_INVALID');
        return record;
    }

    function indexEndpoint(record) {
        if (!record.job) return;
        const key = printerEndpoint(record.job);
        if (!endpointPrinters.has(key)) endpointPrinters.set(key, new Set());
        if (Number(record.printer_id) > 0) endpointPrinters.get(key).add(Number(record.printer_id));
        let holds = endpointHolds.get(key);
        if (['transport_started', 'uncertain'].includes(record.state) && !record.endpoint_recovered_at) {
            if (!holds) endpointHolds.set(key, holds = new Map());
            holds.set(Number(record.queue_id), record);
        } else if (holds) {
            holds.delete(Number(record.queue_id));
            if (!holds.size) endpointHolds.delete(key);
        }
    }

    function removeArtifact(record) {
        const artifactPath = record.artifact?.path;
        if (artifactPath && path.isAbsolute(artifactPath) && artifactPath.startsWith(`${artifactsDirectory}${path.sep}`)) {
            fs.rmSync(artifactPath, { force: true });
        }
    }

    function readDirectory(directory, archived) {
        const cutoff = now() - RETENTION_MS;
        for (const name of fs.readdirSync(directory).filter(value => value.endsWith('.json'))) {
            const file = path.join(directory, name);
            try {
                const record = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (record.version !== VERSION || !Number.isInteger(Number(record.queue_id)) || !TERMINAL.has(record.state) && !RUNNABLE.has(record.state) && record.state !== 'transport_started') {
                    throw new Error('JOB_RECORD_INVALID');
                }
                const queueId = Number(record.queue_id);
                const existing = entries.get(queueId);
                if (!existing || archived) {
                    const entry = { record, file, archived };
                    if (archived && compactable(record)) {
                        if (Date.parse(record.updated_at) < cutoff) {
                            removeArtifact(record);
                            fs.rmSync(file, { force: true });
                            continue;
                        }
                        // An archive written before compact records carries the whole payload.
                        // Shrink it once so later starts read identity only; failing to is harmless.
                        const legacy = !record.compact;
                        compactArchive(entry);
                        if (legacy) {
                            try { writeAtomic(file, entry.record, 'archive_compaction', () => {}, { durable: false }); } catch { /* still valid as it is */ }
                        }
                    }
                    entries.set(queueId, entry);
                    if (archived) activeEntries.delete(queueId);
                    else activeEntries.set(queueId, entry);
                }
            } catch {
                fs.renameSync(file, path.join(quarantineDirectory, `${Date.now()}-${name}`));
            }
        }
    }

    readDirectory(activeDirectory, false);
    readDirectory(archiveDirectory, true);

    function persist(entry, operation) {
        if (entry.compact) throw new Error('JOB_ARCHIVE_NOT_LOADED');
        writeAtomic(entry.file, entry.record, operation, beforeRename);
    }

    function addRecord(record, { archived = false, operation = 'accept' } = {}) {
        const directory = archived ? archiveDirectory : activeDirectory;
        const key = record.idempotency_key || `cancel:${record.queue_id}`;
        const entry = {
            record,
            file: path.join(directory, fileName(record.queue_id, key)),
            archived
        };
        persist(entry, operation);
        entries.set(Number(record.queue_id), entry);
        if (!archived) activeEntries.set(Number(record.queue_id), entry);
        indexEndpoint(record);
        compactArchive(entry);
        return entry;
    }

    function timestamp() {
        return new Date(now()).toISOString();
    }

    // A restart mid-transport is uncertain either way, but only a restart before the
    // sent marker may have cut the stream: after it every byte had left this process
    // (kernel TCP buffer or the Windows spooler), so the endpoint is not held.
    function recoverTransportStarted() {
        for (const entry of activeEntries.values()) {
            if (entry.record.state !== 'transport_started') continue;
            const sent = Boolean(entry.record.transport_sent_at);
            const next = {
                ...entry.record,
                state: 'uncertain',
                result: { queue_id: entry.record.queue_id, outcome: 'uncertain', error_code: sent ? 'AGENT_RESTART_AFTER_SEND' : 'AGENT_RESTART_AFTER_TRANSPORT' },
                ...(sent ? { endpoint_recovered_at: timestamp() } : {}),
                updated_at: timestamp()
            };
            const previous = entry.record;
            entry.record = next;
            try {
                persist(entry, 'recovery');
            } catch (error) {
                entry.record = previous;
                throw error;
            }
        }
    }

    recoverTransportStarted();
    for (const { record } of entries.values()) indexEndpoint(record);

    function getEntry(queueId) {
        return entries.get(Number(queueId)) || null;
    }

    // `persist: false` changes the in-memory record only. It is for bookkeeping the server or a
    // re-render can rebuild after a crash; the next persisted transition writes it out whole.
    function mutate(queueId, operation, transform, { allowTerminal = false, persist: write = true } = {}) {
        const entry = getEntry(queueId);
        if (!entry || entry.archived) throw new Error('JOB_NOT_ACTIVE');
        const previous = entry.record;
        if (!allowTerminal && TERMINAL.has(previous.state)) {
            const error = new Error('JOB_TERMINAL');
            error.code = 'JOB_TERMINAL';
            throw error;
        }
        const next = transform(previous);
        entry.record = { ...next, updated_at: timestamp() };
        try {
            if (write) persist(entry, operation);
        } catch (error) {
            entry.record = previous;
            throw error;
        }
        indexEndpoint(entry.record);
        return entry.record;
    }

    function accept(job) {
        const queueId = Number(job?.queue_id);
        const idempotencyKey = String(job?.idempotency_key || '');
        const payloadHash = String(job?.payload_hash || '');
        if (!Number.isInteger(queueId) || queueId < 1 || !idempotencyKey || !/^[0-9a-f]{64}$/i.test(payloadHash)) {
            throw new Error('JOB_IDENTITY_INVALID');
        }
        const existing = getEntry(queueId);
        if (existing) {
            if (!existing.record.payload_hash && existing.record.state === 'canceled') return fullRecord(existing);
            if (existing.record.idempotency_key !== idempotencyKey || existing.record.payload_hash !== payloadHash) {
                throw new Error('PAYLOAD_IDENTITY_CONFLICT');
            }
            return fullRecord(existing);
        }
        const createdAt = timestamp();
        return addRecord({
            version: VERSION,
            queue_id: queueId,
            idempotency_key: idempotencyKey,
            payload_hash: payloadHash,
            printer_id: job.printer_id ?? null,
            print_type: String(job.print_type || ''),
            state: 'queued',
            job,
            artifact: null,
            result: null,
            accepted_confirmed: false,
            accepted_local_at: createdAt,
            created_at: createdAt,
            updated_at: createdAt
        }).record;
    }

    function requestCancel(queueId) {
        const id = Number(queueId);
        const entry = getEntry(id);
        if (!entry) {
            const createdAt = timestamp();
            return addRecord({
                version: VERSION,
                queue_id: id,
                idempotency_key: `cancel:${id}`,
                payload_hash: '',
                printer_id: null,
                print_type: '',
                state: 'canceled',
                job: null,
                artifact: null,
                result: { queue_id: id, outcome: 'canceled' },
                accepted_confirmed: true,
                created_at: createdAt,
                updated_at: createdAt
            }, { operation: 'cancel' }).record;
        }
        if (entry.archived || TERMINAL.has(entry.record.state) || entry.record.state === 'transport_started') return fullRecord(entry);
        return mutate(id, 'cancel', record => ({
            ...record,
            state: 'canceled',
            result: { queue_id: id, outcome: 'canceled' }
        }));
    }

    function markRendered(queueId, artifact) {
        const entry = getEntry(queueId);
        if (!entry || entry.archived || !RUNNABLE.has(entry.record.state)) {
            const error = new Error('JOB_NOT_RUNNABLE');
            error.code = 'JOB_NOT_RUNNABLE';
            throw error;
        }
        // Not written: a restart before the transport marker renders the job again, which is
        // cheaper than syncing every job's journal record a second time.
        return mutate(queueId, 'rendered', record => ({ ...record, state: 'rendered', artifact }), { persist: false });
    }

    function retainArtifactForCleanup(queueId, artifact) {
        const entry = getEntry(queueId);
        if (!entry || !TERMINAL.has(entry.record.state)) throw new Error('JOB_NOT_TERMINAL');
        const previous = entry.record;
        const wasCompact = entry.compact;
        entry.record = { ...fullRecord(entry), artifact, updated_at: timestamp() };
        entry.compact = false;
        try {
            persist(entry, 'orphan_artifact');
        } catch (error) {
            entry.record = previous;
            entry.compact = wasCompact;
            throw error;
        }
        const result = entry.record;
        compactArchive(entry);
        return result;
    }

    function markTransportStarted(queueId) {
        return mutate(queueId, 'transport_started', record => ({ ...record, state: 'transport_started' }));
    }

    function revertTransportStarted(queueId) {
        const entry = getEntry(queueId);
        if (!entry || entry.archived || entry.record.state !== 'transport_started') {
            const error = new Error('JOB_NOT_TRANSPORT_STARTED');
            error.code = 'JOB_NOT_TRANSPORT_STARTED';
            throw error;
        }
        return mutate(queueId, 'revert_transport_started', record => ({ ...record, state: 'rendered' }));
    }

    function markTransportSent(queueId, details = {}) {
        const entry = getEntry(queueId);
        if (!entry || entry.archived || entry.record.state !== 'transport_started') {
            const error = new Error('JOB_NOT_TRANSPORT_STARTED');
            error.code = 'JOB_NOT_TRANSPORT_STARTED';
            throw error;
        }
        return mutate(queueId, 'transport_sent', record => ({ ...record, ...details, transport_sent_at: timestamp() }));
    }

    // `hold: false` records an uncertain outcome whose stream is known intact (every
    // byte was handed over before the failure), so the endpoint needs no recovery.
    function recordResult(queueId, result, { hold = true } = {}) {
        return mutate(queueId, 'result', record => ({
            ...record,
            state: outcomeState(result?.outcome),
            result: { ...result, queue_id: Number(queueId) },
            ...(result?.outcome === 'uncertain' && !hold ? { endpoint_recovered_at: timestamp() } : {})
        }));
    }

    function recordRetry(queueId, retry) {
        if (getEntry(queueId)?.record.state === 'transport_started') {
            const error = new Error('JOB_TRANSPORT_STARTED');
            error.code = 'JOB_TRANSPORT_STARTED';
            throw error;
        }
        return mutate(queueId, 'retry', record => ({
            ...record,
            state: 'retry_wait',
            result: { ...retry, queue_id: Number(queueId) }
        }));
    }

    function confirmAccepted(ids) {
        for (const queueId of new Set((ids || []).map(Number))) {
            const entry = getEntry(queueId);
            if (!entry || entry.archived || entry.record.accepted_confirmed || !entry.record.payload_hash) continue;
            // Not written: after a restart the job is announced as accepted again and the
            // server confirms it again, exactly as when the confirmation is lost in transit.
            mutate(queueId, 'accept_confirmation', record => ({ ...record, accepted_confirmed: true }), { allowTerminal: true, persist: false });
        }
    }

    function confirmResults(ids) {
        for (const queueId of new Set((ids || []).map(Number))) {
            const entry = getEntry(queueId);
            if (!entry || entry.archived || !TERMINAL.has(entry.record.state) || !entry.record.result) continue;
            beforeRename('result_confirmation', entry.file);
            const destination = path.join(archiveDirectory, path.basename(entry.file));
            // A printed or canceled ticket's artifact has no further use; an uncertain one stays.
            const spent = entry.record.artifact && entry.record.state !== 'uncertain' ? entry.record : null;
            const settled = { ...entry.record, updated_at: timestamp(), ...(spent ? { artifact: null } : {}) };
            const keepFull = !compactable(settled);
            // The archive copy is written before the active one goes, so a crash leaves the
            // job in one place or both (the archive wins on start), never neither. Only a
            // held uncertain record, which recovery needs whole, is synced.
            writeAtomic(destination, keepFull ? settled : compactRecord(settled), 'archive_metadata', beforeRename, { durable: keepFull });
            fs.rmSync(entry.file, { force: true });
            if (spent) removeArtifact(spent);
            entry.file = destination;
            entry.archived = true;
            entry.record = settled;
            activeEntries.delete(queueId);
            compactArchive(entry);
        }
    }

    function unconfirmedAccepted() {
        return [...activeEntries.values()]
            .filter(entry => !entry.record.accepted_confirmed && /^[0-9a-f]{64}$/i.test(entry.record.payload_hash))
            .map(entry => ({ queue_id: entry.record.queue_id, payload_hash: entry.record.payload_hash }));
    }

    function outbox() {
        return [...activeEntries.values()]
            .filter(entry => TERMINAL.has(entry.record.state) && entry.record.result)
            .map(entry => ({ ...entry.record.result, queue_id: entry.record.queue_id }));
    }

    function runnable() {
        return [...activeEntries.values()]
            .filter(entry => RUNNABLE.has(entry.record.state))
            .map(entry => entry.record);
    }

    function cleanup() {
        const cutoff = now() - RETENTION_MS;
        for (const [queueId, entry] of entries) {
            if (!entry.archived || Date.parse(entry.record.updated_at) >= cutoff) continue;
            if (entry.record.state === 'uncertain' && !entry.record.endpoint_recovered_at) continue;
            removeArtifact(entry.record);
            fs.rmSync(entry.file, { force: true });
            entries.delete(queueId);
        }
        const referenced = new Set();
        for (const entry of entries.values()) {
            const artifactPath = entry.record.artifact?.path;
            if (artifactPath) referenced.add(path.normalize(artifactPath));
        }
        const graceCutoff = now() - 60 * 60 * 1000;
        for (const name of fs.readdirSync(artifactsDirectory)) {
            if (!name.endsWith('.bin')) continue;
            const artifactPath = path.join(artifactsDirectory, name);
            if (referenced.has(path.normalize(artifactPath))) continue;
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(artifactPath).mtimeMs; } catch { continue; }
            if (mtimeMs > graceCutoff) continue;
            fs.rmSync(artifactPath, { force: true });
        }
    }

    function health() {
        const counts = {};
        let oldestCreatedAt = null;
        let active = 0;
        let kitchenActive = 0;
        for (const entry of activeEntries.values()) {
            active += 1;
            counts[entry.record.state] = (counts[entry.record.state] || 0) + 1;
            if (entry.record.print_type === 'kitchen') kitchenActive += 1;
            const createdAt = Date.parse(entry.record.created_at);
            if (Number.isFinite(createdAt) && (oldestCreatedAt === null || createdAt < oldestCreatedAt)) oldestCreatedAt = createdAt;
        }
        return {
            counts,
            active,
            kitchen_active: kitchenActive,
            non_kitchen_active: Math.max(0, active - kitchenActive),
            quarantined: fs.readdirSync(quarantineDirectory).filter(name => !name.endsWith('.tmp')).length,
            recovery_required: [...endpointHolds.values()].filter(holds => [...holds.values()].some(record => record.state === 'uncertain')).length,
            oldest_local_job_age_ms: oldestCreatedAt === null ? null : Math.max(0, now() - oldestCreatedAt)
        };
    }

    function agentStatus() {
        if (!fs.existsSync(runtimeStateFile)) return 'starting';
        try {
            const saved = JSON.parse(fs.readFileSync(runtimeStateFile, 'utf8'));
            return typeof saved.status === 'string' ? saved.status : 'starting';
        } catch {
            return 'starting';
        }
    }

    function setAgentStatus(status) {
        if (agentStatus() === status) return;
        writeAtomic(runtimeStateFile, { version: 1, status, updated_at: timestamp() }, 'agent_status', beforeRename);
    }

    function endpointHold(printer) {
        const key = typeof printer === 'string' ? printer : printerEndpoint(printer);
        const held = endpointHolds.get(key);
        if (!held?.size) return null;
        const records = [...held.values()];
        return { endpoint: key, queue_ids: records.map(record => record.queue_id),
            printer_ids: [...endpointPrinters.get(key) || []],
            uncertain: records.some(record => record.state === 'uncertain'),
            error_code: records[records.length - 1].result?.error_code || 'TRANSPORT_IN_PROGRESS' };
    }

    // Called only by the offline recovery tool while it owns the agent state lock.
    // Do not change job outcomes or replay uncertain tickets. Mark the observed
    // failures recovered; partial disk failures leave the remaining holds intact.
    function recoverEndpoint(key, expectedQueueIds) {
        const held = endpointHold(key);
        if (!held || JSON.stringify([...held.queue_ids].sort((a, b) => a - b)) !==
            JSON.stringify([...expectedQueueIds].sort((a, b) => a - b))) throw new Error('ENDPOINT_HOLD_CHANGED');
        for (const queueId of held.queue_ids) {
            const entry = getEntry(queueId);
            const previous = entry.record;
            entry.record = { ...previous, endpoint_recovered_at: timestamp() };
            try { persist(entry, 'endpoint_recovery'); }
            catch (error) { entry.record = previous; throw error; }
            indexEndpoint(entry.record);
            compactArchive(entry);
        }
    }

    return {
        accept,
        get: queueId => fullRecord(getEntry(queueId)),
        requestCancel,
        markRendered,
        retainArtifactForCleanup,
        markTransportStarted,
        markTransportSent,
        revertTransportStarted,
        recordResult,
        recordRetry,
        confirmAccepted,
        confirmResults,
        unconfirmedAccepted,
        outbox,
        runnable,
        cleanup,
        health,
        agentStatus,
        setAgentStatus,
        endpointHold,
        endpointHolds: () => [...endpointHolds.keys()].map(endpointHold),
        recoverEndpoint,
        artifactsDirectory
    };
}

module.exports = { openJobStore };

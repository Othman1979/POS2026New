const path = require('path');
const fs = require('fs');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
    throw new Error('The spooler requires Node.js 22.12 or newer. Upgrade the installed Node runtime before starting.');
}
require('dotenv').config({ path: process.env.SPOOLER_ENV_FILE || path.join(__dirname, '.env') });
const net = require('net');
const { startPlatformHelper } = require('./v2/platform-helper');
const { loadOrCreateIdentity, stageReplacementIdentity, loadCandidateIdentity } = require('./v2/agent-identity');
const { openJobStore } = require('./v2/job-store');
const { createSyncClient } = require('./v2/sync-client');
const { createAgentRuntime } = require('./v2/agent-runtime');
const { createRawArtifactRenderer } = require('./v2/raw-artifact-renderer');
const { createTypstRenderer } = require('./v2/typst-renderer');
const { createRendererRouter } = require('./v2/renderer-router');
const { createPrinterWorkers } = require('./v2/printer-workers');
const { createTcpTransport, createWindowsTransport } = require('./v2/printer-transports');
const { acquireStateRootLock } = require('./v2/state-root-lock');
const spoolerPackage = require('./package.json');

function packagedRuntimeProfile(root = __dirname) {
    const releasePath = path.join(root, 'release.json');
    if (!fs.existsSync(releasePath)) return 'typst-only';
    let release;
    try { release = JSON.parse(fs.readFileSync(releasePath, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('SPOOLER_RELEASE_INVALID'); }
    const profile = String(release.runtimeProfile || 'typst-only').trim().toLowerCase();
    if (profile !== 'typst-only') throw new Error('SPOOLER_RUNTIME_PROFILE_INVALID');
    return profile;
}

// Rendering is fixed to Typst. Legacy environment values cannot start a browser.
function resolveRendererMode() { return 'typst-only'; }

function defaultStateRoot() {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'POS-Spooler', 'state');
}

function assertProductionConfig(env = process.env, runtimeProfile = packagedRuntimeProfile()) {
    if (env.NODE_ENV !== 'production') return;
    if (!String(env.CLOUD_SERVER_URL || '').trim()) throw new Error('CLOUD_SERVER_URL_REQUIRED');
    if (!String(env.SPOOLER_KEY || '').trim()) throw new Error('SPOOLER_KEY_REQUIRED');
    for (const [name, minimum, maximum] of [
        ['SPOOLER_TYPST_TIMEOUT_MS', 1000, 60000],
        ['SPOOLER_TYPST_MAX_HEIGHT', 1000, 50000]
    ]) {
        if (env[name] === undefined || env[name] === '') continue;
        const value = Number(env[name]);
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_INVALID`);
    }
}

function startupJitterMs(random = Math.random) {
    return Math.floor(random() * 2001);
}

function createHelperEventHandler({ shutdown, exit = code => process.exit(code), log = console.error }) {
    let fatalHandled = false;
    return event => {
        if (event?.type !== 'fatal' || fatalHandled) return undefined;
        fatalHandled = true;
        log(event.code || 'PLATFORM_HELPER_FATAL');
        return Promise.resolve(shutdown()).finally(() => exit(event.code === 'STATE_ROOT_LOCKED' ? 73 : 1));
    };
}

async function main() {
    const runtimeProfile = packagedRuntimeProfile();
    assertProductionConfig(process.env, runtimeProfile);
    const stateRoot = process.env.SPOOLER_STATE_DIR || defaultStateRoot();
    const executable = path.join(__dirname, 'bin', 'PosSpoolerPlatform.exe');
    const legacyExecutable = path.join(__dirname, 'windows-helper', 'PosSpoolerPlatform.exe');
    const helperExecutable = require('fs').existsSync(executable) ? executable : legacyExecutable;
    let helper;
    let renderer;
    let runtime;
    let stateLock;
    let closing = false;
    async function close() {
        if (closing) return;
        closing = true;
        try {
            await runtime?.stop();
            await renderer?.close();
            await helper?.close();
        } finally {
            stateLock?.release();
        }
    }
    const onHelperEvent = createHelperEventHandler({
        shutdown: close
    });
    try {
        helper = await startPlatformHelper({
            executable: helperExecutable,
            stateRoot,
            restartOnExit: true,
            onEvent: onHelperEvent
        });
        stateLock = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        process.once('exit', () => stateLock?.release());
        const protector = {
            protect: async bytes => (await helper.request('protect', { value: Buffer.from(bytes).toString('base64') })).value,
            unprotect: async value => Buffer.from((await helper.request('unprotect', { value })).value, 'base64')
        };
        const identity = await loadOrCreateIdentity({ stateRoot, protector });
        const store = openJobStore({ stateRoot });
    const syncClientFor = ({ agentId, secret }) => createSyncClient({
        baseUrl: process.env.CLOUD_SERVER_URL,
        agentId,
        secret,
        bootstrapKey: process.env.SPOOLER_KEY,
        spoolerId: process.env.SPOOLER_ID || 'primary',
        spoolerName: process.env.SPOOLER_NAME || process.env.SPOOLER_ID || 'primary',
        agentVersion: spoolerPackage.version
    });
    const syncClient = syncClientFor(identity);
    // A replacement identity a previous run staged before it could be promoted.
    const leftover = await loadCandidateIdentity({ stateRoot, protector });

    renderer = createRendererRouter({
        mode: resolveRendererMode(process.env, runtimeProfile),
        createRaw: () => createRawArtifactRenderer({ stateRoot }),
        createTypst: () => createTypstRenderer({
            stateRoot,
            executable: process.env.SPOOLER_TYPST_EXE || undefined,
            fontPath: process.env.SPOOLER_TYPST_FONT_DIR || undefined,
            limits: {
                compileMs: Number(process.env.SPOOLER_TYPST_TIMEOUT_MS) || 10000,
                maxHeight: Number(process.env.SPOOLER_TYPST_MAX_HEIGHT) || 12000
            }
        })
    });
    const tcpTransport = createTcpTransport({ net });
    const windowsTransport = createWindowsTransport({ helper });
    const transportFor = job => (job?.printer_type === 'windows' ? windowsTransport : tcpTransport);
    const workers = createPrinterWorkers({
        store,
        renderer,
        transportFor,
        onResultReady: () => runtime?.wake()
    });
    const worker = {
        setBlockedPrinters: workers.setBlockedPrinters,
        start() { workers.start(); },
        stop() { return workers.stop(); },
        wake() { workers.wake(); },
        health() {
            const held = store.endpointHolds().filter(entry => entry.uncertain);
            const blockedIds = new Set(held.flatMap(entry => entry.printer_ids));
            const workerHealth = workers.health();
            // A held endpoint keeps a possibly-printed job from being resent, so it
            // outranks whatever the last finished job said.
            const printers = workerHealth.printers.map(printer => blockedIds.has(printer.printer_id)
                ? { ...printer, device_status: 'error' } : printer);
            return {
                ...workerHealth,
                printers,
                blocked_printer_ids: [...blockedIds].slice(0, 64),
                last_error: held.length ? 'PRINTER_RECOVERY_REQUIRED' : null,
                helper: { state: helper.isReady?.() ? 'ready' : 'degraded' },
                worker_ready: true
            };
        }
    };
    const maxLocalJobs = Number(process.env.SPOOLER_MAX_LOCAL_JOBS) > 0
        ? Number(process.env.SPOOLER_MAX_LOCAL_JOBS)
        : 50;
    runtime = createAgentRuntime({
        store,
        syncClient,
        // Used only when the server reports this identity belongs to another station.
        pendingCandidate: leftover && {
            syncClient: syncClientFor(leftover),
            commit: () => leftover.commit(),
            discard: () => leftover.discard()
        },
        prepareIdentity: async () => {
            const staged = await stageReplacementIdentity({ stateRoot, protector });
            return { syncClient: syncClientFor(staged), commit: () => staged.commit(), discard: () => staged.discard() };
        },
        worker,
        maxLocalJobs,
        agentVersion: spoolerPackage.version,
        agentName: process.env.SPOOLER_NAME || process.env.SPOOLER_ID || 'primary',
        startupJitterMs: startupJitterMs()
    });
    runtime.start();

    process.once('SIGTERM', () => close().finally(() => process.exit(0)));
    process.once('SIGINT', () => close().finally(() => process.exit(0)));
    return { helper, store, runtime, close };
    } catch (error) {
        await close();
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.reason ? `${error.code || error.message} (${error.reason})` : (error.code || error.message));
        process.exit(1);
    });
}

module.exports = {
    main,
    defaultStateRoot,
    createHelperEventHandler,
    startupJitterMs,
    assertProductionConfig,
    packagedRuntimeProfile,
    resolveRendererMode
};

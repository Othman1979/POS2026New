const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { startPlatformHelper } = require('../v2/platform-helper');

const helperSource = fs.readFileSync(path.resolve(__dirname, '../windows-helper/PosSpoolerPlatform.cs'), 'utf8');
assert(helperSource.includes('print_raw'), 'platform helper must expose raw Winspool submission');
assert(helperSource.includes('printer_status'), 'platform helper must expose OS printer status');
assert(helperSource.includes('watch_printers'), 'platform helper must expose printer change notifications');
assert(helperSource.includes('WritePrinter'), 'platform helper must stream bytes through Winspool');
assert(helperSource.includes('paper_low'), 'platform helper must preserve paper-low status');
assert(helperSource.includes('AbortPrinter'), 'platform helper must abort partial RAW documents');
assert(/Buffer\.BlockCopy/.test(helperSource), 'platform helper must honor partial-write offsets');
assert(/if \(status == 0\) return "unknown";/.test(helperSource), 'zero Winspool flags must remain unknown');
assert(/WatchGeneration/.test(helperSource), 'platform helper must use monotonically increasing watch generation');
assert(!/StopWatching\s*=\s*false/.test(helperSource), 'platform helper must not reset a shared stop flag for newer watchers');
assert(/QueueUserWorkItem/.test(helperSource), 'print_raw dispatch must be asynchronous');
// Native completion/cancellation semantics are executed by v2-windows-delivery.
assert(/PRINTER_CHANGE_SET_JOB \| PRINTER_CHANGE_DELETE_JOB/.test(helperSource), 'Winspool drain must subscribe to job completion changes');
assert(/WaitForSingleObject\(changeNotification/.test(helperSource), 'Winspool drain must wait without a busy polling loop');
assert(/FindNextPrinterChangeNotification\(changeNotification/.test(helperSource), 'Winspool drain must reset signaled notifications');
assert(/ValidChangeHandle\(drainNotification\).*FindClosePrinterChangeNotification\(drainNotification\)/.test(helperSource), 'Winspool drain notification handles must always close');
assert(/drain_strategy/.test(helperSource) && /poll_fallback/.test(helperSource), 'Winspool drain must retain an explicit polling rollback and watchdog');
assert(/NotificationEligible\(name\)/.test(helperSource) && /StartsWith\("\\\\\\\\"/.test(helperSource), 'UNC printer shares must avoid blocking notification setup');
const printRawSource = helperSource.slice(
    helperSource.indexOf('private static Dictionary<string, object> PrintRaw'),
    helperSource.indexOf('private static void StopWatch')
);
assert(
    !/FindFirstPrinterChangeNotification|WaitForLocalQueueDrain/.test(printRawSource),
    'print_raw only submits; observation starts after EndDocPrinter handed every byte to Winspool, so a provider stall cannot strand an unprinted job as uncertain'
);
assert(/private static Dictionary<string, object> WaitJob/.test(helperSource) && /command == "wait_job"/.test(helperSource), 'observation runs in bounded wait_job windows');
assert(!/JOB_CONTROL_DELETE/.test(helperSource), 'the helper must never cancel an OS print job');
assert(/OutputLock/.test(helperSource) && /ExecuteAndWrite/.test(helperSource), 'helper output must stay locked while print_raw is async');

let lastChild;
function fakeSpawn() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
    child.stdin.on('data', chunk => {
        for (const line of String(chunk).trim().split(/\r?\n/)) {
            if (!line) continue;
            const request = JSON.parse(line);
            child.stdout.write(`${JSON.stringify({ id: request.id, result: { value: request.payload.value } })}\n`);
        }
    });
    process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
    lastChild = child;
    return child;
}

(async () => {
    const helper = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\ProgramData\\POS-Spooler\\state',
        spawnFn: fakeSpawn
    });
    const [first, second] = await Promise.all([
        helper.request('protect', { value: 'one' }),
        helper.request('unprotect', { value: 'two' })
    ]);
    assert.deepStrictEqual(first, { value: 'one' });
    assert.deepStrictEqual(second, { value: 'two' });
    await helper.close();
    await assert.rejects(helper.request('protect', { value: 'late' }), /PLATFORM_HELPER_CLOSED/);

    const exited = await startPlatformHelper({ executable: 'fake-helper.exe', stateRoot: 'C:\\state', spawnFn: fakeSpawn });
    lastChild.stdin.removeAllListeners('data');
    const pending = exited.request('protect', { value: 'pending' });
    lastChild.emit('exit', 73, null);
    await assert.rejects(pending, /PLATFORM_HELPER_EXITED/);

    if (process.platform === 'win32') {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-platform-'));
        const executable = path.join(root, 'PosSpoolerPlatform.exe');
        const stateRoot = path.join(root, 'state');
        const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
        const source = path.resolve(__dirname, '../windows-helper/PosSpoolerPlatform.cs');
        execFileSync(compiler, [
            '/nologo', '/optimize+', '/target:exe', `/out:${executable}`,
            '/r:System.Web.Extensions.dll', '/r:System.Security.dll', source
        ]);
        const real = await startPlatformHelper({ executable, stateRoot });
        const protectedValue = await real.request('protect', { value: Buffer.from('roundtrip').toString('base64') });
        const unprotected = await real.request('unprotect', { value: protectedValue.value });
        assert.strictEqual(Buffer.from(unprotected.value, 'base64').toString(), 'roundtrip');

        const duplicate = spawn(executable, ['--state-root', stateRoot], { windowsHide: true });
        let duplicateOutput = '';
        duplicate.stdout.on('data', chunk => { duplicateOutput += chunk; });
        const duplicateExit = await new Promise(resolve => duplicate.once('exit', resolve));
        assert.strictEqual(duplicateExit, 73);
        assert.match(duplicateOutput, /STATE_ROOT_LOCKED/);
        await real.close();
        fs.rmSync(root, { recursive: true, force: true });
    }

    let spawnCount = 0;
    let lastRestartChild;
    function restartableSpawn() {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
        child.stdin.on('data', chunk => {
            for (const line of String(chunk).trim().split(/\r?\n/)) {
                if (!line) continue;
                const request = JSON.parse(line);
                child.stdout.write(`${JSON.stringify({ id: request.id, result: { statuses: [] } })}\n`);
            }
        });
        process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
        spawnCount += 1;
        lastRestartChild = child;
        return child;
    }
    const restarting = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: restartableSpawn,
        restartOnExit: true,
        restartDelayMs: 1
    });
    await restarting.watchPrinters(['Kitchen-1']);
    lastRestartChild.emit('exit', 1, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(spawnCount, 2, 'helper should restart after an unexpected exit');
    await restarting.close();

    const hanging = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: restartableSpawn,
        restartOnExit: true,
        restartDelayMs: 1,
        requestTimeoutMs: 20
    });
    lastRestartChild.stdin.removeAllListeners('data');
    await assert.rejects(hanging.request('print_raw', {}), /PLATFORM_HELPER_TIMEOUT/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(lastRestartChild.killed, false, 'a timed-out native write must not be terminated');
    assert.equal(hanging.isReady(), true, 'independent printers remain available');
    const timedOutChild = lastRestartChild;
    let closeFinished = false;
    const safeClose = hanging.close().then(() => { closeFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closeFinished, false, 'shutdown waits for the native write');
    assert.equal(timedOutChild.killed, false);
    timedOutChild.stdout.write(`${JSON.stringify({ id: 1, result: { job_id: 17 } })}\n`);
    await safeClose;
    await hanging.close();

    const statusHanging = await startPlatformHelper({
        executable: 'fake-helper.exe', stateRoot: 'C:\\state', spawnFn: restartableSpawn,
        restartOnExit: true, restartDelayMs: 1, requestTimeoutMs: 20
    });
    const statusChild = lastRestartChild;
    statusChild.stdin.removeAllListeners('data');
    await assert.rejects(
        statusHanging.request('printer_status', {}),
        error => error.code === 'PLATFORM_HELPER_TIMEOUT' && error.failureClass === 'transient_safe'
    );
    assert.strictEqual(statusChild.killed, true, 'a hung status command must kill the child helper and mark it unready before restart');
    assert.strictEqual(statusHanging.isReady(), false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(statusHanging.isReady(), true, 'the helper should become ready again after recycling');
    await statusHanging.close();

    // beforeWrite hook tests
    let helperForBeforeWriteChild;
    function beforeWriteSpawn() {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin.on('data', chunk => {
            for (const line of String(chunk).trim().split(/\r?\n/)) {
                if (!line) continue;
                const request = JSON.parse(line);
                child.stdout.write(`${JSON.stringify({ id: request.id, result: { job_id: 101 } })}\n`);
            }
        });
        process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
        helperForBeforeWriteChild = child;
        return child;
    }
    const bwHelper = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: beforeWriteSpawn
    });

    const bwEvents = [];
    const bwResult = await bwHelper.request('print_raw', {}, {
        beforeWrite: async () => {
            bwEvents.push('before-write-hook');
        }
    });
    assert.strictEqual(bwResult.job_id, 101);
    assert.deepStrictEqual(bwEvents, ['before-write-hook']);

    let markerPersisted = false;
    await assert.rejects(
        bwHelper.request('print_raw', {}, {
            beforeWrite: async () => {
                markerPersisted = true;
                helperForBeforeWriteChild.emit('exit', 1, null);
            }
        }),
        error => error.code === 'PLATFORM_HELPER_RESTARTING' && error.failureClass === 'uncertain'
    );
    assert.strictEqual(markerPersisted, true, 'helper loss after the marker must never be classified as retry-safe');

    // If helper is unready before beforeWrite, beforeWrite is never called and helper rejects with transient_safe
    let neverCalled = false;
    helperForBeforeWriteChild.emit('exit', 1, null);
    await assert.rejects(
        bwHelper.request('print_raw', {}, { beforeWrite: async () => { neverCalled = true; } }),
        error => error.code === 'PLATFORM_HELPER_RESTARTING'
    );
    assert.strictEqual(neverCalled, false, 'beforeWrite must never be called when helper child is not ready');
    await bwHelper.close();

    let watchRequests = 0;
    function watchTimeoutSpawn() {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => child.emit('exit', 0, null);
        child.stdin.on('data', chunk => {
            for (const line of String(chunk).trim().split(/\r?\n/)) {
                if (!line) continue;
                const request = JSON.parse(line);
                if (request.command === 'watch_printers') { watchRequests += 1; continue; }
                child.stdout.write(`${JSON.stringify({ id: request.id, result: { job_id: 99 } })}\n`);
            }
        });
        process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
        return child;
    }
    const watchTimeout = await startPlatformHelper({
        executable: 'fake-helper.exe', stateRoot: 'C:\\state', spawnFn: watchTimeoutSpawn,
        restartOnExit: true, restartDelayMs: 1, requestTimeoutMs: 20
    });
    await assert.rejects(watchTimeout.runExclusive(() => watchTimeout.watchPrinters(['Kitchen-1'])), /PLATFORM_HELPER_TIMEOUT/);
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterWatchTimeout = await watchTimeout.runExclusive(() => watchTimeout.request('print_raw', {}));
    assert.strictEqual(afterWatchTimeout.job_id, 99, 'a failed watch must not starve later printing');
    assert.strictEqual(watchRequests, 1, 'a failed watch must not auto-replay after helper restart');
    await watchTimeout.close();

    const closingDuringRestart = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: restartableSpawn,
        restartOnExit: true,
        restartDelayMs: 1000
    });
    lastRestartChild.emit('exit', 1, null);
    await Promise.race([
        closingDuringRestart.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('helper close hung during restart backoff')), 250))
    ]);

    async function waitFor(predicate, label = 'helper condition') {
        for (let attempt = 0; attempt < 80; attempt += 1) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`Timed out waiting for ${label}`);
    }

    let recordedChild;
    function recordingSpawn() {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.requests = [];
        child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
        child.stdin.on('data', chunk => {
            for (const line of String(chunk).trim().split(/\r?\n/)) {
                if (!line) continue;
                child.requests.push(JSON.parse(line));
            }
        });
        process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
        recordedChild = child;
        return child;
    }

    const concurrent = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: recordingSpawn,
        restartOnExit: true,
        restartDelayMs: 5,
        requestTimeoutMs: 50
    });
    const markers = [];
    const printerA = concurrent.request('print_raw', { printer_name: 'A' }, {
        beforeWrite: () => markers.push('A')
    });
    const printerB = concurrent.request('print_raw', { printer_name: 'B' }, {
        beforeWrite: () => markers.push('B'), timeoutMs: 5000
    });
    await waitFor(() => recordedChild.requests.length === 2, 'both print_raw commands to be written');
    const ids = recordedChild.requests.map(request => request.id);
    assert.strictEqual(new Set(ids).size, 2, 'each printer must keep its own request id');
    assert.deepStrictEqual([...markers].sort(), ['A', 'B']);
    const childDuringTimeout = recordedChild;
    const requestA = recordedChild.requests.find(request => request.payload.printer_name === 'A');
    const requestB = recordedChild.requests.find(request => request.payload.printer_name === 'B');
    assert.notStrictEqual(requestA.id, requestB.id);

    await assert.rejects(
        printerA,
        error => error.code === 'PLATFORM_HELPER_TIMEOUT' && error.failureClass === 'uncertain'
    );
    assert.strictEqual(childDuringTimeout.killed, false, 'timeout must not kill the helper while another print is pending');
    assert.strictEqual(concurrent.isReady(), true, 'other printer requests remain available');

    let lateMarker = false;
    const printerC = concurrent.request('print_raw', { printer_name: 'C' }, { beforeWrite: () => { lateMarker = true; }, timeoutMs: 5000 });
    await waitFor(() => childDuringTimeout.requests.length === 3, 'independent C accepted');
    assert.strictEqual(lateMarker, true);
    const requestC = childDuringTimeout.requests.find(request => request.payload.printer_name === 'C');
    childDuringTimeout.stdout.write(`${JSON.stringify({ id: requestC.id, result: { job_id: 45 } })}\n`);
    assert.strictEqual((await printerC).job_id, 45);

    childDuringTimeout.stdout.write(`${JSON.stringify({ id: requestB.id, result: { job_id: 44 } })}\n`);
    assert.strictEqual((await printerB).job_id, 44, 'already-started B must finish and stay completed');
    assert.strictEqual(childDuringTimeout.killed, false, 'timed-out A is still executing natively');
    childDuringTimeout.stdout.write(`${JSON.stringify({ id: requestA.id, result: { job_id: 43 } })}\n`);
    assert.strictEqual(childDuringTimeout.killed, false, 'late native completion does not replay or cancel');
    await concurrent.close();

    let releaseMarker;
    const markerHeld = new Promise(resolve => { releaseMarker = resolve; });
    let markerEntered;
    const markerReady = new Promise(resolve => { markerEntered = resolve; });
    const preCommand = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: recordingSpawn,
        restartOnExit: true,
        restartDelayMs: 5,
        requestTimeoutMs: 40
    });
    const preCommandChild = recordedChild;
    const preCommandPrint = preCommand.request('print_raw', { printer_name: 'Kitchen' }, {
        beforeWrite: async () => {
            markerEntered();
            await markerHeld;
        },
        timeoutMs: 5000
    });
    await markerReady;
    await assert.rejects(
        preCommand.request('printer_status', { printer_name: 'Kitchen' }),
        error => error.code === 'PLATFORM_HELPER_TIMEOUT' && error.failureClass === 'transient_safe'
    );
    assert.strictEqual(preCommandChild.killed, false, 'status timeout must not kill a print still inside beforeWrite');
    assert.strictEqual(
        preCommandChild.requests.filter(request => request.command === 'print_raw').length,
        0,
        'the print command must not be written until beforeWrite finishes'
    );
    releaseMarker();
    await waitFor(
        () => preCommandChild.requests.some(request => request.command === 'print_raw'),
        'accepted print_raw to be written after beforeWrite'
    );
    const writtenPrints = preCommandChild.requests.filter(request => request.command === 'print_raw');
    assert.strictEqual(writtenPrints.length, 1, 'the accepted print must be written exactly once');
    preCommandChild.stdout.write(`${JSON.stringify({ id: writtenPrints[0].id, result: { job_id: 88 } })}\n`);
    assert.strictEqual((await preCommandPrint).job_id, 88);
    await waitFor(() => preCommandChild.killed === true, 'helper recycle after the accepted print settles');
    await preCommand.close();

    const statusDuringPrint = await startPlatformHelper({
        executable: 'fake-helper.exe',
        stateRoot: 'C:\\state',
        spawnFn: recordingSpawn,
        restartOnExit: true,
        restartDelayMs: 5,
        requestTimeoutMs: 40
    });
    const marked = [];
    const printDuringStatus = statusDuringPrint.request('print_raw', { printer_name: 'Kitchen' }, {
        beforeWrite: () => marked.push('Kitchen'),
        timeoutMs: 5000
    });
    await waitFor(() => recordedChild.requests.some(request => request.command === 'print_raw'), 'print_raw to be written');
    const printChild = recordedChild;
    const printRequest = printChild.requests.find(request => request.command === 'print_raw');
    const hungStatus = statusDuringPrint.request('printer_status', { printer_name: 'Kitchen' });
    await assert.rejects(
        hungStatus,
        error => error.code === 'PLATFORM_HELPER_TIMEOUT' && error.failureClass === 'transient_safe'
    );
    assert.strictEqual(printChild.killed, false, 'a timed-out status request must not kill the helper while print_raw is pending');
    assert.deepStrictEqual(marked, ['Kitchen']);
    printChild.stdout.write(`${JSON.stringify({ id: printRequest.id, result: { job_id: 77 } })}\n`);
    assert.strictEqual((await printDuringStatus).job_id, 77, 'an already-marked print must complete normally after a concurrent status timeout');
    await waitFor(() => printChild.killed === true, 'helper recycle after the print settles');
    await statusDuringPrint.close();
    console.log('v2-platform-helper tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

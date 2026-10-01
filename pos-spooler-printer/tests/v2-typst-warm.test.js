const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypstRenderer, createTypstWatchCompiler } = require('../v2/typst-renderer');
const { createRendererRouter } = require('../v2/renderer-router');
const { createPrinterWorkers } = require('../v2/printer-workers');

// The Typst compiler is started when the workers start, so the first ticket of the day does
// not pay for the cold start. One shot: no timer, and a failed warm-up changes nothing else.


(async () => {
    // The renderer starts its compiler once, before any job, and jobs reuse it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-warm-'));
    try {
        let built = 0, warmed = 0;
        const renderer = createTypstRenderer({ stateRoot: root, compilerFactory: () => {
            built++;
            return { warm: async () => { warmed++; }, compile: async () => { throw new Error('unused'); }, close: async () => {}, health: () => ({ state: 'ready' }) };
        } });
        await renderer.warm();
        await renderer.warm();
        assert.equal(built, 1, 'one compiler is created and kept');
        assert.equal(warmed, 2, 'the compiler itself makes a second warm-up a no-op');
        assert.equal(renderer.health().state, 'ready');
        await renderer.close();

        const failing = createTypstRenderer({ stateRoot: root, compilerFactory: () => ({
            warm: async () => { throw Object.assign(new Error('missing'), { code: 'TYPST_UNAVAILABLE' }); },
            compile: async () => {}, close: async () => {}, health: () => ({ state: 'cold' })
        }) });
        await failing.warm(); // never rejects
        assert.equal(failing.health().last_error, 'TYPST_UNAVAILABLE');
        await failing.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }

    // The first start gets a longer budget than a normal compile; later compiles keep theirs.
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-warm-start-'));
    let ready = false;
    const compiler = createTypstWatchCompiler({
        stateRoot: runtimeRoot, executable: 'controlled-typst.exe', fontPath: 'fonts',
        limits: { compileMs: 100, maxDiagnosticsBytes: 1024 },
        spawnImpl: (_executable, args) => {
            const child = new EventEmitter();
            child.stderr = new EventEmitter();
            const output = args.at(-1);
            child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
            // A cold start: fonts load and the first compile lands well after one compileMs.
            setTimeout(() => {
                fs.writeFileSync(output, Buffer.from('png'));
                ready = true;
                child.stderr.emit('data', Buffer.from('[00:00:00] compiled successfully in 1 ms\n'));
            }, 350);
            return child;
        }
    });
    try {
        await compiler.warm();
        assert(ready, 'a slow first start is waited for');
        assert.equal(compiler.health().state, 'ready');
        const started = Date.now();
        await assert.rejects(
            compiler.compile({ source: '#set page(width: 576pt)\nhi', assets: [], assetPrefix: 'assets-x', renderToken: '0'.repeat(32) }),
            error => error.code === 'TYPST_TIMEOUT'
        );
        assert(Date.now() - started < 1500, 'a normal compile still times out on compileMs');
    } finally {
        await compiler.close();
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }

    // A ticket that arrives while the start-up compile is still running waits for it.
    const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-warm-race-'));
    let raceChild;
    const raceCompiler = createTypstWatchCompiler({
        stateRoot: raceRoot, executable: 'controlled-typst.exe', fontPath: 'fonts',
        limits: { compileMs: 2000, maxDiagnosticsBytes: 1024 },
        spawnImpl: (_executable, args) => {
            const child = new EventEmitter();
            child.stderr = new EventEmitter();
            const output = args.at(-1);
            child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
            const done = () => {
                fs.writeFileSync(output, Buffer.from('png'));
                child.stderr.emit('data', Buffer.from('[00:00:00] compiled successfully in 1 ms\n'));
            };
            setTimeout(done, 150);
            raceChild = { child, done };
            return child;
        }
    });
    try {
        const warming = raceCompiler.warm();
        const png = raceCompiler.compile({ source: '#set page(width: 576pt)\nhi', assets: [], assetPrefix: 'assets-race', renderToken: '0'.repeat(32) });
        await warming;
        // The ticket's own compile starts only after the start-up compile has landed.
        setTimeout(() => raceChild.done(), 20);
        assert((await png).length > 0, 'a compile that begins before warm() resolves succeeds');
    } finally {
        await raceCompiler.close();
        fs.rmSync(raceRoot, { recursive: true, force: true });
    }

    // While the start-up compile is pending the compiler is 'starting', not 'ready'.
    const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-warm-health-'));
    let healthDone;
    const healthCompiler = createTypstWatchCompiler({
        stateRoot: healthRoot, executable: 'controlled-typst.exe', fontPath: 'fonts',
        limits: { compileMs: 2000, maxDiagnosticsBytes: 1024 },
        spawnImpl: (_executable, args) => {
            const child = new EventEmitter();
            child.stderr = new EventEmitter();
            const output = args.at(-1);
            child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
            healthDone = () => {
                fs.writeFileSync(output, Buffer.from('png'));
                child.stderr.emit('data', Buffer.from('[00:00:00] compiled successfully in 1 ms\n'));
            };
            return child;
        }
    });
    try {
        assert.equal(healthCompiler.health().state, 'cold');
        const warming = healthCompiler.warm();
        assert.equal(healthCompiler.health().state, 'starting', 'not ready while the warm-up compile is pending');
        healthDone();
        await warming;
        assert.equal(healthCompiler.health().state, 'ready');
    } finally {
        await healthCompiler.close();
        fs.rmSync(healthRoot, { recursive: true, force: true });
    }

    // The router warms Typst only; the workers warm once when they start.
    let typstWarms = 0, rawBuilt = 0;
    const router = createRendererRouter({
        createTypst: () => ({ warm: async () => { typstWarms++; }, render: async () => ({}), close: async () => {} }),
        createRaw: () => { rawBuilt++; return { render: async () => ({}), close: async () => {} }; }
    });
    await router.warm();
    assert.equal(typstWarms, 1);
    assert.equal(rawBuilt, 0);

    let warmCalls = 0;
    const timers = { setTimeout() { throw new Error('warm-up must not use a timer'); }, clearTimeout() {} };
    const workers = createPrinterWorkers({
        store: { runnable: () => [], get: () => null },
        renderer: { render: async () => ({}), warm: () => { warmCalls++; return Promise.reject(new Error('cold start failed')); }, health: () => ({ state: 'cold' }) },
        transportFor: () => ({ send: async () => ({ success: true }) }),
        timers
    });
    process.once('unhandledRejection', error => { throw error; });
    workers.start();
    workers.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warmCalls, 1, 'started once, however often the runtime restarts the workers');
    await workers.stop();

    console.log('v2-typst-warm tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

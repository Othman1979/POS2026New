// No database, server, or printer. Each sample gets a fresh process.
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const mib = bytes => bytes / 1024 / 1024;
async function settledMemory() {
    for (let i = 0; i < 3; i++) { global.gc(); await pause(30); }
    const usage = process.memoryUsage();
    return { rssMiB: mib(usage.rss), heapMiB: mib(usage.heapUsed) };
}
function baselineLogger(revision) {
    const filename = path.join(root, 'backend/config/logger.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(execFileSync('git', ['show', `${revision}:backend/config/logger.js`], { encoding: 'utf8' }), filename);
    return loaded.exports;
}
async function child(kind, version, revision, workbookFile) {
    const before = await settledMemory();
    const startCpu = process.cpuUsage(), start = performance.now();
    if (kind === 'logging') {
        const logger = version === 'baseline' ? baselineLogger(revision) : require('../../backend/config/logger');
        // Let the baseline transport become ready, then compare a steady workload.
        await pause(500);
        const idle = await settledMemory();
        const busyStart = performance.now(), busyCpu = process.cpuUsage();
        for (let i = 0; i < 10000; i++) logger.info({ sequence: i, orderId: i % 200, status: 'saved' }, 'Checkout complete');
        logger.error({ err: new Error('synthetic print failure'), sequence: 10000 }, 'Print failed');
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Logger flush timed out.')), 10000);
            logger.flush(error => { clearTimeout(timeout); error ? reject(error) : resolve(); });
        });
        await pause(100);
        const cpu = process.cpuUsage(busyCpu);
        process.send({ kind, version, before, idle, busyMs: performance.now() - busyStart,
            busyCpuMs: (cpu.user + cpu.system) / 1000, records: 10001 });
    } else {
        const parser = version === 'baseline' ? require('xlsx') : require('../../backend/services/catalogWorkbook');
        const idle = await settledMemory();
        const buffer = fs.readFileSync(workbookFile);
        let ticks = 0, largestGapMs = 0, previousTick = performance.now();
        const timer = setInterval(() => {
            const now = performance.now(); largestGapMs = Math.max(largestGapMs, now - previousTick);
            previousTick = now; ticks++;
        }, 5);
        await pause(20);
        const parseStart = performance.now(), parseCpu = process.cpuUsage();
        let rows;
        if (version === 'baseline') {
            rows = (() => {
                const workbook = parser.read(buffer, { type: 'buffer' });
                return parser.utils.sheet_to_json(workbook.Sheets.Products);
            })();
        } else {
            rows = (await parser.parseCatalogWorkbook(buffer)).prodRows;
        }
        const parseMs = performance.now() - parseStart, cpu = process.cpuUsage(parseCpu);
        const count = rows.length, hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        rows = null;
        await pause(20); clearInterval(timer);
        const after = await settledMemory();
        process.send({ kind, version, before, idle, after, parseMs, parseCpuMs: (cpu.user + cpu.system) / 1000,
            largestGapMs, ticks, count, hash, peakRssKiB: process.resourceUsage().maxRSS });
    }
    const cpu = process.cpuUsage(startCpu);
    process.send({ totalMs: performance.now() - start, totalCpuMs: (cpu.user + cpu.system) / 1000 });
    process.disconnect();
}
async function parent() {
    const revision = process.argv[2] || '61ab4e38';
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
    const folder = fs.mkdtempSync(path.join(root, 'scratch/resource-experiment-'));
    const xlsx = require('xlsx');
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Name: 'Food' }]), 'Categories');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(Array.from({ length: 20000 }, (_, i) =>
        ({ Name: `Product ${i}`, Price: i / 100, Category: 'Food', 'Tax Rate': 16 }))), 'Products');
    const workbookFile = path.join(folder, 'catalog.xlsx');
    xlsx.writeFile(workbook, workbookFile, { compression: true });
    const results = [];
    try {
        for (const kind of ['logging', 'import']) for (let round = 0; round < 3; round++) {
            for (const version of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
                const env = { ...process.env, NODE_ENV: 'production', LOG_OUTPUT: 'stdout', LOG_LEVEL: 'info', POSAPP_LOG_DIR: path.join(folder, `logs-${round}`) };
                delete env.NODE_OPTIONS; delete env.POSAPP_REVIEW_DB;
                const sample = await new Promise((resolve, reject) => {
                    let result = {}, output = '', errors = '';
                    const processChild = fork(__filename, ['--child', kind, version, revision, workbookFile], {
                        cwd: root, env, execArgv: ['--expose-gc'], stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                    });
                    processChild.stdout.on('data', bytes => { output += bytes; });
                    processChild.stderr.on('data', bytes => { errors += bytes; });
                    processChild.on('message', data => { Object.assign(result, data); });
                    processChild.on('error', reject);
                    processChild.on('exit', code => {
                        try {
                            assert.equal(code, 0, errors);
                            assert.equal(result.kind, kind, 'Child exited before reporting resource measurements.');
                            if (kind === 'logging') {
                                const lines = output.trim().split('\n').map(JSON.parse);
                                assert.equal(lines.length, 10001);
                                lines.forEach((line, index) => assert.equal(line.sequence, index));
                                assert.equal(lines.at(-1).err.message, 'synthetic print failure');
                            }
                            resolve({ round, ...result });
                        } catch (error) { reject(error); }
                    });
                });
                results.push(sample); console.log(JSON.stringify(sample));
            }
        }
        assert.equal(new Set(results.filter(x => x.kind === 'import').map(x => x.hash)).size, 1);
        const evidence = { baseline: revision, node: process.version, platform: process.platform,
            workbookBytes: fs.statSync(workbookFile).size,
            limits: 'Module-level subprocess comparison, not full Hostinger RSS. Import worker trades total parse time/CPU for main-thread responsiveness. RSS is process-wide; heap is main isolate only. Peak RSS is not sampled baseline-vs-worker attribution.', results };
        fs.writeFileSync(path.join(root, 'scratch/backend-resource-comparison.json'), JSON.stringify(evidence, null, 2));
    } finally {
        // mkdtemp-created directory is constrained to the task scratch root.
        assert.equal(path.dirname(folder), path.join(root, 'scratch'));
        fs.rmSync(folder, { recursive: true, force: true });
    }
}
(process.argv[2] === '--child' ? child(...process.argv.slice(3)) : parent()).catch(error => {
    console.error(error); process.exitCode = 1;
});

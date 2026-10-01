// Run the full Vitest suite in about five minutes: balanced parallel shards, each
// a separate `scripts/test-isolated.cjs` run against its OWN throwaway MariaDB
// server (local MariaDB binaries, its own port and datadir, no fsync, one shared
// tablespace). One shared server serializes the per-test schema rebuild
// (seedDatabase drops and recreates every table) across shards; separate
// servers do not. The developer database is never touched.
//
// Files are balanced by their last measured duration. A file longer than an
// average shard is split into test-name parts (every test reseeds, so parts are
// independent), using the per-test durations from the previous run's reports.
//
// Usage: npm run test:isolated:shards [-- --shards=N] [-- <file filter> ...]
// Env:   POSAPP_TEST_MYSQL_BIN (default C:/xampp/mysql/bin), POSAPP_TEST_SHARD_PORT (default 3401)
// Logs, JSON reports and the duration history live in scratch/test-shards/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const work = path.join(root, 'scratch', 'test-shards');
const durationsFile = path.join(work, 'durations.json');
const mysqlBin = (process.env.POSAPP_TEST_MYSQL_BIN || 'C:/xampp/mysql/bin').replace(/\\/g, '/');
const basePort = Number(process.env.POSAPP_TEST_SHARD_PORT) || 3401;
const exe = (name) => path.join(mysqlBin, process.platform === 'win32' ? `${name}.exe` : name);
const args = process.argv.slice(2);
const shardArg = args.find((arg) => arg.startsWith('--shards='));
const shardCount = Math.max(1, Number(shardArg?.slice('--shards='.length)) || Math.min(20, Math.max(2, os.cpus().length - 4)));
const requested = args.filter((arg) => !arg.startsWith('--'));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const minutes = () => ((Date.now() - started) / 60000).toFixed(1);
const toPosix = (file) => file.split(path.sep).join('/');

for (const binary of ['mysqld', 'mysql_install_db', 'mysqladmin']) {
    if (!fs.existsSync(exe(binary))) {
        console.error(`Missing ${exe(binary)}. Set POSAPP_TEST_MYSQL_BIN to a MariaDB bin directory, or run npm run test:isolated.`);
        process.exit(1);
    }
}

// ---- test files (mirrors the include globs in vitest.config.mjs) ----
const walk = (dir, matches) => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full, matches);
    return matches(entry.name) ? [toPosix(path.relative(root, full))] : [];
}));
const allFiles = [
    ...walk(path.join(root, 'backend/tests/unit'), (name) => name.endsWith('.test.js')),
    ...walk(path.join(root, 'backend/tests/integration'), (name) => name.endsWith('.test.js')),
    ...walk(path.join(root, 'src'), (name) => name.endsWith('.spec.js')),
];
const files = requested.length ? allFiles.filter((file) => requested.some((filter) => file.includes(filter))) : allFiles;
if (!files.length) { console.error('No test files matched.'); process.exit(1); }

// ---- durations: Vitest's results cache, overlaid by earlier sharded runs ----
const durations = new Map();
const cacheRoot = path.join(root, 'node_modules', '.vite', 'vitest');
for (const dir of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
    const cache = readJson(path.join(cacheRoot, dir, 'results.json'));
    const rows = Array.isArray(cache?.results) ? cache.results : Object.values(cache?.results || {});
    for (const [key, value] of rows) if (value?.duration) durations.set(key.replace(/^:/, ''), Number(value.duration));
}
for (const [file, ms] of Object.entries(readJson(durationsFile) || {})) durations.set(file, Number(ms));
const known = [...durations.values()].filter((ms) => ms > 0).sort((a, b) => a - b);
const fallbackMs = known.length ? known[Math.floor(known.length / 2)] : 5000;
const weighted = files.map((file) => ({ file, ms: Number(durations.get(file)) || fallbackMs })).sort((a, b) => b.ms - a.ms);
const totalMs = weighted.reduce((sum, item) => sum + item.ms, 0);
const target = totalMs / shardCount;

// ---- per-test durations from the previous reports, for splitting giant files ----
const previousTests = new Map();
for (const name of fs.existsSync(work) ? fs.readdirSync(work).filter((n) => /^shard-\d+\.json$/.test(n)) : []) {
    for (const result of readJson(path.join(work, name))?.testResults || []) {
        const file = toPosix(path.relative(root, result.name));
        const list = previousTests.get(file) || [];
        for (const test of result.assertionResults || []) list.push({ name: test.fullName, ms: test.duration || 0 });
        previousTests.set(file, list);
    }
}
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
const groups = [];
const rest = [];
for (const item of weighted) {
    const tests = [...new Map((previousTests.get(item.file) || []).map((t) => [t.name, t])).values()];
    const parts = Math.min(tests.length, Math.ceil(item.ms / target));
    if (parts < 2 || shardCount < 4) { rest.push(item); continue; }
    const buckets = Array.from({ length: parts }, () => ({ ms: 0, names: [] }));
    for (const test of tests.sort((a, b) => b.ms - a.ms)) {
        const bucket = buckets.reduce((min, b) => (b.ms < min.ms ? b : min), buckets[0]);
        bucket.names.push(test.name);
        bucket.ms += test.ms;
    }
    // A test missing from the last report (new or renamed) still runs: the last
    // part matches every name not listed in the earlier parts.
    const listed = buckets.slice(0, -1).flatMap((b) => b.names);
    buckets.forEach((bucket, index) => groups.push({
        ms: item.ms / parts,
        files: [item.file],
        pattern: index < parts - 1
            ? `^(?:${bucket.names.map(escapeRe).join('|')})$`
            : `^(?!(?:${listed.map(escapeRe).join('|')})$)`,
    }));
}
const bulk = Array.from({ length: Math.max(1, shardCount - groups.length) }, () => ({ ms: 0, files: [] }));
for (const item of rest) {
    const lightest = bulk.reduce((min, shard) => (shard.ms < min.ms ? shard : min), bulk[0]);
    lightest.files.push(item.file);
    lightest.ms += item.ms;
}
groups.push(...bulk.filter((shard) => shard.files.length));

// ---- throwaway MariaDB servers ----
const servers = [];
const portFree = (port) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
});
const writeIni = (dir, port) => {
    const d = toPosix(dir).replace(/\\/g, '/');
    const base = path.dirname(mysqlBin).replace(/\\/g, '/');
    fs.writeFileSync(path.join(dir, 'shard.ini'), [
        '[mysqld]', `port=${port}`, 'bind-address=127.0.0.1', `datadir="${d}/data"`, `tmpdir="${d}/tmp"`,
        `basedir="${base}"`, `plugin_dir="${base}/lib/plugin/"`, `log_error="${d}/error.log"`,
        'skip-log-bin', 'max_allowed_packet=1M', 'max_connections=300',
        // Throwaway data: no fsync, no doublewrite, one shared tablespace (the
        // per-test table rebuild would otherwise create and delete a file per table).
        'innodb_buffer_pool_size=64M', 'innodb_file_per_table=0', 'innodb_log_buffer_size=16M',
        'innodb_flush_log_at_trx_commit=0', 'innodb_doublewrite=0', 'innodb_lock_wait_timeout=50',
        // Same behavior-relevant settings as the XAMPP server.
        'sql_mode=NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION', 'log_bin_trust_function_creators=1',
        'character-set-server=utf8mb4', 'collation-server=utf8mb4_general_ci', '',
    ].join('\n'));
};
const waitReady = async (port) => {
    const mysql = require('mysql2/promise');
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
            await connection.end();
            return true;
        } catch (_) { await sleep(500); }
    }
    return false;
};
const shutdownAll = () => {
    for (const server of servers) {
        spawnSync(exe('mysqladmin'), ['-h', '127.0.0.1', '-P', String(server.port), '-u', 'root', 'shutdown'], { timeout: 20000 });
        try { process.kill(server.pid); } catch (_) {}
    }
    for (const server of servers) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            try { fs.rmSync(server.dir, { recursive: true, force: true }); break; } catch (_) { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']); }
        }
    }
};
process.on('SIGINT', () => { shutdownAll(); process.exit(130); });

(async () => {
    fs.mkdirSync(work, { recursive: true });
    for (const name of fs.readdirSync(work).filter((n) => /^shard-\d+\.(json|log)$/.test(n))) fs.rmSync(path.join(work, name), { force: true });
    console.log(`${files.length} files in ${groups.length} shards (${groups.filter((g) => g.pattern).length} test-name parts), estimated ${(Math.max(...groups.map((g) => g.ms)) / 60000).toFixed(1)} min longest shard. Logs: ${toPosix(path.relative(root, work))}`);

    const template = path.join(work, 'template');
    if (!fs.existsSync(path.join(template, 'mysql'))) {
        fs.rmSync(template, { recursive: true, force: true });
        const init = spawnSync(exe('mysql_install_db'), [`--datadir=${template}`], { encoding: 'utf8' });
        if (init.status !== 0) { console.error('mysql_install_db failed', init.stdout, init.stderr); process.exit(1); }
        fs.rmSync(path.join(template, 'my.ini'), { force: true });
    }
    for (let index = 0; index < groups.length; index += 1) {
        const port = basePort + index;
        if (!await portFree(port)) { console.error(`Port ${port} is in use; set POSAPP_TEST_SHARD_PORT.`); shutdownAll(); process.exit(1); }
        const dir = path.join(work, `db-${index + 1}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
        fs.cpSync(template, path.join(dir, 'data'), { recursive: true });
        writeIni(dir, port);
        const child = spawn(exe('mysqld'), [`--defaults-file=${path.join(dir, 'shard.ini')}`], { detached: true, stdio: 'ignore' });
        child.unref();
        servers.push({ port, pid: child.pid, dir });
    }
    if ((await Promise.all(servers.map((server) => waitReady(server.port)))).some((ready) => !ready)) {
        console.error('A throwaway MariaDB server did not start; see scratch/test-shards/db-*/error.log.');
        shutdownAll();
        process.exit(1);
    }

    const results = await Promise.all(groups.map((group, index) => new Promise((resolve) => {
        const name = `shard-${index + 1}`;
        const log = fs.createWriteStream(path.join(work, `${name}.log`));
        const vitestArgs = ['--no-cache', '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(work, `${name}.json`)}`];
        if (group.pattern) vitestArgs.push('-t', group.pattern);
        const child = spawn(process.execPath, [path.join(root, 'scripts', 'test-isolated.cjs'), ...vitestArgs, ...group.files], {
            cwd: root,
            env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(servers[index].port) },
        });
        child.stdout.pipe(log);
        child.stderr.pipe(log);
        child.on('close', (code) => { log.end(); resolve({ name, code }); });
    })));
    shutdownAll();

    let passed = 0; let failed = 0;
    const failures = [];
    const measured = new Map();
    for (const { name, code } of results) {
        const report = readJson(path.join(work, `${name}.json`));
        if (!report) { failures.push(`${name}: no report (exit ${code}); see ${name}.log`); continue; }
        passed += report.numPassedTests || 0;
        failed += report.numFailedTests || 0;
        for (const result of report.testResults || []) {
            const file = toPosix(path.relative(root, result.name));
            if (result.startTime && result.endTime) measured.set(file, (measured.get(file) || 0) + result.endTime - result.startTime);
            if (result.status === 'failed') failures.push(`${name}: ${file}${result.message ? ` - ${result.message.split('\n')[0]}` : ''}`);
        }
    }
    for (const [file, ms] of measured) durations.set(file, ms);
    fs.writeFileSync(durationsFile, JSON.stringify(Object.fromEntries(durations), null, 1));
    console.log(`\n${passed} passed / ${failed} failed tests in ${minutes()} min`);
    console.log(failures.length ? [...new Set(failures)].join('\n') : 'No failures.');
    process.exitCode = failures.length || results.some((r) => r.code !== 0) ? 1 : 0;
})().catch((error) => { console.error(error); shutdownAll(); process.exit(1); });

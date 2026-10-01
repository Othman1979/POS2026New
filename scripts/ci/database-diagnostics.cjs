// Diagnostic reads of the disposable CI service only; never print its environment.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const mysql = require('mysql2/promise');

function collectDiagnostics(containerId, execute = spawnSync) {
    if (!/^[a-f0-9]{12,64}$/.test(containerId || '')) throw new Error('A CI MariaDB container ID is required.');
    const commands = [
        ['state', 'docker', ['inspect', '--format', '{{json .State}}', containerId]],
        ['logs', 'docker', ['logs', '--tail', '250', containerId]],
        ['resources', 'docker', ['stats', '--no-stream', containerId]],
        ['hostMemory', 'free', ['-m']],
        ['hostDisk', 'df', ['-h']],
        ['innodb', 'docker', ['exec', containerId, 'mariadb', '-uroot', '-e',
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Aborted_connects'); SHOW ENGINE INNODB STATUS;"]]
    ];
    return Object.fromEntries(commands.map(([name, command, args]) => {
        const result = execute(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
        return [name, { status: result.status, signal: result.signal, error: result.error?.message,
            stdout: result.stdout || '', stderr: result.stderr || '' }];
    }));
}

async function collectWindowsDiagnostics(env = process.env, dependencies = {}) {
    const execute = dependencies.execute || spawnSync;
    const createConnection = dependencies.createConnection || mysql.createConnection;
    const report = {
        host: { platform: process.platform, release: os.release(), totalMemory: os.totalmem(), freeMemory: os.freemem() },
        service: null,
        database: null,
    };
    const service = execute('powershell.exe', ['-NoProfile', '-Command',
        "Get-Service mysql -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType | ConvertTo-Json -Compress"],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    report.service = { status: service.status, stdout: service.stdout || '', stderr: service.stderr || '' };
    let connection;
    try {
        connection = await createConnection({
            host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306),
            user: env.DB_USER || 'root', password: env.DB_PASSWORD || '', connectTimeout: 5_000,
        });
        const [status] = await connection.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Aborted_connects')");
        const [[innodb]] = await connection.query('SHOW ENGINE INNODB STATUS');
        report.database = { status, innodb: innodb?.Status || '' };
    } catch (error) {
        report.database = { error: error.message, code: error.code };
    } finally {
        await connection?.end().catch(() => {});
    }
    return report;
}

async function writeDiagnostics(env = process.env) {
    const output = path.resolve('scratch/ci-diagnostics');
    fs.mkdirSync(output, { recursive: true });
    try {
        const report = env.MARIADB_CONTAINER_ID
            ? collectDiagnostics(env.MARIADB_CONTAINER_ID)
            : await collectWindowsDiagnostics(env);
        fs.writeFileSync(path.join(output, 'database.json'), JSON.stringify(report, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(output, 'error.txt'), error.message);
        throw error;
    }
}

if (require.main === module) {
    writeDiagnostics().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
module.exports = { collectDiagnostics, collectWindowsDiagnostics, writeDiagnostics };

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');

if (process.env.POSAPP_ENV_FILE && fs.existsSync(process.env.POSAPP_ENV_FILE)) dotenv.config({ path: process.env.POSAPP_ENV_FILE });
else dotenv.config();

let logger = console;
try { logger = require('../backend/config/logger'); } catch {}

const BACKUP_DIR = process.env.POSAPP_BACKUP_DIR || path.join(__dirname, '../backup');
const RETENTION_DAYS = Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10);

function parseCliArgs(argv) {
    if (argv.length === 0) return {};
    if (argv.length !== 2 || argv[0] !== '--output') throw new Error('Usage: db-backup.js [--output <absolute-.sql.gz-path>]');
    if (!path.isAbsolute(argv[1]) || !argv[1].endsWith('.sql.gz')) throw new Error('--output must be an absolute .sql.gz path.');
    return { output: path.normalize(argv[1]) };
}

function writeStatusFile(status, backupDir = BACKUP_DIR) {
    fs.mkdirSync(backupDir, { recursive: true });
    const statusPath = path.join(backupDir, 'last_status.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    const filename = status.filename !== undefined ? status.filename : existing.filename || null;
    const filePath = filename ? path.join(backupDir, filename) : null;
    fs.writeFileSync(statusPath, JSON.stringify({
        ...existing,
        ...status,
        timestamp: status.timestamp || new Date().toISOString(),
        filename,
        size_bytes: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : null
    }, null, 2));
}

function execDump(executable, args, outputPath, env) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        let childDone = false;
        let outputDone = false;
        const finish = () => { if (childDone && outputDone) resolve(); };
        child.stdout.pipe(output);
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
        child.once('error', (error) => { output.destroy(); reject(error); });
        child.once('close', (code) => {
            if (code !== 0) return reject(new Error(`mariadb-dump exited with code ${code}: ${stderr.trim()}`));
            childDone = true;
            finish();
        });
        output.once('error', reject);
        output.once('finish', () => { outputDone = true; finish(); });
    });
}

function uploadOffsite(filePath, fileName, backupDir = BACKUP_DIR) {
    const offsiteUrl = process.env.BACKUP_OFFSITE_URL;
    if (!offsiteUrl) {
        writeStatusFile({ offsite_uploaded: null }, backupDir);
        return;
    }
    const protocol = new URL(offsiteUrl).protocol === 'https:' ? require('https') : require('http');
    const url = new URL(offsiteUrl);
    const body = fs.readFileSync(filePath);
    const request = protocol.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/gzip',
            'Content-Length': body.length,
            'X-Backup-File': fileName,
            ...(process.env.BACKUP_OFFSITE_KEY ? { Authorization: `Bearer ${process.env.BACKUP_OFFSITE_KEY}` } : {})
        }
    }, (response) => {
        response.resume();
        response.once('end', () => writeStatusFile(response.statusCode >= 200 && response.statusCode < 300
            ? { offsite_uploaded: true, offsite_error: null }
            : { offsite_uploaded: false, offsite_error: `Server responded with status ${response.statusCode}` }, backupDir));
    });
    request.once('error', (error) => writeStatusFile({ offsite_uploaded: false, offsite_error: error.message }, backupDir));
    request.end(body);
}

function cleanOldBackups(backupDir = BACKUP_DIR) {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(backupDir)) {
        if (!file.endsWith('.sql.gz')) continue;
        const target = path.join(backupDir, file);
        if (fs.statSync(target).mtimeMs >= cutoff) continue;
        fs.unlinkSync(target);
        if (fs.existsSync(`${target}.sha256`)) fs.unlinkSync(`${target}.sha256`);
    }
}

async function runBackup({ output } = {}) {
    const database = process.env.DB_NAME || 'posapp';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const compressedFile = output || path.join(BACKUP_DIR, `backup-${database}-${timestamp}.sql.gz`);
    const rawFile = compressedFile.slice(0, -3);
    const backupDir = path.dirname(compressedFile);
    fs.mkdirSync(backupDir, { recursive: true });
    const executable = process.env.MYSQLDUMP_PATH || (process.platform === 'win32' ? 'mariadb-dump.exe' : 'mariadb-dump');
    const args = ['-h', process.env.DB_HOST || '127.0.0.1', '-P', String(process.env.DB_PORT || 3306), '-u', process.env.DB_USER || 'root', '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', database];
    const env = { ...process.env, ...(process.env.DB_PASSWORD ? { MYSQL_PWD: process.env.DB_PASSWORD } : {}) };
    try {
        await execDump(executable, args, rawFile, env);
        await pipeline(fs.createReadStream(rawFile), zlib.createGzip(), fs.createWriteStream(compressedFile));
        fs.unlinkSync(rawFile);
        const checksum = crypto.createHash('sha256').update(fs.readFileSync(compressedFile)).digest('hex');
        fs.writeFileSync(`${compressedFile}.sha256`, `${checksum}  ${path.basename(compressedFile)}\n`);
        writeStatusFile({ success: true, filename: path.basename(compressedFile), checksum, error: null }, backupDir);
        try { uploadOffsite(compressedFile, path.basename(compressedFile), backupDir); }
        catch (error) { logger.error({ err: error }, 'Offsite backup upload could not start.'); writeStatusFile({ offsite_uploaded: false, offsite_error: error.message }, backupDir); }
        try { cleanOldBackups(backupDir); }
        catch (error) { logger.error({ err: error }, 'Backup retention cleanup failed.'); }
        return { file: compressedFile, checksum };
    } catch (error) {
        for (const file of [rawFile, compressedFile]) {
            try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
        }
        writeStatusFile({ success: false, error: error.message, offsite_uploaded: false }, backupDir);
        logger.error({ err: error }, 'Database backup failed.');
        throw error;
    }
}

if (require.main === module) {
    try {
        const options = parseCliArgs(process.argv.slice(2));
        runBackup(options).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => { process.exitCode = 1; });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { runBackup, parseCliArgs, execDump };

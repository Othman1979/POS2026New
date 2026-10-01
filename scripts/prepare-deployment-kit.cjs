const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { generateFreshDatabaseSql, initialUserSeed } = require('../deployment/tools/export-fresh-database');

const root = path.resolve(__dirname, '..');
const privateFiles = ['.env', 'INITIAL-LOGIN.txt'];
const generatedFiles = ['POSAPP-Hostinger-source.zip', 'fresh-database.sql', 'SETUP.txt', 'VERIFICATION.json'];
const kitFiles = [...privateFiles, ...generatedFiles].sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));

function snapshotKit(directory) {
    assert(!fs.lstatSync(directory).isSymbolicLink(), 'Kit directory must not be a symbolic link');
    const names = fs.readdirSync(directory).sort();
    assert.deepEqual(names, kitFiles, 'Expected the six maintained kit files; preserve and review any extra or missing files');
    return Object.fromEntries(names.map(name => {
        const file = path.join(directory, name);
        assert(fs.lstatSync(file).isFile(), `Kit entry must be a regular file: ${name}`);
        return [name, fileHash(file)];
    }));
}

function verifyCandidate(candidate, expectedCommit, original) {
    const snapshot = snapshotKit(candidate);
    const report = JSON.parse(fs.readFileSync(path.join(candidate, 'VERIFICATION.json'), 'utf8'));
    assert.equal(report.commit, expectedCommit);
    assert.equal(report.sourceZipSha256, snapshot['POSAPP-Hostinger-source.zip'], 'Candidate ZIP hash mismatch');
    assert.equal(report.sqlSha256, snapshot['fresh-database.sql'], 'Candidate SQL hash mismatch');
    assert.equal(report.exactSqlImport, 'passed');
    assert.equal(report.schemaValidator, 'passed');
    assert.equal(report.removed, true, 'SQL verification fixture was not removed');
    assert.equal(report.initialIdentitiesMatch, true);
    assert.equal(report.pendingMigrations, 0);
    assert.equal(report.allBusinessTablesEmpty, true);
    for (const name of privateFiles) assert.equal(snapshot[name], original[name], `Private kit file changed: ${name}`);
    return snapshot;
}

function publishKit({ target, candidate, backup, original, verified }, rename = fs.renameSync) {
    assert.deepEqual(snapshotKit(target), original, 'Maintained kit changed during the build');
    assert.deepEqual(snapshotKit(candidate), verified, 'Candidate changed after verification');
    // All files are on the same volume. Roll back a failed directory promotion as a unit.
    rename(target, backup);
    try {
        rename(candidate, target);
        assert.deepEqual(snapshotKit(target), verified, 'Published kit differs from verified candidate');
    } catch (error) {
        try {
            if (fs.existsSync(target)) rename(target, candidate);
            rename(backup, target);
        } catch (rollbackError) {
            throw new Error(`Kit promotion and rollback failed. Preserve ${backup} and ${candidate}. ${rollbackError.message}`, { cause: error });
        }
        throw error;
    }
}

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', ...options });
    if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.error?.message || result.signal || result.status})`);
    return result.stdout?.trim();
}
function cleanRevision() {
    if (command('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: 'pipe' })) {
        throw new Error('Commit or resolve checkout changes before preparing a deployment kit. Nothing has been published.');
    }
    return command('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
}

function removeWorkspace(workspace, target) {
    const resolved = fs.realpathSync(workspace);
    const parent = fs.realpathSync(path.dirname(target));
    assert.equal(path.dirname(resolved), parent, 'Unexpected kit cleanup parent');
    assert(path.basename(resolved).startsWith('.posapp-kit-'), 'Unexpected kit cleanup directory');
    assert(!fs.lstatSync(workspace).isSymbolicLink(), 'Kit cleanup directory must not be a symbolic link');
    fs.rmSync(resolved, { recursive: true });
}

async function prepareDeploymentKit(directory) {
    if (process.platform !== 'win32') throw new Error('The maintained kit builder requires Windows PowerShell and installed npm dependencies.');
    const commit = cleanRevision();
    const target = path.resolve(directory);
    const original = snapshotKit(target);
    const lockPath = path.join(path.dirname(target), `.${path.basename(target)}.posapp-kit.lock`);
    const lock = fs.openSync(lockPath, 'wx');
    let workspace;
    try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, target, commit }));
        workspace = fs.mkdtempSync(path.join(path.dirname(target), '.posapp-kit-'));
        const candidate = path.join(workspace, 'candidate');
        fs.mkdirSync(candidate);
        for (const name of privateFiles) {
            const source = path.join(target, name), destination = path.join(candidate, name);
            fs.copyFileSync(source, destination);
            const stat = fs.statSync(source); fs.utimesSync(destination, stat.atime, stat.mtime);
        }
        const previousSql = fs.readFileSync(path.join(target, 'fresh-database.sql'), 'utf8');
        const sql = await generateFreshDatabaseSql(previousSql);
        assert.equal(initialUserSeed(sql), initialUserSeed(previousSql));
        fs.writeFileSync(path.join(candidate, 'fresh-database.sql'), sql, 'utf8');
        console.log('Building source archive without the checkout environment...');
        command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-hostinger-source.ps1'),
            '-Repo', root, '-OutputDirectory', candidate, '-PreviousZip', path.join(target, 'POSAPP-Hostinger-source.zip')]);
        fs.renameSync(path.join(candidate, 'build.log'), path.join(workspace, 'build.log'));
        const sqlReport = path.join(workspace, 'sql-verification.json');
        console.log('Importing and checking the exact fresh SQL in an owned loopback database...');
        command(process.execPath, [path.join(root, 'scripts/reviews/fresh-pos-baseline.cjs'), path.join(candidate, 'fresh-database.sql'), sqlReport, path.join(candidate, 'INITIAL-LOGIN.txt')]);
        command(process.execPath, [path.join(root, 'scripts/test-isolated.cjs'), 'inventoryScopeRetirement']);
        const source = JSON.parse(fs.readFileSync(path.join(candidate, 'source-verification.json'), 'utf8'));
        assert.equal(source.commit, commit);
        const verifiedSql = JSON.parse(fs.readFileSync(sqlReport, 'utf8'));
        const verification = { ...source, ...verifiedSql, verifiedAt: new Date().toISOString(),
            sourceZip: 'POSAPP-Hostinger-source.zip', sqlFile: 'fresh-database.sql',
            retainedHistoryCompatibility: 'passed', environmentAndInitialLoginsPreserved: true,
            privateFileSha256: Object.fromEntries(privateFiles.map(name => [name, original[name]])),
            initialUserSeedSha256: hash(initialUserSeed(sql)),
            releaseGate: 'Not queried by this command; packaging checks do not assert GitHub approval.',
            spoolerInstallerIncluded: false, deployed: false };
        fs.writeFileSync(path.join(candidate, 'VERIFICATION.json'), JSON.stringify(verification, null, 2) + '\n');
        fs.writeFileSync(path.join(candidate, 'SETUP.txt'), [
            `POSApp installation kit - ${commit}`, '',
            'Fresh installation: create an EMPTY database and database user in hPanel, select that database in phpMyAdmin, and import fresh-database.sql once. Never import this file over an existing installation.',
            'Upload POSAPP-Hostinger-source.zip as the Node.js source. Use Node.js 22.12+; build: npm run build; start: npm start. Source, migrations and a freshly built dist are at the ZIP root.',
            'Keep private kit files outside the uploaded ZIP. Configure hosting values in hPanel using the preserved .env reference and follow the assigned PORT. CORS defaults to same origin; additional trusted HTTP(S) origins require explicit configuration.',
            'Use INITIAL-LOGIN.txt for the preserved initial users. Configure store, staff access, tables and printers after login. The full current permission catalog and table scopes are seeded; business tables are empty.',
            'Existing installations: use source updates and normal startup migrations after a verified backup. Stop old processes before switching code. Do not import fresh-database.sql. Rollback requires matching old code and the database backup together.',
            `The Windows spooler installer is separate. release.json lists spooler source version ${source.release.spoolerVersion} as metadata only.`, '',
            'VERIFICATION.json records the exact ZIP/SQL hashes, source identity and completed packaging checks. GitHub Release gate approval is separate; this command does not upload or deploy.', ''
        ].join('\r\n'), 'utf8');
        fs.rmSync(path.join(candidate, 'source-verification.json'));
        assert.equal(cleanRevision(), commit, 'Checkout changed while verifying the kit');
        const verified = verifyCandidate(candidate, commit, original);
        publishKit({ target, candidate, backup: path.join(workspace, 'previous'), original, verified });
        // Publication was verified; only the owned temporary tree and former six-file kit are removed.
        removeWorkspace(workspace, target); workspace = null;
        console.log(`Deployment kit ready: ${target}\nCommit: ${commit}\nZIP SHA-256: ${verification.sourceZipSha256}\nSQL SHA-256: ${verification.sqlSha256}`);
        return verification;
    } catch (error) {
        // Preserve a recovery copy if promotion could not roll back. Ordinary failures leave the old kit intact.
        if (workspace && fs.existsSync(path.join(workspace, 'previous'))) {
            console.error(`Previous kit retained at ${path.join(workspace, 'previous')}`);
        } else if (workspace) {
            const log = path.join(workspace, 'candidate/build.log');
            if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-6000));
            removeWorkspace(workspace, target);
        }
        throw error;
    } finally { fs.closeSync(lock); fs.rmSync(lockPath); }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--directory')) {
        console.error('Usage: npm run prepare:deployment -- [--directory <existing-kit-directory>]'); process.exitCode = 1;
    } else {
        prepareDeploymentKit(args[1] || path.join(os.homedir(), 'Documents', 'New folder'))
            .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
module.exports = { snapshotKit, verifyCandidate, publishKit, prepareDeploymentKit };

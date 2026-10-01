const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUIRED_PATHS = Object.freeze({
    server: Object.freeze([
        'server.js', 'package.json', 'package-lock.json', 'runtime/node/node.exe',
        'backend/migrations/runPendingMigrations.js',
        'backend/migrations/auto-manifest.json',
        'scripts/db-backup.js', 'deployment/database/baseline.sql',
        'deployment/database/manifest.json', 'deployment/tools/bootstrap-database.js',
        'deployment/tools/installer-config.js', 'deployment/tools/run-pending-migrations.js',
        'deployment/tools/verify-install.js',
        'deployment/templates/pos.env.template',
        'install/mariadb-runtime/bin/mariadbd.exe',
        'install/mariadb-runtime/bin/mariadb-install-db.exe',
        'install/mariadb-runtime/bin/mariadb-dump.exe',
        'install/vendor/httpd-2.4.68-260617-Win64-VS18.zip',
        'install/vendor/php-8.4.16-Win32-vs17-x64.zip',
        'install/vendor/phpMyAdmin-5.2.3-all-languages.zip',
        'install/vendor/nssm-2.24.zip', 'install/vendor/vc_redist.x64.exe',
        'release.json'
    ]),
    spooler: Object.freeze([
        'recover-printer.js',
        'server.js', 'package.json', 'package-lock.json', 'runtime/node/node.exe',
        'install/vendor/nssm-2.24.zip',
        '.cache/typst/0.15.1/typst.exe', '.cache/typst/0.15.1/LICENSE',
        '.cache/typst/0.15.1/NOTICE', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
        '.cache/typst/0.15.1/fonts/NotoSans.ttf',
        '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf', '.cache/typst/0.15.1/fonts/NotoEmoji.ttf',
        '.cache/typst/0.15.1/fonts/OFL.txt', 'release.json',
        'v2', 'bin/PosSpoolerPlatform.exe'
    ]),
    'server-update': Object.freeze([
        'server.js', 'package.json', 'package-lock.json', 'release.json',
        'update-payload-manifest.json',
        'backend/migrations/runPendingMigrations.js',
        'backend/migrations/auto-manifest.json',
        'scripts/db-backup.js',
        'deployment/tools/run-pending-migrations.js',
        'deployment/tools/verify-install.js',
        'deployment/tools/validate-payload.js',
        'dist', 'assets', 'backend', 'node_modules'
    ]),
    'server-update-core': Object.freeze([
        'server.js', 'package.json', 'package-lock.json', 'release.json',
        'update-payload-manifest.json', 'server-dependency-manifest.json',
        'backend/migrations/runPendingMigrations.js', 'backend/migrations/auto-manifest.json',
        'scripts/db-backup.js', 'deployment/tools/run-pending-migrations.js',
        'deployment/tools/verify-install.js', 'deployment/tools/validate-payload.js',
        'dist', 'assets', 'backend'
    ]),
    'server-update-runtime': Object.freeze([
        'server.js', 'package.json', 'package-lock.json', 'release.json',
        'update-payload-manifest.json', 'server-dependency-manifest.json',
        'backend/migrations/runPendingMigrations.js', 'backend/migrations/auto-manifest.json',
        'scripts/db-backup.js', 'deployment/tools/run-pending-migrations.js',
        'deployment/tools/verify-install.js', 'deployment/tools/validate-payload.js',
        'dist', 'assets', 'backend', 'node_modules'
    ]),
    // Nothing in this repo builds this kind any more - the -core/-runtime layers replaced
    // it - but it is still an accepted kind, so it is kept correct rather than deleted on
    // the assumption that no updater in the field asks for it.
    'spooler-update': Object.freeze([
        'recover-printer.js',
        'server.js', 'package.json', 'package-lock.json', 'release.json',
        'update-payload-manifest.json', '.cache/typst/0.15.1/typst.exe',
        '.cache/typst/0.15.1/LICENSE', '.cache/typst/0.15.1/NOTICE', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
        '.cache/typst/0.15.1/fonts/NotoSans.ttf', '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf',
        '.cache/typst/0.15.1/fonts/NotoEmoji.ttf', '.cache/typst/0.15.1/fonts/OFL.txt',
        'node_modules',
        'vendor/request-disabled/index.js', 'vendor/request-disabled/package.json'
    ]),
    'spooler-update-core': Object.freeze([
        'recover-printer.js',
        'server.js', 'package.json', 'package-lock.json', 'release.json',
    ]),
    'spooler-update-runtime': Object.freeze([
        'recover-printer.js',
        'server.js', 'package.json', 'package-lock.json', 'release.json',
        'node_modules', '.cache/typst/0.15.1/typst.exe',
        '.cache/typst/0.15.1/LICENSE', '.cache/typst/0.15.1/NOTICE', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
        '.cache/typst/0.15.1/fonts/NotoSans.ttf', '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf',
        '.cache/typst/0.15.1/fonts/NotoEmoji.ttf', '.cache/typst/0.15.1/fonts/OFL.txt',
    ])
});

const FORBIDDEN = [
    /(^|[\\/])\.git([\\/]|$)/i, /(^|[\\/])\.env(?:\.|$)/i,
    /(^|[\\/])tests?([\\/]|$)/i, /^(docs|skills)([\\/]|$)/i,
    /\.map$/i, /\.7z$/i, /\.zip$/i,
    /(^|[\\/])(playwright-report|test-results)([\\/]|$)/i,
    /^runtime[\\/]node[\\/](?:node_modules|npm(?:\.cmd)?|npx(?:\.cmd)?|corepack(?:\.cmd)?)([\\/]|$)/i
];

const LOCKED_VENDOR_ARCHIVES = new Set(REQUIRED_PATHS.server.filter((file) => file.startsWith('install/vendor/')));
const LOCKED_SPOOLER_VENDOR_ARCHIVES = new Set(REQUIRED_PATHS.spooler.filter((file) => file.startsWith('install/vendor/')));
const FORBIDDEN_SPOOLER_ROOT_FILES = new Set(['README.md', 'install.bat', 'uninstall.bat', 'install-service.js', 'uninstall-service.js']);

const UPDATE_KINDS = new Set(['server-update', 'server-update-core', 'server-update-runtime', 'spooler-update', 'spooler-update-core', 'spooler-update-runtime']);
const SERVER_KINDS = new Set(['server', 'server-update', 'server-update-core', 'server-update-runtime']);
const SERVER_LAYER_KINDS = new Set(['server-update-core', 'server-update-runtime']);
const SPOOLER_LAYER_KINDS = new Set(['spooler-update-core', 'spooler-update-runtime']);
const SPOOLER_KINDS = new Set(['spooler', ...SPOOLER_LAYER_KINDS]);
const TYPST_ONLY_FORBIDDEN = [
    /^\.cache[\/]puppeteer(?:[\/]|$)/i,
    /^\.puppeteerrc\.cjs$/i,
    /^node_modules[\/](?:puppeteer|puppeteer-core|@puppeteer|chromium-bidi)(?:[\/]|$)/i
];
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function walkFiles(root, rejectReparse = false) {
    const files = [];
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink()) {
                if (rejectReparse) throw new Error(`Reparse/symlink path is not allowed: ${path.relative(root, absolute)}`);
                return;
            }
            if (entry.isDirectory()) visit(absolute);
            else files.push(path.relative(root, absolute));
        }
    }
    visit(root);
    return files;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashFileInventory(root, filter) {
    const files = walkFiles(root, true)
        .map((file) => file.replaceAll('\\', '/'))
        .filter(filter)
        .sort();
    const lines = files.map((relative) => {
        const absolute = path.join(root, relative);
        return `${relative}\t${fs.statSync(absolute).size}\t${sha256(absolute)}\n`;
    }).join('');
    return crypto.createHash('sha256').update(lines, 'utf8').digest('hex');
}

function computeSpoolerPayloadHash(root) {
    return hashFileInventory(root, (relative) => relative !== 'release.json' && !relative.startsWith('deployment/') && !relative.startsWith('spooler-service/'));
}

function computeSpoolerRuntimeHash(root) {
    const isRuntimeFile = (relative) => (/^(?:node_modules|\.cache)\//.test(relative) && relative !== 'node_modules/.package-lock.json');
    if (!walkFiles(root, true).map((file) => file.replaceAll('\\', '/')).some(isRuntimeFile)) {
        throw new Error('Spooler runtime payload is empty');
    }
    return hashFileInventory(root, isRuntimeFile);
}

function stampSpoolerPayload(root, kind, runtimeRoot = root) {
    if (!SPOOLER_KINDS.has(kind)) throw new Error(`Cannot stamp non-spooler payload: ${kind}`);
    const releasePath = path.join(root, 'release.json');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8').replace(/^\uFEFF/, ''));
    release.payloadSha256 = computeSpoolerPayloadHash(root);
    release.runtimeSha256 = computeSpoolerRuntimeHash(runtimeRoot);
    if (!SHA256_PATTERN.test(release.runtimeSha256)) throw new Error('Spooler runtime hash is invalid');
    fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
    return release;
}

function validateSpoolerPayloadHash(root, kind, release) {
    if (!SHA256_PATTERN.test(String(release.payloadSha256 || '')) || computeSpoolerPayloadHash(root) !== String(release.payloadSha256).toLowerCase()) {
        throw new Error('Spooler payload hash mismatch');
    }
    if (!SHA256_PATTERN.test(String(release.runtimeSha256 || ''))) throw new Error('Spooler runtime hash is invalid');
    if (kind !== 'spooler-update-core' && computeSpoolerRuntimeHash(root) !== String(release.runtimeSha256).toLowerCase()) {
        throw new Error('Spooler runtime hash mismatch');
    }
}

function validateUpdateManifest(root, kind, release, files) {
    const manifestPath = path.join(root, 'update-payload-manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Invalid update payload manifest'); }
    if (manifest.format !== 1 || manifest.kind !== kind || manifest.version !== release.version || manifest.commit !== release.commit) {
        throw new Error('Update payload manifest identity does not match release');
    }
    if (!Array.isArray(manifest.managedRoots) || !manifest.managedRoots.length || !Array.isArray(manifest.files)) throw new Error('Invalid update payload manifest');
    const seen = new Set();
    const normalizedRoots = [];
    const seenRoots = new Set();
    for (const entry of manifest.managedRoots) {
        if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').some((part) => part === '..' || part === '.') || entry.startsWith('ProgramData/')) throw new Error('Invalid managed update root');
        const key = entry.toLowerCase();
        if (seenRoots.has(key)) throw new Error(`Duplicate managed update root: ${entry}`);
        seenRoots.add(key);
        normalizedRoots.push(entry);
    }
    for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== 'string' || path.isAbsolute(entry.path)) throw new Error('Invalid update manifest file path');
        const normalized = entry.path.replaceAll('\\', '/');
        if (!normalized || normalized.split('/').some((part) => part === '..' || part === '.') || normalized.startsWith('/') || normalized.startsWith('ProgramData/')) throw new Error('Invalid update manifest file path');
        const rooted = normalizedRoots.some((root) => {
            const fileKey = normalized.toLowerCase();
            const rootKey = root.toLowerCase();
            return fileKey === rootKey || fileKey.startsWith(`${rootKey}/`);
        });
        if (!rooted) throw new Error(`Update manifest path is outside managed roots: ${normalized}`);
        if (seen.has(normalized)) throw new Error(`Duplicate update manifest path: ${normalized}`);
        seen.add(normalized);
        const absolute = path.join(root, normalized);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Missing update payload file: ${normalized}`);
        if (!Number.isInteger(entry.bytes) || entry.bytes !== fs.statSync(absolute).size || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256) || sha256(absolute) !== entry.sha256.toLowerCase()) throw new Error(`Update payload hash mismatch: ${normalized}`);
    }
    const filesSet = new Set(files.map((file) => file.replaceAll('\\', '/')));
    for (const normalized of filesSet) {
        if (normalized === 'update-payload-manifest.json') continue;
        if (!seen.has(normalized)) throw new Error(`Unlisted update payload file: ${normalized}`);
    }
    return manifest;
}

function assertLayerPath(value, label) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error(`Invalid ${label} path`);
    const normalized = value.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '.' || part === '..')) throw new Error(`Invalid ${label} path`);
    return normalized;
}

function validateServerDependencyManifest(root, kind, files) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'server-dependency-manifest.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Invalid server dependency manifest'); }
    if (manifest.format !== 1 || manifest.kind !== 'server-dependencies' || manifest.nodeVersion !== '22.23.0' || manifest.platform !== 'win32' || manifest.arch !== 'x64') throw new Error('Invalid server dependency manifest identity');
    const inventory = manifest.dependencies;
    if (!inventory || !SHA256_PATTERN.test(String(inventory.id || '')) || !Array.isArray(inventory.files)) throw new Error('Invalid server dependency inventory');
    const canonical = [];
    const seen = new Set();
    for (const entry of inventory.files) {
        const relative = assertLayerPath(entry?.path, 'server dependency inventory');
        if (relative !== 'node_modules' && !relative.startsWith('node_modules/')) throw new Error(`Server dependency path is outside node_modules: ${relative}`);
        const key = relative.toLowerCase();
        if (seen.has(key)) throw new Error(`Duplicate server dependency path: ${relative}`);
        seen.add(key);
        if (!Number.isInteger(entry.bytes) || !SHA256_PATTERN.test(String(entry.sha256 || ''))) throw new Error(`Invalid server dependency metadata: ${relative}`);
        canonical.push({ path: relative, bytes: entry.bytes, sha256: String(entry.sha256).toLowerCase() });
        if (kind === 'server-update-runtime') {
            const absolute = path.join(root, relative);
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size !== entry.bytes || sha256(absolute) !== String(entry.sha256).toLowerCase()) throw new Error(`Server dependency hash mismatch: ${relative}`);
        }
    }
    const sorted = [...canonical].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (JSON.stringify(canonical) !== JSON.stringify(sorted)) throw new Error('Server dependency inventory is not sorted');
    const expectedId = require('crypto').createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
    if (expectedId !== String(inventory.id).toLowerCase()) throw new Error('Server dependency inventory ID mismatch');
    const hasRuntimeFiles = files.some((file) => /^(?:node_modules|runtime|install)(?:[\\/]|$)/i.test(file.replaceAll('\\', '/')));
    if (kind === 'server-update-core' && hasRuntimeFiles) throw new Error('Core server payload contains runtime content');
    if (kind === 'server-update-runtime' && !files.some((file) => /^node_modules[\\/]/i.test(file))) throw new Error('Runtime server payload is missing dependencies');
    return manifest;
}

function validateMigrationPayload(root) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(root, 'backend/migrations/auto-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new Error('Invalid automatic migration manifest');
    }
    if (!Array.isArray(manifest.migrations)) throw new Error('Invalid automatic migration manifest');
    for (const migration of manifest.migrations) {
        const file = migration?.file;
        if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.auto.sql')) {
            throw new Error('Invalid migration payload file name');
        }
        if (!fs.existsSync(path.join(root, 'backend/migrations', file))) {
            throw new Error(`Missing migration payload file: ${file}`);
        }
        if (migration.preflight !== undefined) {
            const preflight = migration.preflight;
            if (typeof preflight !== 'string' || path.basename(preflight) !== preflight || !preflight.endsWith('.sql')) {
                throw new Error('Invalid migration preflight payload file name');
            }
            if (!fs.existsSync(path.join(root, 'backend/migrations', preflight))) {
                throw new Error(`Missing migration payload file: ${preflight}`);
            }
        }
    }
}

function validatePayload(root, kind) {
    if (!path.isAbsolute(root)) throw new Error('Payload root must be absolute');
    const requiredPaths = REQUIRED_PATHS[kind];
    if (!requiredPaths) throw new Error(`Unknown payload kind: ${kind}`);
    let release;
    try { release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Invalid release identity'); }
    const runtimeProfile = SPOOLER_KINDS.has(kind) ? String(release.runtimeProfile || '').toLowerCase() : null;
    if (SPOOLER_KINDS.has(kind) && runtimeProfile !== 'typst-only') throw new Error('Invalid spooler runtime profile');
    for (const relative of requiredPaths) {
        if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing payload file: ${relative}`);
    }
    if (SERVER_KINDS.has(kind)) validateMigrationPayload(root);
    const files = walkFiles(root, UPDATE_KINDS.has(kind));
    if (!release.version || !VERSION_PATTERN.test(String(release.version)) || !release.commit || !release.schemaVersion || !release.spoolerVersion || !/^[0-9a-f]{40}$/i.test(release.commit)) {
        throw new Error('Invalid release identity');
    }
    if (UPDATE_KINDS.has(kind) && release.payloadKind !== kind) throw new Error(`Release payload kind must be ${kind}`);
    for (const file of files) {
        const normalized = file.replaceAll('\\', '/');
        if (SPOOLER_KINDS.has(kind) && TYPST_ONLY_FORBIDDEN.some((pattern) => pattern.test(normalized))) {
            throw new Error(`Forbidden Chromium file in Typst-only payload: ${file}`);
        }
        if (kind === 'spooler' && FORBIDDEN_SPOOLER_ROOT_FILES.has(normalized)) throw new Error(`Forbidden legacy spooler file: ${file}`);
        const isVendorArchive = /^install[\\/]vendor[\\/][^\\/]+\.(zip|msi|exe)$/i.test(file);
        const lockedArchives = kind === 'server' ? LOCKED_VENDOR_ARCHIVES : LOCKED_SPOOLER_VENDOR_ARCHIVES;
        if (isVendorArchive && !lockedArchives.has(normalized)) throw new Error(`Unexpected vendor archive: ${file}`);
        const isLockedVendorArchive = isVendorArchive && lockedArchives.has(normalized);
        if (!isLockedVendorArchive && FORBIDDEN.some((pattern) => pattern.test(file))) throw new Error(`Forbidden payload file: ${file}`);
    }
    if (SPOOLER_KINDS.has(kind)) validateSpoolerPayloadHash(root, kind, release);
    const manifest = UPDATE_KINDS.has(kind) && !SPOOLER_LAYER_KINDS.has(kind)
        ? validateUpdateManifest(root, kind, release, files)
        : null;
    if (SERVER_LAYER_KINDS.has(kind)) validateServerDependencyManifest(root, kind, files);
    if (SPOOLER_LAYER_KINDS.has(kind) && kind === 'spooler-update-runtime' && files.some((file) => /^node_modules[\\/]node_modules(?:[\\/]|$)/i.test(file) || /^\.cache[\\/]\.cache(?:[\\/]|$)/i.test(file))) {
        throw new Error('Nested dependency/cache roots are forbidden in runtime transition payload');
    }
    return { fileCount: files.length, runtimeProfile: runtimeProfile || undefined, manifest: manifest ? { format: manifest.format, kind: manifest.kind, version: manifest.version, commit: manifest.commit } : undefined };
}

module.exports = { computeSpoolerPayloadHash, computeSpoolerRuntimeHash, stampSpoolerPayload, validatePayload, REQUIRED_PATHS };

if (require.main === module) {
    try {
        const [root, kind, runtimeRoot] = process.argv.slice(2);
        if (!root || !path.isAbsolute(root) || !kind) throw new Error('Usage: validate-payload.js <absolute-root> <server|spooler|server-update-core|server-update-runtime|spooler-update-core|spooler-update-runtime>');
        if (process.argv.includes('--stamp-spooler')) {
            process.stdout.write(`${JSON.stringify(stampSpoolerPayload(root, kind, runtimeRoot || root))}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(validatePayload(root, kind))}\n`);
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

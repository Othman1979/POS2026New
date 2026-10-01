const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Shared application allowlist for the packaged updater and lightweight bundle.
const APPLICATION_ROOTS = Object.freeze([
    'beep-tester.js',
    'http-client.js',
    'print-width-calibration.js',
    'printer-alerts.js',
    'raw-print.js',
    'recover-printer.js',
    'receipt-display.cjs',
    'renderDocument.js',
    'businessTime.js',
    'report-html.js',
    'server.js',
    'thermal-raster.js',
    'package.json',
    'package-lock.json',
    'release.json',
    'vendor',
    'v2',
    'bin',
    'windows-helper',
    'maintenance',
]);

function normalizeRelative(relative) {
    const normalized = String(relative).replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error(`Unsafe spooler path: ${relative}`);
    }
    return normalized;
}

function collectTree(root, relativeRoot, { ignoreNpmHiddenLock = false } = {}) {
    const normalizedRoot = normalizeRelative(relativeRoot);
    const absoluteRoot = path.resolve(root, normalizedRoot);
    if (!fs.existsSync(absoluteRoot)) throw new Error(`Missing spooler root: ${relativeRoot}`);
    const rootStat = fs.lstatSync(absoluteRoot);
    if (rootStat.isSymbolicLink()) throw new Error(`Reparse/symlink path is not allowed: ${relativeRoot}`);
    if (rootStat.isFile()) return [normalizedRoot];
    const files = [];
    function visit(directory, prefix) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const absolute = path.join(directory, entry.name);
            const relative = normalizeRelative(path.posix.join(prefix, entry.name));
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) throw new Error(`Reparse/symlink path is not allowed: ${relative}`);
            if (stat.isDirectory()) visit(absolute, relative);
            else if (stat.isFile() && !(ignoreNpmHiddenLock && entry.name === '.package-lock.json')) files.push(relative);
        }
    }
    visit(absoluteRoot, normalizedRoot);
    return files;
}

function collectInventory(root, roots, options = {}) {
    const files = roots.flatMap((relativeRoot) => collectTree(root, relativeRoot, options)).sort();
    const seen = new Set();
    const entries = files.map((relative) => {
        const key = relative.toLowerCase();
        if (seen.has(key)) throw new Error(`Duplicate spooler path: ${relative}`);
        seen.add(key);
        const absolute = path.join(root, relative.replaceAll('/', path.sep));
        const bytes = fs.statSync(absolute).size;
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        return { path: relative, bytes, sha256 };
    });
    return { id: crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex'), files: entries };
}

module.exports = { APPLICATION_ROOTS, collectInventory };

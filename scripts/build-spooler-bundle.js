#!/usr/bin/env node
/**
 * Build the hand-copy spooler bundle: application files and installer support.
 * install.cmd fetches Node, NSSM, node_modules, Typst and pinned fonts.
 *
 * The file list is APPLICATION_ROOTS from deployment/tools/spooler-layer-manifest.js,
 * the same list the packaged update payload is built from, so a module added to the
 * spooler cannot be forgotten here.
 *
 * Sourced from the staged payload rather than pos-spooler-printer/ because the repo
 * folder carries a bin/PosSpoolerPlatform.exe that is only rebuilt by the installer
 * build, and has no release.json at all.
 *
 *   node scripts/build-spooler-bundle.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, 'deployment/out/stage/spooler');
const SERVICE = path.join(ROOT, 'deployment/spooler-service');
const OUT = path.join(ROOT, 'deployment/out/POSAPP-Spooler-Files.zip');

const { APPLICATION_ROOTS, collectInventory } = require(path.join(ROOT, 'deployment/tools/spooler-layer-manifest.js'));
const { validatePayload } = require(path.join(ROOT, 'deployment/tools/validate-payload.js'));
const SUPPORT_FILES = [
    'deployment/vendor-lock.json',
    'deployment/tools/spooler-layer-manifest.js',
    'deployment/tools/patch-typst-fast-watch.js',
    'deployment/tools/validate-payload.js',
    'deployment/patches/typst-0.15.1-fast-watch.txt',
    'deployment/windows/Install-Spooler.ps1',
    'deployment/windows/Remove-SpoolerRuntime.ps1',
];

// These are what install.cmd downloads. If one ever appears in the bundle the zip
// stops being a lightweight copy and starts being a slow, stale duplicate of the
// full installer.
const MUST_NOT_SHIP = ['node_modules', '.cache', 'runtime', 'install', '.env'];

function fail(message) {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}

function copyInto(source, destination) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) copyInto(path.join(source, entry), path.join(destination, entry));
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function walk(directory, base = directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
    });
}

function humanSize(bytes) {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

if (!fs.existsSync(STAGE)) {
    fail('No staged spooler payload. Run scripts/build-installers.ps1 first - the bundle takes the\n  freshly compiled platform helper and release.json from it.');
}

const gitHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty) fail('The worktree is not clean. Commit or remove local changes before building a field bundle.');
const stagedRelease = JSON.parse(fs.readFileSync(path.join(STAGE, 'release.json'), 'utf8').replace(/^\uFEFF/, ''));
if (String(stagedRelease.commit || '').toLowerCase() !== gitHead) {
    fail(`The staged spooler release ${stagedRelease.commit || '(missing commit)'} does not match HEAD ${gitHead}.\n  Rebuild the installers before building the lightweight bundle.`);
}
validatePayload(STAGE, 'spooler');
collectInventory(STAGE, APPLICATION_ROOTS);

// The helper is compiled during the installer build. A stage older than the source it
// was built from would ship a helper that does not match the shipped v2 code.
const helper = path.join(STAGE, 'bin/PosSpoolerPlatform.exe');
const helperSource = path.join(ROOT, 'pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs');
if (!fs.existsSync(helper)) fail('The staged payload has no bin/PosSpoolerPlatform.exe.');
if (fs.statSync(helper).mtimeMs < fs.statSync(helperSource).mtimeMs) {
    fail('The staged platform helper is older than PosSpoolerPlatform.cs.\n  Rebuild the installers so the helper matches its source.');
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spooler-bundle-'));
try {
    for (const name of APPLICATION_ROOTS) {
        const source = path.join(STAGE, name);
        if (!fs.existsSync(source)) fail(`The staged payload is missing an application root: ${name}`);
        copyInto(source, path.join(work, name));
    }
    copyInto(SERVICE, path.join(work, 'spooler-service'));
    fs.writeFileSync(path.join(work, 'spooler-service', 'payload-roots.json'), `${JSON.stringify(APPLICATION_ROOTS, null, 2)}\n`, 'utf8');
    for (const relative of SUPPORT_FILES) {
        copyInto(path.join(ROOT, relative), path.join(work, relative));
    }

    // A dev .env would point the till at a dev server; install.cmd writes one from
    // .env.example instead and refuses to register a service without real values.
    const example = path.join(ROOT, 'pos-spooler-printer/.env.example');
    if (fs.existsSync(example)) fs.copyFileSync(example, path.join(work, '.env.example'));

    const shipped = walk(work);
    for (const forbidden of MUST_NOT_SHIP) {
        const hit = shipped.find(file => file.split(path.sep).includes(forbidden) || file === forbidden);
        if (hit) fail(`${forbidden} must not be in the bundle - install.cmd fetches it. Found: ${hit}`);
    }
    if (!shipped.includes(path.join('vendor', 'request-disabled', 'package.json'))) {
        fail('vendor/request-disabled is missing; npm ci fails without it because package.json\n  resolves "request" to that path.');
    }

    fs.rmSync(OUT, { force: true });
    execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Compress-Archive -Path '${work}\\*' -DestinationPath '${OUT}' -CompressionLevel Optimal -Force`
    ], { stdio: 'inherit' });

    const bytes = shipped.reduce((total, file) => total + fs.statSync(path.join(work, file)).size, 0);
    console.log(`\n  ${path.relative(ROOT, OUT)}`);
    console.log(`  ${shipped.length} files, ${humanSize(bytes)} uncompressed, ${humanSize(fs.statSync(OUT).size)} zipped`);
    console.log(`  roots: ${APPLICATION_ROOTS.join(', ')}, spooler-service, deployment support, .env.example`);
    console.log('  install.cmd downloads: Node runtime, NSSM, node_modules, Typst and pinned fonts\n');
} finally {
    fs.rmSync(work, { recursive: true, force: true });
}

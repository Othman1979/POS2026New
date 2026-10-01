const fs = require('fs');
const path = require('path');

function readJson(root, relative) {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
}

function nextPatch(version, label) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
    if (!match) throw new Error(`${label} version must be major.minor.patch.`);
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function planPackage(root, packagePath, lockPath, installerPath, label) {
    const packageJson = readJson(root, packagePath);
    const lockJson = readJson(root, lockPath);
    const installer = fs.readFileSync(path.join(root, installerPath), 'utf8');
    const current = String(packageJson.version);
    if (String(lockJson.version) !== current || String(lockJson.packages?.['']?.version) !== current) {
        throw new Error(`${label} package and lock versions disagree.`);
    }
    if (!installer.includes(`#define AppVersion "${current}"`)) {
        throw new Error(`${label} package and installer versions disagree.`);
    }
    const version = nextPatch(current, label);
    packageJson.version = version;
    lockJson.version = version;
    lockJson.packages[''].version = version;
    return {
        version,
        files: [
            [packagePath, `${JSON.stringify(packageJson, null, 2)}\n`],
            [lockPath, `${JSON.stringify(lockJson, null, 2)}\n`],
            [installerPath, installer.replace(`#define AppVersion "${current}"`, `#define AppVersion "${version}"`)],
        ],
    };
}

const PRODUCTS = {
    server: ['package.json', 'package-lock.json', 'deployment/server/POSAPP-Server.iss', 'Server'],
    spooler: ['pos-spooler-printer/package.json', 'pos-spooler-printer/package-lock.json', 'deployment/spooler/POSAPP-Spooler.iss', 'Spooler'],
};

// The two versions are independent and nothing couples them at runtime, so a
// spooler-only release leaves the deployed server's version untouched. Rebuilding
// at the SAME version is not an option: Compare-PackagedRelease treats a matching
// version with a different commit as blocked_version_collision, so both updaters
// would refuse on every till and only a full reinstall would work.
function bumpInstallerVersions(root, { only } = {}) {
    const names = only ? [only] : Object.keys(PRODUCTS);
    for (const name of names) {
        if (!PRODUCTS[name]) throw new Error(`Unknown product: ${name}. Expected server or spooler.`);
    }
    const planned = {};
    for (const name of names) planned[name] = planPackage(root, ...PRODUCTS[name]);
    for (const plan of Object.values(planned)) {
        for (const [relative, contents] of plan.files) fs.writeFileSync(path.join(root, relative), contents, 'utf8');
    }
    const current = name => String(readJson(root, PRODUCTS[name][0]).version);
    // Shape is pinned by installerPackageContract; the CLI derives what it needs
    // from --only rather than widening it.
    return {
        serverVersion: planned.server ? planned.server.version : current('server'),
        spoolerVersion: planned.spooler ? planned.spooler.version : current('spooler'),
    };
}

if (require.main === module) {
    try {
        const flag = name => {
            const index = process.argv.indexOf(name);
            return index >= 0 ? process.argv[index + 1] : undefined;
        };
        const root = path.resolve(flag('--root') || path.resolve(__dirname, '..'));
        const only = flag('--only');
        const result = bumpInstallerVersions(root, { only });
        if (process.argv.includes('--commit')) {
            const { execFileSync } = require('child_process');
            const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'inherit' });
            const bumped = only ? [only] : ['server', 'spooler'];
            const versionOf = name => (name === 'spooler' ? result.spoolerVersion : result.serverVersion);
            const label = bumped.map(name => `${name} to ${versionOf(name)}`).join(' and ');
            git(['add', '--', ...bumped.flatMap(name => PRODUCTS[name].slice(0, 3))]);
            git(['commit', '-m', `chore(release): bump ${label}`]);
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { bumpInstallerVersions, nextPatch };

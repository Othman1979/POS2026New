const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const { assertProductionConfig, packagedRuntimeProfile, resolveRendererMode } = require('../server');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(source.includes('SPOOLER_ENV_FILE'), 'server must support an external environment file');
assert(source.includes("NODE_ENV !== 'production'") || source.includes("env.NODE_ENV !== 'production'"), 'server must have a production guard');
assert(source.includes('CLOUD_SERVER_URL_REQUIRED'), 'server must fail closed without CLOUD_SERVER_URL');
assert(source.includes('SPOOLER_KEY_REQUIRED'), 'server must fail closed without SPOOLER_KEY');
assert(source.includes('SPOOLER_STATE_DIR'), 'server must support durable ProgramData state');
assert(!source.includes('posjo.triple7foodmasters.com'), 'production must not contain a hosted fallback');
assert(!source.includes('socket.io-client'), 'the durable agent must not load Socket.IO');

assert.strictEqual(typeof assertProductionConfig, 'function');
assert.strictEqual(resolveRendererMode({ SPOOLER_RENDERER: 'chromium' }, 'typst-only'), 'typst-only');
assert.strictEqual(resolveRendererMode({ SPOOLER_RENDERER: 'typst' }), 'typst-only');
assert.strictEqual(packagedRuntimeProfile(path.join(root, 'missing-release-root')), 'typst-only');
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-runtime-profile-'));
try {
    fs.writeFileSync(path.join(profileRoot, 'release.json'), JSON.stringify({ runtimeProfile: 'typst-only' }));
    assert.strictEqual(packagedRuntimeProfile(profileRoot), 'typst-only');
    fs.writeFileSync(path.join(profileRoot, 'release.json'), JSON.stringify({ runtimeProfile: 'unknown' }));
    assert.throws(() => packagedRuntimeProfile(profileRoot), /SPOOLER_RUNTIME_PROFILE_INVALID/);
} finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
}
assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', CLOUD_SERVER_URL: '', SPOOLER_KEY: 'k' }),
    /CLOUD_SERVER_URL_REQUIRED/
);
assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', CLOUD_SERVER_URL: 'https://pos.example', SPOOLER_KEY: '   ' }),
    /SPOOLER_KEY_REQUIRED/
);
assert.doesNotThrow(() => assertProductionConfig({
    NODE_ENV: 'production',
    CLOUD_SERVER_URL: 'https://pos.example',
    SPOOLER_KEY: 'k',
    SPOOLER_RENDERER: 'typst',
    SPOOLER_TYPST_TIMEOUT_MS: '10000',
    SPOOLER_TYPST_MAX_HEIGHT: '12000'
}));
assert.doesNotThrow(() => assertProductionConfig({
    NODE_ENV: 'production',
    CLOUD_SERVER_URL: 'https://pos.example',
    SPOOLER_KEY: 'k',
    SPOOLER_RENDERER: 'chromium'
}, 'typst-only'));
assert.doesNotThrow(() => assertProductionConfig({ NODE_ENV: 'production', CLOUD_SERVER_URL: 'https://pos.example', SPOOLER_KEY: 'k', SPOOLER_RENDERER: 'auto' }), 'retired renderer settings cannot activate another engine');
assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', CLOUD_SERVER_URL: 'https://pos.example', SPOOLER_KEY: 'k', SPOOLER_TYPST_TIMEOUT_MS: '0' }),
    /SPOOLER_TYPST_TIMEOUT_MS_INVALID/
);
assert.doesNotThrow(() => assertProductionConfig({ NODE_ENV: 'test' }));
assert.doesNotThrow(() => assertProductionConfig({}));

const mainBody = source.slice(source.indexOf('async function main'));
assert(mainBody.indexOf('assertProductionConfig') < mainBody.indexOf('startPlatformHelper'));
assert(mainBody.indexOf('assertProductionConfig') < mainBody.indexOf('acquireStateRootLock'));
assert(mainBody.indexOf('assertProductionConfig') < mainBody.indexOf('defaultStateRoot'));

function spawnProduction(overrides) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-config-'));
    const envFile = path.join(stateRoot, 'empty.env');
    fs.writeFileSync(envFile, '');
    const result = spawnSync(process.execPath, [path.join(root, 'server.js')], {
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            NODE_ENV: 'production',
            SPOOLER_ENV_FILE: envFile,
            SPOOLER_STATE_DIR: stateRoot,
            ...overrides
        },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true
    });
    return { result, stateRoot };
}

for (const [missing, env] of [
    ['CLOUD_SERVER_URL_REQUIRED', { CLOUD_SERVER_URL: '', SPOOLER_KEY: 'present' }],
    ['SPOOLER_KEY_REQUIRED', { CLOUD_SERVER_URL: 'https://pos.example', SPOOLER_KEY: '' }]
]) {
    const { result, stateRoot } = spawnProduction(env);
    try {
        assert.notStrictEqual(result.status, 0, `${missing} must exit before startup`);
        assert.match(`${result.stderr || ''}${result.stdout || ''}`, new RegExp(missing));
        assert(!fs.existsSync(path.join(stateRoot, 'agent.lock')), `${missing} must not create a lock`);
        assert(!fs.existsSync(path.join(stateRoot, 'agent.json')), `${missing} must not create identity`);
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

console.log('external-config checks passed');

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { acquireStateRootLock } = require('../v2/state-root-lock');

const LOCK_MODULE = path.join(__dirname, '..', 'v2', 'state-root-lock.js');
const liveChildren = new Set();

function temporaryRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-state-lock-'));
}

function lockPathFor(stateRoot) {
    return path.join(stateRoot, 'agent.lock');
}

function staleTombstonePath(stateRoot, owner) {
    const digest = crypto.createHash('sha256').update(`${owner.pid}:${owner.boot_id}`).digest('hex');
    return path.join(stateRoot, `agent.lock.stale-${digest}`);
}

function writeLock(stateRoot, contents) {
    fs.writeFileSync(lockPathFor(stateRoot), contents);
}

function readOwner(stateRoot) {
    return JSON.parse(fs.readFileSync(lockPathFor(stateRoot), 'utf8'));
}

function isCompleteOwner(owner) {
    return Number.isInteger(owner?.pid) && owner.pid >= 1 && typeof owner?.boot_id === 'string' && owner.boot_id.length > 0;
}

function diagnosticNames(stateRoot, prefix) {
    return fs.readdirSync(stateRoot).filter(name => name.startsWith(prefix) && name.includes('.corrupt-'));
}

function lockedWithReason(reason) {
    return error => error.code === 'STATE_ROOT_LOCKED' && error.reason === reason;
}

function reapChildren() {
    for (const child of liveChildren) {
        try { child.kill(); } catch {}
    }
    liveChildren.clear();
}

function waitForLine(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => finish(new Error('lock contender timed out')), timeoutMs);
        const onData = chunk => {
            buffer += String(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            const line = lines.find(Boolean);
            if (line) finish(null, line);
        };
        const onExit = code => finish(new Error(`lock contender exited before evidence (${code})`));
        function finish(error, line) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
            if (error) reject(error);
            else resolve(line);
        }
        child.stdout.on('data', onData);
        child.once('exit', onExit);
    });
}

function spawnAuthorizedContender(stateRoot) {
    const script = `
        const { acquireStateRootLock } = require(${JSON.stringify(LOCK_MODULE)});
        try {
            const held = acquireStateRootLock({
                stateRoot: ${JSON.stringify(stateRoot)},
                staleReclaimAuthorized: true
            });
            process.stdout.write(JSON.stringify({ status: 'ACQUIRED' }) + '\\n');
            process.stdin.resume();
            process.stdin.on('data', () => {
                held.release();
                process.exit(0);
            });
        } catch (error) {
            process.stdout.write(JSON.stringify({
                status: 'ERROR',
                code: error.code || error.message,
                reason: error.reason || null
            }) + '\\n');
            process.exit(0);
        }
    `;
    const child = spawn(process.execPath, ['-e', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });
    child.stdin.on('error', () => {});
    liveChildren.add(child);
    child.once('exit', () => liveChildren.delete(child));
    return child;
}

function observeCanonicalPublication(operation) {
    const realLink = fs.linkSync;
    const realOpen = fs.openSync;
    const events = [];
    fs.linkSync = (source, destination) => {
        if (path.basename(destination) === 'agent.lock') {
            let owner = null;
            try { owner = JSON.parse(fs.readFileSync(source, 'utf8')); } catch {}
            events.push({
                type: 'link',
                destinationExists: fs.existsSync(destination),
                owner
            });
        }
        return realLink.call(fs, source, destination);
    };
    fs.openSync = (target, flags, mode) => {
        if (path.basename(String(target)) === 'agent.lock') {
            events.push({ type: 'open', flags: String(flags) });
        }
        return realOpen.call(fs, target, flags, mode);
    };
    try {
        return { events, lock: operation() };
    } finally {
        fs.linkSync = realLink;
        fs.openSync = realOpen;
    }
}

async function testAtomicPublicationNeverExposesPartialLock() {
    const stateRoot = temporaryRoot();
    try {
        const { events, lock } = observeCanonicalPublication(() => (
            acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true })
        ));
        const owner = readOwner(stateRoot);
        assert(isCompleteOwner(owner), 'published lock must be complete valid JSON');
        assert.strictEqual(owner.pid, process.pid);
        assert(!events.some(event => event.type === 'open' && /w/.test(event.flags)),
            'canonical agent.lock must not be created with a write-open window');
        const publish = events.filter(event => event.type === 'link');
        assert.strictEqual(publish.length, 1, 'canonical lock must be published by exactly one exclusive hard-link');
        assert.strictEqual(publish[0].destinationExists, false);
        assert(isCompleteOwner(publish[0].owner), 'hard-link source must already be a complete owner');
        lock.release();
        assert(!fs.existsSync(lockPathFor(stateRoot)), 'release must remove a complete lock, not leave a partial file');
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testAbandonedPrivateFileIsInertAndCleaned() {
    const stateRoot = temporaryRoot();
    try {
        const deadPending = path.join(stateRoot, 'agent.lock.pending-dead');
        const unreadablePending = path.join(stateRoot, 'agent.lock.pending-corrupt');
        const livePending = path.join(stateRoot, 'agent.lock.pending-live');
        fs.writeFileSync(deadPending, `${JSON.stringify({ pid: 2147483646, boot_id: 'dead-pending' })}\n`);
        fs.writeFileSync(unreadablePending, '');
        fs.writeFileSync(livePending, `${JSON.stringify({ pid: process.pid, boot_id: 'live-pending' })}\n`);
        const lock = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        assert(isCompleteOwner(readOwner(stateRoot)));
        assert(!fs.existsSync(deadPending), 'a dead private owner file must be removed');
        assert(!fs.existsSync(unreadablePending), 'an unreadable private owner file must be removed');
        assert(fs.existsSync(livePending), 'a live private owner file must be left inert and untouched');
        lock.release();
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testAuthorizedCorruptLockQuarantinesThenNextStartAcquires() {
    const stateRoot = temporaryRoot();
    try {
        for (const corrupt of ['', '{"pid":12', '{}']) {
            writeLock(stateRoot, corrupt);
            assert.throws(
                () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }),
                lockedWithReason('corrupt_lock_quarantined'),
                `authorized start must quarantine ${JSON.stringify(corrupt)} and fail`
            );
            assert(!fs.existsSync(lockPathFor(stateRoot)), 'quarantine must rename the malformed lock away');
            assert.strictEqual(diagnosticNames(stateRoot, 'agent.lock.corrupt-').length >= 1, true,
                'quarantine must leave diagnostic evidence');
            const recovered = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
            assert(isCompleteOwner(readOwner(stateRoot)));
            recovered.release();
        }
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testUnauthorizedCorruptLockRemainsUntouched() {
    const stateRoot = temporaryRoot();
    try {
        for (const corrupt of ['', '{"pid":12', '{}']) {
            writeLock(stateRoot, corrupt);
            assert.throws(
                () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: false }),
                error => error.code === 'STATE_ROOT_LOCKED' && error.reason === undefined,
                'unauthorized start must fail closed without repairing ownership'
            );
            assert.strictEqual(fs.readFileSync(lockPathFor(stateRoot), 'utf8'), corrupt);
            assert.deepStrictEqual(diagnosticNames(stateRoot, 'agent.lock.corrupt-'), []);
        }
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testAuthorizedCorruptTombstoneQuarantinesThenNextRestartRecovers() {
    const stateRoot = temporaryRoot();
    try {
        const staleOwner = { pid: 2147483647, started_at: new Date().toISOString(), boot_id: 'stale-for-tombstone' };
        const tombstone = staleTombstonePath(stateRoot, staleOwner);
        for (const corrupt of ['', '{"pid":12', '{}']) {
            writeLock(stateRoot, JSON.stringify(staleOwner));
            fs.writeFileSync(tombstone, corrupt);
            assert.throws(
                () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }),
                lockedWithReason('corrupt_tombstone_quarantined'),
                `authorized start must quarantine tombstone ${JSON.stringify(corrupt)} and fail`
            );
            assert(!fs.existsSync(tombstone), 'quarantine must rename the malformed tombstone away');
            assert(fs.existsSync(lockPathFor(stateRoot)), 'quarantine must not steal the stale lock in the same start');
            assert.strictEqual(diagnosticNames(stateRoot, path.basename(tombstone)).length >= 1, true);
            const recovered = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
            assert(isCompleteOwner(readOwner(stateRoot)));
            assert.deepStrictEqual(
                fs.readdirSync(stateRoot).filter(name => name.startsWith('agent.lock.stale-') && !name.includes('.corrupt-')),
                []
            );
            recovered.release();
        }
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testFourContendersAroundQuarantineHaveAtMostOneOwner() {
    const stateRoot = temporaryRoot();
    try {
        writeLock(stateRoot, '');
        const children = [0, 1, 2, 3].map(() => spawnAuthorizedContender(stateRoot));
        const results = await Promise.all(children.map(async child => {
            const line = await waitForLine(child);
            return JSON.parse(line);
        }));
        const acquired = results.filter(result => result.status === 'ACQUIRED');
        assert(acquired.length <= 1, `quarantine/restart boundary must have at most one owner, got ${acquired.length}`);
        const quarantined = results.filter(result => result.reason === 'corrupt_lock_quarantined');
        for (const result of quarantined) {
            assert.strictEqual(result.status, 'ERROR');
        }
        if (acquired.length === 1) {
            assert(isCompleteOwner(readOwner(stateRoot)));
        } else {
            const recovered = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
            assert(isCompleteOwner(readOwner(stateRoot)));
            recovered.release();
        }
        for (const child of children) {
            child.stdin.on('error', () => {});
            if (child.exitCode === null) {
                try { child.stdin.write('RELEASE\n'); } catch {}
            }
        }
        await Promise.all(children.map(child => new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            const timer = setTimeout(resolve, 1000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        })));
    } finally {
        reapChildren();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function testValidLiveOwnerAndClaimantAreNeverQuarantined() {
    const stateRoot = temporaryRoot();
    try {
        const live = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        const before = fs.readFileSync(lockPathFor(stateRoot), 'utf8');
        assert.throws(
            () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }),
            error => error.code === 'STATE_ROOT_LOCKED' && error.reason === undefined
        );
        assert.strictEqual(fs.readFileSync(lockPathFor(stateRoot), 'utf8'), before);
        assert.deepStrictEqual(diagnosticNames(stateRoot, 'agent.lock.corrupt-'), []);
        live.release();

        const staleOwner = { pid: 2147483647, started_at: new Date().toISOString(), boot_id: 'live-claimant-owner' };
        writeLock(stateRoot, JSON.stringify(staleOwner));
        const tombstone = staleTombstonePath(stateRoot, staleOwner);
        const liveClaimant = { pid: process.pid, boot_id: 'live-claimant' };
        fs.writeFileSync(tombstone, JSON.stringify(liveClaimant));
        assert.throws(
            () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }),
            error => error.code === 'STATE_ROOT_LOCKED' && error.reason === undefined
        );
        assert.strictEqual(fs.readFileSync(tombstone, 'utf8'), JSON.stringify(liveClaimant));
        assert.deepStrictEqual(diagnosticNames(stateRoot, path.basename(tombstone)), []);
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

(async () => {
    await testAtomicPublicationNeverExposesPartialLock();
    await testAbandonedPrivateFileIsInertAndCleaned();
    await testAuthorizedCorruptLockQuarantinesThenNextStartAcquires();
    await testUnauthorizedCorruptLockRemainsUntouched();
    await testAuthorizedCorruptTombstoneQuarantinesThenNextRestartRecovers();
    await testFourContendersAroundQuarantineHaveAtMostOneOwner();
    await testValidLiveOwnerAndClaimantAreNeverQuarantined();
    console.log('v2-state-root-lock tests passed');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

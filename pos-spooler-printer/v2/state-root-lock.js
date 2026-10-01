const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function lockedError() {
    const error = new Error('STATE_ROOT_LOCKED');
    error.code = 'STATE_ROOT_LOCKED';
    return error;
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

function sameOwner(left, right) {
    return left?.pid === right?.pid && left?.boot_id === right?.boot_id;
}

function isCompleteOwner(owner) {
    return Number.isInteger(owner?.pid) && owner.pid >= 1 && typeof owner?.boot_id === 'string';
}

function writeCompleteOwnerFile(target, owner) {
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function publishOwnerFile(stateRoot, lockPath, owner) {
    const pendingPath = path.join(stateRoot, `agent.lock.pending-${owner.boot_id}`);
    try {
        writeCompleteOwnerFile(pendingPath, owner);
        fs.linkSync(pendingPath, lockPath);
    } finally {
        try { fs.unlinkSync(pendingPath); } catch {}
    }
}

function cleanupAbandonedPrivateFiles(stateRoot) {
    for (const name of fs.readdirSync(stateRoot)) {
        if (!name.startsWith('agent.lock.claim-') && !name.startsWith('agent.lock.pending-')) continue;
        const privatePath = path.join(stateRoot, name);
        let claimant = null;
        try { claimant = JSON.parse(fs.readFileSync(privatePath, 'utf8')); } catch {}
        const claimantIsLive = isCompleteOwner(claimant) && processIsAlive(claimant.pid);
        if (!claimantIsLive) {
            try { fs.unlinkSync(privatePath); } catch {}
        }
    }
}

function quarantineCorruptState(target, owner, reason) {
    const diagnostic = `${target}.corrupt-${owner.boot_id}`;
    try {
        fs.renameSync(target, diagnostic);
    } catch {
        throw lockedError();
    }
    const error = lockedError();
    error.reason = reason;
    throw error;
}

// A tombstone already exists for this stale owner. Either a contender is reclaiming it
// right now, or a contender died midway through its reclaim. The tombstone records the
// claimant, so liveness tells those two apart: a dead claimant's tombstone is cleared so
// the next start reclaims cleanly instead of failing for the life of the installation.
//
// Tombstones are published atomically (see below), so an unreadable tombstone is corrupt
// ownership state rather than an interrupted write. An authorized start quarantines it
// and fails; the next start may reclaim. Clearing it in the same call would reopen the
// gate while another claimant might still be running.
function resolveStaleTombstone(stalePath, owner) {
    let claimant;
    try {
        claimant = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
    } catch {
        quarantineCorruptState(stalePath, owner, 'corrupt_tombstone_quarantined');
    }
    if (!isCompleteOwner(claimant)) {
        quarantineCorruptState(stalePath, owner, 'corrupt_tombstone_quarantined');
    }
    const claimantIsLive = processIsAlive(claimant.pid);
    if (claimantIsLive) return lockedError();
    try {
        fs.unlinkSync(stalePath);
    } catch {
        return lockedError();
    }
    const error = lockedError();
    error.reason = 'interrupted_reclaim_cleared';
    return error;
}

function acquireStateRootLock({ stateRoot, staleReclaimAuthorized = false } = {}) {
    if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error('SPOOLER_STATE_DIR_INVALID');
    fs.mkdirSync(stateRoot, { recursive: true });
    cleanupAbandonedPrivateFiles(stateRoot);
    const lockPath = path.join(stateRoot, 'agent.lock');
    const owner = {
        pid: process.pid,
        started_at: new Date().toISOString(),
        boot_id: crypto.randomUUID()
    };

    function create() {
        publishOwnerFile(stateRoot, lockPath, owner);
    }

    try {
        create();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let existing;
        try {
            existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch {
            if (staleReclaimAuthorized === true) {
                quarantineCorruptState(lockPath, owner, 'corrupt_lock_quarantined');
            }
            throw lockedError();
        }
        if (!isCompleteOwner(existing)) {
            if (staleReclaimAuthorized === true) {
                quarantineCorruptState(lockPath, owner, 'corrupt_lock_quarantined');
            }
            throw lockedError();
        }
        if (processIsAlive(existing.pid)) throw lockedError();
        if (staleReclaimAuthorized !== true) throw lockedError();
        const staleClaim = crypto
            .createHash('sha256')
            .update(`${existing.pid}:${existing.boot_id}`)
            .digest('hex');
        const stalePath = path.join(stateRoot, `agent.lock.stale-${staleClaim}`);
        // Publish the tombstone atomically. The claimant is written to a private file
        // named for this acquire, then hard-linked into the shared path: linkSync fails
        // EEXIST when another contender already holds the claim, and the content is
        // complete before the shared name exists, so no contender can observe a
        // half-written tombstone. Creating the shared name first and writing into it
        // afterwards would expose an empty file that another contender reads as damaged
        // and clears, re-opening the claim while this reclaim is still running.
        //
        // The tombstone names the CLAIMANT rather than hard-linking agent.lock itself: a
        // link to the lock carries the stale owner's identity, which makes an interrupted
        // reclaim indistinguishable from a live one and locks the station out for good.
        const pendingPath = path.join(stateRoot, `agent.lock.claim-${owner.boot_id}`);
        try {
            writeCompleteOwnerFile(pendingPath, owner);
        } catch {
            try { fs.unlinkSync(pendingPath); } catch {}
            throw lockedError();
        }
        try {
            fs.linkSync(pendingPath, stalePath);
        } catch (claimError) {
            try { fs.unlinkSync(pendingPath); } catch {}
            if (claimError?.code === 'EEXIST') throw resolveStaleTombstone(stalePath, owner);
            throw lockedError();
        }
        try { fs.unlinkSync(pendingPath); } catch {}
        try {
            // Re-read under the claim: the lock must still be the same stale owner we
            // authorized reclaiming. Anything else means someone already took it.
            const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (!sameOwner(current, existing)) throw lockedError();
            fs.unlinkSync(lockPath);
            create();
        } catch {
            try { fs.unlinkSync(stalePath); } catch {}
            throw lockedError();
        }
        try { fs.unlinkSync(stalePath); } catch {}
    }

    let released = false;
    function release() {
        if (released) return;
        released = true;
        try {
            const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (sameOwner(existing, owner)) fs.unlinkSync(lockPath);
        } catch {}
    }

    return { release };
}

module.exports = { acquireStateRootLock };

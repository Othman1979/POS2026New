const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMPORARY_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);
const TEMP_PREFIXES = ['agent.json.', 'agent.candidate.json.'];

async function readIdentityFile(file, protector) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1
        || !UUID_V4.test(String(saved.agent_id || ''))
        || typeof saved.protected_secret !== 'string') {
        throw new Error('AGENT_IDENTITY_INVALID');
    }
    const secret = await protector.unprotect(saved.protected_secret);
    if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('AGENT_IDENTITY_INVALID');
    return { agentId: saved.agent_id, secret };
}

// Temp file, fsync, rename: `file` is always either the previous content or the new
// content, never a partial write. The secret only ever hits disk protected.
async function writeIdentityFile({ file, protector, identity, beforeRename = async () => {} }) {
    const saved = {
        version: 1,
        agent_id: identity.agentId,
        protected_secret: await protector.protect(identity.secret)
    };
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    let renamed = false;
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    try {
        await beforeRename();
        fs.renameSync(temporary, file);
        renamed = true;
    } finally {
        if (!renamed) fs.rmSync(temporary, { force: true });
    }
}

async function loadOrCreateIdentity({ stateRoot, protector, beforeRename = async () => {} }) {
    const file = path.join(stateRoot, 'agent.json');
    fs.mkdirSync(stateRoot, { recursive: true });
    // Only interrupted temp writes are swept. agent.candidate.json is a durable
    // replacement identity awaiting promotion and is handled by loadCandidateIdentity.
    for (const name of fs.readdirSync(stateRoot)) {
        if (TEMP_PREFIXES.some(prefix => name.startsWith(prefix)) && name.endsWith('.tmp')) {
            fs.rmSync(path.join(stateRoot, name), { force: true });
        }
    }

    if (fs.existsSync(file)) return readIdentityFile(file, protector);

    const identity = { agentId: crypto.randomUUID(), secret: crypto.randomBytes(32) };
    await writeIdentityFile({ file, protector, identity, beforeRename });
    return identity;
}

function candidateHandle({ stateRoot, candidateFile, file, identity, beforeRename }) {
    let settled = false;
    return {
        ...identity,
        // Promotion: the candidate becomes the machine's identity in one atomic rename.
        async commit() {
            if (settled) throw new Error('AGENT_IDENTITY_STAGE_SETTLED');
            await beforeRename();
            fs.renameSync(candidateFile, file);
            settled = true;
        },
        discard() {
            settled = true;
            fs.rmSync(candidateFile, { force: true });
        }
    };
}

// Writes a replacement identity to agent.candidate.json (durable, protected, atomic)
// and leaves agent.json alone. It is written BEFORE the server is asked to register
// it, so a crash after the server accepted it can still be finished on restart. The
// caller commits (promotes) it once the server has accepted, or discards it.
async function stageReplacementIdentity({ stateRoot, protector, beforeRename = async () => {} }) {
    fs.mkdirSync(stateRoot, { recursive: true });
    const file = path.join(stateRoot, 'agent.json');
    const candidateFile = path.join(stateRoot, 'agent.candidate.json');
    const identity = { agentId: crypto.randomUUID(), secret: crypto.randomBytes(32) };
    await writeIdentityFile({ file: candidateFile, protector, identity });
    return candidateHandle({ stateRoot, candidateFile, file, identity, beforeRename });
}

// A candidate left by a previous run (crash between "server accepted" and promotion,
// or before the server heard of it). Returns null when there is none or it is unusable.
async function loadCandidateIdentity({ stateRoot, protector, beforeRename = async () => {} }) {
    const file = path.join(stateRoot, 'agent.json');
    const candidateFile = path.join(stateRoot, 'agent.candidate.json');
    if (!fs.existsSync(candidateFile)) return null;
    let identity;
    try {
        identity = await readIdentityFile(candidateFile, protector);
    } catch (error) {
        // The file may be the only copy of credentials the server already accepted, so it
        // goes only when it is unusable for good. A busy or briefly unreadable file (or a
        // helper that cannot unprotect right now) stays, and the error tells the caller
        // to try again.
        if (error?.failureClass === 'transient_safe' || TEMPORARY_FILE_ERRORS.has(error?.code)) throw error;
        fs.rmSync(candidateFile, { force: true });
        return null;
    }
    return candidateHandle({ stateRoot, candidateFile, file, identity, beforeRename });
}

module.exports = { loadOrCreateIdentity, stageReplacementIdentity, loadCandidateIdentity };

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrCreateIdentity, stageReplacementIdentity, loadCandidateIdentity } =require('../v2/agent-identity');

function temporaryRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-identity-'));
}

const protector = {
    protect: async value => Buffer.from(value).toString('base64'),
    unprotect: async value => Buffer.from(value, 'base64')
};

(async () => {
    const root = temporaryRoot();
    const first = await loadOrCreateIdentity({ stateRoot: root, protector });
    const second = await loadOrCreateIdentity({ stateRoot: root, protector });
    assert.strictEqual(second.agentId, first.agentId);
    assert.deepStrictEqual(second.secret, first.secret);
    const savedText = fs.readFileSync(path.join(root, 'agent.json'), 'utf8');
    const saved = JSON.parse(savedText);
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(typeof saved.protected_secret, 'string');
    assert(!savedText.includes(first.secret.toString('hex')));
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));

    const crashRoot = temporaryRoot();
    await assert.rejects(
        loadOrCreateIdentity({
            stateRoot: crashRoot,
            protector,
            beforeRename: async () => { throw new Error('SIMULATED_CRASH'); }
        }),
        /SIMULATED_CRASH/
    );
    assert(!fs.existsSync(path.join(crashRoot, 'agent.json')));
    assert(!fs.readdirSync(crashRoot).some(name => name.endsWith('.tmp')));
    const regenerated = await loadOrCreateIdentity({ stateRoot: crashRoot, protector });
    assert(fs.existsSync(path.join(crashRoot, 'agent.json')));
    assert.strictEqual((await loadOrCreateIdentity({ stateRoot: crashRoot, protector })).agentId, regenerated.agentId);

    const corruptRoot = temporaryRoot();
    fs.writeFileSync(path.join(corruptRoot, 'agent.json'), '{}');
    await assert.rejects(loadOrCreateIdentity({ stateRoot: corruptRoot, protector }), /AGENT_IDENTITY_INVALID/);

    // A replacement identity is staged beside agent.json and adopted only on commit,
    // atomically, with the secret never written in the clear.
    const agentFile = path.join(root, 'agent.json');
    const beforeStage = fs.readFileSync(agentFile);
    const staged = await stageReplacementIdentity({ stateRoot: root, protector });
    assert.notStrictEqual(staged.agentId, first.agentId);
    assert.notDeepStrictEqual(staged.secret, first.secret);
    assert.strictEqual(staged.secret.length, 32);
    assert(beforeStage.equals(fs.readFileSync(agentFile)), 'staging must not touch agent.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(agentFile, 'utf8')).agent_id, first.agentId);
    await staged.commit();
    const reloaded = await loadOrCreateIdentity({ stateRoot: root, protector });
    assert.strictEqual(reloaded.agentId, staged.agentId);
    assert.deepStrictEqual(reloaded.secret, staged.secret);
    assert(!fs.readFileSync(agentFile, 'utf8').includes(staged.secret.toString('hex')));
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));

    let protectedInput = null;
    const sealing = { protect: async value => { protectedInput = value; return `sealed:${Buffer.from(value).toString('base64')}`; }, unprotect: protector.unprotect };
    const sealed = await stageReplacementIdentity({ stateRoot: root, protector: sealing });
    assert(Buffer.isBuffer(protectedInput) && protectedInput.length === 32, 'the new secret goes through the protector');
    await sealed.commit();
    assert(JSON.parse(fs.readFileSync(agentFile, 'utf8')).protected_secret.startsWith('sealed:'));

    // A discarded stage leaves the saved identity byte-identical and no temp file behind.
    const beforeDiscard = fs.readFileSync(agentFile);
    (await stageReplacementIdentity({ stateRoot: root, protector })).discard();
    assert(beforeDiscard.equals(fs.readFileSync(agentFile)));
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));

    // A crash before the rename leaves the previous identity intact and no temp file behind.
    const before = fs.readFileSync(path.join(crashRoot, 'agent.json'), 'utf8');
    const crashing = await stageReplacementIdentity({
        stateRoot: crashRoot,
        protector,
        beforeRename: async () => { throw new Error('SIMULATED_CRASH'); }
    });
    await assert.rejects(crashing.commit(), /SIMULATED_CRASH/);
    assert.strictEqual(fs.readFileSync(path.join(crashRoot, 'agent.json'), 'utf8'), before);
    assert.strictEqual((await loadOrCreateIdentity({ stateRoot: crashRoot, protector })).agentId, regenerated.agentId);
    assert(!fs.readdirSync(crashRoot).some(name => name.endsWith('.tmp')));

    // A staged identity is durable (agent.candidate.json, protected) until promoted, and
    // the start-up temp sweep never removes it.
    const candidateFile = path.join(crashRoot, 'agent.candidate.json');
    const durable = await stageReplacementIdentity({ stateRoot: crashRoot, protector });
    assert(fs.existsSync(candidateFile));
    assert(!fs.readFileSync(candidateFile, 'utf8').includes(durable.secret.toString('hex')));
    await loadOrCreateIdentity({ stateRoot: crashRoot, protector });
    assert(fs.existsSync(candidateFile), 'the start-up sweep must not delete a candidate');
    const restored = await loadCandidateIdentity({ stateRoot: crashRoot, protector });
    assert.strictEqual(restored.agentId, durable.agentId);
    assert.deepStrictEqual(restored.secret, durable.secret);
    await restored.commit();
    assert(!fs.existsSync(candidateFile));
    assert.strictEqual((await loadOrCreateIdentity({ stateRoot: crashRoot, protector })).agentId, durable.agentId);
    assert.strictEqual(await loadCandidateIdentity({ stateRoot: crashRoot, protector }), null);
    fs.writeFileSync(candidateFile, '{"garbage":true}');
    assert.strictEqual(await loadCandidateIdentity({ stateRoot: crashRoot, protector }), null, 'an unusable candidate is ignored');
    assert(!fs.existsSync(candidateFile), 'and removed');

    // A read that fails for a temporary reason must not delete the only copy of an
    // identity the server may already have accepted.
    const kept = await stageReplacementIdentity({ stateRoot: crashRoot, protector });
    for (const failure of [
        Object.assign(new Error('PLATFORM_HELPER_BUSY'), { failureClass: 'transient_safe' }),
        Object.assign(new Error('busy'), { code: 'EBUSY' })
    ]) {
        const flaky = { protect: protector.protect, unprotect: async () => { throw failure; } };
        await assert.rejects(loadCandidateIdentity({ stateRoot: crashRoot, protector: flaky }), error => error === failure);
        assert(fs.existsSync(candidateFile), 'a temporary failure keeps the candidate');
    }
    assert.deepStrictEqual((await loadCandidateIdentity({ stateRoot: crashRoot, protector })).secret, kept.secret, 'a later attempt reads it again');
    fs.rmSync(candidateFile, { force: true });

    for (const directory of [root, crashRoot, corruptRoot]) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log('v2-agent-identity tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

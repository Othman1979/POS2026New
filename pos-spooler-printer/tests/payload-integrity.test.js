const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPrintPayload } = require('../../backend/services/printJobIdentity');
const { openJobStore } = require('../v2/job-store');
const { verifyArtifactHash } = require('../v2/printer-transports');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-payload-'));
    try {
        const contents = Buffer.from('queued-artifact');
        const file = path.join(root, 'artifact.bin');
        fs.writeFileSync(file, contents);
        const hash = crypto.createHash('sha256').update(contents).digest('hex');
        await verifyArtifactHash({ path: file, hash, bytes: contents.length });
        await assert.rejects(
            () => verifyArtifactHash({ path: file, hash: '0'.repeat(64), bytes: contents.length }),
            error => error?.code === 'ARTIFACT_HASH_MISMATCH' && error.failureClass === 'permanent_safe',
            'a non-null stored hash must reject tampered artifact bytes'
        );

        const payload = {
            printer_id: 7,
            printer_type: 'network',
            network_ip: '127.0.0.1',
            print_type: 'receipt',
            data: { invoice_id: 7001, total: 5 }
        };
        const payloadHash = hashPrintPayload(payload);
        const store = openJobStore({ stateRoot: root });
        const accepted = store.accept({
            queue_id: 44,
            idempotency_key: 'receipt:7:request:hash',
            payload_hash: payloadHash,
            printer_id: 7,
            print_type: 'receipt',
            data: payload.data
        });
        assert.strictEqual(accepted.payload_hash, payloadHash);
        assert.throws(
            () => store.accept({
                queue_id: 44,
                idempotency_key: 'receipt:7:request:hash',
                payload_hash: 'f'.repeat(64),
                printer_id: 7,
                print_type: 'receipt',
                data: { ...payload.data, total: 99 }
            }),
            /PAYLOAD_IDENTITY_CONFLICT/,
            'a later identity mismatch must refuse the queued job'
        );
        assert.strictEqual(store.get(44).payload_hash, payloadHash);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('payload-integrity tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const CASH_DRAWER_PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function classified(code, failureClass, message = code) {
    const error = new Error(message);
    error.code = code;
    error.failureClass = failureClass;
    return error;
}

function createRawArtifactRenderer({ stateRoot }) {
    const artifactsDirectory = path.join(stateRoot, 'artifacts');
    fs.mkdirSync(artifactsDirectory, { recursive: true });

    function render(job) {
        if (job?.print_type !== 'cash_drawer') {
            throw classified('RAW_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Raw renderer supports cash-drawer jobs only.');
        }
        const renderStartedAt = performance.now();
        const queueId = Number(job?.queue_id) || `local-${Date.now()}`;
        const temporary = path.join(artifactsDirectory, `${queueId}.${process.pid}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        try {
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(descriptor, CASH_DRAWER_PULSE);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = null;
            const digest = crypto.createHash('sha256').update(CASH_DRAWER_PULSE).digest('hex');
            const finalPath = path.join(artifactsDirectory, `${queueId}-${digest}.bin`);
            fs.renameSync(temporary, finalPath);
            return {
                path: finalPath,
                hash: digest,
                bytes: CASH_DRAWER_PULSE.length,
                width: 0,
                height: 0,
                render_ms: performance.now() - renderStartedAt,
                raster_ms: 0,
                renderer: 'raw'
            };
        } catch (error) {
            throw error.failureClass ? error : classified('ARTIFACT_WRITE_FAILED', 'transient_safe', error.message);
        } finally {
            if (descriptor !== undefined && descriptor !== null) {
                try { fs.closeSync(descriptor); } catch {}
            }
            fs.rmSync(temporary, { force: true });
        }
    }

    return { render, close: async () => {}, health: () => ({ state: 'ready', last_error: null }) };
}

module.exports = { createRawArtifactRenderer };

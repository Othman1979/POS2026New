// Offline recovery only. Never sends printer bytes, deletes OS jobs or reprints.
const path = require('node:path');
const fs = require('node:fs');
const { openJobStore } = require('./v2/job-store');
const { acquireStateRootLock } = require('./v2/state-root-lock');
const { startPlatformHelper } = require('./v2/platform-helper');

async function main(args = process.argv.slice(2)) {
    require('dotenv').config({ path: process.env.SPOOLER_ENV_FILE || path.join(__dirname, '.env') });
    const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
    const stateRoot = path.resolve(option('--state-root') || process.env.SPOOLER_STATE_DIR ||
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'POS-Spooler', 'state'));
    const lock = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
    let helper;
    try {
        // The native mutex also rejects an orphan helper still inside WritePrinter.
        const packaged = path.join(__dirname, 'bin', 'PosSpoolerPlatform.exe');
        const executable = fs.existsSync(packaged) ? packaged : path.join(__dirname, 'windows-helper', 'PosSpoolerPlatform.exe');
        helper = await startPlatformHelper({ executable, stateRoot });
        const store = openJobStore({ stateRoot });
        const holds = store.endpointHolds();
        const queueId = Number(option('--queue-id'));
        if (!args.includes('--queue-id')) {
            console.log(JSON.stringify({ holds, instructions: 'Stop the POS spooler service. Check the affected ticket and clear its Windows queue. Power-cycle the affected printer to clear partial command data. Then use --queue-id ID --confirm-queue-cleared --confirm-printer-reset. Restart the service afterwards. Uncertain tickets are never automatically reprinted.' }, null, 2));
            return;
        }
        if (!Number.isSafeInteger(queueId) || queueId < 1) throw new Error('QUEUE_ID_REQUIRED');
        if (!args.includes('--confirm-queue-cleared') || !args.includes('--confirm-printer-reset')) throw new Error('QUEUE_CLEAR_AND_DEVICE_RESET_CONFIRMATION_REQUIRED');
        const held = holds.find(entry => entry.queue_ids.includes(queueId));
        if (!held) throw new Error('ENDPOINT_HOLD_NOT_FOUND');
        store.recoverEndpoint(held.endpoint, held.queue_ids);
        console.log(JSON.stringify({ recovered_endpoint: held.endpoint, reviewed_queue_ids: held.queue_ids, reprinted: false }));
    } finally {
        await helper?.close();
        lock.release();
    }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };

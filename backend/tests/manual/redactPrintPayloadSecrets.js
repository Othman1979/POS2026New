#!/usr/bin/env node
'use strict';

// One-off remediation for the credential leak fixed in 44e85cbe.
//
// Until that commit, the print route attached the entire settings table to every receipt
// payload to obtain four letterhead fields. Those payloads were persisted to
// print_queue.payload, shipped to the spooler agent, and written to its durable journal
// under %ProgramData%\POS-Spooler\state, whose ACL grants BUILTIN\Users read access. The
// code fix stops new copies; it cannot reach the ones already written. This does.
//
// It redacts rather than deletes. print_queue rows are print history and a dead-lettered
// row is still reprintable; the agent's archived records are how it recognises a queue_id
// it has already handled. Both survive intact - only the extra settings keys are dropped,
// leaving exactly the letterhead a fresh payload now carries, so a reprint of a redacted
// row produces the same ticket as a new one.
//
// Safe against the running agent: archived records are loaded at startup for identity
// (queue_id, idempotency_key, payload_hash, state) and every code path refuses to act on
// them. None of those fields is touched. Files are replaced atomically.
//
//   node backend/tests/manual/redactPrintPayloadSecrets.js            # dry run, changes nothing
//   node backend/tests/manual/redactPrintPayloadSecrets.js --apply

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();
const pool = require('../../config/db');
const { PRINT_STORE_INFO_KEYS } = require('../../services/printStoreInfo');
const { hashPayload } = require('../../services/auditReportBuilder');

const LETTERHEAD = PRINT_STORE_INFO_KEYS;
const APPLY = process.argv.includes('--apply');
const STATE_ROOT = process.env.SPOOLER_STATE_ROOT
    || path.join(process.env.ProgramData || 'C:/ProgramData', 'POS-Spooler', 'state');

function redactStoreInfo(storeInfo) {
    if (!storeInfo || typeof storeInfo !== 'object') return { changed: false, value: storeInfo, dropped: [] };
    const dropped = Object.keys(storeInfo).filter(key => !LETTERHEAD.includes(key));
    if (!dropped.length) return { changed: false, value: storeInfo, dropped: [] };
    const value = {};
    for (const key of LETTERHEAD) if (key in storeInfo) value[key] = storeInfo[key];
    return { changed: true, value, dropped };
}

function sensitive(keys) {
    return keys.filter(key => /secret|client_id|token|password|key$/i.test(key));
}

async function redactDatabase() {
    const [rows] = await pool.query(
        `SELECT id, print_type, status, payload FROM print_queue
          WHERE JSON_EXTRACT(payload, '$.data.storeInfo') IS NOT NULL
          ORDER BY id`
    );
    let changed = 0;
    const droppedKeys = new Set();
    for (const row of rows) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const result = redactStoreInfo(payload?.data?.storeInfo);
        if (!result.changed) continue;
        changed += 1;
        result.dropped.forEach(key => droppedKeys.add(key));
        console.log(`  queue ${String(row.id).padStart(4)}  ${row.print_type.padEnd(22)} ${String(row.status).padEnd(13)} drop ${result.dropped.length} keys` +
            (sensitive(result.dropped).length ? `  [${sensitive(result.dropped).length} credential]` : ''));
        if (!APPLY) continue;
        payload.data.storeInfo = result.value;
        await pool.query('UPDATE print_queue SET payload = ? WHERE id = ?', [JSON.stringify(payload), row.id]);
    }
    const [documents] = await pool.query(
        `SELECT id, payload_json, payload_hash FROM audit_report_documents
          WHERE JSON_EXTRACT(payload_json, '$.storeInfo') IS NOT NULL
          ORDER BY id`
    );
    let auditChanged = 0;
    for (const document of documents) {
        const payload = typeof document.payload_json === 'string'
            ? JSON.parse(document.payload_json)
            : document.payload_json;
        const result = redactStoreInfo(payload?.storeInfo);
        if (!result.changed) continue;
        auditChanged += 1;
        result.dropped.forEach(key => droppedKeys.add(key));
        const oldHash = document.payload_hash;
        payload.storeInfo = result.value;
        const newHash = hashPayload(payload);
        payload.payload_hash = newHash;
        console.log(`  audit ${String(document.id).padStart(4)}  drop ${result.dropped.length} keys` +
            (sensitive(result.dropped).length ? `  [${sensitive(result.dropped).length} credential]` : ''));
        if (!APPLY) continue;
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(
                'UPDATE audit_report_documents SET payload_json = ?, payload_hash = ? WHERE id = ?',
                [JSON.stringify(payload), newHash, document.id]
            );
            await conn.query(
                `INSERT INTO audit_events
                    (event_type, entity_type, entity_id, old_value, new_value)
                 VALUES ('audit_report.credentials_redacted', 'audit_report_document', ?, ?, ?)`,
                [document.id, JSON.stringify({ payload_hash: oldHash }), JSON.stringify({ payload_hash: newHash })]
            );
            await conn.commit();
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }

    const [archives] = await pool.query(
        `SELECT id, report_payload FROM master_held
          WHERE JSON_EXTRACT(report_payload, '$.storeInfo') IS NOT NULL
          ORDER BY id`
    );
    let archiveChanged = 0;
    for (const archive of archives) {
        const payload = typeof archive.report_payload === 'string'
            ? JSON.parse(archive.report_payload)
            : archive.report_payload;
        const result = redactStoreInfo(payload?.storeInfo);
        if (!result.changed) continue;
        archiveChanged += 1;
        result.dropped.forEach(key => droppedKeys.add(key));
        console.log(`  Y archive ${String(archive.id).padStart(4)}  drop ${result.dropped.length} keys` +
            (sensitive(result.dropped).length ? `  [${sensitive(result.dropped).length} credential]` : ''));
        if (!APPLY) continue;
        payload.storeInfo = result.value;
        await pool.query('UPDATE master_held SET report_payload = ? WHERE id = ?', [JSON.stringify(payload), archive.id]);
    }

    return {
        scanned: rows.length + documents.length + archives.length,
        changed: changed + auditChanged + archiveChanged,
        droppedKeys: [...droppedKeys],
    };
}

function jobFiles() {
    const out = [];
    for (const sub of ['jobs/active', 'jobs/archive', 'jobs', 'quarantine']) {
        const dir = path.join(STATE_ROOT, ...sub.split('/'));
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            const full = path.join(dir, name);
            try { if (fs.statSync(full).isFile() && name.endsWith('.json')) out.push(full); } catch { /* raced */ }
        }
    }
    return out;
}

function redactJournal() {
    const files = jobFiles();
    let changed = 0;
    const droppedKeys = new Set();
    for (const file of files) {
        let record;
        try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        const storeInfo = record?.job?.data?.storeInfo;
        const result = redactStoreInfo(storeInfo);
        if (!result.changed) continue;
        changed += 1;
        result.dropped.forEach(key => droppedKeys.add(key));
        console.log(`  ${path.relative(STATE_ROOT, file).padEnd(78)} drop ${result.dropped.length} keys` +
            (sensitive(result.dropped).length ? `  [${sensitive(result.dropped).length} credential]` : ''));
        if (!APPLY) continue;
        record.job.data.storeInfo = result.value;
        // Atomic replace: a torn write here would cost the agent a job identity.
        const temporary = path.join(os.tmpdir(), `redact-${process.pid}-${path.basename(file)}`);
        fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, 'utf8');
        fs.renameSync(temporary, file);
    }
    return { scanned: files.length, changed, droppedKeys: [...droppedKeys] };
}

(async () => {
    console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN - nothing will be written (pass --apply) ===');
    console.log(`letterhead kept: ${LETTERHEAD.join(', ')}`);
    console.log(`state root:      ${STATE_ROOT}\n`);

    console.log('print_queue.payload');
    const db = await redactDatabase();
    console.log(`  -> ${db.changed} of ${db.scanned} rows carry extra settings\n`);

    console.log('spooler agent journal');
    const journal = redactJournal();
    console.log(`  -> ${journal.changed} of ${journal.scanned} records carry extra settings\n`);

    const credentials = sensitive([...new Set([...db.droppedKeys, ...journal.droppedKeys])]);
    if (credentials.length) {
        console.log(`credential keys ${APPLY ? 'removed' : 'that would be removed'}:`);
        credentials.forEach(key => console.log(`  - ${key}`));
        console.log('\nRotate these in the JoFotara portal. They were readable by every local');
        console.log('account on every till that printed a receipt, so removing the copies does');
        console.log('not undo the exposure.');
    }
    await pool.end();
})().catch(error => { console.error('FAILED', error); process.exit(1); });

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { businessLocalDateSql } = require('../utils/businessDate');
const { isValidDateOnly, parseDailyReportPeriod } = require('./dailyReportPeriod');
const LEASE_SECONDS = 60;
const COVERAGE_DAYS = 8;

function scopeFor(type, id) {
    if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('Stock report source IDs must be exact integers.');
    if (!['invoice', 'operation'].includes(type) || !/^[1-9]\d{0,19}$/.test(String(id))) throw new Error('Invalid stock report source.');
    return createHash('sha256').update(`${type}:${id}`).digest().readUInt32BE(0) % 32;
}

// The source transaction owns this call, after all stock/source locks. Refunds
// use the original invoice partition; an operation without an invoice uses its
// operation partition. No process-local queue may substitute for this write.
async function markDirty(conn, scopes) {
    if (!Array.isArray(scopes) || scopes.length > 64) throw new Error('A stock report mutation supports at most 64 scopes.');
    const unique = new Map();
    for (const scope of scopes) {
        const { day, scope_id } = scope || {};
        if (typeof day !== 'string' || !Number.isInteger(scope_id) || scope_id < 0 || scope_id >= 32) throw new Error('Invalid stock report scope.');
        if (!isValidDateOnly(day)) throw new Error('Invalid stock report day.');
        unique.set(`${day}/${String(scope_id).padStart(2,'0')}`, [day, scope_id]);
    }
    const values = [...unique.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value);
    if (!values.length) return;
    await conn.query(`INSERT INTO stock_report_dirty(day,scope_id) VALUES ?
        ON DUPLICATE KEY UPDATE generation=generation+1,
        dirty_at=IF(pending=0,CURRENT_TIMESTAMP(6),dirty_at),pending=1`, [values]);
}

// One connection is held only for each short metadata transaction. The worker
// must release its source-chunk connection before yielding or calling these.
async function transaction(pool, work) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
}

async function acquireWorker(conn, owner) {
    await conn.query('INSERT IGNORE INTO stock_report_worker(id) VALUES (1)');
    const [worker]=await conn.query(`UPDATE stock_report_worker SET lease_owner=?,lease_until=DATE_ADD(NOW(6),INTERVAL ? SECOND)
        WHERE id=1 AND (lease_until IS NULL OR lease_until<=NOW(6))`,[owner,LEASE_SECONDS]);
    return Boolean(worker.affectedRows);
}

// Cleanup shares the same installation-wide resource lease as rebuilding.
// The callback obtains/releases its own short connection; no lease connection
// is retained while it runs. Call only after finding actual cleanup work.
async function withWorkerLease(pool, work) {
    const owner=randomUUID();
    if(!await transaction(pool,conn=>acquireWorker(conn,owner)))return null;
    try{return await work();}
    finally{await pool.query('UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?',[owner]);}
}

async function claim(pool) {
    // An idle installation must not write/clear a lease on every timer tick.
    // A writer racing this probe is picked up by the next scheduled attempt.
    const [pending] = await pool.query('SELECT 1 FROM stock_report_dirty WHERE pending=1 LIMIT 1');
    if (!pending.length) return null;
    const owner = randomUUID();
    return transaction(pool, async conn => {
        // A lease row, not a retained GET_LOCK connection, limits the entire
        // installation to one rebuild even when several Node processes run.
        if (!await acquireWorker(conn,owner)) return null;
        const [[scope]] = await conn.query(`SELECT DATE_FORMAT(day,'%Y-%m-%d') day,scope_id,CAST(generation AS CHAR) generation,
            CAST(active_build_id AS CHAR) active_build_id FROM stock_report_dirty
            WHERE pending=1 ORDER BY dirty_at,day,scope_id LIMIT 1 FOR UPDATE`);
        if (!scope) {
            await conn.query('UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?',[owner]);
            return null;
        }
        if (scope.active_build_id) await conn.query("UPDATE stock_report_builds SET state='abandoned' WHERE id=? AND state='building'",[scope.active_build_id]);
        await conn.query('INSERT INTO stock_report_builds(day,scope_id,generation) VALUES (?,?,?)',[scope.day,scope.scope_id,scope.generation]);
        const [[inserted]] = await conn.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id');
        const buildId = inserted.id;
        await conn.query(`UPDATE stock_report_dirty SET lease_owner=?,lease_until=DATE_ADD(NOW(6),INTERVAL ? SECOND),active_build_id=?
            WHERE day=? AND scope_id=?`,[owner,LEASE_SECONDS,buildId,scope.day,scope.scope_id]);
        return {day:scope.day,scope_id:scope.scope_id,generation:scope.generation,build_id:buildId,owner};
    });
}

async function lockOwner(conn, claim) {
    const [[worker]] = await conn.query('SELECT lease_owner,lease_until>NOW(6) AS live FROM stock_report_worker WHERE id=1 FOR UPDATE');
    return worker?.lease_owner === claim.owner && Boolean(worker.live);
}

async function release(conn, claim) {
    await conn.query(`UPDATE stock_report_dirty SET active_build_id=NULL,lease_owner=NULL,lease_until=NULL
        WHERE day=? AND scope_id=? AND active_build_id=? AND lease_owner=?`,[claim.day,claim.scope_id,claim.build_id,claim.owner]);
    await conn.query("UPDATE stock_report_builds SET state='abandoned' WHERE id=? AND state='building'",[claim.build_id]);
    await conn.query('UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?',[claim.owner]);
}

async function renew(pool, claim) {
    return transaction(pool, async conn => {
        if (!await lockOwner(conn,claim)) return false;
        const [updated] = await conn.query(`UPDATE stock_report_dirty SET lease_until=DATE_ADD(NOW(6),INTERVAL ? SECOND)
            WHERE day=? AND scope_id=? AND generation=? AND active_build_id=? AND lease_owner=? AND lease_until>NOW(6)`,
            [LEASE_SECONDS,claim.day,claim.scope_id,claim.generation,claim.build_id,claim.owner]);
        if (!updated.affectedRows) { await release(conn,claim); return false; }
        await conn.query('UPDATE stock_report_worker SET lease_until=DATE_ADD(NOW(6),INTERVAL ? SECOND) WHERE id=1 AND lease_owner=?',[LEASE_SECONDS,claim.owner]);
        return true;
    });
}

// Call only after every fact chunk has committed under this build ID. Readers
// join the published pointer; staging rows are never eligible for reports.
async function publish(pool, claim) {
    return transaction(pool, async conn => {
        if (!await lockOwner(conn,claim)) return false;
        const [[scope]] = await conn.query(`SELECT CAST(published_build_id AS CHAR) published_build_id FROM stock_report_dirty
            WHERE day=? AND scope_id=? FOR UPDATE`,[claim.day,claim.scope_id]);
        const [updated] = await conn.query(`UPDATE stock_report_dirty SET published_build_id=active_build_id,published_generation=generation,
            active_build_id=NULL,pending=0,as_of=NOW(6),lease_owner=NULL,lease_until=NULL
            WHERE day=? AND scope_id=? AND generation=? AND active_build_id=? AND lease_owner=? AND lease_until>NOW(6)`,
            [claim.day,claim.scope_id,claim.generation,claim.build_id,claim.owner]);
        if (!updated.affectedRows) { await release(conn,claim); return false; }
        await conn.query("UPDATE stock_report_builds SET state='published' WHERE id=?",[claim.build_id]);
        if (scope.published_build_id) await conn.query("UPDATE stock_report_builds SET state='obsolete' WHERE id=? AND state='published'",[scope.published_build_id]);
        await conn.query('UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=?',[claim.owner]);
        return true;
    });
}

async function abandon(pool, claim) {
    return transaction(pool, async conn => {
        // Serialize with a replacement worker before touching its scope.
        await conn.query('SELECT id FROM stock_report_worker WHERE id=1 FOR UPDATE');
        await release(conn,claim);
    });
}

async function status(conn, period) {
    const { start_date, end_date } = parseDailyReportPeriod(period);
    const [rows] = await conn.query(`SELECT DATE_FORMAT(day,'%Y-%m-%d') day,scope_id,CAST(generation AS CHAR) generation,pending,
        CAST(published_build_id AS CHAR) published_build_id,CAST(published_generation AS CHAR) published_generation,as_of
        FROM stock_report_dirty WHERE day BETWEEN ? AND ? ORDER BY day,scope_id`,[start_date,end_date]);
    return rows.map(row=>({...row,pending:Boolean(row.pending)}));
}

// Source discovery is installation work, never a scan on an interactive read.
// Checkpoints advance with their dirty rows in one transaction; crashes retry
// a bounded page and new source transactions invalidate without waiting for it.
async function coverageIncomplete(conn) {
    const [[row]]=await conn.query('SELECT 1 FROM stock_report_backfill WHERE complete=0 LIMIT 1');
    return Boolean(row);
}
async function hasSources(conn, input) {
    const period=parseDailyReportPeriod({startDate:input.startDate||input.start_date,endDate:input.endDate||input.end_date});
    const [[row]]=await conn.query('SELECT 1 FROM stock_report_dirty WHERE day BETWEEN ? AND ? LIMIT 1',[period.start_date,period.end_date]);
    return Boolean(row)||await coverageIncomplete(conn);
}
async function ensureCoverage(pool) {
    return transaction(pool,async conn=>{
        const [sources]=await conn.query('SELECT source,CAST(last_id AS CHAR) last_id FROM stock_report_backfill WHERE complete=0 ORDER BY source FOR UPDATE');
        const days=new Set();let examined=0;
        for(const source of sources){
            let sql;
            if(source.source==='orders')sql=`SELECT CAST(invoice_id AS CHAR) id,CASE WHEN payment_method NOT IN ('unpaid_table','voided') THEN ${businessLocalDateSql('COALESCE(invoice_issued_at,created_at)')} END day FROM orders WHERE invoice_id>? ORDER BY invoice_id LIMIT 128`;
            else if(source.source==='refunds')sql=`SELECT CAST(id AS CHAR) id,CASE WHEN kind='refund' THEN ${businessLocalDateSql('created_at')} END day FROM refunds WHERE id>? ORDER BY id LIMIT 128`;
            // The coverage cursor retains its historical source name and IDs.
            else if(source.source==='ingredient_movements')sql="SELECT CAST(id AS CHAR) id,DATE_FORMAT(business_date,'%Y-%m-%d') day FROM stock_movements WHERE movement_type='ingredient' AND id>? ORDER BY id LIMIT 128";
            else if(source.source==='stock_operations')sql="SELECT CAST(id AS CHAR) id,DATE_FORMAT(business_date,'%Y-%m-%d') day FROM stock_operations WHERE id>? ORDER BY id LIMIT 128";
            else throw new Error('Unknown stock report coverage source.');
            const [rows]=await conn.query(sql,[source.last_id]);examined+=rows.length;
            let last=source.last_id,consumed=0;
            for(const row of rows){
                if(row.day&&!days.has(row.day)&&days.size===COVERAGE_DAYS)break;
                if(row.day)days.add(row.day);last=row.id;consumed++;
            }
            await conn.query('UPDATE stock_report_backfill SET last_id=?,complete=? WHERE source=?',[last,rows.length<128&&consumed===rows.length?1:0,source.source]);
            if(days.size===COVERAGE_DAYS)break;
        }
        const values=[...days].sort().flatMap(day=>Array.from({length:32},(_,scope)=>[day,scope]));
        if(values.length)await conn.query('INSERT IGNORE INTO stock_report_dirty(day,scope_id) VALUES ?',[values]);
        return {inserted:values.length,days:[...days],examined,complete:!await coverageIncomplete(conn)};
    });
}

module.exports = { scopeFor, markDirty, claim, renew, publish, abandon, status, withWorkerLease, hasSources, coverageIncomplete, ensureCoverage };

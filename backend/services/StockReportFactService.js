'use strict';

const { streamFinancialFacts } = require('./IngredientAnalysisService');
const { withWorkerLease } = require('./StockReportGenerationService');

// Keep extra precision in derived cost/quantity sums; round only at the report
// boundary. These estimates are not the financial carrying-value ledger.
const decimal = value => {
    const number=Number(value);
    if (!Number.isFinite(number) || Math.abs(number)>=1e21) throw new Error('Report fact exceeds supported numeric precision.');
    return number.toFixed(16);
};
const negate=value=>String(value).startsWith('-')?String(value).slice(1):'-'+String(value);
const definitions={
    daily:{columns:'build_id,stock_item_id,ingredient_id,location_id,incoming,outgoing,received,used,waste,corrections,used_cost,waste_cost,opening_id',
        add:['incoming','outgoing','received','used','waste','corrections','used_cost','waste_cost'],min:['opening_id']},
    counts:{columns:'build_id,ingredient_id,count_id,previous_count_id,count_at,count_qty,received,theoretical,waste'},
    count_corrections:{columns:'build_id,ingredient_id,count_id,original_id,kind,qty'},
    meals:{columns:'build_id,product_id,name,sold,refunded,net_revenue_cents,known_cost,incomplete_lines,legacy_lines,unallocated_records,unallocated_revenue_cents,excluded_revenue_cents',
        add:['sold','refunded','net_revenue_cents','known_cost','incomplete_lines','legacy_lines','unallocated_records','unallocated_revenue_cents','excluded_revenue_cents']},
    ingredients:{columns:'build_id,product_id,ingredient_id,name,display_unit,qty,known_cost,incomplete',add:['qty','known_cost'],max:['incomplete']},
    events:{columns:'build_id,kind,source_id,source_line_id,invoice_id,product_id,event_at,quantity,net_revenue_cents,known_cost,incomplete'},
    operations:{columns:'build_id,stock_item_id,ingredient_id,kind,source_type,qty,known_cost,uncosted_qty,movement_count',add:['qty','known_cost','uncosted_qty','movement_count']}
};

function* financialRows(fact) {
    if (fact.coverage!=='allocated') {
        yield {table:'meals',values:[0,null,0,0,0,'0',0,0,fact.coverage==='unallocated'?1:0,
            fact.coverage==='unallocated'?fact.net_revenue_cents:0,fact.coverage==='excluded'?fact.net_revenue_cents:0]};
        return;
    }
    const sign=fact.kind==='refund'?-1:1;
    const cost=fact.recipe.reduce((sum,part)=>sum+part.cost_per_portion*fact.quantity*sign,0);
    const incomplete=(fact.recipe.length===0||fact.modified?1:0)+fact.recipe.filter(part=>!part.complete).length;
    yield {table:'meals',values:[fact.product_id,fact.name,fact.kind==='sale'?fact.quantity:0,fact.kind==='refund'?fact.quantity:0,
        fact.net_revenue_cents,decimal(cost),incomplete,fact.legacy?1:0,0,0,0]};
    yield {table:'events',values:[fact.kind,fact.source_id,fact.source_line_id,fact.invoice_id,fact.product_id,fact.at,
        fact.quantity,fact.net_revenue_cents,decimal(cost),fact.incomplete?1:0]};
    for (const part of fact.recipe) yield {table:'ingredients',values:[fact.product_id,part.ingredient_id,part.name,part.display_unit,
        decimal(part.qty_per_portion*fact.quantity*sign),decimal(part.cost_per_portion*fact.quantity*sign),!part.complete||fact.modified?1:0]};
}

async function writeBatch(pool,buildId,rows) {
    if (!Array.isArray(rows) || rows.length>500) throw new Error('A report write contains at most 500 facts.');
    if (!rows.length) return;
    const groups=new Map();
    for (const row of rows) {
        const definition=definitions[row.table];
        if (!definition || row.values.length!==definition.columns.split(',').length-1) throw new Error('Invalid report fact shape.');
        if (!groups.has(row.table)) groups.set(row.table,[]);
        groups.get(row.table).push([buildId,...row.values]);
    }
    const conn=await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const [table,values] of groups) {
            const definition=definitions[table];
            const updates=[...(definition.add||[]).map(column=>`${column}=${column}+VALUES(${column})`),
                ...(definition.max||[]).map(column=>`${column}=GREATEST(${column},VALUES(${column}))`),
                ...(definition.min||[]).map(column=>`${column}=COALESCE(LEAST(${column},VALUES(${column})),${column},VALUES(${column}))`)];
            await conn.query(`INSERT INTO stock_report_${table}(${definition.columns}) VALUES ?${updates.length?' ON DUPLICATE KEY UPDATE '+updates.join(','):''}`,[values]);
        }
        await conn.commit();
    } catch(error) {await conn.rollback();throw error;}
    finally {conn.release();}
}

// Pool queries release their connection before invoking emit. The worker may
// persist/yield there without retaining a source connection or transaction.
async function stream(pool,claim,emit) {
    const financial=await streamFinancialFacts(pool,{businessDate:claim.day,scopeId:claim.scope_id},async fact=>{
        for (const row of financialRows(fact)) await emit(row);
    });
    let after='0',movements=0;
    // Ingredient rows retain their operational/cost meaning. Historical mirrored
    // operations and new attached physical effects share the same source rules,
    // so physical reporting never counts the ingredient activity twice.
    const legacySource="CASE WHEN m.source_type='order' AND m.source_id>0 THEN CONCAT('invoice:',m.source_id) WHEN m.source_type='refund' AND r.invoice_id IS NOT NULL THEN CONCAT('invoice:',r.invoice_id) ELSE CONCAT('operation:',m.id) END";
    while (true) {
        const [rows]=await pool.query(`SELECT CAST(m.id AS CHAR) id,m.ingredient_id,m.kind,m.source_type,m.qty,m.unit_cost,m.occurred_at,
            CAST(m.qty*COALESCE(m.unit_cost,0) AS CHAR) known_cost
            FROM stock_movements m LEFT JOIN refunds r ON m.source_type='refund' AND r.id=m.source_id
            WHERE m.movement_type='ingredient' AND m.business_date=? AND m.id>?
            AND MOD(CONV(LEFT(SHA2(${legacySource},256),8),16,10),32)=?
            ORDER BY m.id LIMIT 100`,[claim.day,after,claim.scope_id]);
        if (!rows.length) break;
        after=rows.at(-1).id;movements+=rows.length;
        for (const row of rows) {
            await emit({table:'operations',values:['0',row.ingredient_id,row.kind,row.source_type,
                row.qty,row.known_cost,row.unit_cost==null?String(row.qty).replace(/^-/,''):'0',1]});
            const used=['usage','reversal'].includes(row.kind);
            await emit({table:'daily',values:['0',row.ingredient_id,'0',0,0,
                row.kind==='receipt'?row.qty:0,used?negate(row.qty):0,
                row.kind==='waste'?negate(row.qty):0,row.kind==='correction'?row.qty:0,
                used?negate(row.known_cost):0,row.kind==='waste'?negate(row.known_cost):0,
                row.kind==='count'?row.id:null]});
            if(row.kind==='count')await streamCountInterval(pool,row,emit);
        }
    }
    after='0';
    // Migrated ingredient rows have no operation_id, so colliding historical IDs
    // are excluded by the join. New attached rows use the shared ID allocator.
    while (true) {
        const [rows]=await pool.query(`SELECT CAST(m.id AS CHAR) id,CAST(m.stock_item_id AS CHAR) stock_item_id,CAST(COALESCE(m.location_id,0) AS CHAR) location_id,li.id physical_ingredient_id,o.kind,m.quantity,
            EXISTS(SELECT 1 FROM stock_operation_sources s WHERE s.operation_id=m.operation_id
                AND s.source_kind IN ('ingredient_cutover','ingredient_usage','ingredient_manual','ingredient_correction')) mirrored
            FROM stock_movements m JOIN stock_operations o ON o.id=m.operation_id
            LEFT JOIN ingredients li ON li.stock_item_id=m.stock_item_id
            WHERE m.business_date=? AND m.id>?
            AND MOD(CONV(LEFT(SHA2(CONCAT('operation:',m.operation_id),256),8),16,10),32)=?
            ORDER BY m.id LIMIT 100`,[claim.day,after,claim.scope_id]);
        if (!rows.length) break;
        after=rows.at(-1).id;movements+=rows.length;
        for (const row of rows) {
            if(!row.mirrored)await emit({table:'operations',values:[row.stock_item_id,0,row.kind,'stock',row.quantity,'0',String(row.quantity).replace(/^-/,''),1]});
            if(!row.mirrored&&row.physical_ingredient_id){
                await emit({table:'daily',values:['0',row.physical_ingredient_id,'0',0,0,
                    row.kind==='receipt'?row.quantity:0,['issue','return'].includes(row.kind)?negate(row.quantity):0,
                    row.kind==='waste'?negate(row.quantity):0,0,0,0,null]});
            }
            await emit({table:'daily',values:[row.stock_item_id,0,row.location_id,
                Number(row.quantity)>0?row.quantity:0,Number(row.quantity)<0?String(row.quantity).replace(/^-/,''):0,
                0,0,0,0,0,0,null]});
        }
    }
    return {...financial,movements};
}

// Each immutable movement belongs to at most one completed count interval.
// Retain correction origins: summing interval totals alone would incorrectly
// apply a correction whose original movement predates the requested opening.
async function streamCountInterval(pool,count,emit) {
    const [[previous]]=await pool.query(`SELECT CAST(id AS CHAR) id FROM stock_movements
        FORCE INDEX (idx_im_ingredient_kind_id) WHERE movement_type='ingredient' AND ingredient_id=? AND kind='count' AND id<?
        ORDER BY id DESC LIMIT 1`,[count.ingredient_id,count.id]);
    let after=previous?.id||'0',received=0n,theoretical=0n,waste=0n;
    const {parse}=require('./stockQuantity');
    const format=value=>{const sign=value<0n?'-':'';const n=value<0n?-value:value;return sign+String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0');};
    if(previous)while(true){
        const [rows]=await pool.query(`SELECT CAST(m.id AS CHAR) id,m.kind,CAST(m.qty AS CHAR) qty,
            CAST(m.corrects_movement_id AS CHAR) original_id,original.kind original_kind
            FROM stock_movements m FORCE INDEX (idx_im_balance)
            LEFT JOIN stock_movements original ON original.movement_type='ingredient' AND original.id=m.corrects_movement_id
            WHERE m.movement_type='ingredient' AND m.ingredient_id=? AND m.id>? AND m.id<? ORDER BY m.id LIMIT 100`,[count.ingredient_id,after,count.id]);
        if(!rows.length)break;after=rows.at(-1).id;
        for(const row of rows){
            const qty=parse(row.qty);
            if(row.kind==='receipt')received+=qty;
            else if(['usage','reversal'].includes(row.kind))theoretical-=qty;
            else if(row.kind==='waste')waste-=qty;
            else if(row.kind==='correction'&&['receipt','waste'].includes(row.original_kind))
                await emit({table:'count_corrections',values:[count.ingredient_id,count.id,row.original_id,row.original_kind,row.qty]});
        }
    }
    await emit({table:'counts',values:[count.ingredient_id,count.id,previous?.id||'0',count.occurred_at,count.qty,format(received),format(theoretical),format(waste)]});
}

async function cleanup(pool) {
    const [[candidate]]=await pool.query(`SELECT CAST(b.id AS CHAR) id FROM stock_report_builds b
        WHERE b.state IN ('abandoned','obsolete') AND NOT EXISTS
        (SELECT 1 FROM stock_report_dirty d WHERE d.active_build_id=b.id OR d.published_build_id=b.id)
        ORDER BY b.id LIMIT 1`);
    if(!candidate)return {rows:0,builds:0};
    return await withWorkerLease(pool,()=>cleanupBuild(pool,candidate.id)) || {rows:0,builds:0};
}

async function cleanupBuild(pool,buildId) {
    const conn=await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[build]]=await conn.query('SELECT state FROM stock_report_builds WHERE id=? FOR UPDATE',[buildId]);
        if(!build||!['abandoned','obsolete'].includes(build.state)){await conn.commit();return {rows:0,builds:0};}
        // These states never become active again. Use a non-locking pointer
        // check to avoid reversing publication's dirty-row -> build lock order.
        const [[visible]]=await conn.query('SELECT 1 FROM stock_report_dirty WHERE active_build_id=? OR published_build_id=? LIMIT 1',[buildId,buildId]);
        if(visible){await conn.commit();return {rows:0,builds:0};}
        let remaining=500;
        for(const table of Object.keys(definitions)) {
            const [deleted]=await conn.query(`DELETE FROM stock_report_${table} WHERE build_id=? LIMIT ?`,[buildId,remaining]);
            remaining-=deleted.affectedRows;
            if(!remaining)break;
        }
        let builds=0;
        // Delete the header only after all child tables were drained. Do not
        // rely on a cascading delete that could remove a huge build in one TX.
        if(remaining){const [deleted]=await conn.query('DELETE FROM stock_report_builds WHERE id=?',[buildId]);builds=deleted.affectedRows;}
        await conn.commit();return {rows:500-remaining,builds};
    } catch(error){await conn.rollback();throw error;}
    finally{conn.release();}
}

// One snapshot reads at most 32 published rows per identity/location. It never
// visits source movement history. Missing publication is explicit, not zero stock.
async function readDaily(conn,{day,ids,kind,locationId=null}) {
    if(!['ingredient','stock'].includes(kind)||!Array.isArray(ids)||ids.length>100)throw new Error('Invalid daily stock projection request.');
    if(!ids.length)return {rows:[],freshness:{state:'current',source:'published'}};
    const identity=kind==='ingredient'?'ingredient_id':'stock_item_id';
    const columns=['incoming','outgoing','received','used','waste','corrections','used_cost','waste_cost'];
    const [rows]=await conn.query(`SELECT wanted.id,${columns.map(c=>`COALESCE(f.${c},0) ${c}`).join(',')},f.opening_id,
        meta.total,meta.published,meta.pending,meta.as_of,meta.incomplete
        FROM (${ids.map(()=> 'SELECT ? id').join(' UNION ALL ')}) wanted
        LEFT JOIN (
            SELECT f.${identity} id,${columns.map(c=>`SUM(f.${c}) ${c}`).join(',')},MIN(f.opening_id) opening_id
            FROM stock_report_dirty d JOIN stock_report_daily f ON f.build_id=d.published_build_id
            WHERE d.day=? AND f.${identity} IN (?) ${locationId?'AND f.location_id=?':''}
            GROUP BY f.${identity}
        ) f ON f.id=wanted.id CROSS JOIN (
            SELECT COUNT(*) total,COUNT(published_build_id) published,COALESCE(SUM(pending),0) pending,MIN(as_of) as_of,
                EXISTS(SELECT 1 FROM stock_report_backfill WHERE complete=0) incomplete
            FROM stock_report_dirty WHERE day=?
        ) meta`,[...ids,day,ids,...(locationId?[locationId]:[]),day]);
    const meta=rows[0];
    const state=meta.incomplete||Number(meta.published)<Number(meta.total)?'rebuilding':Number(meta.pending)?'stale':'current';
    return {rows:rows.map(({total,published,pending,as_of,incomplete,...row})=>row),freshness:{state,as_of:meta.as_of,source:'published'}};
}

module.exports={financialRows,writeBatch,stream,cleanup,readDaily};

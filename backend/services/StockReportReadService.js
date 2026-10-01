'use strict';

const { createHash } = require('node:crypto');
const { parseDailyReportPeriod } = require('./dailyReportPeriod');
const { hasSources, coverageIncomplete } = require('./StockReportGenerationService');
const { roundMoney } = require('./PosCalculator');
const L = require('./RecipeLedgerService');

const emptyTotals = {
    net_revenue: 0, known_cost: 0, estimated_margin: 0, food_cost_pct: null, incomplete: false,
    complete_meals: 0, total_meals: 0, legacy_lines: 0, unallocated_records: 0,
    unallocated_revenue: 0, excluded_revenue: 0
};

function cap(rows) {
    return { rows: rows.slice(0, 50), has_more: rows.length > 50 };
}

function freshnessMeta(state, stats) {
    return {
        state,
        as_of: stats.as_of || null,
        published_partitions: Number(stats.published || 0),
        pending_partitions: Number(stats.pending || 0),
        generation: stats.generation == null ? null : String(stats.generation),
        source: 'published'
    };
}

async function dirtyStats(conn, period) {
    // The range is limited to 366 days and 32 scopes/day. Hash exact strings
    // in canonical order; MAX(generation) misses changes to other partitions.
    const [vector] = await conn.query(`SELECT DATE_FORMAT(day,'%Y-%m-%d') day,scope_id,pending,as_of,
        CAST(published_build_id AS CHAR) build_id,CAST(published_generation AS CHAR) generation
        FROM stock_report_dirty WHERE day BETWEEN ? AND ? ORDER BY day,scope_id`,
        [period.start_date,period.end_date]);
    const identity = createHash('sha256');
    const buildIds = new Set();
    let pending = 0, published = 0, asOf = null;
    for (const part of vector) {
        identity.update(JSON.stringify([part.day,part.scope_id,part.build_id,part.generation])+'\n');
        pending += Number(part.pending) === 1 ? 1 : 0;
        if (part.build_id !== null) { published++; buildIds.add(part.build_id); }
        if (part.as_of !== null && (asOf === null || part.as_of < asOf)) asOf = part.as_of;
    }
    return {
        total: vector.length, pending, published, buildIds: [...buildIds],
        generation: vector.length ? identity.digest('hex') : null,
        as_of: asOf
    };
}

function moneyFromCents(cents) {
    return roundMoney(Number(cents || 0) / 100);
}

async function publishedCountComparisons(conn,buildIds,{after,q,limit}) {
    const [intervals]=await conn.query(`SELECT c.ingredient_id,i.name,i.display_unit,
        CAST(MIN(c.count_id) AS CHAR) first_id,CAST(MAX(c.count_id) AS CHAR) last_id
        FROM stock_report_counts c JOIN ingredients i ON i.id=c.ingredient_id
        WHERE c.build_id IN (?) AND c.ingredient_id>? AND i.name LIKE ? ESCAPE '='
        GROUP BY c.ingredient_id,i.name,i.display_unit HAVING COUNT(*)>=2 ORDER BY c.ingredient_id LIMIT ?`,
        [buildIds,after,'%'+q.replace(/[=%_]/g,char=>'='+char)+'%',limit]);
    if(!intervals.length)return [];
    // A backdated intermediate count can sit outside the selected business
    // dates. Include its published interval by immutable count ID, not day.
    const where=intervals.map(()=>'(c.ingredient_id=? AND c.count_id>=? AND c.count_id<=?)').join(' OR ');
    const args=intervals.flatMap(row=>[row.ingredient_id,row.first_id,row.last_id]);
    const firstCase='CASE c.ingredient_id '+intervals.map(()=> 'WHEN ? THEN ?').join(' ')+' END';
    const firstArgs=intervals.flatMap(row=>[row.ingredient_id,row.first_id]);
    const [totals]=await conn.query(`SELECT c.ingredient_id,
        SUM(CASE WHEN c.count_id>${firstCase} THEN c.count_id-c.previous_count_id ELSE 0 END) covered_span,
        SUM(CASE WHEN c.count_id>${firstCase} THEN c.received ELSE 0 END) received,
        SUM(CASE WHEN c.count_id>${firstCase} THEN c.theoretical ELSE 0 END) theoretical,
        SUM(CASE WHEN c.count_id>${firstCase} THEN c.waste ELSE 0 END) waste
        FROM stock_report_counts c JOIN stock_report_dirty d ON d.published_build_id=c.build_id
        WHERE ${where} GROUP BY c.ingredient_id`,[...firstArgs,...firstArgs,...firstArgs,...firstArgs,...args]);
    const [corrections]=await conn.query(`SELECT c.ingredient_id,
        SUM(CASE WHEN c.kind='receipt' THEN c.qty ELSE 0 END) received,
        -SUM(CASE WHEN c.kind='waste' THEN c.qty ELSE 0 END) waste
        FROM stock_report_count_corrections c JOIN stock_report_dirty d ON d.published_build_id=c.build_id
        WHERE (${where}) AND c.count_id>${firstCase} AND c.original_id>${firstCase}
        GROUP BY c.ingredient_id`,[...args,...firstArgs,...firstArgs]);
    const [endpoints]=await conn.query(`SELECT c.ingredient_id,CAST(c.count_id AS CHAR) count_id,c.count_qty,c.count_at
        FROM stock_report_counts c JOIN stock_report_dirty d ON d.published_build_id=c.build_id
        WHERE (c.ingredient_id,c.count_id) IN (?)`,[intervals.flatMap(row=>[[row.ingredient_id,row.first_id],[row.ingredient_id,row.last_id]])]);
    const sums=new Map(totals.map(row=>[Number(row.ingredient_id),row])),adjustments=new Map(corrections.map(row=>[Number(row.ingredient_id),row]));
    const ends=new Map(endpoints.map(row=>[row.ingredient_id+'/'+row.count_id,row]));
    return intervals.map(row=>{
        const id=Number(row.ingredient_id),sum=sums.get(id),adjustment=adjustments.get(id),a=ends.get(id+'/'+row.first_id),b=ends.get(id+'/'+row.last_id);
        // Positive interval widths telescope exactly. Any unpublished gap
        // prevents a certified comparison instead of being silently zeroed.
        const complete=Boolean(a&&b&&sum&&BigInt(sum.covered_span||0)===BigInt(row.last_id)-BigInt(row.first_id));
        const received=complete?L.roundSix(Number(sum.received)+Number(adjustment?.received||0)):null;
        const waste=complete?L.roundSix(Number(sum.waste)+Number(adjustment?.waste||0)):null;
        const actual=complete?L.roundSix(Number(a.count_qty)+received-Number(b.count_qty)):null;
        return {ingredient_id:id,name:row.name,display_unit:row.display_unit,from_at:a?.count_at,to_at:b?.count_at,
            opening_qty:a?.count_qty,counted_qty:b?.count_qty,received,theoretical:complete?L.roundSix(sum.theoretical):null,waste,
            actual_usage:actual,unexplained:complete?L.roundSix(actual-Number(sum.theoretical)-waste):null,complete};
    });
}

async function getPublishedAnalysis(conn, { startDate, endDate, productId, ingredientId, eventCursor, partsCursor, view, cursor, q = '' } = {}) {
    if (view !== undefined && !['meal','ingredient','preparation','counts'].includes(view)) throw Object.assign(new Error('Invalid report view.'),{statusCode:400});
    if (typeof q !== 'string' || q.length>100) throw Object.assign(new Error('Invalid report search.'),{statusCode:400});
    q=q.trim();
    const period = parseDailyReportPeriod({ startDate, endDate });
    const sources = await hasSources(conn, period);
    const stats = await dirtyStats(conn, period);
    const missingCoverage = sources && await coverageIncomplete(conn, period);
    let state = 'current';
    if (sources && stats.total === 0) state = 'unavailable';
    else if (stats.published === 0 && (stats.pending > 0 || missingCoverage)) state = 'rebuilding';
    else if (missingCoverage || stats.pending > 0) state = stats.published > 0 ? 'stale' : 'rebuilding';
    else if (stats.published > 0 || !sources) state = 'current';
    else state = 'unavailable';

    const freshness = freshnessMeta(state, stats);
    let after=0;
    if (cursor) {
        let decoded;
        try {
            if(typeof cursor!=='string'||cursor.length>2048||!view)throw new Error();
            decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
            if(decoded.v!==1||decoded.view!==view||decoded.q!==q||decoded.product!==(productId??null)||decoded.ingredient!==(ingredientId??null)||decoded.from!==period.start_date||decoded.to!==period.end_date||!Number.isSafeInteger(decoded.id)||decoded.id<=0)throw new Error();
        } catch { throw Object.assign(new Error('Invalid report cursor.'),{statusCode:400}); }
        if(decoded.g!==freshness.generation)throw Object.assign(new Error('Report changed. Reload the first page.'),{statusCode:409});
        after=decoded.id;
    }
    const selected=name=>view===undefined||view===name;
    const searchPattern='%'+q.replace(/[=%_]/g,char=>'='+char)+'%';
    const detailToken=(type,key)=>Buffer.from(JSON.stringify({type,key,g:freshness.generation,product:productId,from:period.start_date,to:period.end_date})).toString('base64url');
    function detailKey(raw,type) {
        if(!raw)return null;
        let value;
        try {
            if(typeof raw!=='string'||raw.length>2048||!productId)throw new Error();
            value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
            if(value.type!==type||value.product!==productId||value.from!==period.start_date||value.to!==period.end_date)throw new Error();
            if(type==='parts'&&(!Number.isSafeInteger(value.key)||value.key<1))throw new Error();
            if(type==='events'&&(!Array.isArray(value.key)||value.key.length!==5||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.key[0])||!['sale','refund'].includes(value.key[2])||![1,3,4].every(n=>typeof value.key[n]==='string'&&/^[1-9]\d{0,19}$/.test(value.key[n]))))throw new Error();
        }catch{throw Object.assign(new Error('Invalid report cursor.'),{statusCode:400});}
        if(value.g!==freshness.generation)throw Object.assign(new Error('Report changed. Reload the first page.'),{statusCode:409});
        return value.key;
    }
    const eventAfter=detailKey(eventCursor,'events'),partsAfter=detailKey(partsCursor,'parts');
    if (state === 'unavailable' || state === 'rebuilding') {
        return {
            period, meals: [], ingredients: [], operations: [], comparisons: [], events: [],
            events_has_more: false, meals_has_more: false, ingredients_has_more: false,
            operations_has_more: false, comparisons_has_more: false,
            totals: null, freshness, next_cursor:null
        };
    }

    const buildIds = stats.buildIds;
    if (!buildIds.length) {
        return {
            period, meals: [], ingredients: [], operations: [], comparisons: [], events: [],
            events_has_more: false, meals_has_more: false, ingredients_has_more: false,
            operations_has_more: false, comparisons_has_more: false,
            totals: emptyTotals, freshness, next_cursor:null
        };
    }

    const [mealTotals] = await conn.query(`SELECT
        SUM(CASE WHEN product_id<>0 THEN net_revenue_cents ELSE 0 END) net_revenue_cents,
        SUM(CASE WHEN product_id<>0 THEN known_cost ELSE 0 END) known_cost,
        SUM(CASE WHEN product_id<>0 AND incomplete_lines=0 THEN 1 ELSE 0 END) complete_meals,
        SUM(CASE WHEN product_id<>0 THEN 1 ELSE 0 END) total_meals,
        SUM(CASE WHEN product_id<>0 AND incomplete_lines>0 THEN 1 ELSE 0 END) incomplete_meals,
        SUM(unallocated_records) unallocated_records,
        SUM(unallocated_revenue_cents) unallocated_revenue_cents,
        SUM(excluded_revenue_cents) excluded_revenue_cents,
        SUM(legacy_lines) legacy_lines
        FROM (
            SELECT product_id, SUM(net_revenue_cents) net_revenue_cents, SUM(known_cost) known_cost,
                SUM(incomplete_lines) incomplete_lines, SUM(legacy_lines) legacy_lines,
                SUM(unallocated_records) unallocated_records,
                SUM(unallocated_revenue_cents) unallocated_revenue_cents,
                SUM(excluded_revenue_cents) excluded_revenue_cents
            FROM stock_report_meals WHERE build_id IN (?) GROUP BY product_id
        ) meals`, [buildIds]);
    const totalsRow = mealTotals[0] || {};
    const [mealRows] = selected('meal') ? await conn.query(`SELECT product_id, MAX(name) name, SUM(sold) sold, SUM(refunded) refunded,
        SUM(net_revenue_cents) net_revenue_cents, SUM(known_cost) known_cost, SUM(incomplete_lines) incomplete_lines,
        SUM(legacy_lines) legacy_lines, SUM(unallocated_records) unallocated_records,
        SUM(unallocated_revenue_cents) unallocated_revenue_cents, SUM(excluded_revenue_cents) excluded_revenue_cents
        FROM stock_report_meals m WHERE build_id IN (?) AND product_id>?${productId?' AND product_id=?':''}
        ${ingredientId?'AND EXISTS (SELECT 1 FROM stock_report_ingredients part WHERE part.build_id IN (?) AND part.product_id=m.product_id AND part.ingredient_id=?)':''}
        GROUP BY product_id HAVING MAX(name) LIKE ? ESCAPE '=' ORDER BY product_id LIMIT 51`, [buildIds,after,...(productId?[productId]:[]),...(ingredientId?[buildIds,ingredientId]:[]),searchPattern]) : [[]];
    const mealsPage = cap(mealRows);
    const unallocated_records = Number(totalsRow.unallocated_records || 0);
    const unallocated_revenue = moneyFromCents(totalsRow.unallocated_revenue_cents);
    const excluded_revenue = moneyFromCents(totalsRow.excluded_revenue_cents);
    const legacy_lines = Number(totalsRow.legacy_lines || 0);

    const [ingredientRows] = selected('ingredient') ? await conn.query(`SELECT ingredient_id, MAX(name) name, MAX(display_unit) display_unit,
        SUM(qty) qty, SUM(known_cost) known_cost, MAX(incomplete) incomplete
        FROM stock_report_ingredients WHERE build_id IN (?) AND ingredient_id>?
        GROUP BY ingredient_id HAVING MAX(name) LIKE ? ESCAPE '=' ORDER BY ingredient_id LIMIT 51`, [buildIds,after,searchPattern]) : [[]];
    const ingredientsPage = cap(ingredientRows);

    const [operationRows] = selected('preparation') ? await conn.query(`SELECT o.ingredient_id, MAX(i.name) name, MAX(i.display_unit) display_unit,
        -SUM(CASE WHEN o.kind IN ('usage','reversal') THEN o.qty ELSE 0 END) qty,
        -SUM(CASE WHEN o.kind IN ('usage','reversal') THEN o.known_cost ELSE 0 END) known_cost,
        -SUM(CASE WHEN o.source_type='redemption' THEN o.qty ELSE 0 END) redemption_qty,
        SUM(CASE WHEN o.kind IN ('usage','reversal') THEN o.uncosted_qty ELSE 0 END) missing
        FROM stock_report_operations o JOIN ingredients i ON i.id=o.ingredient_id
        WHERE o.build_id IN (?) AND o.ingredient_id>?
        GROUP BY o.ingredient_id HAVING MAX(i.name) LIKE ? ESCAPE '=' ORDER BY o.ingredient_id LIMIT 51`, [buildIds,after,searchPattern]) : [[]];
    const operationsPage = cap(operationRows);

    const meals = mealsPage.rows.map(row => {
        const net_revenue = moneyFromCents(row.net_revenue_cents);
        const known_cost = L.roundEight(row.known_cost);
        const incomplete_lines = Number(row.incomplete_lines || 0);
        return {
            product_id: Number(row.product_id), name: row.name, sold: Number(row.sold), refunded: Number(row.refunded),
            net_revenue, known_cost, incomplete_lines,
            estimated_margin: incomplete_lines ? null : roundMoney(net_revenue - known_cost),
            ingredients: []
        };
    });

    const ingredients = ingredientsPage.rows.map(row => ({
        ingredient_id: Number(row.ingredient_id), name: row.name, display_unit: row.display_unit,
        qty: L.roundSix(row.qty), known_cost: L.roundEight(row.known_cost), incomplete: Boolean(Number(row.incomplete))
    }));

    const operations = operationsPage.rows.map(row => ({
        ingredient_id: Number(row.ingredient_id), name: row.name, display_unit: row.display_unit,
        qty: L.roundSix(row.qty), known_cost: L.roundEight(row.known_cost),
        redemption_qty: L.roundSix(row.redemption_qty), incomplete: Number(row.missing) > 0
    }));

    const netRevenue = moneyFromCents(totalsRow.net_revenue_cents);
    const knownCost = L.roundEight(totalsRow.known_cost);
    const incomplete = Number(totalsRow.incomplete_meals || 0) > 0 || unallocated_records > 0;
    const complete_meals = Number(totalsRow.complete_meals || 0);

    let events = [];
    let events_has_more = false;
    let events_next_cursor=null,parts_next_cursor=null;
    if (productId) {
        const [eventRows] = await conn.query(`SELECT kind, CAST(source_line_id AS CHAR) source_line_id, invoice_id,
            CAST(source_id AS CHAR) source_id,CAST(build_id AS CHAR) build_id,DATE_FORMAT(event_at,'%Y-%m-%d %H:%i:%s') event_key,
            event_at, quantity, net_revenue_cents, known_cost, incomplete
            FROM stock_report_events WHERE build_id IN (?) AND product_id=?
            ${eventAfter?'AND (event_at,source_line_id,kind,source_id,build_id)<(?,?,?,?,?)':''}
            ORDER BY event_at DESC, source_line_id DESC,kind DESC,source_id DESC,build_id DESC LIMIT 51`,
            [buildIds, productId,...(eventAfter||[])]);
        events_has_more = eventRows.length > 50;
        if(events_has_more){const last=eventRows[49];events_next_cursor=detailToken('events',[last.event_key,last.source_line_id,last.kind,last.source_id,last.build_id]);}
        events = eventRows.slice(0, 50).map(row => ({
            id: `${row.kind}:${row.source_id}:${row.source_line_id}`, at: row.event_at, kind: row.kind,
            invoice_id: Number(row.invoice_id), quantity: Number(row.quantity),
            net_revenue: moneyFromCents(row.net_revenue_cents), known_cost: L.roundEight(row.known_cost),
            incomplete: Boolean(Number(row.incomplete))
        }));
        const [parts] = await conn.query(`SELECT ingredient_id, MAX(name) name, MAX(display_unit) display_unit,
            SUM(qty) qty, SUM(known_cost) known_cost, MAX(incomplete) incomplete
            FROM stock_report_ingredients WHERE build_id IN (?) AND product_id=? AND ingredient_id>?
            GROUP BY ingredient_id ORDER BY ingredient_id LIMIT 51`, [buildIds, productId,partsAfter||0]);
        if(parts.length>50)parts_next_cursor=detailToken('parts',Number(parts[49].ingredient_id));
        const meal = meals.find(row => row.product_id === Number(productId));
        if (meal) meal.ingredients = parts.slice(0,50).map(row => ({
            ingredient_id: Number(row.ingredient_id), name: row.name, display_unit: row.display_unit,
            qty: L.roundSix(row.qty), known_cost: L.roundEight(row.known_cost), incomplete: Boolean(Number(row.incomplete))
        }));
    }

    const allComparisons = selected('counts') ? await publishedCountComparisons(conn, buildIds,{after,q,limit:51}) : [];
    const comparisonsPage = cap(allComparisons);
    if(allComparisons.some(row=>!row.complete))freshness.state='stale';
    const list={meal:mealsPage,ingredient:ingredientsPage,preparation:operationsPage,counts:comparisonsPage}[view];
    const last=list?.rows.at(-1);
    const next_cursor=list?.has_more ? Buffer.from(JSON.stringify({v:1,view,q,product:productId??null,ingredient:ingredientId??null,from:period.start_date,to:period.end_date,g:freshness.generation,id:Number(last.product_id??last.ingredient_id)})).toString('base64url') : null;

    return {
        period, meals, ingredients, operations, comparisons: comparisonsPage.rows, events, events_has_more,events_next_cursor,parts_next_cursor,
        meals_has_more: mealsPage.has_more, ingredients_has_more: ingredientsPage.has_more,
        operations_has_more: operationsPage.has_more, comparisons_has_more: comparisonsPage.has_more,
        totals: {
            net_revenue: netRevenue, known_cost: knownCost,
            estimated_margin: incomplete ? null : roundMoney(netRevenue - knownCost),
            food_cost_pct: incomplete || netRevenue <= 0 ? null : knownCost / netRevenue,
            incomplete, complete_meals, total_meals: Number(totalsRow.total_meals || 0),
            legacy_lines, unallocated_records, unallocated_revenue, excluded_revenue
        },
        freshness, next_cursor
    };
}

module.exports = { getPublishedAnalysis };

const { isValidDateOnly, parseDailyReportPeriod } = require('./dailyReportPeriod');
const { paidOrderRangeWhere } = require('./financialSql');
const { calculateLineSubtotal, roundMoney } = require('./PosCalculator');
const { allocateCents, moneyToCents } = require('./SplitMoneyAllocator');
const L = require('./RecipeLedgerService');

const chunks = (items, size = 800) => Array.from({length: Math.ceil(items.length / size)}, (_, i) => items.slice(i * size, (i + 1) * size));
const placeholders = items => items.map(() => '?').join(',');

// Use the POS money allocator, rather than a second SQL approximation of tax,
// modifiers and split-check discounts. Invoices are read in bounded batches.
function allocateSaleRevenue(order, lines) {
    const weights = lines.map(line => Math.max(0, calculateLineSubtotal({
        price: Number(line.price_at_sale), qty: Number(line.quantity), discountType: line.discount_type,
        discountValue: Number(line.discount_value), modifier_surcharge: line.modifier_surcharge,
        modifier_tax_amount: line.modifier_tax_amount, note: line.note,
    }, Number(line.tax_rate), Boolean(Number(order.tax_inclusive_at_sale)), {
        taxRegistrationType: order.tax_registration_type_at_sale || 'sales_tax',
        taxExempt: Boolean(Number(order.tax_exempt_at_sale)), pricesAlreadyExempt: Boolean(Number(order.tax_exempt_at_sale)),
    })));
    return allocateCents(moneyToCents(Number(order.total) - Number(order.tax)), weights).map(value => value / 100);
}

async function loadRecipeCosts(conn, keys, current = false) {
    const result = new Map();
    for (const batch of chunks([...new Set(keys.filter(Boolean))])) {
        const [rows] = await conn.query(`SELECT m.line_key,m.ingredient_id,MAX(i.name) AS name,MAX(i.display_unit) AS display_unit,
          SUM(m.product_qty) AS portions, -SUM(m.qty) AS qty,
          -SUM(m.qty*COALESCE(m.unit_cost,0)) AS cost,
          SUM(CASE WHEN m.unit_cost IS NULL THEN ABS(m.qty) ELSE 0 END) AS uncosted_qty
          FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id
          WHERE m.movement_type='ingredient' AND m.line_key IN (${placeholders(batch)}) AND m.source_type='order' AND m.kind IN ('usage','reversal')
          GROUP BY m.line_key,m.ingredient_id${current ? ' FOR UPDATE' : ''}`,batch);
        for (const row of rows) {
            if (!result.has(row.line_key)) result.set(row.line_key,[]);
            if (Number(row.portions)>0) result.get(row.line_key).push({...row,
                ingredient_id:Number(row.ingredient_id), qty_per_portion:Number(row.qty)/Number(row.portions),
                cost_per_portion:Number(row.cost)/Number(row.portions), complete:Number(row.uncosted_qty)===0,
            });
        }
    }
    return result;
}

function recordedRecipe(line, fallback) {
    if (line.recipe_cost_snapshot == null) return fallback;
    return typeof line.recipe_cost_snapshot === 'string' ? JSON.parse(line.recipe_cost_snapshot) : line.recipe_cost_snapshot;
}

// The same preparation key can span several split invoices. Freeze each paid
// line inside checkout's transaction; later additions must not reprice it.
async function captureInvoiceCosts(conn, invoiceId) {
    const [lines] = await conn.query('SELECT id,recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL AND recipe_cost_snapshot IS NULL FOR UPDATE',[invoiceId]);
    if (!lines.length) return;
    const {recordedKeys}=await L.lockLineIngredients(conn,lines.map(line=>line.recipe_line_key));
    const costs = await loadRecipeCosts(conn,recordedKeys,true);
    const params=[];
    const cases=lines.map(line=>{
        params.push(line.id,JSON.stringify((costs.get(line.recipe_line_key)||[]).map(({ingredient_id,name,display_unit,qty_per_portion,cost_per_portion,complete})=>({ingredient_id,name,display_unit,qty_per_portion,cost_per_portion,complete}))));
        return 'WHEN ? THEN ?';
    });
    await conn.query(`UPDATE order_items SET recipe_cost_snapshot=CASE id ${cases.join(' ')} END WHERE invoice_id=? AND id IN (${placeholders(lines)}) AND recipe_cost_snapshot IS NULL`,[...params,invoiceId,...lines.map(line=>line.id)]);
}

// Source traversal is shared by the reference report and the rebuild worker.
// Awaiting each consumer provides backpressure; no connection is reserved by
// this helper when the caller passes the pool. Publication generations provide
// the consistency check across its separate query snapshots.
async function readFinancialLines(conn,{period,batchSize=200,scopeId=null},addLine,onUnallocated) {
    const range=[period.business_start_at,period.business_end_at];
    const counts={invoices:0,refunds:0};
    let cursor=0;
    while (true) {
        const [orders]=await conn.query(`SELECT o.* FROM orders o WHERE ${paidOrderRangeWhere('o')} AND o.invoice_id>? ${scopeId == null ? '' : "AND MOD(CONV(LEFT(SHA2(CONCAT('invoice:',o.invoice_id),256),8),16,10),32)=?"} ORDER BY o.invoice_id LIMIT ${batchSize}`,[...range,...range,cursor,...(scopeId == null ? [] : [scopeId])]);
        if (!orders.length) break;
        counts.invoices += orders.length;
        cursor=Number(orders.at(-1).invoice_id);
        // At 300k lines MariaDB can choose only the NULL-parent prefix of
        // this index. Force the existing composite index so sparse invoice
        // batches use both key parts rather than scanning the parent prefix.
        const [lines]=await conn.query(`SELECT * FROM order_items FORCE INDEX (idx_order_items_parent_invoice) WHERE invoice_id IN (${placeholders(orders)}) AND parent_item_id IS NULL ORDER BY invoice_id,id`,orders.map(o=>o.invoice_id));
        const costs=await loadRecipeCosts(conn,lines.filter(line=>line.recipe_cost_snapshot==null).map(line=>line.recipe_line_key));
        const byInvoice=new Map();
        for (const line of lines) { if (!byInvoice.has(line.invoice_id)) byInvoice.set(line.invoice_id,[]); byInvoice.get(line.invoice_id).push(line); }
        for (const order of orders) {
            const items=byInvoice.get(order.invoice_id)||[];
            if (!items.length) { await onUnallocated({kind:'sale',invoice_id:Number(order.invoice_id),source_id:Number(order.invoice_id),at:order.invoice_issued_at||order.created_at,net_revenue_cents:moneyToCents(Number(order.total)-Number(order.tax))}); continue; }
            const amounts=allocateSaleRevenue(order,items);
            for (let i=0;i<items.length;i++) {
                const line=items[i];
                await addLine({...line,event_at:order.invoice_issued_at||order.created_at,event_id:`sale:${line.id}`},amounts[i],Number(line.quantity),recordedRecipe(line,costs.get(line.recipe_line_key)));
            }
        }
    }
    cursor=0;
    while (true) {
        const [refunds]=await conn.query(`SELECT r.* FROM refunds r WHERE r.kind='refund' AND r.created_at>=? AND r.created_at<? AND r.id>? ${scopeId == null ? '' : "AND MOD(CONV(LEFT(SHA2(CONCAT('invoice:',r.invoice_id),256),8),16,10),32)=?"} ORDER BY r.id LIMIT ${batchSize}`,[...range,cursor,...(scopeId == null ? [] : [scopeId])]);
        if (!refunds.length) break;
        counts.refunds += refunds.length;
        cursor=Number(refunds.at(-1).id);
        const ids=refunds.map(row=>row.id);
        const [lines]=await conn.query(`SELECT ri.*,oi.recipe_line_key,oi.recipe_cost_snapshot,oi.selected_modifiers FROM refund_items ri LEFT JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.refund_id IN (${placeholders(ids)}) ORDER BY ri.refund_id,ri.id`,ids);
        const [restored]=await conn.query(`SELECT m.source_id,m.line_key,m.ingredient_id,MAX(i.name) name,MAX(i.display_unit) display_unit,
          SUM(m.qty) qty,SUM(m.qty*COALESCE(m.unit_cost,0)) cost,SUM(m.unit_cost IS NULL AND m.qty<>0) missing
          FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id
          WHERE m.movement_type='ingredient' AND m.source_type='refund' AND m.source_id IN (${placeholders(ids)}) AND m.kind='reversal'
          GROUP BY m.source_id,m.line_key,m.ingredient_id`,ids);
        const byRefund=new Map(), quantities=new Map();
        for (const line of lines) {
            if (!byRefund.has(line.refund_id)) byRefund.set(line.refund_id,[]); byRefund.get(line.refund_id).push(line);
            const key=`${line.refund_id}:${line.recipe_line_key}`; quantities.set(key,(quantities.get(key)||0)+Number(line.quantity));
        }
        const costs=new Map();
        for (const row of restored) {
            const key=`${row.source_id}:${row.line_key}`, qty=quantities.get(key);
            if (!(qty>0)) continue;
            if (!costs.has(key)) costs.set(key,[]);
            costs.get(key).push({...row,ingredient_id:Number(row.ingredient_id),qty_per_portion:Number(row.qty)/qty,cost_per_portion:Number(row.cost)/qty,complete:Number(row.missing)===0});
        }
        for (const refund of refunds) {
            const items=byRefund.get(refund.id)||[], net=Number(refund.amount_refunded)-Number(refund.tax_refunded);
            if (!items.length) { await onUnallocated({kind:'refund',invoice_id:Number(refund.invoice_id),source_id:Number(refund.id),at:refund.created_at,net_revenue_cents:-moneyToCents(net)}); continue; }
            const amounts=allocateCents(moneyToCents(net),items.map(line=>Math.max(0,Number(line.line_subtotal))));
            for (let i=0;i<items.length;i++) {
                const line=items[i];
                await addLine({...line,invoice_id:refund.invoice_id,event_at:refund.created_at,event_id:`refund:${line.id}`},-amounts[i]/100,Number(line.quantity),recordedRecipe(line,costs.get(`${refund.id}:${line.recipe_line_key}`)),true);
            }
        }
    }
    return counts;
}

async function getAnalysis(conn, {startDate,endDate,productId,detailPage=1} = {}) {
    const period = parseDailyReportPeriod({startDate,endDate});
    const meals = new Map(), ingredients = new Map();
    const costErrors = new WeakMap();
    function addCost(target, value) {
        // Compensate repeated fractional additions before the existing
        // eight-decimal report boundary; do not round every source line.
        const corrected = value - (costErrors.get(target) || 0);
        const next = target.known_cost + corrected;
        costErrors.set(target, (next - target.known_cost) - corrected);
        target.known_cost = next;
    }
    const events=[];
    const page=Math.min(100,Math.max(1,Math.trunc(Number(detailPage))||1));
    let unallocatedRevenue=0, excludedRevenue=0, legacyLines=0, unallocatedRecords=0;
    function addLine(line, revenue, quantity, recipe, refund=false) {
        if (!line.product_id) { excludedRevenue+=revenue; return; }
        const id=Number(line.product_id);
        if (line.recipe_cost_snapshot == null) legacyLines++;
        if (!meals.has(id)) meals.set(id,{product_id:id,name:line.item_name || `#${id}`,sold:0,refunded:0,net_revenue:0,known_cost:0,incomplete_lines:0,ingredients:new Map()});
        const meal=meals.get(id);
        meal[refund?'refunded':'sold']+=quantity; meal.net_revenue+=revenue;
        const modified = line.selected_modifiers && !['[]','{}','null'].includes(String(line.selected_modifiers));
        if (!recipe?.length || modified) meal.incomplete_lines++;
        for (const part of recipe || []) {
            const sign=refund?-1:1, qty=part.qty_per_portion*quantity*sign, cost=part.cost_per_portion*quantity*sign;
            if (!part.complete) meal.incomplete_lines++;
            addCost(meal,cost);
            for (const map of [ingredients,meal.ingredients]) {
                if (!map.has(part.ingredient_id)) map.set(part.ingredient_id,{ingredient_id:part.ingredient_id,name:part.name,display_unit:part.display_unit,qty:0,known_cost:0,incomplete:false});
                const value=map.get(part.ingredient_id); value.qty+=qty; addCost(value,cost); value.incomplete ||= !part.complete || !!modified;
            }
        }
        if (productId && id===Number(productId)) {
            events.push({id:line.event_id,at:line.event_at,kind:refund?'refund':'sale',invoice_id:Number(line.invoice_id),quantity,net_revenue:revenue,
                known_cost:L.roundEight((recipe||[]).reduce((sum,part)=>sum+part.cost_per_portion*quantity*(refund?-1:1),0)),
                incomplete:!recipe?.length||!!modified||recipe.some(part=>!part.complete)});
            events.sort((a,b)=>String(b.at).localeCompare(String(a.at))||Number(b.id.split(':')[1])-Number(a.id.split(':')[1]));
            if(events.length>page*50+1) events.length=page*50+1;
        }
    }
    await readFinancialLines(conn,{period},addLine, fact=>{
        unallocatedRecords++;unallocatedRevenue+=fact.net_revenue_cents/100;
    });
    const [operations]=await conn.query(`SELECT m.ingredient_id,MAX(i.name) name,MAX(i.display_unit) display_unit,
       -SUM(CASE WHEN m.kind IN ('usage','reversal') THEN m.qty ELSE 0 END) AS qty,
       -SUM(CASE WHEN m.kind IN ('usage','reversal') THEN m.qty*COALESCE(m.unit_cost,0) ELSE 0 END) AS known_cost,
       -SUM(CASE WHEN m.source_type='redemption' THEN m.qty ELSE 0 END) AS redemption_qty,
       SUM(m.unit_cost IS NULL AND m.kind IN ('usage','reversal') AND m.qty<>0) missing
       FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id
       WHERE m.movement_type='ingredient' AND m.business_date BETWEEN ? AND ? GROUP BY m.ingredient_id`,[period.start_date,period.end_date]);
    const rows=[...meals.values()].map(meal=>({...meal,net_revenue:roundMoney(meal.net_revenue),known_cost:L.roundEight(meal.known_cost),
        estimated_margin:meal.incomplete_lines?null:roundMoney(meal.net_revenue-meal.known_cost),
        ingredients:[...meal.ingredients.values()].map(row=>({...row,qty:L.roundSix(row.qty),known_cost:L.roundEight(row.known_cost)}))}));
    const netRevenue=roundMoney(rows.reduce((sum,row)=>sum+row.net_revenue,0));
    const cost=L.roundEight(rows.reduce((sum,row)=>sum+row.known_cost,0));
    const incomplete=rows.some(row=>row.incomplete_lines>0)||unallocatedRecords>0;
    const [comparisons]=await conn.query(`
      SELECT i.id ingredient_id,i.name,i.display_unit,a.occurred_at from_at,b.occurred_at to_at,
        a.qty opening_qty,b.qty counted_qty,
        COALESCE(SUM(CASE WHEN m.kind='receipt' THEN m.qty WHEN m.kind='correction' AND original.kind='receipt' AND original.id>a.id THEN m.qty ELSE 0 END),0) received,
        -COALESCE(SUM(CASE WHEN m.kind IN ('usage','reversal') THEN m.qty ELSE 0 END),0) theoretical,
        -COALESCE(SUM(CASE WHEN m.kind='waste' THEN m.qty WHEN m.kind='correction' AND original.kind='waste' AND original.id>a.id THEN m.qty ELSE 0 END),0) waste
      FROM (SELECT ingredient_id,MIN(id) first_id,MAX(id) last_id FROM stock_movements
        WHERE movement_type='ingredient' AND kind='count' AND business_date BETWEEN ? AND ? GROUP BY ingredient_id HAVING COUNT(*)>=2) intervals
      JOIN ingredients i ON i.id=intervals.ingredient_id
      JOIN stock_movements a ON a.movement_type='ingredient' AND a.id=intervals.first_id JOIN stock_movements b ON b.movement_type='ingredient' AND b.id=intervals.last_id
      LEFT JOIN stock_movements m ON m.movement_type='ingredient' AND m.ingredient_id=i.id AND m.id>a.id AND m.id<b.id
      LEFT JOIN stock_movements original ON original.movement_type='ingredient' AND original.id=m.corrects_movement_id
      GROUP BY i.id,i.name,i.display_unit,a.id,b.id,a.qty,b.qty,a.occurred_at,b.occurred_at`,[period.start_date,period.end_date]);
    return {period,meals:rows,events:events.slice((page-1)*50,page*50),events_has_more:events.length>page*50,
        comparisons:comparisons.map(row=>({...row,ingredient_id:Number(row.ingredient_id),actual_usage:L.roundSix(Number(row.opening_qty)+Number(row.received)-Number(row.counted_qty)),
            unexplained:L.roundSix(Number(row.opening_qty)+Number(row.received)-Number(row.counted_qty)-Number(row.theoretical)-Number(row.waste))})),
        ingredients:[...ingredients.values()].map(row=>({...row,qty:L.roundSix(row.qty),known_cost:L.roundEight(row.known_cost)})),
        operations:operations.map(row=>({...row,ingredient_id:Number(row.ingredient_id),qty:L.roundSix(row.qty),known_cost:L.roundEight(row.known_cost),redemption_qty:L.roundSix(row.redemption_qty),incomplete:Number(row.missing)>0})),
        totals:{net_revenue:netRevenue,known_cost:cost,estimated_margin:incomplete?null:roundMoney(netRevenue-cost),
            food_cost_pct:incomplete||netRevenue<=0?null:cost/netRevenue,incomplete,
            complete_meals:rows.filter(row=>!row.incomplete_lines).length,total_meals:rows.length,
            legacy_lines:legacyLines,unallocated_records:unallocatedRecords,unallocated_revenue:roundMoney(unallocatedRevenue),excluded_revenue:roundMoney(excludedRevenue)}};
}

// At most 16 invoices form a source batch. The sink must split
// expanded ingredient facts into <=500-row writes and yield between chunks.
// This does not retain a whole-day meal/event map or execute count comparisons.
async function streamFinancialFacts(conn, {businessDate,scopeId=null}, sink) {
    if (typeof sink !== 'function' || typeof businessDate !== 'string' || !isValidDateOnly(businessDate) ||
        (scopeId !== null && (!Number.isInteger(scopeId) || scopeId<0 || scopeId>=32))) throw new Error('Invalid report fact source.');
    const period=parseDailyReportPeriod({startDate:businessDate,endDate:businessDate});
    return readFinancialLines(conn,{period,batchSize:16,scopeId},async(line,revenue,quantity,recipe,refund=false)=>{
        const modified=line.selected_modifiers && !['[]','{}','null'].includes(String(line.selected_modifiers));
        await sink({kind:refund?'refund':'sale',source_id:Number(refund?line.refund_id:line.invoice_id),source_line_id:Number(line.id),
            invoice_id:Number(line.invoice_id),product_id:line.product_id==null?null:Number(line.product_id),name:line.item_name,
            at:line.event_at,quantity,net_revenue_cents:moneyToCents(revenue),recipe:recipe||[],
            coverage:line.product_id?'allocated':'excluded',legacy:line.recipe_cost_snapshot==null,
            incomplete:!recipe?.length||!!modified||(recipe||[]).some(part=>!part.complete),modified:!!modified});
    },fact=>sink({...fact,source_line_id:0,product_id:null,name:null,quantity:0,recipe:[],
        coverage:'unallocated',legacy:false,incomplete:true,modified:false}));
}

module.exports={getAnalysis,allocateSaleRevenue,captureInvoiceCosts,streamFinancialFacts};

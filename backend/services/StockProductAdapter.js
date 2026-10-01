'use strict';
const {createHash}=require('node:crypto');
const ledger=require('./StockLedgerService');
const quantity=require('./stockQuantity');
const snapshots=require('./StockSaleSnapshots');
const SCALE=1000000n;
// Compatibility reads derive linked availability from current physical balances.
// Updating every sibling product during a sale would lock the whole shared menu.
function availabilitySql(alias='p'){
    if(!/^[a-z_]+$/i.test(alias))throw new TypeError('Invalid product alias.');
    return `(CASE WHEN EXISTS(SELECT 1 FROM product_stock_links sl WHERE sl.product_id=${alias}.id) THEN
        (SELECT CASE WHEN COUNT(*)<>COUNT(b.stock_item_id) OR MIN(b.quantity_known)=0 THEN NULL
            ELSE TRUNCATE(MIN(b.quantity/sl.qty_per_sale),6) END
         FROM product_stock_links sl
         LEFT JOIN stock_balances b ON b.stock_item_id=sl.stock_item_id
         WHERE sl.product_id=${alias}.id) ELSE ${alias}.stock END)`;
}
const compare=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
function conflict(message){throw Object.assign(new Error(message),{statusCode:409});}
function multiply(a,b){
    const product=quantity.parse(a)*quantity.parse(b);
    if(product%SCALE!==0n)conflict('The resolved stock quantity requires more than six decimal places. Use a smaller base unit.');
    return quantity.format(product/SCALE);
}
async function loadLinks(conn,ids){
    if(!ids.length)return [];
    const [links]=await conn.query(`SELECT product_id,CAST(stock_item_id AS CHAR) stock_item_id,
        CAST(qty_per_sale AS CHAR) qty_per_sale,CAST(policy_version AS CHAR) policy_version
        FROM product_stock_links WHERE product_id IN (?) ORDER BY product_id,stock_item_id FOR UPDATE`,[ids]);
    const counts=new Map();
    for(const link of links){const count=(counts.get(Number(link.product_id))||0)+1;counts.set(Number(link.product_id),count);if(count>200)conflict('A sale line supports at most 200 resolved stock components.');}
    return links;
}
async function keysFor(conn,itemIds,loadLegacy=false){
    if(!itemIds.length)return new Map();
    const ids=[...new Set(itemIds.map(String))].sort(compare);
    // Reserve every identity before any balance, across all chunks and
    // original-stock returns. Do not acquire the next chunk's items later.
    const [items]=await conn.query('SELECT CAST(id AS CHAR) id FROM stock_items WHERE id IN (?) ORDER BY id FOR UPDATE',[ids]);
    if(items.length!==ids.length)conflict('A resolved stock item no longer exists.');
    if(!loadLegacy)return new Map(ids.map(id=>[id,{stock_item_id:id}]));
    const [rows]=await conn.query(`SELECT CAST(stock_item_id AS CHAR) stock_item_id,
        CAST(location_id AS CHAR) location_id,CAST(lot_id AS CHAR) lot_id FROM stock_balances WHERE stock_item_id IN (?)`,[ids]);
    const legacy=new Map(rows.map(row=>[row.stock_item_id,row]));
    return new Map(ids.map(id=>[id,{stock_item_id:id,location_id:legacy.get(id)?.location_id??null,lot_id:legacy.get(id)?.lot_id??null}]));
}
function currentSnapshot(links){
    return {version:3,authority:'product',components:links.map(link=>({stock_item_id:link.stock_item_id,qty_per_sale:link.qty_per_sale,policy_version:link.policy_version}))};
}
function parts(snapshot,keys){
    const components=snapshot.version>=2?snapshot.components:[snapshot];
    return components.map(part=>{
        const saved=keys.get(String(part.stock_item_id));
        if(!saved)conflict('The original stock item no longer exists.');
        if(snapshot.version===2&&(part.location_id!==saved.location_id||part.lot_id!==saved.lot_id))conflict('The original stock identity does not match this item.');
        return {stock_item_id:String(part.stock_item_id),qty_per_sale:part.qty_per_sale,policy_version:part.policy_version};
    });
}
async function postSources(conn,{before,sources,kind,source,businessDate,actorId}){
    if(!source||typeof source.type!=='string'||!/^[a-z_]{1,24}$/.test(source.type)||!/^[A-Za-z0-9_-]{1,40}$/.test(String(source.id??'')))throw new TypeError('A durable product stock source is required.');
    if(!sources.length)return {lines:[],operation_ids:[]};
    const grouped=new Map();
    for(const entry of sources){const key=entry.stock_item_id;if(!grouped.has(key))grouped.set(key,{...entry,quantity:0n,sources:[]});const group=grouped.get(key);group.quantity+=quantity.parse(entry.quantity);group.sources.push(entry);}
    const groups=[...grouped.values()].sort((a,b)=>compare(a.stock_item_id,b.stock_item_id));
    const itemIds=groups.map(row=>row.stock_item_id);
    await conn.query('INSERT IGNORE INTO stock_balances(stock_item_id) VALUES ?',[itemIds.map(id=>[id])]);
    await conn.query('SELECT stock_item_id FROM stock_balances WHERE stock_item_id IN (?) ORDER BY stock_item_id FOR UPDATE',[itemIds]);
    const identity=[source.type,String(source.id),kind,before.map(row=>[String(row.id),String(row.stock_version)]),sources];
    const hash=createHash('sha256').update(JSON.stringify(identity)).digest('hex'),result={lines:[],operation_ids:[]};
    for(let offset=0;offset<groups.length;offset+=100){
        const chunk=groups.slice(offset,offset+100);
        const posted=await ledger.post(conn,{kind,request_key:`product_${hash}_${offset/100}`,business_date:businessDate,
            lines:chunk.map(row=>({stock_item_id:row.stock_item_id,quantity:quantity.format(row.quantity),
                source_line:row.sources.length===1?`${source.type}:${source.id}:product:${row.sources[0].product_id}`:`${source.type}:${source.id}:resolved`}))},actorId);
        if(!posted.replayed)await conn.query('UPDATE stock_operations SET result_json=? WHERE id=?',[JSON.stringify({...posted,product_sources:chunk.flatMap(row=>row.sources)}),posted.operation_id]);
        result.lines.push(...posted.lines);result.operation_ids.push(posted.operation_id);
    }
    result.operation_id=result.operation_ids[0];return result;
}
async function projectProducts(conn,links,before){
    if(!links.length)return;
    const itemIds=[...new Set(links.map(link=>link.stock_item_id))];
    const [rows]=await conn.query('SELECT CAST(stock_item_id AS CHAR) stock_item_id,CAST(quantity AS CHAR) quantity,quantity_known FROM stock_balances WHERE stock_item_id IN (?)',[itemIds]);
    const balances=new Map(rows.map(row=>[row.stock_item_id,row])),available=new Map();
    for(const link of links){
        const balance=balances.get(link.stock_item_id),id=Number(link.product_id);
        const units=balance?.quantity_known?quantity.parse(balance.quantity)*SCALE/quantity.parse(link.qty_per_sale):null;
        if(!available.has(id))available.set(id,units);else if(units===null||available.get(id)===null)available.set(id,null);else if(units<available.get(id))available.set(id,units);
    }
    const entries=[...available.entries()];
    const versions=new Map(before.map(row=>[Number(row.id),String(row.stock_version)]));
    const [updated]=await conn.query(`UPDATE products SET stock=CASE id ${entries.map(()=> 'WHEN ? THEN ?').join(' ')} END,stock_version=stock_version+1 WHERE id IN (?) AND stock_version=CASE id ${entries.map(()=> 'WHEN ? THEN ?').join(' ')} END`,[...entries.flatMap(([id,units])=>[id,units===null?null:quantity.format(units)]),entries.map(([id])=>id),...entries.flatMap(([id])=>[id,versions.get(id)])]);
    if(updated.affectedRows!==entries.length)conflict('Product stock changed outside its authority adapter.');
}
async function journalProductDeltas(conn,{before,deltas,kind,source,businessDate,actorId,resolvedLinks}){
    if(!['issue','receipt','return'].includes(kind))throw new TypeError('Unsupported product delta kind.');
    const rows=[...before].sort((a,b)=>Number(a.id)-Number(b.id)),links=resolvedLinks||await loadLinks(conn,rows.map(row=>row.id));
    if(!links.length)return null;
    await keysFor(conn,links.map(link=>link.stock_item_id));
    const byProduct=new Map();
    for(const link of links){const id=Number(link.product_id);if(!byProduct.has(id))byProduct.set(id,[]);byProduct.get(id).push(link);}
    const productSnapshots=new Map(),sources=[];
    for(const [id,components] of byProduct){
        const delta=deltas.get(id)??deltas.get(String(id));
        if(kind==='issue'?quantity.parse(delta)>=0n:quantity.parse(delta)<=0n)throw new TypeError('Product stock delta has the wrong direction.');
        productSnapshots.set(id,currentSnapshot(components));
        for(const component of components)sources.push({stock_item_id:component.stock_item_id,product_id:id,qty_per_sale:component.qty_per_sale,policy_version:component.policy_version,quantity:multiply(delta,component.qty_per_sale)});
    }
    const posted=await postSources(conn,{before:rows,sources,kind,source,businessDate,actorId});await projectProducts(conn,links,rows);return {...posted,productSnapshots};
}
async function restoreProductSnapshots(conn,{before,cartItems,source,businessDate,actorId,resolvedLinks,touchedStockItemIds}){
    const links=resolvedLinks||await loadLinks(conn,before.map(row=>row.id)),byProduct=new Map();
    for(const link of links){const id=Number(link.product_id);if(!byProduct.has(id))byProduct.set(id,[]);byProduct.get(id).push(link);}
    const entries=cartItems.map(row=>({row,snapshot:snapshots.read(row)})).filter(({snapshot})=>snapshot?.authority!=='none'),itemIds=links.map(link=>link.stock_item_id);
    for(const {snapshot} of entries)if(snapshot?.authority==='product')itemIds.push(...(snapshot.version>=2?snapshot.components.map(row=>row.stock_item_id):[snapshot.stock_item_id]));
    const keys=await keysFor(conn,itemIds,entries.some(({snapshot})=>snapshot?.version===2)),sources=[],legacy=new Map();
    for(const {row,snapshot} of entries){
        const id=Number(row.product_id),amount=String(row.qty??row.quantity);if(quantity.parse(amount)<=0n)throw new TypeError('Invalid returned quantity.');
        let mapping=snapshot;
        if(mapping?.authority!=='product'){
            const current=byProduct.get(id)||[];
            if(current.length){if(current.length!==1||current[0].qty_per_sale!=='1.000000')conflict('This legacy sale has no original stock composition. Review its physical return.');mapping=currentSnapshot(current);}
            else{legacy.set(id,(legacy.get(id)||0n)+quantity.parse(amount));continue;}
        }
        for(const component of parts(mapping,keys))sources.push({...component,product_id:id,quantity:multiply(amount,component.qty_per_sale)});
    }
    if(touchedStockItemIds)for(const source of sources)touchedStockItemIds.add(String(source.stock_item_id));
    const posted=await postSources(conn,{before,sources,kind:'return',source,businessDate,actorId});await projectProducts(conn,links,before);return {...posted,legacy};
}
module.exports={journalProductDeltas,restoreProductSnapshots,loadLinks,availabilitySql};

'use strict';

function invalid() {
    throw Object.assign(new Error('The saved stock mapping is invalid. Review this sale before restoring stock.'), { statusCode: 409 });
}

// Only call with server-loaded rows. Client cart snapshots are never authority.
function read(row) {
    const authority = row?.stock_authority ?? 'legacy';
    if (authority === 'legacy') return null;
    if (authority === 'none') return { authority: 'none' };
    let snapshot = row?.stock_snapshot;
    if (typeof snapshot === 'string') {
        try { snapshot = JSON.parse(snapshot); } catch { invalid(); }
    }
    if (!snapshot || ![1,2,3].includes(snapshot.version) || !['legacy_product', 'product'].includes(authority)) invalid();
    if (snapshot.version===2 || snapshot.version===3) {
        if(authority!=='product'||!Array.isArray(snapshot.components)||snapshot.components.length<1||snapshot.components.length>200)invalid();
        const keys=new Set();
        for(const part of snapshot.components){
            const fields = snapshot.version === 2 ? ['stock_item_id','location_id','lot_id','policy_version'] : ['stock_item_id','policy_version'];
            if(!part||!fields.every(key=>typeof part[key]==='string'&&/^[1-9]\d{0,18}$/.test(part[key])))invalid();
            try {if(require('./stockQuantity').parse(part.qty_per_sale)<=0n)invalid();}catch{invalid();}
            const key=snapshot.version===2?[part.stock_item_id,part.location_id,part.lot_id].join('/'):part.stock_item_id;if(keys.has(key))invalid();keys.add(key);
        }
        return {...snapshot,authority};
    }
    if (authority === 'product' && (!/^[1-9]\d{0,18}$/.test(String(snapshot.stock_item_id)) ||
        snapshot.qty_per_sale !== '1.000000' || !/^[1-9]\d{0,18}$/.test(String(snapshot.policy_version)))) invalid();
    return { ...snapshot, authority };
}

function columns(snapshot) {
    if (!snapshot) return ['legacy', null];
    const { authority, ...details } = snapshot;
    return [authority, authority === 'none' ? null : JSON.stringify(details)];
}

module.exports = { read, columns };

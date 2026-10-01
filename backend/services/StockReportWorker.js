'use strict';
const { hasSourcePressure } = require('./StockReportInvalidation');

const generations=require('./StockReportGenerationService');
const facts=require('./StockReportFactService');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const budgets=new WeakMap();

// Claims the installation lease, rebuilds one dirty scope, and publishes only
// a still-current generation. Startup coverage and idle polling live in
// StockReportWorkerRunner; source writers mark dirty inside their own transactions.
async function runOne(pool,{signal,waitFor=wait}={}) {
    if (hasSourcePressure()) return {status:'deferred'};
    if(signal?.aborted) return {status:'cancelled'};
    let budget=budgets.get(pool);
    if(!budget){budget={running:false,windowStart:performance.now(),used:0};budgets.set(pool,budget);}
    if(budget.running)return {status:'busy'};
    budget.running=true;
    try {
        const now=performance.now();
        if(now-budget.windowStart>=500){budget.windowStart=now;budget.used=0;}
        if(budget.used>=70){await waitFor(Math.max(0,500-(now-budget.windowStart)));budget.windowStart=performance.now();budget.used=0;}
        return await rebuild(pool,budget,{signal,waitFor});
    } finally {budget.running=false;}
}

async function rebuild(pool,budget,{signal,waitFor}) {
    let segmentStart=performance.now();
    const claim=await generations.claim(pool);
    if (!claim) {
        const cleaned=await facts.cleanup(pool);
        budget.used+=performance.now()-segmentStart;
        return {status:cleaned.rows||cleaned.builds?'cleaned':'idle',...cleaned};
    }
    const result={status:'building',build_id:claim.build_id,rows:0,chunks:0,max_work_ms:0};
    let pending=[];
    const stopped=()=>{
        if (signal?.aborted) throw Object.assign(new Error('Report build cancelled.'),{reportStop:'cancelled'});
        if (hasSourcePressure()) throw Object.assign(new Error('Yielding to a stock source transaction.'),{reportStop:'deferred'});
    };
    async function yieldBudget(rest=false) {
        const now=performance.now();budget.used+=now-segmentStart;
        result.max_work_ms=Math.max(result.max_work_ms,budget.used);
        const exhausted=rest||budget.used>=70;
        // Yield after every chunk, but share the duty budget across small
        // chunks and scopes instead of sleeping half a second for each one.
        await waitFor(exhausted?Math.max(0,500-(now-budget.windowStart)):0);
        segmentStart=performance.now();
        if(exhausted||segmentStart-budget.windowStart>=500){budget.windowStart=segmentStart;budget.used=0;}
    }
    async function flush(final=false) {
        stopped();
        if (!await generations.renew(pool,claim)) throw Object.assign(new Error('Report source changed.'),{reportStop:'superseded'});
        if (pending.length) {
            await facts.writeBatch(pool,claim.build_id,pending);
            result.rows+=pending.length;pending=[];
        }
        result.chunks++;
        if (!final) {
            // Leave headroom for persistence/renewal before the 100-ms target.
            // Record actual overruns; a SQL query cannot be preempted safely.
            await yieldBudget();stopped();
        }
    }
    const source={async query(...args){
        stopped();
        // A source batch contains several queries before its first emitted
        // fact. Reserve headroom before each query, not only after emission.
        if(budget.used+performance.now()-segmentStart>=50){await yieldBudget(true);stopped();}
        return pool.query(...args);
    }};
    try {
        const counts=await facts.stream(source,claim,async row=>{
            stopped();pending.push(row);
            if (pending.length===500 || budget.used+performance.now()-segmentStart>=70) await flush();
        });
        await flush(true);
        result.status=await generations.publish(pool,claim)?'published':'superseded';
        await yieldBudget();
        return {...result,...counts};
    } catch(error) {
        await generations.abandon(pool,claim);
        await yieldBudget();
        if (error.reportStop) return {...result,status:error.reportStop};
        throw error;
    }
}

async function drain(pool,{limit=256,signal,waitFor=wait}={}) {
    const results=[];
    for (let index=0;index<limit;index++) {
        const result=await runOne(pool,{signal,waitFor});
        results.push(result);
        if (result.status==='idle'||result.status==='cancelled') break;
    }
    return results;
}

module.exports={runOne,drain};

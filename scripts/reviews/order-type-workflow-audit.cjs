// Real HTTP/DB/browser/spooler audit. Generated loopback database and TCP sinks only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${crypto.randomBytes(6).toString('hex')}`;
process.env.SPOOLER_KEY = crypto.randomBytes(24).toString('hex');
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...dbOptions } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const out = path.join(root, 'scratch/order-type-workflow-audit');
const stateRoot = path.join(out, `journal-${crypto.randomBytes(6).toString('hex')}`);
fs.mkdirSync(out, { recursive: true });
const evidence = { database, revision: require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), phases: [] };
let created = false, server, io, base, adminCookie, cashierCookie, shiftId, browser, agent, renderer, sink;
const peers = new Set(), deliveries = [];
const sellers=[];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
evidence.tracked_diff_sha256=hash(require('node:child_process').execFileSync('git',['diff','--binary']));
evidence.harness_sha256=hash(fs.readFileSync(__filename));
const saveEvidence = () => {
    const json=JSON.stringify(evidence,null,2);
    fs.writeFileSync(path.join(out,'results.json'),json);
    fs.writeFileSync(path.join(out,`${database}.json`),json);
};
process.on('exit',()=>{if(!evidence.complete)process.exitCode=1;});
process.prependListener('unhandledRejection',error=>{evidence.error=String(error?.stack||error);saveEvidence();console.error(error);});
const phase = (name, result) => { evidence.phases.push({ name, ...result }); saveEvidence(); console.log(name, JSON.stringify(result)); };

async function api(route, body, cookie = adminCookie, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, {method, headers:{cookie:cookie || '', 'content-type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(30000)});
    const data = await response.json();
    assert(response.ok && data.success !== false, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
    return {data,response};
}
async function login(number) {
    const {response} = await api('/api/auth/login', {user_number:number}, '');
    return response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
}
const setMode = async value => api('/api/system/settings', {order_type_numbering:value ? '1' : '0'});
function saleBody(type, index=0) {
    const quantity=1 + index % 3, total=Number((5.8*quantity).toFixed(2));
    const payment=['cash','card','split'][index % 3];
    return {cart:[{id:1,qty:quantity,price:5}],order_type_id:type,order_type_is_deferred_settlement:false,
        subtotal:5*quantity,tax:Number((0.8*quantity).toFixed(2)),total,shift_id:shiftId,payment_method:payment,
        amount_tendered:payment==='cash' ? total+1 : total,
        change_due:payment==='cash' ? 1 : 0,...(payment==='split'?{cash_amount:2,card_amount:Number((total-2).toFixed(2))}:{}),
        idempotency_key:crypto.randomUUID()};
}
async function sale(type,index=0,extra={},seller={cookie:cashierCookie,shiftId}) { return (await api('/api/pos/checkout',{...saleBody(type,index),shift_id:seller.shiftId,...extra},seller.cookie)).data; }
async function hold(type, extra={}) {
    return (await api('/api/pos/held_orders',{hold_request_id:crypto.randomUUID(),subtotal:5,
        cart:{order_type_id:type,delivery_date:extra.delivery_date || null,items:[{id:1,product_id:1,name:'Test Burger',qty:1,price:5}]},...extra},cashierCookie)).data;
}
function stats(samples) {
    const values=[...samples].sort((a,b)=>a-b);
    const at=q=>Number(values[Math.min(values.length-1,Math.floor(values.length*q))].toFixed(2));
    return {count:values.length,p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)};
}
async function measuredBatch(enabled, count, concurrency) {
    await setMode(enabled);
    const timings=[], results=[], delay=monitorEventLoopDelay({resolution:10});
    const cpu=process.cpuUsage(), memory=process.memoryUsage();
    const before=performance.now(); delay.enable();
    for(let i=0;i<count;i+=concurrency) {
        await Promise.all(Array.from({length:Math.min(concurrency,count-i)},async(_,j)=>{
            const started=performance.now(), index=i+j;
            const data=await sale(1+index%5,index,{},sellers[index%sellers.length]);
            assert.match(data.order_display_no, enabled ? /^[A-E]-\d+$/ : /^\d+$/);
            timings.push(performance.now()-started); results.push(data);
        }));
    }
    delay.disable();
    const elapsed=performance.now()-before, used=process.cpuUsage(cpu);
    const ids=results.map(r=>r.invoice_id);
    const [rows]=await pool.query(`SELECT order_id,order_type_id,order_seq_scope,subtotal,tax,total,payment_method,cash_amount,card_amount,amount_tendered,change_due,invoice_number FROM orders WHERE invoice_id IN (?)`,[ids]);
    assert.equal(rows.length,count);
    assert.equal(new Set(rows.map(r=>r.invoice_number)).size,count);
    assert.equal(new Set(rows.map(r=>`${r.order_seq_scope}:${r.order_id}`)).size,count);
    for(const r of rows) {
        assert.equal(Math.round(Number(r.subtotal)*116),Math.round(Number(r.total)*100));
        assert.equal(Math.round(Number(r.tax)*100),Math.round(Number(r.subtotal)*16));
        assert.equal(Math.round((Number(r.cash_amount)+Number(r.card_amount))*100),Math.round(Number(r.total)*100));
        assert.equal(Math.round((Number(r.amount_tendered)-Number(r.change_due))*100),Math.round(Number(r.total)*100));
        if(r.payment_method==='cash') assert.equal(Number(r.card_amount),0);
        if(r.payment_method==='card') assert.equal(Number(r.cash_amount),0);
        if(enabled) assert.equal(r.order_seq_scope.split(':')[2],String(r.order_type_id));
    }
    const result={enabled,concurrency,...stats(timings),elapsed_ms:Number(elapsed.toFixed(2)),cpu_ms:(used.user+used.system)/1000,
        event_loop_p95_ms:Number((delay.percentile(95)/1e6).toFixed(2)),rss_delta_mb:Number(((process.memoryUsage().rss-memory.rss)/1048576).toFixed(2)),
        connections:pool.connectionTelemetrySnapshot()};
    phase('checkout batch',result);
    return results;
}
async function workflowChecks() {
    await setMode(true);
    const held=await hold(3), body=saleBody(1);
    const [normal,claim]=await Promise.all([sale(2),api(`/api/pos/held_orders/${held.id}/claim`,{claim_token:'a'.repeat(64),expected_version:1},cashierCookie)]);
    body.held_order_context={id:held.id,claim_token:claim.data.claim.claimToken,expected_version:claim.data.claim.version,operation_id:crypto.randomUUID()};
    const paid=(await api('/api/pos/checkout',body,cashierCookie)).data;
    const retries=await Promise.all(Array.from({length:4},()=>api('/api/pos/checkout',body,cashierCookie)));
    assert.equal(paid.order_display_no,held.order_display_no);
    assert(retries.every(r=>r.data.invoice_id===paid.invoice_id && r.data.order_display_no===held.order_display_no));
    const scheduled=await hold(4,{delivery_date:'2099-09-12T18:00'});
    assert.equal(scheduled.order_display_no,null);
    const printed=(await api(`/api/pos/held_orders/${scheduled.id}/print_receipt`,{print_request_id:crypto.randomUUID()},cashierCookie)).data;
    assert.match(printed.order_display_no,/^D-/);
    await pool.query("UPDATE order_types SET is_deferred_settlement=1 WHERE id=5");
    const platforms=await Promise.all([hold(5),hold(5)]);
    const settled=(await api('/api/pos/held_orders/settle-platform',{order_type_id:5,held_order_ids:platforms.map(r=>r.id)},cashierCookie)).data;
    assert.deepEqual(settled.failures,[]);
    const [platformRows]=await pool.query('SELECT * FROM orders WHERE invoice_id IN (?)',[settled.successes.map(r=>r.invoice_id)]);
    assert.equal(platformRows.length,2);
    assert(platformRows.every(r=>r.payment_method==='platform' && Number(r.cash_amount)===0 && Number(r.card_amount)===0));
    assert.deepEqual(platformRows.map(require('../../backend/utils/orderNumber').formatOrderNumber).sort(),platforms.map(r=>r.order_display_no).sort());
    await pool.query('UPDATE order_types SET is_deferred_settlement=0 WHERE id=5');
    const [[cash]]=await pool.query('SELECT COALESCE(SUM(cash_amount),0) AS cash FROM orders WHERE shift_id=?',[shiftId]);
    const report=(await api(`/api/auth/shifts?action=zreport&shift_id=${shiftId}`,undefined,cashierCookie)).data;
    assert.equal(Math.round(Number(report.data.expected_cash)*100),Math.round((50+Number(cash.cash))*100));
    phase('held/platform/retry/shift workflows',{held:held.order_display_no,paid:paid.order_display_no,parallel_retries:4,
        scheduled:printed.order_display_no,platform:platforms.map(r=>r.order_display_no),shift_cash_matches:true,normal:normal.order_display_no});
}
async function browserChecks() {
    const {chromium,expect}=require('@playwright/test');
    browser=await chromium.launch({headless:true});
    for(const [language,width,cpuRate] of [['en',1280,1],['ar',1024,4]]) {
        await api('/api/system/settings',{admin_language:language,print_method:'backend',use_invoice_no_only:'0'});
        const context=await browser.newContext({viewport:{width,height:900}}), page=await context.newPage(), errors=[];
        page.setDefaultTimeout(10000);
        const t=key=>language==='ar' ? require('../../src/shared/i18n/ar.json')[key] || key : key;
        try {
            await context.addInitScript(language=>{localStorage.setItem('pos_language',language);localStorage.setItem('pos_admin_language',language);},language);
            const auth=await context.request.post(base+'/api/auth/login',{data:{user_number:'9002'}});
            assert(auth.ok());
            const cdp=await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
            page.on('pageerror',error=>{errors.push(error.message);console.error('Browser error:',error.message);});
            let failInitialSettings = true;
            await page.route('**/api/system/settings', route => failInitialSettings
                ? route.fulfill({status:503,json:{success:false}}) : route.continue());
            await page.goto(base+'/pos');
            const settingsAlert=page.getByRole('alert').filter({hasText:t('Settings could not be loaded. Retry before checkout or printing.')});
            await expect(settingsAlert).toBeVisible();
            failInitialSettings=false;
            await settingsAlert.getByRole('button',{name:t('Retry'),exact:true}).click();
            await expect(settingsAlert).toBeHidden();
            await page.unroute('**/api/system/settings');
            await page.waitForSelector('.btn-3d');
            const labels=[];
            for(const name of ['Dine In','Takeaway','Delivery']) {
                let releasePrint=()=>{}, receiptRequests=0;
                const delayReceipt=language==='en' && name==='Dine In';
                if(delayReceipt) {
                    const printGate=new Promise(resolve=>{releasePrint=resolve;});
                    await page.route('**/api/print/print',async route=>{
                        if(route.request().postDataJSON().print_type!=='receipt') return route.continue();
                        receiptRequests++;
                        const response=await route.fetch();
                        assert(response.ok()); // The real queue accepted it.
                        await printGate;
                        await route.fulfill({response});
                    });
                }
                try {
                await page.locator('.btn-3d',{hasText:'Test Burger'}).first().click();
                await page.getByRole('button',{name:/Pay|دفع/}).first().click();
                const modal=page.getByRole('dialog',{name:t('Complete Payment')});
                await expect(modal).toBeVisible();
                await modal.getByRole('button',{name,exact:true}).click();
                await modal.getByRole('button',{name:new RegExp(t('Cash'),'i')}).first().click();
                await modal.getByRole('textbox',{name:t('Amount Tendered')}).fill('6');
                const response=page.waitForResponse(r=>r.url().endsWith('/api/pos/checkout')&&r.request().method()==='POST');
                response.catch(()=>{}); // Locator failures must not leave an unhandled timeout during cleanup.
                await modal.getByRole('button',{name:new RegExp(t('CONFIRM PAYMENT'),'i')}).click();
                const data=await (await response).json(); assert(data.success,JSON.stringify(data));
                await expect(modal).toBeHidden({timeout:delayReceipt?35000:10000}); labels.push(data.order_display_no);
                if(delayReceipt) {
                    assert.equal(receiptRequests,1);
                    // The sale dialog closes as soon as payment is saved. The
                    // print acknowledgement can remain pending until its deadline.
                    await expect(page.getByText(t('Printing was not confirmed. Check Printing before retrying.'),{exact:false})).toBeVisible({timeout:35000});
                    phase('print admission timeout',{invoiceId:data.invoice_id,receiptRequests,saleSaved:true});
                }
                } finally {releasePrint();if(delayReceipt) await page.unrouteAll({behavior:'wait'});}
            }
            assert.deepEqual(labels.map(n=>n.split('-')[0]),['A','B','D']);
            // Real commits whose responses never reach the cashier intact.
            // Only the client response is intercepted; the server and DB are real.
            const recovered=[];
            for(const fault of (language==='en' ? ['lost','truncated','timeout'] : ['lost','truncated'])) {
                const attempts=[], observedAttempts=[];
                const observeCheckout=request=>{
                    if(request.url().endsWith('/api/pos/checkout')&&request.method()==='POST') observedAttempts.push(request.postDataJSON());
                };
                page.on('request',observeCheckout);
                let committed, releaseLate;
                const lateGate=new Promise(resolve=>{releaseLate=resolve;});
                await page.route('**/api/pos/checkout', async route=>{
                    attempts.push(route.request().postDataJSON());
                    if(attempts.length>1) return route.continue();
                    const response=await route.fetch();
                    committed=await response.json();
                    assert(committed.success,JSON.stringify(committed));
                    if(fault==='lost') return route.abort('failed');
                    if(fault==='truncated') return route.fulfill({status:200,contentType:'application/json',body:'{"success":true'});
                    await lateGate;
                    await route.fulfill({response});
                });
                const invoiceJobs=async invoiceId=>{
                    const [rows]=await pool.query('SELECT print_type,payload FROM print_queue');
                    return rows.filter(row=>{
                        const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
                        return Number(payload.data?.invoice_id)===Number(invoiceId);
                    });
                };
                try {
                    await page.locator('.btn-3d',{hasText:'Test Burger'}).first().click();
                    await page.getByRole('button',{name:/Pay|دفع/}).first().click();
                    let modal=page.getByRole('dialog',{name:t('Complete Payment')});
                    await modal.getByRole('button',{name:'Takeaway',exact:true}).click();
                    await modal.getByRole('button',{name:new RegExp(t('Cash'),'i')}).first().click();
                    await modal.getByRole('textbox',{name:t('Amount Tendered')}).fill('20');
                    await modal.getByRole('button',{name:new RegExp(t('CONFIRM PAYMENT'),'i')}).click();
                    await expect(modal.getByRole('button',{name:t('Check last payment'),exact:true})).toBeEnabled({timeout:35000});
                    assert.equal(observedAttempts.length,1); // no automatic payment retry
                    assert.match(committed.order_display_no,/^B-\d+$/);
                    assert.equal((await invoiceJobs(committed.invoice_id)).length,0);
                    releaseLate();
                    if(fault==='timeout') {
                        await page.unrouteAll({behavior:'wait'});
                        assert.equal((await invoiceJobs(committed.invoice_id)).length,0);
                        await page.route('**/api/pos/checkout',route=>{attempts.push(route.request().postDataJSON());return route.continue();});
                    }
                    // The original reference must survive even if the mode changes
                    // before recovery. Lost-response recovery also survives reload.
                    await setMode(false);
                    if(fault==='lost') {
                        await page.reload();
                        await page.getByRole('button',{name:t('Check last payment'),exact:true}).click();
                        modal=page.getByRole('dialog',{name:t('Complete Payment')});
                    }
                    // A released timeout response can arrive late. Pair the
                    // acknowledgement with the newly observed retry request.
                    const retried=page.waitForRequest(r=>r.url().endsWith('/api/pos/checkout')&&r.method()==='POST');
                    retried.catch(()=>{});
                    await modal.getByRole('button',{name:t('Check last payment'),exact:true}).click();
                    const retryRequest=await retried;
                    const result=await (await retryRequest.response()).json();
                    assert.equal(result.invoice_id,committed.invoice_id);
                    assert.equal(result.order_display_no,committed.order_display_no);
                    assert.deepEqual(retryRequest.postDataJSON(),attempts[0]);
                    await expect(modal).toBeHidden();
                    const [orders]=await pool.query('SELECT invoice_id,amount_tendered,change_due,total FROM orders WHERE idempotency_key=?',[attempts[0].idempotency_key]);
                    assert.equal(orders.length,1);
                    assert.equal(Number(orders[0].amount_tendered),20);
                    assert.equal(Number(orders[0].change_due),14.2);
                    assert.equal(Number(orders[0].total),5.8);
                    await expect.poll(async()=> (await invoiceJobs(committed.invoice_id)).length).toBe(2);
                    assert.deepEqual((await invoiceJobs(committed.invoice_id)).map(row=>row.print_type).sort(),['kitchen','receipt']);
                    assert.equal(observedAttempts.length,2);
                    recovered.push({fault,invoiceId:result.invoice_id,display:result.order_display_no,requests:observedAttempts.length,printJobs:2});
                } finally { page.off('request',observeCheckout); releaseLate(); await page.unrouteAll({behavior:'wait'}); await setMode(true); }
            }
            phase('committed-response recovery',{language,recovered,settingsColdFailureRecovered:true});
            // A non-default table created by another terminal must survive a real
            // waiter edit/save and a cashier reopen before splitting/settlement.
            const table=(await api('/api/pos/table_order',{table_id:1,order_type_id:4,
                cart:[{id:1,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8},await login('9003'))).data;
            const waiterContext=await browser.newContext({viewport:{width,height:900}});
            const waiterPage=await waiterContext.newPage();
            try {
                await waiterContext.addInitScript(language=>{localStorage.setItem('pos_language',language);localStorage.setItem('pos_admin_language',language);},language);
                assert((await waiterContext.request.post(base+'/api/auth/login',{data:{user_number:'9003'}})).ok());
                waiterPage.on('pageerror',error=>errors.push(error.message));
                const waiterCdp=await waiterContext.newCDPSession(waiterPage);
                await waiterCdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
                await waiterPage.goto(base+'/tables');
                await waiterPage.locator('[data-testid="table-card"][data-table-number="1"]').click();
                await waiterPage.waitForURL(base+'/pos');
                await waiterPage.locator('.btn-3d',{hasText:'Test Burger'}).first().click();
                const saveResponse=waiterPage.waitForResponse(r=>r.url().endsWith('/api/pos/table_order')&&r.request().method()==='POST');
                saveResponse.catch(()=>{});
                await waiterPage.getByRole('button',{name:t('Save Table'),exact:true}).click();
                const savedResponse=await saveResponse, saved=await savedResponse.json();
                assert.equal(savedResponse.request().postDataJSON().order_type_id,4);
                assert.equal(saved.success,true,JSON.stringify(saved));
                assert.equal(saved.order_type_id,4);
                await waiterPage.waitForURL(base+'/tables');
            } finally {
                fs.writeFileSync(path.join(out,`waiter-${language}-text.txt`),waiterPage.url()+'\n'+await waiterPage.locator('body').innerText().catch(()=>''));
                await waiterContext.close();
            }
            await page.goto(base+'/tables');
            const reopenedResponse=page.waitForResponse(r=>r.url().includes('/api/pos/table_order?order_id=')&&r.request().method()==='GET');
            reopenedResponse.catch(()=>{});
            await page.locator('[data-testid="table-card"][data-table-number="1"]').click();
            await page.waitForURL(base+'/pos');
            const reopened=await (await reopenedResponse).json();
            assert.equal(reopened.order_type_id,4);
            assert.equal(reopened.cart.reduce((sum,item)=>sum+Number(item.qty),0),2);
            const [[savedTable]]=await pool.query('SELECT order_id,order_type_id,total FROM orders WHERE invoice_id=?',[table.invoice_id]);
            assert.equal(savedTable.order_id,null);assert.equal(savedTable.order_type_id,4);assert.equal(Number(savedTable.total),11.6);
            phase('built table save/reopen',{language,invoiceId:table.invoice_id,orderType:4,quantity:2,numberBeforeSettlement:null});
            // Restore both seats through the built board/store, then settle them in POS.
            const seatItems=reopened.cart.flatMap(item=>Array.from({length:Number(item.qty)},()=>({...item,qty:1})));
            assert.equal(seatItems.length,2);
            await api('/api/pos/table_splits/split',{tableId:1,currentOrderId:table.invoice_id,
                splits:seatItems.map((item,index)=>({referenceName:`Seat ${index+1}`,subtotal:5.8,items:[item]}))});
            const seatLabels=[];
            for(let seat=0;seat<2;seat++) {
                let releaseBadge;
                const badgeGate=new Promise(resolve=>{releaseBadge=resolve;});
                const badgeUrl='**/api/pos/held_orders/summary';
                await page.route(badgeUrl,async route=>{
                    await badgeGate;
                    // Navigating away can cancel a prior badge request while
                    // the fixture holds it. The live request below must still
                    // complete and leave the payment dialog open.
                    try { await route.continue(); }
                    catch(error) { if(!route.request().failure()) throw error; }
                });
                try {
                    await page.goto(base+'/table-splits');
                    await page.getByRole('button',{name:t('Pay'),exact:true}).first().click();
                    await page.waitForURL(base+'/pos');
                    await page.getByRole('button',{name:t('Pay'),exact:true}).and(page.locator('.cart-final-action')).click();
                    const modal=page.getByRole('dialog',{name:t('Complete Payment')});
                    await expect(modal).toBeVisible();
                    const badgeResponse=page.waitForResponse(r=>r.url().endsWith('/api/pos/held_orders/summary'));
                    releaseBadge();
                    await (await badgeResponse).json();
                    await page.unrouteAll({behavior:'wait'});
                    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
                    await expect(modal).toBeVisible(); // Late badge loading must not dismiss a new payment.
                    await modal.getByRole('button',{name:new RegExp(t('Cash'),'i')}).first().click();
                    await modal.getByRole('textbox',{name:t('Amount Tendered')}).fill('6');
                    if(seat===0) await page.screenshot({path:path.join(out,`split-payment-${language}.png`)});
                    const response=page.waitForResponse(r=>r.url().endsWith('/api/pos/checkout')&&r.request().method()==='POST');
                    response.catch(()=>{});
                    await modal.getByRole('button',{name:new RegExp(t('CONFIRM PAYMENT'),'i')}).click();
                    const result=await response, data=await result.json();
                    assert(data.success,JSON.stringify(data));
                    assert.equal(Number(result.request().postDataJSON().order_type_id),4);
                    assert.match(data.order_display_no,/^D-\d+$/);
                    seatLabels.push(data.order_display_no);
                    await expect(modal).toBeHidden();
                } finally {releaseBadge();await page.unrouteAll({behavior:'wait'});}
            }
            assert.deepEqual(errors,[]);
            await page.screenshot({path:path.join(out,`pos-${language}.png`)});
            phase('built POS browser',{language,width,cpuRate,labels,seatLabels,errors});
        } finally {
            fs.writeFileSync(path.join(out,`browser-${language}-text.txt`),await page.locator('body').innerText().catch(()=>''));
            await page.screenshot({path:path.join(out,`pos-${language}-last.png`)}).catch(()=>{});
            await context.close();
        }
    }
    await browser.close(); browser=null;
}
async function printChecks(spoolerId) {
    const [jobs]=await pool.query("SELECT id,payload FROM print_queue WHERE status='pending' ORDER BY id");
    assert(jobs.length>0);
    for(const row of jobs) {
        const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
        if(payload.data.order_display_no) {
            assert.match(payload.data.order_display_no,/^[A-E]-\d+$/);
            assert(payload.data.compiled_document_v1.html.includes(payload.data.order_display_no));
        } else {
            // Unpaid table kitchen tickets intentionally identify the table, consuming no number.
            assert(payload.data.table_number);
            assert(payload.data.compiled_document_v1.html.includes(String(payload.data.table_number)));
        }
    }
    const {openJobStore}=require('../../pos-spooler-printer/v2/job-store');
    const {createTypstRenderer}=require('../../pos-spooler-printer/v2/typst-renderer');
    const {createPrinterWorkers}=require('../../pos-spooler-printer/v2/printer-workers');
    const {createAgentRuntime}=require('../../pos-spooler-printer/v2/agent-runtime');
    const {createSyncClient}=require('../../pos-spooler-printer/v2/sync-client');
    const {createTcpTransport}=require('../../pos-spooler-printer/v2/printer-transports');
    const store=openJobStore({stateRoot});
    renderer=createTypstRenderer({stateRoot,executable:process.env.SPOOLER_TYPST_EXE,fontPath:process.env.SPOOLER_TYPST_FONT_DIR,env:process.env});
    const transport=createTcpTransport({connectMs:1000,writeIdleMs:3000,totalMs:15000});
    const client=createSyncClient({baseUrl:base,agentId:crypto.randomUUID(),secret:crypto.randomBytes(32),bootstrapKey:process.env.SPOOLER_KEY,spoolerId,spoolerName:'Numbering fixture',agentVersion:'review',timeoutMs:5000});
    const worker=createPrinterWorkers({store,renderer,transportFor:()=>transport,onResultReady:()=>agent?.wake()});
    agent=createAgentRuntime({store,syncClient:client,worker,startupJitterMs:0,random:()=>0,log:()=>{}});
    const started=performance.now();agent.start();
    const deadline=Date.now()+120000;
    let completed=[];
    while(Date.now()<deadline) {
        [completed]=await pool.query("SELECT id,status,artifact_hash,artifact_bytes FROM print_queue WHERE id IN (?)",[jobs.map(r=>r.id)]);
        const failed=completed.find(r=>r.status==='dead_letter' || r.status==='failed');
        assert(!failed,JSON.stringify(failed && {job:failed,local:store.get(failed.id)?.result}));
        if(completed.every(r=>r.status==='acknowledged') && deliveries.length===jobs.length) break;
        await sleep(100);
    }
    assert(completed.every(r=>r.status==='acknowledged'),JSON.stringify(completed));
    assert.equal(deliveries.length,jobs.length);
    const received=deliveries.map(hash).sort();
    assert.deepEqual(received,completed.map(r=>r.artifact_hash).sort());
    for(const row of completed) {
        assert.equal(store.get(row.id).artifact.hash,row.artifact_hash);
        assert.equal(Number(store.get(row.id).artifact.bytes),Number(row.artifact_bytes));
    }
    phase('spooler delivery',{jobs:jobs.length,elapsed_ms:Math.round(performance.now()-started),hashes_match:true,
        bytes:deliveries.reduce((n,b)=>n+b.length,0),scope:'API -> queue -> V2 sync -> journal -> Typst -> loopback TCP; no physical printer'});
    await agent.stop();agent=null;await renderer.close();renderer=null;
}
async function verifyClosingCash() {
    for(const seller of sellers) {
        const [[money]]=await pool.query('SELECT COALESCE(SUM(cash_amount),0) AS cash FROM orders WHERE shift_id=?',[seller.shiftId]);
        const expected=Math.round((50+Number(money.cash))*100)/100;
        // Browser login deliberately replaces that cashier's earlier HTTP session.
        const cookie=await login(seller.userNumber);
        const closed=(await api('/api/auth/shifts?action=close',{shift_id:seller.shiftId,actual_cash:expected},cookie,'PUT')).data;
        assert.equal(Number(closed.expected_cash),expected);
        const [[row]]=await pool.query('SELECT expected_cash,actual_cash,status FROM shifts WHERE id=?',[seller.shiftId]);
        assert.equal(row.status,'closed');assert.equal(Number(row.actual_cash),Number(row.expected_cash));
    }
    phase('closed shift reconciliation',{cashiers:sellers.length,variance:0,all_closed:true});
}
async function run() {
    assert(/^posapp_review_recipe_p1_[a-f0-9]{12}$/.test(database));
    const admin=await mysql.createConnection(dbOptions);
    try {await admin.query(`CREATE DATABASE \`${database}\``);created=true;} finally {await admin.end();}
    await seedDatabase();
    await pool.query("UPDATE order_types SET requires_hash=0,name=CASE id WHEN 1 THEN 'Dine In' ELSE 'Takeaway' END");
    await pool.query("INSERT INTO order_types(id,name) VALUES(3,'Y'),(4,'Delivery'),(5,'Pickup')");
    await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('y_order_type_id','3'),('use_invoice_no_only','0'),('print_method','backend') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
    await pool.query("INSERT INTO user_permissions(user_id,perm_key) VALUES(2,'tables.access'),(2,'pos.split_checks')");
    ({server,io}=require('../../server'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    base=`http://127.0.0.1:${server.address().port}`;adminCookie=await login('9001');cashierCookie=await login('9002');
    await api('/api/auth/shifts?action=open',{user_id:2,starting_cash:50},cashierCookie);
    const [[shift]]=await pool.query("SELECT id FROM shifts WHERE user_id=2 AND status='open'");shiftId=shift.id;
    sellers.push({cookie:cashierCookie,shiftId,userNumber:'9002'});
    for(const id of [7,8,9]) {
        await pool.query("INSERT INTO users(id,user_number,name,role,is_active) VALUES(?,?,?,'cashier',1)",[id,`900${id}`,`Till ${id}`]);
        await pool.query("INSERT INTO user_permissions(user_id,perm_key) VALUES(?,'pos.checkout'),(?,'shift.open'),(?,'shift.close')",[id,id,id]);
        const cookie=await login(`900${id}`);
        await api('/api/auth/shifts?action=open',{user_id:id,starting_cash:50},cookie);
        const [[opened]]=await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[id]);
        sellers.push({cookie,shiftId:opened.id,userNumber:`900${id}`});
    }
    await measuredBatch(false,10,1); // Warm-up separately recorded.
    for(const enabled of [false,true,true,false]) await measuredBatch(enabled,50,4);
    await setMode(true);
    const latest=[];for(let type=1;type<=5;type++) latest.push(await sale(type));
    sink=net.createServer(socket=>{peers.add(socket);const chunks=[];socket.on('data',b=>chunks.push(Buffer.from(b)));socket.on('end',()=>deliveries.push(Buffer.concat(chunks)));socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});});
    await new Promise(resolve=>sink.listen(0,'127.0.0.1',resolve));
    const spoolerId=`numbering-${crypto.randomBytes(5).toString('hex')}`;
    for(const role of ['receipt','kitchen']) {
        const [p]=await pool.query("INSERT INTO printers(name,role,type,network_ip,network_port,spooler_id,status_capability) VALUES(?,?,'network','127.0.0.1',?,?,'write_only')",[role,role,sink.address().port,spoolerId]);
        if(role==='kitchen') await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,1)',[p.insertId]);
    }
    await workflowChecks();
    for(const row of latest) for(const print_type of ['receipt','kitchen']) await api('/api/print/print',{print_type,invoice_id:row.invoice_id});
    if(!process.env.NUMBER_AUDIT_SKIP_BROWSER) await browserChecks();
    await printChecks(spoolerId);
    await verifyClosingCash();
    const [[duplicates]]=await pool.query('SELECT COUNT(*) AS n FROM (SELECT order_seq_scope,order_id FROM orders WHERE order_id IS NOT NULL GROUP BY order_seq_scope,order_id HAVING COUNT(*)>1) d');assert.equal(Number(duplicates.n),0);
    const [[paid]]=await pool.query("SELECT COUNT(*) AS n FROM orders WHERE payment_method IN ('cash','card','split','platform')");
    assert.equal(Number(paid.n),process.env.NUMBER_AUDIT_SKIP_BROWSER ? 219 : 234);
    const connections=pool.connectionTelemetrySnapshot();
    assert.equal(connections.inUse,0);
    assert.equal(connections.acquired,connections.released);
    assert.equal(connections.connectionErrors,0);
    phase('final integrity',{paid_invoices:Number(paid.n),duplicate_scoped_numbers:Number(duplicates.n),connections});
    evidence.complete=true;saveEvidence();
}
run().catch(error=>{evidence.error=error.stack;saveEvidence();console.error(error);process.exitCode=1;}).finally(async()=>{
    await browser?.close();await agent?.stop();await renderer?.close();
    for(const socket of peers)socket.destroy();if(sink?.listening)await new Promise(resolve=>sink.close(resolve));
    if(io)await new Promise(resolve=>io.close(resolve));if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await pool.end();
    if(created){const admin=await mysql.createConnection(dbOptions);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
    // Journal stays under scratch with the run's evidence; never touches a machine spooler.
});

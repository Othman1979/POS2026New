const { formatOrderNumber } = require('../utils/orderNumber');
const {buildHeldPresentations} = require('./ReceiptPresentationSources');
const {readItemsFromHeldRow} = require('./HeldOrderKitchenDispatch');
const {ensureHeldOrderNumber} = require('./HeldOrderNumber');
const {enqueuePrintJobs,selectReceiptPrinter} = require('./printDispatch');
const {prepareQueuedPrintPayload} = require('./printDocumentCompiler');
const {parseBackendTimestamp} = require('../utils/businessDate');

async function prepareHeldCustomerReceipt(db, heldOrder, {printerId=null,requestId,automatic=false,forceBackend=false,replayBrowserOnly=false}={}) {
    await ensureHeldOrderNumber(db,heldOrder);
    const [{presentation,error}] = await buildHeldPresentations(db,[heldOrder]);
    if (!presentation) throw error || new Error('The held order cannot be printed.');
    const {parsed,items} = readItemsFromHeldRow(heldOrder);
    const [settings] = await db.query("SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('store_name','store_address','store_phone','receipt_config','print_method')");
    const storeInfo = Object.fromEntries(settings.map(row=>[row.setting_key,row.setting_value]));
    if (replayBrowserOnly && (storeInfo.print_method === 'backend' || !parsed._customer_receipt_requested)) return null;
    const [[staff]] = await db.query('SELECT name FROM users WHERE id=?',[heldOrder.user_id]);
    const data = {
        held_order_receipt:true, provisional:true, payment_method:'held',
        invoice_id:null, internal_invoice_id:null, invoice_number:null, invoice_display_no:null,
        ticket_display_no:null, order_id:heldOrder.order_id, order_display_no:formatOrderNumber(heldOrder),
        storeInfo,storeName:storeInfo.store_name,cashier:staff?.name || '',
        order_taken_at:parseBackendTimestamp(heldOrder.created_at).toISOString(),
        date:parseBackendTimestamp(heldOrder.created_at).toISOString(),
        customer_name:parsed.customer_name || '',customer_phone:parsed.customer_phone || '',customer_address:parsed.customer_address || '',
        delivery_date:parsed.delivery_date || null,order_note:parsed.order_note || '',
        items,receipt_display_v1:presentation,total:presentation.summary.total,
        print_request_id:`held-receipt-${heldOrder.id}-${requestId}`
    };
    if (!forceBackend && storeInfo.print_method !== 'backend') {
        const prepared = await prepareQueuedPrintPayload(db, {print_type:'receipt',data}, {browser:true});
        await db.query("UPDATE held_orders SET cart_data=JSON_SET(cart_data,'$._customer_receipt_requested',1) WHERE id=?",[heldOrder.id]);
        return {mode:'browser',data:prepared.data};
    }
    const [printers] = await db.query("SELECT * FROM printers WHERE role='receipt' AND is_active=1");
    let printer;
    try {
        printer=selectReceiptPrinter(printers,{printerId});
        if (!printer) throw Object.assign(new Error('No receipt printer found.'),{statusCode:409});
    } catch(error) {
        if (!automatic) throw error;
        return {mode:'unavailable',message:error.message};
    }
    const queued=await enqueuePrintJobs(db,[{
        printer_id:printer.id,printer_name:printer.windows_name,printer_type:printer.type,
        network_ip:printer.network_ip,network_port:printer.network_port,
        status_capability:printer.status_capability || 'write_only',print_type:'receipt',data
    }],{returnStatus:true});
    if (queued.some(job => !['pending','processing','sent','acknowledged'].includes(job.status))) {
        throw Object.assign(new Error('This print attempt needs review. Check the print queue before printing again.'), {statusCode:409});
    }
    await db.query("UPDATE held_orders SET cart_data=JSON_SET(cart_data,'$._customer_receipt_requested',1) WHERE id=?",[heldOrder.id]);
    return {mode:'backend',queued};
}

module.exports={prepareHeldCustomerReceipt};

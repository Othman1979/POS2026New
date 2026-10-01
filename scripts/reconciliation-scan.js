const db = require('../backend/config/db');
const { buildReceiptPresentation } = require('../backend/services/ReceiptPresentation');
const { buildOrderPresentation } = require('../backend/services/ReceiptPresentationSources');

async function run() {
    console.log('🔍 Starting database reconciliation scan...');
    let conn;
    try {
        conn = await db.getConnection();
        
        // Fetch all orders
        const [orders] = await conn.query('SELECT * FROM orders ORDER BY invoice_id ASC');
        console.log(`Loaded ${orders.length} orders from the database.`);
        
        const anomalies = {
            nonPositiveQty: [],
            negativeMoney: [],
            duplicateKeys: [],
            presentationErrors: [],
            centMismatches: []
        };
        
        for (const order of orders) {
            const [items] = await conn.query('SELECT * FROM order_items WHERE invoice_id = ?', [order.invoice_id]);
            
            // Check for basic data sanity
            const sourceKeys = new Set();
            for (const item of items) {
                if (item.id == null) {
                    anomalies.duplicateKeys.push({ orderId: order.invoice_id, itemId: null, reason: 'missing source identity' });
                } else {
                    const sourceKey = `order-item-${item.id}`;
                    if (sourceKeys.has(sourceKey)) {
                        anomalies.duplicateKeys.push({ orderId: order.invoice_id, itemId: item.id, reason: 'duplicate source identity' });
                    }
                    sourceKeys.add(sourceKey);
                }
                if (Number(item.quantity) <= 0) {
                    anomalies.nonPositiveQty.push({ orderId: order.invoice_id, itemId: item.id, qty: item.quantity });
                }
            }
            
            if (Number(order.total) < 0 || Number(order.subtotal) < 0 || Number(order.tax) < 0 || Number(order.discount_value) < 0) {
                anomalies.negativeMoney.push({ orderId: order.invoice_id, total: order.total, subtotal: order.subtotal, tax: order.tax });
            }
            
            // Check for presentation errors
            let presentation;
            try {
                presentation = buildOrderPresentation({ order, items });
            } catch (err) {
                anomalies.presentationErrors.push({
                    orderId: order.invoice_id,
                    paymentStatus: order.payment_status || order.payment_method,
                    taxInclusiveAtSale: order.tax_inclusive_at_sale,
                    message: err.message,
                    code: err.code
                });
                continue;
            }
            
            // Verify totals match exactly (checking to the exact cent)
            const expectedSubtotal = presentation.summary.subtotal;
            const expectedTax = presentation.summary.taxAmount;
            const expectedTotal = presentation.summary.total;
            
            let actualSubtotal = Number(order.subtotal);
            let actualTax = Number(order.tax);
            let actualTotal = Number(order.total);
            
            if (order.payment_method === 'voided' || order.status === 'voided') {
                if (order.original_subtotal !== null && order.original_subtotal !== undefined) {
                    actualSubtotal = Number(order.original_subtotal);
                }
                if (order.original_tax !== null && order.original_tax !== undefined) {
                    actualTax = Number(order.original_tax);
                }
                if (order.original_total !== null && order.original_total !== undefined) {
                    actualTotal = Number(order.original_total);
                }
            }
            
            const subtotalDiff = Math.abs(Math.round((expectedSubtotal - actualSubtotal) * 100));
            const taxDiff = Math.abs(Math.round((expectedTax - actualTax) * 100));
            const totalDiff = Math.abs(Math.round((expectedTotal - actualTotal) * 100));
            
            if (subtotalDiff > 0 || taxDiff > 0 || totalDiff > 0) {
                anomalies.centMismatches.push({
                    orderId: order.invoice_id,
                    paymentStatus: order.payment_status || order.payment_method,
                    taxInclusiveAtSale: order.tax_inclusive_at_sale,
                    expected: { subtotal: expectedSubtotal, tax: expectedTax, total: expectedTotal },
                    actual: { subtotal: actualSubtotal, tax: actualTax, total: actualTotal },
                    diff: { subtotal: subtotalDiff / 100, tax: taxDiff / 100, total: totalDiff / 100 }
                });
            }
        }
        
        console.log('\n--- SCAN RESULT SUMMARY ---');
        console.log(`Non-Positive Quantities: ${anomalies.nonPositiveQty.length}`);
        console.log(`Negative Money Fields: ${anomalies.negativeMoney.length}`);
        console.log(`Presentation Build Errors: ${anomalies.presentationErrors.length}`);
        console.log(`Cent Mismatches: ${anomalies.centMismatches.length}`);
        console.log(`Duplicate/Missing Source Identities: ${anomalies.duplicateKeys.length}`);
        
        if (anomalies.nonPositiveQty.length > 0) {
            console.log('\n❌ NON-POSITIVE QUANTITIES:', JSON.stringify(anomalies.nonPositiveQty, null, 2));
        }
        if (anomalies.negativeMoney.length > 0) {
            console.log('\n❌ NEGATIVE MONEY FIELDS:', JSON.stringify(anomalies.negativeMoney, null, 2));
        }
        if (anomalies.presentationErrors.length > 0) {
            console.log('\n❌ PRESENTATION BUILD ERRORS:', JSON.stringify(anomalies.presentationErrors, null, 2));
        }
        if (anomalies.duplicateKeys.length > 0) {
            console.log('\nINVALID SOURCE IDENTITIES:', JSON.stringify(anomalies.duplicateKeys, null, 2));
        }
        
        if (anomalies.centMismatches.length > 0) {
            console.log('\n⚠️ CENT MISMATCHES:');
            // Group by payment status and tax_inclusive_at_sale
            const grouped = {};
            for (const cm of anomalies.centMismatches) {
                const key = `payment_status=${cm.paymentStatus}, tax_inclusive=${cm.taxInclusiveAtSale}`;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(cm);
            }
            for (const [key, list] of Object.entries(grouped)) {
                console.log(`\nGroup: ${key} (Count: ${list.length})`);
                console.log(list.slice(0, 10).map(m => `Order #${m.orderId}: expected total ${m.expected.total} vs actual ${m.actual.total} (diff: ${m.diff.total})`));
                if (list.length > 10) console.log(`... and ${list.length - 10} more`);
            }
        }
        
        console.log('\nReconciliation scan completed.');
        if (Object.values(anomalies).some(entries => entries.length > 0)) {
            process.exitCode = 1;
        }
        
    } catch (err) {
        console.error('Fatal scan error:', err);
        process.exitCode = 1;
    } finally {
        if (conn) conn.release();
        await db.end();
    }
}

run();

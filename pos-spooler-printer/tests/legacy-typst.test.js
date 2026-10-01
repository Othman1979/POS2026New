const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTypstRenderer, defaultTypstPaths } = require('../v2/typst-renderer');
const largeReport = require('./fixtures/v2-report-200-rows');

const defaults = defaultTypstPaths();
const runtime = process.env.SPOOLER_TYPST_EXE || defaults.executable;
const fonts = process.env.SPOOLER_TYPST_FONT_DIR || defaults.fontPath;
assert(fs.existsSync(runtime) && fs.existsSync(fonts), 'Prepare the pinned Typst runtime before running spooler tests.');

(async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-legacy-typst-'));
    const renderer = createTypstRenderer({ stateRoot, executable: runtime, fontPath: fonts });
    try {
        const receipt = await renderer.render({ queue_id: 9101, print_type: 'receipt', data: {
            storeInfo: { store_name: 'مطعم الاختبار', store_address: 'Amman', store_phone: '0790000000' },
            invoice_display_no: 'D-7', order_id: 7, order_display_no: 'D-7',
            date: '2026-09-25T12:00:00Z', cashier: 'Cashier', customer_name: 'مريم', customer_phone: '0791',
            items: [{ name: 'شاورما دجاج', qty: 2, price: 3, tax_rate: 16, note: 'Extra sauce' }],
            subtotal: 6, tax: 0.96, total: 6.96, payment_method: 'cash', amount_tendered: 10, change_due: 3.04
        } });
        assert(receipt.height > 60 && fs.statSync(receipt.path).size > 1000);
        console.log('real legacy receipt rendered');
        const scale = await renderer.render({ queue_id: 9103, print_type: 'receipt', data: {
            storeInfo: { store_name: 'مطعم الاختبار' }, provisional: true, date: '2026-09-25T12:00:00Z',
            items: [{ name: 'شاورما SUPERCALIFRAGILISTICEXTRALONGPRODUCTTOKEN', qty: 1.125, price: 3, note: 'بدون بصل\nExtra sauce' }],
            subtotal: 3.375, tax: 0, total: 3.375
        } });
        assert(scale.height > 200 && fs.statSync(scale.path).size > 1000);
        const kitchen = await renderer.render({ queue_id: 9102, print_type: 'kitchen', data: {
            follow_up: true, follow_up_sequence: 2, held_order: true, order_id: 7, order_display_no: 'D-7',
            date: '2026-09-25T12:00:00Z', items: [{ qty: 1, name: 'برغر', note: 'No onion' }]
        } });
        assert(kitchen.height > 320 && fs.statSync(kitchen.path).size > 1000);
        console.log('real legacy kitchen rendered');
        const report = await renderer.render(largeReport);
        assert(report.height > kitchen.height && fs.statSync(report.path).size > 1000);
        assert(fs.readFileSync(report.path).subarray(-6).equals(Buffer.from([10, 10, 10, 29, 86, 0])));
        const repeat = await renderer.render({ ...largeReport, queue_id: largeReport.queue_id + 1 });
        assert.strictEqual(repeat.hash, report.hash, 'repeated report raster bytes are stable');
        assert.strictEqual(fs.readdirSync(path.join(stateRoot, 'typst-runtime')).filter(name => name.startsWith('assets-')).length, 1,
            'real watcher retains only the current page assets after repeated reports');
        console.log(`legacy-typst real-runtime passed: receipt ${receipt.height}px, kitchen ${kitchen.height}px, report ${report.height}px twice`);
    } catch (error) {
        console.error('real Typst render failed:', error);
        throw error;
    } finally {
        await renderer.close();
        assert(!fs.existsSync(path.join(stateRoot, 'typst-runtime')), 'real watcher runtime is removed on close');
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

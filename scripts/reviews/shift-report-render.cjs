// Real spooler Typst output, with no printer transport. Run after the
// shift-report-print-browser fixture and set SPOOLER_TYPST_EXE/SPOOLER_TYPST_FONT_DIR if using an external runtime.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createTypstRenderer } = require('../../pos-spooler-printer/v2/typst-renderer');
const report = require('../../pos-spooler-printer/tests/fixtures/v2-report-200-rows');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'scratch/shifts-print-render');
fs.mkdirSync(out, { recursive: true });
const y = JSON.parse(fs.readFileSync(path.join(root, 'scratch/shifts-print-y-en-job.json'), 'utf8'));
const largeY = { ...y, data: { ...y.data,
    summary: { order_count: 200, subtotal: 2000, line_discount: 0, order_discount: 0, tax: 0, total: 2000 },
    items: Array.from({ length: 200 }, (_, index) => ({ item_name: `Item ${String(index + 1).padStart(3, '0')}`, qty_sold: 2, gross_revenue: 10 })),
    categories: [{ category_name: 'All items', qty_sold: 400, gross_revenue: 2000 }],
} };
const longY = { ...y, data: { ...y.data,
    items: [
        { item_name: 'ExtraLongProductName'.repeat(8), qty_sold: 999, gross_revenue: 99999999.99 },
        { item_name: 'وجبةعائليةخاصة'.repeat(12), qty_sold: 999, gross_revenue: 99999999.99 },
    ],
} };
const renderer = createTypstRenderer({ stateRoot: out, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR, env: {} });

async function run() {
    const results = [];
    for (const [index, [name, job]] of [['y', y], ['y-200-items', largeY], ['audit-200-rows', report], ['y-long-names', longY]].entries()) {
        const artifact = await renderer.render({ ...job, queue_id: index + 1 });
        const bytes = fs.readFileSync(artifact.path);
        let rows = 0, bands = 0, offset = 0;
        while ((offset = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30]), offset)) !== -1) {
            const widthBytes = bytes.readUInt16LE(offset + 4);
            const height = bytes.readUInt16LE(offset + 6);
            assert.equal(widthBytes, 72, '576 printable dots');
            assert.ok(height > 0 && height <= 256);
            rows += height; bands += 1;
            offset += 8 + widthBytes * height;
        }
        assert.equal(rows, artifact.height, 'raster bands must include every rendered row');
        assert.ok(bands > 0);
        assert.equal(bytes.subarray(-3).toString('hex'), '1d5600', 'one final full cut command');
        results.push({ name, width: artifact.width, height: artifact.height, encodedRows: rows, bands, bytes: artifact.bytes });
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => renderer.close());

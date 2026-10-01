'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildReportDocuments } = require('../v2/report-typst');
const pinnedFonts = process.env.SPOOLER_TYPST_FONT_DIR || path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'fonts');

const executable = [process.env.SPOOLER_TYPST_EXE,
    path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'typst.exe'),
    path.join(__dirname, '..', '..', 'deployment', 'out', 'stage', 'spooler', '.cache', 'typst', '0.15.1', 'typst.exe')
].find(candidate => candidate && fs.existsSync(candidate));
const dir = executable ? fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-y-report-')) : null;
if (executable) assert(fs.existsSync(pinnedFonts), 'pinned Typst fonts are required');
try {
    for (const test of [
        { name: '100 items', count: 100 }, { name: '200 items', count: 200 },
        { name: 'long Arabic and English names', count: 100, long: true },
        { name: '200 long Arabic and English names', count: 200, long: true },
        { name: 'large and fractional values', count: 2, large: true },
        { name: 'period report', count: 100, period: true }, { name: 'no items', count: 0 }
    ]) {
        const items = Array.from({ length: test.count }, (_, i) => ({
            item_name: test.long ? (i % 2 ? 'وجبةعائليةخاصة' : 'ExtraLongProductName').repeat(10) + i
                : test.large ? `<img src=x> & "literal" ${i}` : `شاورما دجاج ${i + 1}`,
            qty_sold: test.large ? [99999.999, 0.001][i] : i + 1,
            gross_revenue: test.large ? [99999999.99, 0][i] : (i + 1) * 10.5
        }));
        const data = { generated_at: '2026-09-11T09:00:00Z', business_date: '2026-09-11',
            is_period: test.period, period_start_date: '2026-09-01', period_end_date: '2026-09-11',
            summary: { order_count: 31, subtotal: 123.45, line_discount: 1.25,
                order_discount: 2.5, tax: 7.75, total: 128.7 },
            categories: [{ category_name: 'CATEGORY-KEPT', qty_sold: 32, gross_revenue: 12.34 }],
            subcategories: [{ category_name: 'GROUP-KEPT', rows: [{ category_name: 'SUBCATEGORY-KEPT',
                qty_sold: 3, gross_revenue: 4.56 }] }], items,
            orders: [{ reference_name: 'RECEIPTS-MUST-STAY-OMITTED' }] };
        const docs = buildReportDocuments({ print_type: 'y_held_items_report', data });
        assert(docs.length >= 1 && docs.length <= 20, `${test.name}: bounded document count`);
        const joined = docs.map(doc => doc.source).join('').replace(/\u200b/g, '');
        for (const retained of ['CATEGORY-KEPT', 'GROUP-KEPT', 'SUBCATEGORY-KEPT',
            '123.45', '1.25', '2.50', '7.75', '128.70', 'نهاية تقرير Y']) {
            assert(joined.includes(retained), `${test.name}: missing ${retained}`);
        }
        assert(!joined.includes('RECEIPTS-MUST-STAY-OMITTED'));
        if (test.period) assert(joined.includes('2026-09-01') && joined.includes('2026-09-11'));
        let previous = -1;
        for (const item of items) {
            const at = joined.indexOf(JSON.stringify(item.item_name));
            assert(at > previous, `${test.name}: item retained in order: ${item.item_name}`);
            previous = at;
            assert(joined.includes(String(item.qty_sold)), `${test.name}: item quantity retained`);
            assert(joined.includes(item.gross_revenue.toFixed(2)), `${test.name}: item amount retained`);
        }
        if (test.count >= 100) assert(docs.length > 1, `${test.name}: large report split`);
        if (executable) {
            for (let i = 0; i < docs.length; i++) {
                const input = path.join(dir, `y-${i}.typ`), output = path.join(dir, `y-${i}.png`);
                fs.writeFileSync(input, docs[i].source);
                execFileSync(executable, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { timeout: 15000, stdio: 'pipe' });
                const png = fs.readFileSync(output);
                assert.equal(png.readUInt32BE(16), 576);
                assert(png.readUInt32BE(20) <= 12004);
            }
        }
    }
} finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`Native Y report seven cases passed${executable ? ' with real Typst compilation' : ''}.`);

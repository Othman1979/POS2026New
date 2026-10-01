'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildReportDocuments } = require('../v2/report-typst');
const pinnedFonts = process.env.SPOOLER_TYPST_FONT_DIR || path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'fonts');

const typst = [process.env.SPOOLER_TYPST_EXE,
    path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'typst.exe'),
    path.join(__dirname, '..', '..', 'deployment', 'out', 'stage', 'spooler', '.cache', 'typst', '0.15.1', 'typst.exe')
].find(candidate => candidate && fs.existsSync(candidate));
const temp = typst ? fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-shift-layout-')) : null;
if (typst) assert(fs.existsSync(pinnedFonts), 'pinned Typst fonts are required');
try {
    for (const name of ['ExtraLongProductName'.repeat(8), 'وجبةعائليةخاصة'.repeat(12)]) {
        const data = { storeInfo: { store_name: name }, generated_by: { name },
            generated_at: '2026-09-11T09:00:00Z', business_date: '2026-09-11', shift_id: 7,
            actual_cash: 99999999.99, expected_cash: 99999999.99,
            summary: { total: 99999999.99, order_count: 100 },
            categories: [{ category_name: name, qty_sold: 999, gross_revenue: 99999999.99 }],
            subcategories: [{ category_name: name, rows: [{ category_name: name,
                qty_sold: 999, gross_revenue: 99999999.99 }] }],
            items: [{ item_name: name, qty_sold: 999, gross_revenue: 99999999.99 }],
            order_type_breakdown: [{ order_type_name: name, total_sales: 99999999.99 }],
            order_types: [{ order_type_name: name, order_count: 999, total_sales: 99999999.99 }],
            shifts: [{ shift_id: 7, cashier_name: name, status: 'closed', gross_sales: 99999999.99,
                cash_sales: 99999999.99, card_sales: 99999999.99, platform_sales: 99999999.99 }] };
        for (const type of ['x_report', 'z_report', 'audit_report', 'category_items_report', 'y_held_items_report']) {
            const docs = buildReportDocuments({ print_type: type, data });
            const all = docs.map(doc => doc.source).join('').replace(/\u200b/g, '');
            assert(all.includes(name), `${type}: name must stay complete`);
            assert(all.includes('99999999.99'), `${type}: money must stay complete`);
            for (let i = 0; i < docs.length; i++) {
                const doc = docs[i];
                assert.match(doc.source, /width: 576pt/);
                assert.match(doc.source, /left: 10pt, right: 10pt/);
                if (!typst) continue;
                const input = path.join(temp, `${type}-${i}.typ`), output = path.join(temp, `${type}-${i}.png`);
                fs.writeFileSync(input, doc.source);
                execFileSync(typst, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { timeout: 15000, stdio: 'pipe' });
                const png = fs.readFileSync(output);
                assert.equal(png.readUInt32BE(16), 576, `${type}: exact raster width`);
                assert(png.readUInt32BE(20) <= 12004, `${type}: bounded raster height`);
            }
        }
    }
} finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
console.log(`Native shift report long-name and money checks passed${typst ? ' with real Typst compilation' : ''}.`);

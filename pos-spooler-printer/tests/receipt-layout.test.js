const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypstRenderer } = require('../v2/typst-renderer');
const { buildTypstDocument } = require('../v2/compiled-document-typst');
const { compileTemplate } = require('../../backend/services/printTemplateEngine');
const { getBuiltinTemplate, getTemplateFixture } = require('../../backend/services/printTemplateDefaults');
const { rasterRows } = require('./fixtures/raster-rows.cjs');
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-receipt-layout-'));
    const renderer = createTypstRenderer({ stateRoot: root, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR });
    try {
        const heights = [];
        for (const long of [false, true]) {
            const fixture = getTemplateFixture('receipt', 'receipt-basic');
            if (long) {
                fixture.rows[0].name = 'DOUBLE CHICKEN SHAWARMA FAMILY PLATTER WITH FRIES AND EXTRA GARLIC SAUCE شاورما دجاج وجبة عائلية';
                fixture.rows[0].note = 'NO PICKLES, CUT EACH WRAP IN HALF AND PACK THE SAUCES SEPARATELY بدون مخلل والصوص على جنب';
            }
            const { artifact: compiled } = await compileTemplate(getBuiltinTemplate('receipt'), fixture, { mode: 'runtime', templateRevisionId: 'builtin:receipt-v1' });
            const job = { queue_id: long ? 2 : 1, print_type: 'receipt', data: { compiled_document_v1: compiled } };
            const source = buildTypstDocument(job).source;
            assert(source.includes('DOUBLE CHICKEN') === long);
            assert(source.includes('PACK THE SAUCES') === long);
            const artifact = await renderer.render(job);
            const rows = rasterRows(artifact);
            assert(rows.firstInk >= 0 && rows.lastInk > rows.firstInk);
            assert.equal(artifact.width, 576);
            assert(artifact.height - rows.lastInk - 1 >= 50, 'footer retains paper clearance');
            heights.push(artifact.height);
        }
        assert(heights[1] > heights[0] + 35, 'long name and note expand the receipt instead of clipping');
        const headerHeights = [];
        for (const long of [false, true]) {
            const fixture = getTemplateFixture('receipt', 'receipt-basic');
            if (long) fixture.meta.invoiceDisplayNo = 'INV-2026-000000012345678';
            const { artifact: compiled } = await compileTemplate(getBuiltinTemplate('receipt'), fixture, { mode: 'runtime', templateRevisionId: 'builtin:receipt-v1' });
            const meta = compiled.nativeLayout.bands.find(band => band.id === 'meta');
            compiled.nativeLayout.bands = [{ ...meta, nodes: [meta.nodes.find(node => node.id === 'invoice-date-row')] }];
            const artifact = await renderer.render({ queue_id: long ? 4 : 3, print_type: 'receipt', data: { compiled_document_v1: compiled } });
            headerHeights.push(artifact.height);
            if (long) {
                const rows = rasterRows(artifact);
                let start = rows.lastInk;
                while (start > 0 && rows.counts[start - 1]) start--;
                const lastLine = rows.bounds.slice(start, rows.lastInk + 1);
                assert(Math.min(...lastLine.map(row => row.left)) >= 250, 'wrapped identifier leaves the date on its own right-aligned line');
                assert(Math.max(...lastLine.map(row => row.right)) >= 550, 'date remains at the paper edge');
            }
        }
        assert(headerHeights[1] > headerHeights[0], 'long invoice expands the header without clipping');
        console.log('receipt-layout: native long bilingual content expands cleanly');
    } finally { await renderer.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypstRenderer } = require('../v2/typst-renderer');
const { compileTemplate } = require('../../backend/services/printTemplateEngine');
const { getBuiltinTemplate, getTemplateFixture, listTemplateFixtures } = require('../../backend/services/printTemplateDefaults');
const { rasterRows } = require('./fixtures/raster-rows.cjs');
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-kitchen-spacing-'));
    const renderer = createTypstRenderer({ stateRoot: root, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR });
    try {
        let id = 1;
        for (const { key } of listTemplateFixtures('kitchen')) {
            const { artifact: compiled } = await compileTemplate(getBuiltinTemplate('kitchen'), getTemplateFixture('kitchen', key), { mode: 'runtime', templateRevisionId: 'builtin:kitchen-v1' });
            const artifact = await renderer.render({ queue_id: id++, print_type: 'kitchen', data: { compiled_document_v1: compiled } });
            const rows = rasterRows(artifact);
            assert(rows.firstInk >= 120, `${key}: keep 15 mm of paper above ink`);
            assert(rows.lastInk > rows.firstInk);
            assert(artifact.height - rows.lastInk - 1 >= 200, `${key}: keep 25 mm below ink`);
        }
        console.log('kitchen-spacing: native normal, void and follow-up layouts passed');
    } finally { await renderer.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

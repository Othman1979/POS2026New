const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const spoolerRoot = path.join(root, 'pos-spooler-printer');
const { decodePng, encodePng } = require(path.join(spoolerRoot, 'v2/png'));
const { compileTemplate } = require(path.join(root, 'backend/services/printTemplateEngine'));
const { getBuiltinTemplate, getTemplateFixture, listTemplateFixtures } = require(path.join(root, 'backend/services/printTemplateDefaults'));
const { buildOrderPresentation } = require(path.join(root, 'backend/services/ReceiptPresentationSources'));
const { buildTypstDocument } = require(path.join(spoolerRoot, 'v2/compiled-document-typst'));
const { createRendererRouter } = require(path.join(spoolerRoot, 'v2/renderer-router'));
const { createTypstRenderer, defaultTypstPaths } = require(path.join(spoolerRoot, 'v2/typst-renderer'));

const outputRoot = path.resolve(process.env.TYPST_E2E_OUTPUT || path.join(root, 'scratch/typst-spooler-e2e'));
const typstPaths = defaultTypstPaths();
const typstExecutable = path.resolve(process.env.SPOOLER_TYPST_EXE || typstPaths.executable);
const typstFontPath = path.resolve(process.env.SPOOLER_TYPST_FONT_DIR || typstPaths.fontPath);
assert(fs.existsSync(typstExecutable), `Typst executable is missing: ${typstExecutable}`);
assert(fs.existsSync(typstFontPath), `Typst fonts are missing: ${typstFontPath}`);
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
const typstState = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-e2e-'));
const env = { KITCHEN_BEEP_ENABLED: 'true', KITCHEN_BEEP_COUNT: '3', KITCHEN_BEEP_DURATION: '5', RECEIPT_BEEP_ENABLED: 'false' };
const typst = createTypstRenderer({ stateRoot: typstState, executable: typstExecutable, fontPath: typstFontPath, env });

function countBytes(bytes, needle) {
    let count = 0;
    for (let offset = 0; (offset = bytes.indexOf(needle, offset)) !== -1; offset += needle.length) count += 1;
    return count;
}

function decodeArtifact(artifactPath, imagePath) {
    const bytes = fs.readFileSync(artifactPath);
    let offset = 0;
    let height = 0;
    const bands = [];
    const marker = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
    while (bytes.subarray(offset, offset + 4).equals(marker)) {
        const rowBytes = bytes.readUInt16LE(offset + 4);
        const rows = bytes.readUInt16LE(offset + 6);
        assert.equal(rowBytes, 72);
        assert(rows > 0 && rows <= 256);
        const length = rowBytes * rows;
        bands.push({ rows, data: bytes.subarray(offset + 8, offset + 8 + length) });
        height += rows;
        offset += 8 + length;
    }
    assert(height > 0, 'artifact contains no raster bands');
    const pixels = { data: Buffer.alloc(576 * height * 4, 255) };
    let y = 0;
    let black = 0;
    let topInk128 = 0;
    for (const band of bands) {
        for (let row = 0; row < band.rows; row += 1) {
            for (let byte = 0; byte < 72; byte += 1) {
                const value = band.data[row * 72 + byte];
                for (let bit = 0; bit < 8; bit += 1) {
                    if (!(value & (0x80 >> bit))) continue;
                    const pixel = ((y + row) * 576 + byte * 8 + bit) * 4;
                    pixels.data[pixel] = 0;
                    pixels.data[pixel + 1] = 0;
                    pixels.data[pixel + 2] = 0;
                    black += 1;
                    if (y + row < 128) topInk128 += 1;
                }
            }
        }
        y += band.rows;
    }
    fs.writeFileSync(imagePath, encodePng(576, height, pixels.data));
    return {
        bytes,
        height,
        blackRatio: black / (576 * height),
        topInk128,
        beeps: countBytes(bytes.subarray(offset), Buffer.from([0x1b, 0x42])),
        drawers: countBytes(bytes.subarray(offset), Buffer.from([0x1b, 0x70])),
        cuts: countBytes(bytes.subarray(offset), Buffer.from([0x1d, 0x56]))
    };
}

function pngDataUri(width = 64, height = 64) {
    const rgba = Buffer.alloc(width * height * 4, 0);
    const left = Math.max(2, Math.floor(width / 4));
    const top = Math.max(2, Math.floor(height / 4));
    const innerWidth = Math.max(1, Math.floor(width / 2));
    const innerHeight = Math.max(1, Math.floor(height / 2));
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const white = x >= left && x < left + innerWidth && y >= top && y < top + innerHeight;
            rgba.set([white ? 255 : 0, white ? 255 : 0, white ? 255 : 0, 255], (y * width + x) * 4);
        }
    }
    return `data:image/png;base64,${encodePng(width, height, rgba).toString('base64')}`;
}

async function jobs() {
    const values = [];
    for (const type of ['receipt', 'kitchen']) {
        for (const { key } of listTemplateFixtures(type)) {
            const { artifact } = await compileTemplate(getBuiltinTemplate(type), getTemplateFixture(type, key), {
                mode: 'runtime', templateRevisionId: `builtin:${type}-v1`, printRequestedAt: '2026-09-17T00:00:00.000Z'
            });
            values.push({ name: key, print_type: type, data: { compiled_document_v1: artifact } });
        }
    }
    const longReceipt = getTemplateFixture('receipt', 'receipt-basic');
    const restaurantReceipt = getTemplateFixture('receipt', 'receipt-basic');
    restaurantReceipt.rows[0].name = 'وقية فوارغ مشوي';
    restaurantReceipt.rows[0].note = 'خبز حبة كاملة (+0.50)';
    restaurantReceipt.rows[1].name = 'وقية فوارغ مسلوق';
    const restaurantCompiled = await compileTemplate(getBuiltinTemplate('receipt'), restaurantReceipt, {
        mode: 'runtime', templateRevisionId: 'builtin:receipt-v1', printRequestedAt: '2026-09-22T11:50:00.000Z'
    });
    values.push({ name: 'receipt-restaurant-arabic', print_type: 'receipt', data: { compiled_document_v1: restaurantCompiled.artifact } });
    longReceipt.meta.invoiceDisplayNo = 'INV-2026-000000012345678';
    longReceipt.meta.orderDisplayNo = 'TAKEAWAY-123456789012345678';
    longReceipt.rows[0].name = 'DOUBLE CHICKEN SHAWARMA FAMILY PLATTER WITH FRIES SUPERCALIFRAGILISTICEXTRALONGPRODUCTTOKEN';
    longReceipt.rows[0].note = 'NO PICKLES, EXTRA GARLIC ON THE SIDE, CUT EACH WRAP IN HALF AND PACK THE SAUCES SEPARATELY';
    const longCompiled = await compileTemplate(getBuiltinTemplate('receipt'), longReceipt, {
        mode: 'runtime', templateRevisionId: 'builtin:receipt-v1', printRequestedAt: '2026-09-17T00:00:00.000Z'
    });
    values.push({ name: 'receipt-long-content', print_type: 'receipt', data: { compiled_document_v1: longCompiled.artifact } });
    const bilingualReceipt = getTemplateFixture('receipt', 'receipt-basic');
    bilingualReceipt.store.name = 'مَطْعَمُ الياسمين — Yasmine 🌯';
    bilingualReceipt.store.address = 'عمّان · Amman 2026';
    bilingualReceipt.rows[0].name = 'شاورما دجاج مميّزة — Premium Chicken Shawarma 123';
    bilingualReceipt.rows[0].note = 'بدون بصل، صوص إضافي، وتغليف منفصل · NO ONION, EXTRA SAUCE, PACK SEPARATELY';
    bilingualReceipt.rows[1].name = 'قهوة عربيّة ☕ Arabic Coffee';
    const bilingualCompiled = await compileTemplate(getBuiltinTemplate('receipt'), bilingualReceipt, {
        mode: 'runtime', templateRevisionId: 'builtin:receipt-v1', printRequestedAt: '2026-09-17T00:00:00.000Z'
    });
    values.push({ name: 'receipt-bilingual-hostile', print_type: 'receipt', data: { compiled_document_v1: bilingualCompiled.artifact } });
    const mixedPresentation = buildOrderPresentation({
        order: {
            invoice_id: 991, subtotal: 9.70, tax: 0, total: 9.70,
            discount_type: null, discount_value: 0, tax_inclusive_at_sale: 0,
            tax_exempt_at_sale: 0, tax_registration_type_at_sale: 'sales_tax',
            payment_method: 'cash', parent_invoice_id: null
        },
        items: [
            {
                id: 991, item_name: 'Chicken Shawarma', quantity: 1, price_at_sale: 6.20, tax_rate: 0,
                note: 'Size: Large (0.50 JD)\nNo onion, sauce on the side\nTwo slices (+0.20)',
                selected_modifiers: JSON.stringify([
                    { gid: 'size', oid: 'large', group: 'Size', option: 'Large', price: 0.5 },
                    { noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }
                ])
            },
            { id: 992, item_name: 'Iced Coffee', quantity: 1, price_at_sale: 3.50, tax_rate: 0, note: '' }
        ]
    });
    assert.equal(mixedPresentation.rows[0].note, 'No onion, sauce on the side\nSize: Large (0.50 JD)\nTwo slices (+0.20)');
    const mixedReceipt = getTemplateFixture('receipt', 'receipt-basic');
    for (const key of ['rows', 'summary', 'taxMode', 'status', 'currency', 'decimals']) mixedReceipt[key] = mixedPresentation[key];
    const mixedCompiled = await compileTemplate(getBuiltinTemplate('receipt'), mixedReceipt, {
        mode: 'runtime', templateRevisionId: 'builtin:receipt-v1', printRequestedAt: '2026-09-17T00:00:00.000Z'
    });
    values.push({ name: 'receipt-mixed-item-details', print_type: 'receipt', data: { compiled_document_v1: mixedCompiled.artifact } });
    const wideQuantityKitchen = getTemplateFixture('kitchen', 'kitchen-normal');
    wideQuantityKitchen.items[0].qty = 1234;
    wideQuantityKitchen.items[0].name = 'CHICKEN SHAWARMA';
    const wideQuantityCompiled = await compileTemplate(getBuiltinTemplate('kitchen'), wideQuantityKitchen, {
        mode: 'runtime', templateRevisionId: 'builtin:kitchen-v1', printRequestedAt: '2026-09-17T00:00:00.000Z'
    });
    values.push({ name: 'kitchen-wide-quantity', print_type: 'kitchen', data: { compiled_document_v1: wideQuantityCompiled.artifact } });
    const custom = getBuiltinTemplate('receipt');
    custom.bands.unshift({
        id: 'custom-logo-band', kind: 'once', layout: 'absolute', source: null, filter: null, visibleWhen: null, height: 128,
        nodes: [{
            id: 'custom-logo', type: 'store_logo', size: 128, style: { align: 'center' }, visibleWhen: null,
            x: 224, y: 0, widthPx: 128, heightPx: 128
        }]
    });
    custom.bands.push({
        id: 'custom-positioned-footer', kind: 'once', layout: 'absolute', source: null, filter: null, visibleWhen: null, height: 64,
        nodes: [
            { id: 'custom-left', type: 'text', text: { en: 'CUSTOM', ar: '', mode: 'auto' }, style: { fontWeight: 'black' }, visibleWhen: null, x: 0, y: 8, widthPx: 240, heightPx: 40 },
            { id: 'custom-right', type: 'text', text: { en: '', ar: 'مخصص', mode: 'auto' }, style: { align: 'right', direction: 'rtl', fontWeight: 'black' }, visibleWhen: null, x: 316, y: 8, widthPx: 240, heightPx: 40 }
        ]
    });
    const { artifact } = await compileTemplate(custom, getTemplateFixture('receipt', 'receipt-basic'), {
        mode: 'runtime', templateRevisionId: 9001,
        profile: { allowAbsoluteOnce: true, allowStoreLogo: true },
        storeLogoDataUri: pngDataUri(32, 128), printRequestedAt: '2026-09-17T00:00:00.000Z'
    });
    values.push({ name: 'receipt-custom-positioned-logo', print_type: 'receipt', data: { compiled_document_v1: artifact } });
    return values;
}

(async () => {
    const results = [];
    let queueId = 9800;
    const workload = await jobs();
    // Exercise actual Typst line boxes, not just generated source strings. Both
    // ascenders and descenders must leave an ink-free gap between wrapped lines.
    const spacingArtifact = structuredClone(workload[0].data.compiled_document_v1);
    spacingArtifact.nativeLayout.bands = [{ id: 'spacing', layout: 'flow', nodes: [{
        id: 'spacing-text', type: 'text', style: { fontSize: 'item', lineHeight: 1.2 }, value: [{ text: 'Ágjpq\nÁgjpq', direction: 'ltr' }]
    }] }];
    const spacingRender = await typst.render({ queue_id: 9799, print_type: 'receipt', data: { compiled_document_v1: spacingArtifact } });
    const spacingPath = path.join(outputRoot, 'line-spacing-regression.png');
    decodeArtifact(spacingRender.path, spacingPath);
    const spacingImage = decodePng(fs.readFileSync(spacingPath));
    const rgba = spacingImage.data;
    const inkRows = Array.from({ length: spacingImage.height }, (_, y) => {
        for (let x = 0; x < 576; x++) if (rgba[(y * 576 + x) * 4] === 0) return y;
        return null;
    }).filter(y => y !== null);
    const largestInternalGap = Math.max(...inkRows.slice(1).map((y, i) => y - inkRows[i] - 1));
    assert(largestInternalGap >= 5, `Ascenders and descenders need separation, found ${largestInternalGap} dots`);
    // Check separator clearance in the final printer dots, including Arabic
    // descenders and an item row (a grid), rather than just source margins.
    const dividerArtifact = structuredClone(workload[0].data.compiled_document_v1);
    dividerArtifact.nativeLayout.bands = [{ id: 'divider-spacing', layout: 'flow', nodes: [
        { id: 'last-item', type: 'row', layout: 'flow', style: { marginBottom: 4 }, nodes: [
            { id: 'name', type: 'text', style: {}, value: [{ text: 'وقية فوارغ مسلوق بالجميد', direction: 'rtl' }] },
            { id: 'price', type: 'text', style: { align: 'right' }, value: [{ text: '3.50 JD', direction: 'ltr' }] }
        ] },
        { id: 'rule', type: 'divider', variant: 'dashed', style: {} },
        { id: 'subtotal', type: 'text', style: {}, value: [{ text: 'Subtotal', direction: 'ltr' }] }
    ] }];
    const dividerRender = await typst.render({ queue_id: 9798, print_type: 'receipt', data: { compiled_document_v1: dividerArtifact } });
    const dividerPath = path.join(outputRoot, 'divider-spacing-regression.png');
    decodeArtifact(dividerRender.path, dividerPath);
    const dividerImage = decodePng(fs.readFileSync(dividerPath));
    const dividerPixels = dividerImage.data;
    const counts = Array.from({ length: dividerImage.height }, (_, y) => {
        let count = 0;
        for (let x = 0; x < 576; x++) if (dividerPixels[(y * 576 + x) * 4] === 0) count++;
        return count;
    });
    const ruleRows = counts.map((count, y) => count > 250 ? y : -1).filter(y => y >= 0);
    assert(ruleRows.length > 0, 'Separator must remain visible');
    const firstRule = ruleRows[0], lastRule = ruleRows.at(-1);
    const precedingInk = counts.slice(0, firstRule).findLastIndex(count => count > 0);
    const followingInk = counts.findIndex((count, y) => y > lastRule && count > 0);
    assert(precedingInk >= 0 && followingInk > lastRule, 'Text must remain on both sides of the separator');
    assert(firstRule - precedingInk - 1 >= 8, 'Last item needs at least eight clear dots before the rule');
    assert(followingInk - lastRule - 1 >= 8, 'Subtotal needs at least eight clear dots after the rule');
    for (const job of workload) {
        queueId += 1;
        const plan = buildTypstDocument(job);
        if (job.name === 'receipt-long-content') {
            const unwrapped = plan.source.replace(/\u200b/g, '');
            assert(unwrapped.includes('INV-2026-000000012345678'), 'long invoice identifier must remain complete');
            assert(unwrapped.includes('TAKEAWAY-123456789012345678'), 'long order identifier must remain complete');
        }
        const typstArtifact = await typst.render({ ...job, queue_id: queueId });
        const typstDecoded = decodeArtifact(typstArtifact.path, path.join(outputRoot, `${job.name}-typst.png`));
        assert.equal(typstArtifact.hash, crypto.createHash('sha256').update(typstDecoded.bytes).digest('hex'));
        assert(typstDecoded.blackRatio > 0.003 && typstDecoded.blackRatio < 0.5, `${job.name} Typst raster is blank or saturated`);
        assert.equal(typstDecoded.cuts, 1, `${job.name} Typst cut count`);
        assert.equal(typstDecoded.drawers, job.print_type === 'receipt' && job.data?.provisional !== true ? 1 : 0, `${job.name} drawer semantics`);
        assert.equal(typstDecoded.beeps, job.print_type === 'kitchen' ? 1 : 0, `${job.name} beep semantics`);
        if (job.name === 'receipt-accepted-jofotara' || job.name === 'receipt-custom-positioned-logo') {
            assert(plan.assets.length > 0, `${job.name} should retain its image asset`);
        }
        if (job.name === 'receipt-custom-positioned-logo') {
            assert(typstDecoded.topInk128 > 500, 'portrait logo should remain visible inside its positioned square');
            assert(plan.source.includes('width: 128pt, height: 128pt, fit: "contain"'));
        }
        if (job.name === 'kitchen-wide-quantity') {
            assert(plan.source.includes('columns: (auto, 86.5fr)'), 'wide kitchen quantities must receive an intrinsic column');
        }
        results.push({
            name: job.name,
            type: job.print_type,
            typst: { height: typstDecoded.height, bytes: typstArtifact.bytes, render_ms: typstArtifact.render_ms, black_ratio: typstDecoded.blackRatio },
            image_assets: plan.assets.length,
            alerts: { beeps: typstDecoded.beeps, drawers: typstDecoded.drawers, cuts: typstDecoded.cuts }
        });
    }
    const report = { result: 'pass', typstVersion: '0.15.1', workloadCount: results.length, results };
    fs.writeFileSync(path.join(outputRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await typst.close();
    fs.rmSync(typstState, { recursive: true, force: true });
});

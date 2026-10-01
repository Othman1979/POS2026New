const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodePng } = require('../v2/png');
const { buildTypstDocument } = require('../v2/compiled-document-typst');
const { createTypstRenderer, createTypstWatchCompiler, pngDimensions } = require('../v2/typst-renderer');
const { buildLegacyDocument } = require('../v2/legacy-document-typst');
const report200 = require('./fixtures/v2-report-200-rows');

const compiledReceipt = {
    version: 1,
    kind: 'compiled_document_v1',
    docType: 'receipt',
    widthPx: 576,
    templateRevisionId: 'builtin:receipt-v1',
    compilerVersion: 1,
    html: '<not-used-by-typst>',
    css: 'not-used-by-typst',
    nativeLayout: {
        version: 1, docType: 'receipt', widthPx: 576,
        bands: [{
            id: 'header', layout: 'flow', nodes: [
                { id: 'heading', type: 'text', value: [{ text: 'Cafe ', direction: 'ltr' }, { text: 'مرحبا 😀', direction: 'rtl' }], style: { fontSize: '2xl', fontWeight: 'black', align: 'center', offsetY: -2 } },
                { id: 'flow-row', type: 'row', layout: 'flow', style: {}, nodes: [
                    { id: 'flow-left', type: 'field', label: [], value: [{ text: 'Left', direction: 'auto' }], style: { width: 50 }, labelStyle: {}, valueStyle: {} },
                    { id: 'flow-right', type: 'field', label: [], value: [{ text: 'Right', direction: 'auto' }], style: { width: 50, align: 'right' }, labelStyle: {}, valueStyle: {} }
                ] },
                { id: 'row', type: 'row', layout: 'absolute', height: 40, style: {}, nodes: [
                    { id: 'left', type: 'field', label: [], value: [{ text: 'Left', direction: 'auto' }], style: {}, labelStyle: {}, valueStyle: {}, box: { x: 0, y: 0, width: 200, height: 36 } },
                    { id: 'right', type: 'field', label: [], value: [{ text: 'Right', direction: 'auto' }], style: { align: 'right' }, labelStyle: {}, valueStyle: {}, box: { x: 300, y: 0, width: 256, height: 36 } }
                ] }
            ]
        }]
    }
};

// RGBA test image; paint(x, y) returns [r, g, b, a]. The default is transparent black, like a blank canvas.
function makePng(width, height, paint = () => [0, 0, 0, 0]) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set(paint(x, y), (y * width + x) * 4);
    return encodePng(width, height, rgba);
}

function fakeTypst({ height = 180, watchDelayMs = 0 } = {}) {
    const calls = [];
    const spawnImpl = (executable, args, options) => {
        calls.push({ executable, args, options });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        const source = args.at(-2);
        const output = args.at(-1);
        let watcher;
        let stopped = false;
        const compile = () => {
            if (stopped) return;
            const sourceText = fs.readFileSync(source, 'utf8');
            const bottomMargin = sourceText.includes('bottom: 200pt') ? 200 : 60;
            const pageHeight = bottomMargin === 200 ? height + 140 : height;
            const token = sourceText.match(/posapp-render-token:([a-f0-9]{32})/)?.[1];
            const tokenBits = token ? `10110010${[...token].map(character => Number.parseInt(character, 16).toString(2).padStart(4, '0')).join('')}01001101` : '';
            fs.writeFileSync(output, makePng(576, pageHeight, (x, y) => {
                let black = x >= 10 && x < 130 && y >= 10 && y < 30;
                const index = Math.floor((x - 10) / 3);
                if (tokenBits && x >= 10 && index < tokenBits.length && y >= pageHeight - bottomMargin - 6 && y < pageHeight - bottomMargin - 2) black = tokenBits[index] === '1';
                return black ? [0, 0, 0, 255] : [255, 255, 255, 255];
            }));
            child.stderr.emit('data', Buffer.from('[00:00:00] compiled successfully in 1 ms\n'));
        };
        watcher = fs.watch(source, () => setTimeout(compile, watchDelayMs));
        child.kill = () => {
            if (stopped) return true;
            stopped = true;
            watcher.close();
            setImmediate(() => child.emit('exit', null, 'SIGKILL'));
            return true;
        };
        setImmediate(compile);
        return child;
    };
    return { calls, spawnImpl };
}

const planned = buildTypstDocument({ print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } });
assert.strictEqual(planned.width, 576);
assert(planned.source.includes('page(width: 576pt'));
assert(planned.source.includes('"Noto Sans Arabic"'));
assert(planned.source.includes('Noto Sans Arabic'));
assert(planned.source.includes('Noto Emoji'));
assert(planned.source.includes('place(top + left'));
assert(planned.source.includes('مرحبا 😀'));
assert(planned.source.includes('#move(dy: -2pt)'));
assert(planned.source.includes('align: top'));
assert(planned.source.includes('columns: (1fr, auto)'));
assert(planned.source.includes('#block(width: auto'));
assert(!planned.source.includes('not-used-by-typst'));
assert(
    planned.source.includes('#block(width: 100%, height: 40pt, above: 0pt, below: 0pt, clip: true)'),
    'CSS blocks without margins must suppress Typst default block spacing'
);
assert.strictEqual(planned.assets.length, 0);
const legacyIcoArtifact = structuredClone(compiledReceipt);
legacyIcoArtifact.nativeLayout.bands[0].nodes.push({
    id: 'legacy-logo', type: 'image', imageType: 'logo', size: 64,
    dataUri: 'data:image/x-icon;base64,AA==', style: {}
});
const plannedLegacyIco = buildTypstDocument({
    print_type: 'receipt',
    data: { compiled_document_v1: legacyIcoArtifact }
});
assert.strictEqual(plannedLegacyIco.assets.length, 0, 'legacy ICO logos must not reach Typst');
assert(!plannedLegacyIco.source.includes('.ico'), 'legacy ICO logos must not make the receipt fail');
const portraitLogoArtifact = structuredClone(compiledReceipt);
portraitLogoArtifact.nativeLayout.bands[0].nodes.push({
    id: 'portrait-logo', type: 'image', imageType: 'logo', size: 64,
    dataUri: `data:image/png;base64,${makePng(32, 128).toString('base64')}`,
    style: {}
});
const plannedPortraitLogo = buildTypstDocument({
    print_type: 'receipt',
    data: { compiled_document_v1: portraitLogoArtifact }
});
assert(
    plannedPortraitLogo.source.includes('width: 64pt, height: 64pt, fit: "contain"'),
    'logos must preserve their aspect ratio inside the configured square'
);
const kitchenQuantityArtifact = structuredClone(compiledReceipt);
kitchenQuantityArtifact.docType = 'kitchen';
kitchenQuantityArtifact.templateRevisionId = 'builtin:kitchen-v1';
kitchenQuantityArtifact.nativeLayout.docType = 'kitchen';
kitchenQuantityArtifact.nativeLayout.bands[0].nodes[1] = {
    id: 'kitchen-item', type: 'row', layout: 'flow', style: {}, nodes: [
        {
            id: 'quantity', type: 'field', label: [], value: [{ text: '1234x', direction: 'ltr' }],
            kitchenRole: 'quantity', style: { width: 13.5 }, labelStyle: {}, valueStyle: {}
        },
        {
            id: 'name', type: 'field', label: [], value: [{ text: 'CHICKEN SHAWARMA', direction: 'ltr' }],
            kitchenRole: 'name', style: { width: 86.5 }, labelStyle: {}, valueStyle: {}
        }
    ]
};
const plannedKitchenQuantity = buildTypstDocument({
    print_type: 'kitchen',
    data: { compiled_document_v1: kitchenQuantityArtifact }
});
assert(
    plannedKitchenQuantity.source.includes('columns: (auto, 86.5fr)'),
    'kitchen quantity columns must grow with their content instead of using the template percentage'
);
assert(
    plannedKitchenQuantity.source.includes('#block(width: auto, above: 0pt, below: 0pt, inset: (right: 12pt))'),
    'kitchen quantity width must include its trailing padding'
);
assert(
    plannedKitchenQuantity.source.includes('box(width: calc.max(75pt, measure(cell).width))'),
    'short kitchen quantities must retain the existing minimum column width'
);
const semiboldArtifact = structuredClone(compiledReceipt);
semiboldArtifact.nativeLayout.bands[0].nodes[1].nodes[0].valueStyle.fontWeight = 'bold';
const plannedSemibold = buildTypstDocument({
    print_type: 'receipt',
    data: { compiled_document_v1: semiboldArtifact }
});
assert(plannedSemibold.source.includes('weight: 600'));
assert(!plannedSemibold.source.includes('IBM Plex'));
const apartArtifact = structuredClone(compiledReceipt);
apartArtifact.nativeLayout.bands[0].nodes[1].nodes[0].label = [{ text: 'Cashier', direction: 'ltr' }];
apartArtifact.nativeLayout.bands[0].nodes[1].nodes[0].style.labelLayout = 'apart';
const plannedApart = buildTypstDocument({
    print_type: 'receipt',
    data: { compiled_document_v1: apartArtifact }
});
assert(plannedApart.source.includes('#grid(columns: (1fr, auto)'), 'apart labels must remain native Typst grids');
const longToken = 'SUPERCALIFRAGILISTICEXTRALONGPRODUCTTOKEN';
const longTokenArtifact = structuredClone(compiledReceipt);
longTokenArtifact.nativeLayout.bands[0].nodes[1].nodes[1].value[0].text = longToken;
const plannedLongToken = buildTypstDocument({
    print_type: 'receipt',
    data: { compiled_document_v1: longTokenArtifact }
});
assert(
    plannedLongToken.source.includes([...longToken].join('\u200b')),
    'long unbroken ASCII text must receive invisible line-break opportunities'
);
assert.throws(
    () => {
        const forged = structuredClone(compiledReceipt);
        forged.nativeLayout.bands[0].nodes[0].style.rotation = 1;
        buildTypstDocument({ print_type: 'receipt', data: { compiled_document_v1: forged } });
    },
    error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED'
);

const png = makePng(576, 12);
assert.deepStrictEqual(pngDimensions(png), { width: 576, height: 12 });
assert.throws(() => pngDimensions(Buffer.from('not a png')), error => error.code === 'TYPST_OUTPUT_INVALID');

const legacyReceiptData = {
    storeInfo: { store_name: 'Cafe', store_address: 'Amman', store_phone: '079', receipt_config: '{"customFooterText":"Come again"}' },
    date: '2026-09-25T12:00:00Z', invoice_display_no: 'R-7', order_id: 7, order_display_no: 'D-7',
    cashier: 'Cashier', customer_name: 'مريم', customer_phone: '0791', note: 'No cutlery',
    items: [{ name: 'Shawarma', qty: 2, price: 3, tax_rate: 16, note: 'Extra sauce' }],
    subtotal: 6, tax: 0.96, total: 6.96, payment_method: 'cash', amount_tendered: 10, change_due: 3.04
};
const legacyReceipt = buildLegacyDocument({ print_type: 'receipt', data: legacyReceiptData });
for (const phrase of ['Cafe', 'Invoice: R-7', 'Order: #D-7', 'Customer: مريم', 'Extra sauce', 'Subtotal', 'Tax', '6.96 JD', 'Come again']) {
    assert(legacyReceipt.source.includes(phrase), `legacy receipt keeps ${phrase}`);
}
assert(!legacyReceipt.source.includes('GUEST CHECK'));
const scaleReceipt = buildLegacyDocument({ print_type: 'receipt', data: {
    ...legacyReceiptData, items: [{ name: 'شاورما SUPERCALIFRAGILISTICEXTRALONGPRODUCTTOKEN', qty: 1.125, price: 3, discountType: 'percent', discountValue: 10, note: 'بدون بصل\nExtra sauce' }]
} });
assert(scaleReceipt.source.includes('1.125x'), 'legacy scale quantities keep the third decimal');
assert(scaleReceipt.source.includes('Discount Off'), 'legacy discounted rows name the discount');
assert(scaleReceipt.source.includes('dir: auto'), 'mixed Arabic/Latin text retains automatic bidi direction');
assert(scaleReceipt.source.includes('بدون بصل') && scaleReceipt.source.includes('Extra sauce'), 'multiline Arabic notes retain every line');
assert(scaleReceipt.source.includes([...('SUPERCALIFRAGILISTICEXTRALONGPRODUCTTOKEN')].join('\u200b')), 'long ASCII names have wrap opportunities');
const provisionalLegacy = buildLegacyDocument({ print_type: 'receipt', data: {
    ...legacyReceiptData, provisional: true, invoice_id: 'GUEST CHECK', table_number: '4'
} });
assert(provisionalLegacy.source.includes('GUEST CHECK'));
assert(provisionalLegacy.source.includes('Table: 4'));
assert(!provisionalLegacy.source.includes('Invoice: R-7'));
assert(!provisionalLegacy.source.includes('Tendered'));
const legacyKitchen = buildLegacyDocument({ print_type: 'kitchen', data: {
    held_order: true, order_id: 7, order_display_no: 'D-7', follow_up: true, follow_up_sequence: 2,
    date: '2026-09-25T12:00:00Z', items: [{ qty: 1, name: 'Burger', note: 'No onion', _bundleLabel: 'Meal' }, { qty: 2, name: 'Fries', _isOther: true }]
} });
for (const phrase of ['FOLLOW UP', 'Order: #D-7', 'Burger', 'No onion', 'ALSO ON ORDER', 'Fries']) assert(legacyKitchen.source.includes(phrase));
assert.strictEqual(legacyKitchen.bottomMargin, 200);
assert.throws(() => buildLegacyDocument({ print_type: 'receipt', data: { ...legacyReceiptData, compiled_document_v1: {
    templateRevisionId: 'revision:3', html: '<main></main>'
} } }), error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED');
assert.throws(() => buildLegacyDocument({ print_type: 'receipt', data: { compiled_document_v1: { templateRevisionId: 'builtin:receipt-v1' } } }), error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED');
assert.throws(() => buildLegacyDocument({ print_type: 'receipt', data: {
    ...legacyReceiptData, compiled_document_v1: { ...compiledReceipt, nativeLayout: { version: 2 } }
} }), error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-renderer-'));
    const typst = fakeTypst();
    const renderer = createTypstRenderer({
        stateRoot: root,
        executable: 'controlled-typst.exe',
        fontPath: 'controlled-fonts',
        spawnImpl: typst.spawnImpl
    });
    try {
        assert.strictEqual(renderer.supports({ print_type: 'receipt', data: { ...legacyReceiptData, compiled_document_v1: { ...compiledReceipt, nativeLayout: undefined } } }), true, 'legacy structured jobs select Typst');
        assert.strictEqual(renderer.supports({ print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } }), true, 'native compiled jobs select Typst');
        const artifact = await renderer.render({ queue_id: 7501, print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } });
        const bytes = fs.readFileSync(artifact.path);
        assert.strictEqual(artifact.renderer, 'typst');
        assert.strictEqual(artifact.width, 576);
        assert.strictEqual(artifact.height, 172);
        assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), artifact.hash);
        assert(bytes.includes(Buffer.from([0x1b, 0x70])), 'paid receipts retain the drawer pulse');
        assert(bytes.includes(Buffer.from([0x1d, 0x56])), 'Typst artifacts retain the cut command');
        assert(typst.calls[0].args.includes('--jobs') && typst.calls[0].args.includes('1'), 'Typst compilation stays single-threaded');
        assert(typst.calls[0].args.includes('--ignore-system-fonts'), 'Typst avoids scanning customer fonts');
        await renderer.render({ queue_id: 7502, print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } });
        const legacyArtifact = await renderer.render({ queue_id: 7504, print_type: 'receipt', data: legacyReceiptData });
        assert.strictEqual(legacyArtifact.renderer, 'typst');
        const provisionalArtifact = await renderer.render({ queue_id: 7506, print_type: 'receipt', data: { ...legacyReceiptData, provisional: true } });
        assert(!fs.readFileSync(provisionalArtifact.path).includes(Buffer.from([0x1b, 0x70])), 'unpaid legacy guest checks must not pulse the cash drawer');
        const kitchenArtifact = await renderer.render({ queue_id: 7505, print_type: 'kitchen', data: {
            date: '2026-09-25T12:00:00Z', items: [{ qty: 1, name: 'Burger' }]
        } });
        assert.strictEqual(kitchenArtifact.height, 312, 'kitchen nonce uses its 200pt footer margin');
        assert.strictEqual(typst.calls.length, 1, 'one Typst watcher serves a sustained print run');
        assert.strictEqual(fs.readdirSync(path.join(root, 'typst-runtime')).filter(name => name.startsWith('assets-')).length, 1, 'only the current image directory is retained');
    } finally {
        await renderer.close();
        fs.rmSync(root, { recursive: true, force: true });
    }

    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-report-'));
    const reportTypst = fakeTypst();
    const reportRenderer = createTypstRenderer({
        stateRoot: reportRoot,
        executable: 'controlled-typst.exe', fontPath: 'controlled-fonts', spawnImpl: reportTypst.spawnImpl
    });
    try {
        assert(reportRenderer.supports(report200), 'large reports select Typst');
        const reportArtifact = await reportRenderer.render(report200);
        assert(reportArtifact.height > 172, 'large report rasterizes multiple bounded pages');
        const bytes = fs.readFileSync(reportArtifact.path);
        assert.strictEqual(bytes.filter((value, index) => value === 0x1d && bytes[index + 1] === 0x56).length, 1, 'report has one cut');
        assert.strictEqual(reportTypst.calls.length, 1, 'one watcher compiles report pages in order');
    } finally {
        await reportRenderer.close();
        fs.rmSync(reportRoot, { recursive: true, force: true });
    }

    const timedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-timing-'));
    const timedTypst = fakeTypst({ watchDelayMs: 80 });
    const timedRenderer = createTypstRenderer({
        stateRoot: timedRoot, executable: 'controlled-typst.exe', fontPath: 'controlled-fonts', spawnImpl: timedTypst.spawnImpl
    });
    try {
        const timed = await timedRenderer.render({ queue_id: 7507, print_type: 'receipt', data: legacyReceiptData });
        assert(timed.render_ms - timed.raster_ms >= 60, 'raster_ms excludes Typst compile latency');
    } finally {
        await timedRenderer.close();
        fs.rmSync(timedRoot, { recursive: true, force: true });
    }

    const shortWriteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-short-write-'));
    const shortWriteTypst = fakeTypst();
    const shortWriteRenderer = createTypstRenderer({
        stateRoot: shortWriteRoot, executable: 'controlled-typst.exe', fontPath: 'controlled-fonts', spawnImpl: shortWriteTypst.spawnImpl
    });
    const originalWrite = fs.writeSync;
    let partialWrites = 0;
    try {
        fs.writeSync = (fd, buffer, offset = 0, length = buffer.length - offset, position = null) => {
            partialWrites += 1;
            return originalWrite(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        };
        const artifact = await shortWriteRenderer.render({ queue_id: 7510, print_type: 'receipt', data: legacyReceiptData });
        const bytes = fs.readFileSync(artifact.path);
        assert(partialWrites > 2, 'the injected short-write path was exercised');
        assert.strictEqual(bytes.length, artifact.bytes, 'published length matches complete file');
        assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), artifact.hash, 'published hash matches complete file');
        assert(bytes.subarray(-6).equals(Buffer.from([10, 10, 10, 29, 86, 0])), 'cut tail survives short writes');
    } finally {
        fs.writeSync = originalWrite;
        await shortWriteRenderer.close();
        fs.rmSync(shortWriteRoot, { recursive: true, force: true });
    }

    const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-report-partial-'));
    const partialTypst = fakeTypst();
    const partial = createTypstRenderer({
        stateRoot: partialRoot, executable: 'controlled-typst.exe', fontPath: 'controlled-fonts', spawnImpl: partialTypst.spawnImpl,
        limits: { maxTotalHeight: 300 }
    });
    try {
        await assert.rejects(partial.render(report200), error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED');
        assert.deepStrictEqual(fs.readdirSync(path.join(partialRoot, 'artifacts')), [], 'partial report never publishes an artifact');
        assert(!fs.existsSync(path.join(partialRoot, 'typst-runtime')), 'failed multipage render cleans transient source and assets');
    } finally {
        await partial.close();
        fs.rmSync(partialRoot, { recursive: true, force: true });
    }

    const tallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-tall-'));
    const tall = fakeTypst({ height: 185 });
    const bounded = createTypstRenderer({
        stateRoot: tallRoot,
        executable: 'controlled-typst.exe',
        fontPath: 'controlled-fonts',
        limits: { maxHeight: 180 },
        spawnImpl: tall.spawnImpl
    });
    try {
        await assert.rejects(
            bounded.render({ queue_id: 7502, print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } }),
            error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED'
        );
        assert.strictEqual(fs.readdirSync(path.join(tallRoot, 'artifacts')).length, 0);
    } finally {
        await bounded.close();
        fs.rmSync(tallRoot, { recursive: true, force: true });
    }

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-stale-'));
    const stalePng = makePng(576, 180);
    const stale = createTypstRenderer({
        stateRoot: staleRoot,
        compilerFactory: () => ({ compile: async () => stalePng, close: async () => {}, health: () => ({ state: 'ready' }) })
    });
    try {
        await assert.rejects(
            stale.render({ queue_id: 7503, print_type: 'receipt', data: { compiled_document_v1: compiledReceipt } }),
            error => error.code === 'TYPST_OUTPUT_INVALID' && /stale or invalid/.test(error.message)
        );
        assert.strictEqual(fs.readdirSync(path.join(staleRoot, 'artifacts')).length, 0, 'stale Typst output must never become a printer artifact');
    } finally {
        await stale.close();
        fs.rmSync(staleRoot, { recursive: true, force: true });
    }

    const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-cleanup-'));
    let cleanupChild;
    let successfulJobCompiles = 0;
    const cleanupCompiler = createTypstWatchCompiler({
        stateRoot: cleanupRoot,
        executable: 'controlled-typst.exe',
        fontPath: 'controlled-fonts',
        limits: { compileMs: 1000, maxDiagnosticsBytes: 1024 },
        spawnImpl: (_executable, args) => {
            const child = new EventEmitter();
            child.stderr = new EventEmitter();
            const source = args.at(-2);
            const output = args.at(-1);
            let stopped = false;
            const compile = () => {
                if (stopped) return;
                const contents = fs.readFileSync(source, 'utf8');
                const ready = contents.includes('Typst ready');
                const succeeds = ready || successfulJobCompiles++ === 0;
                if (succeeds) fs.writeFileSync(output, Buffer.from('controlled png bytes'));
                child.stderr.emit('data', Buffer.from(succeeds
                    ? '[00:00:00] compiled successfully in 1 ms\n'
                    : '[00:00:00] compiled with errors\n'));
            };
            const watcher = fs.watch(source, () => setImmediate(compile));
            child.kill = () => {
                stopped = true;
                watcher.close();
                setImmediate(() => child.emit('exit', null, 'SIGKILL'));
                return true;
            };
            cleanupChild = child;
            setImmediate(compile);
            return child;
        }
    });
    try {
        await cleanupCompiler.compile({
            source: '#text("valid")',
            assets: [{ name: 'render-token.png', bytes: Buffer.from('asset') }],
            assetPrefix: 'assets-last-success',
            renderToken: 'b'.repeat(32)
        });
        for (const assetPrefix of ['assets-failed-one', 'assets-failed-two']) {
            await assert.rejects(
                cleanupCompiler.compile({
                    source: '#text("broken")',
                    assets: [{ name: 'render-token.png', bytes: Buffer.from('asset') }],
                    assetPrefix,
                    renderToken: 'a'.repeat(32)
                }),
                error => error.code === 'TYPST_RENDER_FAILED'
            );
            assert.strictEqual(
                fs.readdirSync(path.join(cleanupRoot, 'typst-runtime')).filter(name => name.startsWith('assets-')).length,
                1,
                'failed live-watcher compiles must retain only the last successful asset directory'
            );
            assert(fs.existsSync(path.join(cleanupRoot, 'typst-runtime', 'assets-last-success')));
        }
        assert(cleanupChild, 'the watcher must remain alive while failed job assets are cleaned');
    } finally {
        await cleanupCompiler.close();
        fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }

    console.log('typst-renderer tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

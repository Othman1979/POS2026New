const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { encodeRasterBands } = require('../thermal-raster');
const { decodePng, encodePng } = require('./png');
const { getKitchenBeepConfig, getReceiptBeepConfig } = require('../printer-alerts');
const { buildTypstDocument } = require('./compiled-document-typst');
const { buildLegacyDocument } = require('./legacy-document-typst');
const { supportsReport, buildReportDocuments } = require('./report-typst');

const WIDTH = 576;
const CASH_DRAWER_PULSE = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
const PRINT_TAIL = Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]);
// The first start loads the fonts and compiles once; that is slower than any later compile.
const START_MS_MINIMUM = 30000;
const DEFAULT_LIMITS = {
    compileMs: 10000,
    clipRows: 256,
    maxBytes: 16 * 1024 * 1024,
    maxPngBytes: 32 * 1024 * 1024,
    maxHeight: 12000,
    maxPages: 24,
    maxTotalHeight: 200000,
    maxRenderMs: 120000,
    maxDiagnosticsBytes: 64 * 1024
};

function classified(code, failureClass, message = code) {
    const error = new Error(message);
    error.code = code;
    error.failureClass = failureClass;
    return error;
}

function alertChunks(printType, data, env) {
    const chunks = [];
    const beep = printType === 'kitchen' ? getKitchenBeepConfig(env)
        : printType === 'receipt' ? getReceiptBeepConfig(env) : null;
    if (beep?.enabled) chunks.push(Buffer.from([0x1b, 0x42, beep.count & 0xff, beep.duration & 0xff]));
    const drawer = (printType === 'receipt' && data?.provisional !== true)
        || (['expense_slip', 'expense_cancel_slip'].includes(printType) && data?.source === 'drawer');
    if (drawer) chunks.push(CASH_DRAWER_PULSE);
    return chunks;
}

function pngDimensions(bytes) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
        throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst did not produce a valid PNG.');
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function defaultTypstPaths() {
    const runtimeRoot = path.join(__dirname, '..', '.cache', 'typst', '0.15.1');
    return {
        executable: path.join(runtimeRoot, process.platform === 'win32' ? 'typst.exe' : 'typst'),
        fontPath: path.join(runtimeRoot, 'fonts')
    };
}

function renderTokenBits(renderToken) {
    if (!/^[a-f0-9]{32}$/.test(renderToken)) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst render token is invalid.');
    const tokenBits = [...renderToken].map(character => Number.parseInt(character, 16).toString(2).padStart(4, '0')).join('');
    return `10110010${tokenBits}01001101`;
}

function renderTokenSource(renderToken, assetPrefix) {
    renderTokenBits(renderToken);
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(assetPrefix)) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst asset prefix is invalid.');
    return `// posapp-render-token:${renderToken}\n#block(width: 100%, height: 8pt)[#align(left)[#image("${assetPrefix}/render-token.png", width: 432pt, height: 8pt)]]`;
}

function renderTokenAsset(renderToken) {
    const bits = renderTokenBits(renderToken);
    const pixels = Buffer.alloc(432 * 8 * 4, 0xff);
    for (let index = 0; index < bits.length; index += 1) {
        if (bits[index] !== '1') continue;
        for (let y = 2; y < 6; y += 1) {
            for (let x = index * 3; x < index * 3 + 3; x += 1) pixels.fill(0, (y * 432 + x) * 4, (y * 432 + x) * 4 + 3);
        }
    }
    return encodePng(432, 8, pixels);
}

function verifyRenderToken(image, dimensions, renderToken, bottomMargin = 60) {
    const sentinelHeight = 8;
    const top = dimensions.height - bottomMargin - sentinelHeight;
    if (top < 0) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst render token is missing.');
    const pixels = image.data;
    const actual = [...renderTokenBits(renderToken)].map((_, index) => {
        const pixel = ((top + 3) * WIDTH + 10 + index * 3 + 1) * 4;
        return pixels[pixel] < 128 && pixels[pixel + 1] < 128 && pixels[pixel + 2] < 128 ? '1' : '0';
    }).join('');
    if (actual !== renderTokenBits(renderToken)) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst returned stale or invalid output.');
    return { top, height: sentinelHeight };
}

// The raster thresholds against a white page, so blend any transparent pixels onto white first.
function flattenOnWhite(data) {
    for (let i = 3; i < data.length; i += 4) {
        const alpha = data[i];
        if (alpha === 255) continue;
        const inverse = 255 - alpha;
        data[i - 3] = Math.round((data[i - 3] * alpha + 255 * inverse) / 255);
        data[i - 2] = Math.round((data[i - 2] * alpha + 255 * inverse) / 255);
        data[i - 1] = Math.round((data[i - 1] * alpha + 255 * inverse) / 255);
        data[i] = 255;
    }
}

function createTypstWatchCompiler({ stateRoot, executable, fontPath, limits, spawnImpl = spawn }) {
    const runtimeDirectory = path.join(stateRoot, 'typst-runtime');
    const sourcePath = path.join(runtimeDirectory, 'document.typ');
    const pngPath = path.join(runtimeDirectory, 'document.png');
    let child = null;
    let starting = null;
    let pending = null;
    let diagnostics = '';
    let failureTimer = null;
    let activeAssetPrefix = null;
    let closing = false;

    async function removeRuntimeDirectory() {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                fs.rmSync(runtimeDirectory, { recursive: true, force: true });
                return;
            } catch (error) {
                if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt === 7) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    function stopChild() {
        const current = child;
        child = null;
        if (current) {
            try { current.kill('SIGKILL'); } catch {}
        }
    }

    function finish(error) {
        if (!pending) return;
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        clearTimeout(failureTimer);
        failureTimer = null;
        if (error) current.reject(error);
        else current.resolve();
    }

    function waitForCompile(write, timeoutMs = limits.compileMs) {
        if (pending) return Promise.reject(classified('TYPST_RENDER_FAILED', 'transient_safe', 'Typst received overlapping compile work.'));
        diagnostics = '';
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                stopChild();
                finish(classified('TYPST_TIMEOUT', 'transient_safe', 'Typst rendering timed out.'));
            }, timeoutMs);
            pending = { resolve, reject, timer };
        });
        try { write?.(); }
        catch (error) { finish(error); }
        return promise;
    }

    function onDiagnostics(chunk) {
        const text = Buffer.from(chunk).toString('utf8');
        diagnostics = `${diagnostics}${text}`.slice(-limits.maxDiagnosticsBytes);
        if (!pending) return;
        if (/compiled successfully in [^\r\n]+/i.test(diagnostics)) {
            finish();
            return;
        }
        if (/compiled with errors/i.test(diagnostics) && !failureTimer) {
            // Typst writes the error detail immediately after the outcome marker.
            // Give that final chunk one turn before building the bounded diagnostic.
            failureTimer = setTimeout(() => {
                finish(classified('TYPST_RENDER_FAILED', 'transient_safe', 'Typst compilation failed.'));
            }, 25);
        }
    }

    async function start() {
        // child is assigned before the start-up compile finishes: wait for that compile
        // instead of treating the compiler as ready and overlapping it.
        if (starting) return starting;
        if (child) return;
        starting = (async () => {
            fs.rmSync(runtimeDirectory, { recursive: true, force: true });
            fs.mkdirSync(runtimeDirectory, { recursive: true });
            fs.writeFileSync(sourcePath, '#set page(width: 576pt, height: auto)\nTypst ready', { encoding: 'utf8', mode: 0o600 });
            const ready = waitForCompile(undefined, Math.max(limits.compileMs * 3, START_MS_MINIMUM));
            try {
                child = spawnImpl(executable, [
                    'watch', '--ppi', '72', '--jobs', '1', '--ignore-system-fonts',
                    '--font-path', fontPath, '--root', runtimeDirectory, '--creation-timestamp', '0',
                    sourcePath, pngPath
                ], { cwd: runtimeDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
            } catch (error) {
                finish(classified('TYPST_UNAVAILABLE', 'transient_safe', error.message));
                throw await ready;
            }
            child.stderr?.on('data', onDiagnostics);
            child.once('error', error => {
                child = null;
                finish(classified(error.code === 'ENOENT' ? 'TYPST_UNAVAILABLE' : 'TYPST_RENDER_FAILED', 'transient_safe', error.message));
            });
            child.once('exit', (code, signal) => {
                child = null;
                if (!closing) finish(classified('TYPST_RENDER_FAILED', 'transient_safe', `Typst stopped with ${code ?? signal}.`));
            });
            await ready;
        })().finally(() => { starting = null; });
        return starting;
    }

    async function compile({ source, assets, assetPrefix, renderToken }) {
        await start();
        const assetDirectory = path.join(runtimeDirectory, assetPrefix);
        try {
            fs.mkdirSync(assetDirectory, { recursive: true });
            for (const asset of assets) fs.writeFileSync(path.join(assetDirectory, asset.name), asset.bytes, { mode: 0o600 });
            const guardedSource = `${source}\n${renderTokenSource(renderToken, assetPrefix)}\n`;
            await waitForCompile(() => fs.writeFileSync(sourcePath, guardedSource, { encoding: 'utf8', mode: 0o600 }));
            const png = fs.readFileSync(pngPath);
            const previousAssetPrefix = activeAssetPrefix;
            activeAssetPrefix = assetPrefix;
            if (previousAssetPrefix && previousAssetPrefix !== assetPrefix) {
                fs.rmSync(path.join(runtimeDirectory, previousAssetPrefix), { recursive: true, force: true });
            }
            return png;
        } catch (error) {
            try { fs.rmSync(assetDirectory, { recursive: true, force: true }); } catch {}
            if (!child) {
                try { await removeRuntimeDirectory(); } catch {}
                activeAssetPrefix = null;
            }
            throw error;
        }
    }

    async function close() {
        closing = true;
        clearTimeout(failureTimer);
        finish(classified('TYPST_RENDER_FAILED', 'transient_safe', 'Typst renderer closed.'));
        const current = child;
        stopChild();
        if (current) await Promise.race([
            new Promise(resolve => current.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 1000))
        ]);
        await removeRuntimeDirectory();
    }

    return { compile, warm: start, close, health: () => ({ state: starting ? 'starting' : child ? 'ready' : 'cold' }) };
}

function createTypstRenderer({ stateRoot, executable, fontPath, limits = {}, env = process.env, spawnImpl = spawn, compilerFactory = createTypstWatchCompiler }) {
    const defaults = defaultTypstPaths();
    const typstExecutable = executable || defaults.executable;
    const typstFontPath = fontPath || defaults.fontPath;
    const settings = { ...DEFAULT_LIMITS, ...limits };
    const artifactsDirectory = path.join(stateRoot, 'artifacts');
    fs.mkdirSync(artifactsDirectory, { recursive: true });
    let compiler = null;
    let serial = Promise.resolve();
    let rendering = false;
    let lastError = null;

    function newCompiler() {
        return compilerFactory({ stateRoot, executable: typstExecutable, fontPath: typstFontPath, limits: settings, spawnImpl });
    }

    function supports(job) {
        return supportsReport(job) || (['receipt', 'kitchen'].includes(job?.print_type) && !!job?.data);
    }

    async function renderOne(job) {
        if (!supports(job)) throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst does not support this print job.');
        const renderStartedAt = performance.now();
        const queueId = Number(job?.queue_id) || `local-${Date.now()}`;
        const sourceAssetPrefix = `assets-${crypto.randomUUID()}`;
        const temporary = path.join(artifactsDirectory, `${queueId}.${process.pid}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        let bytes = 0;
        let rasterMs = 0;
        let totalHeight = 0;
        let multiPage = false;
        const hash = crypto.createHash('sha256');

        function write(chunk) {
            if (bytes + chunk.length > settings.maxBytes) throw classified('ARTIFACT_TOO_LARGE', 'permanent_safe');
            let offset = 0;
            while (offset < chunk.length) {
                const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
                if (!Number.isInteger(written) || written <= 0) throw classified('ARTIFACT_WRITE_FAILED', 'transient_safe', 'Typst artifact write made no progress.');
                offset += written;
            }
            hash.update(chunk);
            bytes += chunk.length;
        }

        try {
            const native = job?.data?.compiled_document_v1?.nativeLayout;
            // Presence of a malformed native layout is an error. Old HTML-only
            // compiled jobs may use their frozen structured payload instead.
            const documents = supportsReport(job) ? buildReportDocuments(job, { assetPrefix: sourceAssetPrefix })
                : native !== undefined ? [buildTypstDocument(job, { assetPrefix: sourceAssetPrefix })]
                    : [buildLegacyDocument(job)];
            if (!Array.isArray(documents) || documents.length < 1 || documents.length > settings.maxPages) {
                throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst document page count exceeds the limit.');
            }
            multiPage = documents.length > 1;
            compiler ||= newCompiler();
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            let outputY = 0;
            for (const document of documents) {
                if (performance.now() - renderStartedAt > settings.maxRenderMs) throw classified('TYPST_TIMEOUT', 'transient_safe', 'Typst report exceeded the render time limit.');
                if (!document || document.width !== WIDTH || typeof document.source !== 'string' || !Array.isArray(document.assets)) {
                    throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst document is invalid.');
                }
                const assetPrefix = `assets-${crypto.randomUUID()}`;
                const renderToken = crypto.randomBytes(16).toString('hex');
                // Report/legacy sources can carry their own assets. Rebase only
                // the generated asset directory name, never the saved payload.
                const source = document.source.replaceAll(`${sourceAssetPrefix}/`, `${assetPrefix}/`);
                const assets = [...document.assets, { name: 'render-token.png', bytes: renderTokenAsset(renderToken) }];
                const png = await compiler.compile({ source, assets, assetPrefix, renderToken });
                const rasterStartedAt = performance.now();
                try {
                    if (png.length < 24 || png.length > settings.maxPngBytes) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst PNG size is invalid.');
                    const dimensions = pngDimensions(png);
                    if (dimensions.width !== WIDTH || dimensions.height < 1) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst PNG dimensions are invalid.');
                    if (dimensions.height > settings.maxHeight + 4) throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst page exceeds the bounded raster height.');
                    const image = decodePng(png);
                    if (image.width !== dimensions.width || image.height !== dimensions.height) throw classified('TYPST_OUTPUT_INVALID', 'transient_safe', 'Typst PNG could not be decoded.');
                    const bottomMargin = document.bottomMargin ?? (job.print_type === 'kitchen' ? 200 : 60);
                    if (!Number.isInteger(bottomMargin) || bottomMargin < 60 || bottomMargin > 300) throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst footer margin is invalid.');
                    const sentinel = verifyRenderToken(image, dimensions, renderToken, bottomMargin);
                    flattenOnWhite(image.data);
                    const printableHeight = dimensions.height - sentinel.height;
                    if (printableHeight > settings.maxHeight) throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst page exceeds the bounded raster height.');
                    totalHeight += printableHeight;
                    if (totalHeight > settings.maxTotalHeight) throw classified('TYPST_DOCUMENT_UNSUPPORTED', 'permanent_safe', 'Typst report exceeds the total raster height limit.');
                    for (const region of [
                        { start: 0, rows: sentinel.top },
                        { start: sentinel.top + sentinel.height, rows: dimensions.height - sentinel.top - sentinel.height }
                    ]) {
                        for (let row = 0; row < region.rows; row += settings.clipRows) {
                            const rows = Math.min(settings.clipRows, region.rows - row);
                            const first = region.start + row;
                            const pixels = { width: WIDTH, height: rows, data: image.data.subarray(first * WIDTH * 4, (first + rows) * WIDTH * 4) };
                            for (const band of encodeRasterBands(pixels, {
                                bandHeight: settings.clipRows,
                                // Thermal text benefits from contiguous strokes; ordered
                                // halftoning made small Arabic glyph edges visibly speckled.
                                mode: 'threshold',
                                originY: outputY
                            })) write(band);
                            outputY += rows;
                        }
                    }
                } finally {
                    rasterMs += performance.now() - rasterStartedAt;
                }
            }
            if (performance.now() - renderStartedAt > settings.maxRenderMs) throw classified('TYPST_TIMEOUT', 'transient_safe', 'Typst report exceeded the render time limit.');
            for (const chunk of alertChunks(job.print_type, job.data, env)) write(chunk);
            write(PRINT_TAIL);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = null;
            const digest = hash.digest('hex');
            const finalPath = path.join(artifactsDirectory, `${queueId}-${digest}.bin`);
            fs.renameSync(temporary, finalPath);
            lastError = null;
            return {
                path: finalPath,
                hash: digest,
                bytes,
                width: WIDTH,
                height: totalHeight,
                render_ms: performance.now() - renderStartedAt,
                raster_ms: rasterMs,
                renderer: 'typst'
            };
        } catch (error) {
            lastError = error.code || 'TYPST_RENDER_FAILED';
            if (multiPage && compiler) {
                try { await compiler.close(); } catch {}
                compiler = null;
            }
            if (['EACCES', 'ENOSPC', 'EPERM', 'EROFS'].includes(error.code)) {
                throw classified('ARTIFACT_WRITE_FAILED', 'transient_safe', error.message);
            }
            throw error.failureClass ? error : classified('TYPST_RENDER_FAILED', 'transient_safe', error.message);
        } finally {
            if (descriptor !== undefined && descriptor !== null) {
                try { fs.closeSync(descriptor); } catch {}
            }
            fs.rmSync(temporary, { force: true });
        }
    }

    function render(job) {
        const run = serial.then(async () => {
            rendering = true;
            try { return await renderOne(job); } finally { rendering = false; }
        });
        serial = run.catch(() => {});
        return run;
    }

    // Start the compiler ahead of the first ticket so it does not pay the cold start. A
    // failure is only recorded: the first real job starts it again and reports its own error.
    async function warm() {
        try {
            compiler ||= newCompiler();
            await compiler.warm?.();
        } catch (error) {
            lastError = error.code || 'TYPST_RENDER_FAILED';
        }
    }

    async function close() {
        await serial;
        await compiler?.close?.();
    }

    return {
        supports,
        render,
        warm,
        close,
        health: () => ({ state: rendering ? 'rendering' : compiler?.health?.().state || 'cold', last_error: lastError })
    };
}

module.exports = { createTypstRenderer, createTypstWatchCompiler, defaultTypstPaths, pngDimensions };

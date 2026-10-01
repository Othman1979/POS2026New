const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { compileTemplate } = require('../../services/printTemplateEngine');
const { buildReceiptDocumentModel, buildKitchenDocumentModel } = require('../../services/printDocumentModel');
const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');
const { resolveCompiledDocument } = require('../../../pos-spooler-printer/renderDocument');

const root = path.resolve(__dirname, '../../..');
const spoolerRoot = path.join(root, 'pos-spooler-printer');
const tracked = new Set(execFileSync('git', ['ls-files', '--', 'pos-spooler-printer'], {
    cwd: root,
    encoding: 'utf8'
}).trim().split(/\r?\n/).filter(Boolean));

const requiredFiles = [
    '.env.example',
    'beep-tester.js',
    'http-client.js',
    'package-lock.json',
    'package.json',
    'printer-alerts.js',
    'receipt-display.cjs',
    'renderDocument.js',
    'README.md',
    'report-html.js',
    'server.js',
    'thermal-raster.js',
    'v2/agent-identity.js',
    'v2/agent-runtime.js',
    'v2/raw-artifact-renderer.js',
    'v2/typst-renderer.js',
    'v2/compiled-document-typst.js',
    'v2/legacy-document-typst.js',
    'v2/report-typst.js',
    'v2/report-data.js',
    'v2/job-store.js',
    'v2/platform-helper.js',
    'v2/printer-transports.js',
    'v2/printer-workers.js',
    'v2/sync-client.js',
    'windows-helper/PosSpoolerPlatform.cs',
    'tests/beep-tester.test.js',
    'tests/http-client.test.js',
    'tests/printer-alerts.test.js',
    'tests/receipt-display.test.js',
    'tests/render-document.test.js',
    'tests/report-html.test.js',
    'tests/run-tests.js',
    'tests/spooler-report-rendering.test.js',
    'tests/thermal-raster.test.js',
    'tests/v2-agent-identity.test.js',
    'tests/fixtures/v2-report-200-rows.js',
    'tests/v2-job-store.test.js',
    'tests/v2-platform-helper.test.js',
    'tests/v2-printer-transports.test.js',
    'tests/v2-printer-workers.test.js',
    'tests/v2-sync-runtime.test.js',
    'vendor/request-disabled/index.js',
    'vendor/request-disabled/package.json'
];

describe('tracked POS spooler package', () => {
    it('tracks every source file required to deploy and test the spooler', () => {
        for (const relative of requiredFiles) {
            expect(fs.existsSync(path.join(spoolerRoot, relative)), relative).toBe(true);
            expect(tracked.has(`pos-spooler-printer/${relative}`), relative).toBe(true);
        }
    });

    it('never tracks machine secrets or generated runtime data', () => {
        for (const file of tracked) {
            if (file !== 'pos-spooler-printer/.env.example') {
                expect(file).not.toMatch(/(?:^|\/)(?:\.env(?:\..*)?|node_modules|\.cache)(?:\/|$)/);
            }
            expect(file).not.toMatch(/\.(?:pem|key|pfx|p12|zip)$/i);
        }
    });

    it('keeps every relative server import inside the tracked deployment package', () => {
        const source = fs.readFileSync(path.join(spoolerRoot, 'server.js'), 'utf8');
        const imports = [...source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)].map(match => match[1]);

        for (const request of imports) {
            const base = path.join(spoolerRoot, request);
            const resolved = [base, `${base}.js`, `${base}.cjs`, `${base}.json`].find(fs.existsSync);
            expect(resolved, request).toBeTruthy();
            const relative = path.relative(root, resolved).replace(/\\/g, '/');
            expect(tracked.has(relative), relative).toBe(true);
        }
    });

    it('owns a runnable syntax-and-test command', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(spoolerRoot, 'package.json'), 'utf8'));
        expect(pkg.main).toBe('server.js');
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.scripts?.test).toContain('node --check server.js');
        expect(pkg.scripts?.test).not.toContain('v2-server.js');
        expect(pkg.scripts?.['start:v2']).toBeUndefined();
        expect(pkg.dependencies).not.toHaveProperty('socket.io-client');
        expect(pkg.dependencies).not.toHaveProperty('escpos');
        expect(pkg.scripts?.test).toContain('tests/run-tests.js');
        for (const gone of ['v2-server.js', 'poll-fallback.js', 'durable-seen-store.js', 'receiptDisplayV1.cjs',
            'install.bat', 'uninstall.bat', 'install-service.js', 'uninstall-service.js']) {
            expect(fs.existsSync(path.join(spoolerRoot, gone)), gone).toBe(false);
        }
        expect(pkg.scripts?.['setup-browser']).toBeUndefined();
        expect(pkg.optionalDependencies?.puppeteer).toBeUndefined();
        expect(fs.existsSync(path.join(spoolerRoot, 'v2/artifact-renderer.js'))).toBe(false);
        expect(pkg.engines?.node).toBe('>=22.12.0');

        expect(pkg.devDependencies?.['node-windows']).toBeUndefined();
        expect(pkg.dependencies).not.toHaveProperty('node-windows');
    });

    it('packages the V2 source and compiles one Windows platform helper into the application layer', () => {
        const build = fs.readFileSync(path.join(root, 'scripts/build-installers.ps1'), 'utf8');
        expect(build).toContain("'v2', 'windows-helper'");
        expect(build).toContain('PosSpoolerPlatform.cs');
        expect(build).toContain('PosSpoolerPlatform.exe');
        expect(build).toContain('Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
        expect(build).not.toMatch(/pos-spooler-printer[\\/]runtime[\\/].*PosSpoolerPlatform/i);
    });

    it('accepts the receipt and kitchen artifact contract compiled by the backend', async () => {
        const cases = JSON.parse(fs.readFileSync(path.join(root, 'backend/tests/fixtures/printGoldens/cases.json'), 'utf8'));
        const receiptCase = cases.find(entry => entry.id === 'receipt-item-discount');
        const kitchenCase = cases.find(entry => entry.id === 'kitchen-normal');
        const artifacts = await Promise.all([
            compileTemplate(
                getBuiltinTemplate('receipt', { storeInfo: receiptCase.input.storeInfo }),
                buildReceiptDocumentModel(receiptCase.input, { printRequestedAt: '2026-07-25T14:30:00.000Z' }),
                { mode: 'test', templateRevisionId: 'builtin:receipt-v1', profile: { allowAbsoluteOnce: true, allowStoreLogo: true } }
            ),
            compileTemplate(
                getBuiltinTemplate('kitchen'),
                buildKitchenDocumentModel(kitchenCase.input, { printRequestedAt: '2026-07-25T14:30:00.000Z' }),
                { mode: 'test', templateRevisionId: 'builtin:kitchen-v1', profile: { allowAbsoluteOnce: true, allowStoreLogo: true } }
            )
        ]);

        expect(() => resolveCompiledDocument({ compiled_document_v1: artifacts[0].artifact }, 'receipt')).not.toThrow();
        expect(() => resolveCompiledDocument({ compiled_document_v1: artifacts[1].artifact }, 'kitchen')).not.toThrow();
    });

    it('accepts exactly 256KB of compiled HTML and CSS but rejects one byte more', () => {
        const html = '<main class="compiled-document" data-doc-type="receipt" style="width:576px"></main>';
        const exactCss = '.x{}'.padEnd((256 * 1024) - Buffer.byteLength(html, 'utf8'), ' ');
        const artifact = {
            version: 1,
            kind: 'compiled_document_v1',
            docType: 'receipt',
            widthPx: 576,
            templateRevisionId: 'builtin:receipt-v1',
            compilerVersion: 1,
            html,
            css: exactCss
        };

        expect(Buffer.byteLength(artifact.html, 'utf8') + Buffer.byteLength(artifact.css, 'utf8')).toBe(256 * 1024);
        expect(() => resolveCompiledDocument({ compiled_document_v1: artifact }, 'receipt')).not.toThrow();
        expect(() => resolveCompiledDocument({ compiled_document_v1: { ...artifact, css: `${artifact.css}a` } }, 'receipt'))
            .toThrow(expect.objectContaining({ code: 'COMPILED_DOCUMENT_INVALID' }));
    });

    // server.js required dotenv from 8cbeb5d6 without it ever being declared. On a dev
    // machine Node walks up and resolves it from the repo root's node_modules, so every
    // payload built here looked fine; on a till there is no parent tree and the service
    // dies at line 2 with MODULE_NOT_FOUND. Declared dependencies are the only ones that
    // reach a station.
    it('declares every external module the spooler requires', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(spoolerRoot, 'package.json'), 'utf8'));
        const declared = new Set([
            ...Object.keys(manifest.dependencies || {}),
            ...Object.keys(manifest.optionalDependencies || {}),
            ...Object.keys(manifest.devDependencies || {}),
        ]);
        const builtin = new Set(require('module').builtinModules);

        const sources = [];
        const walk = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (['node_modules', '.cache', 'runtime', 'install', 'vendor', 'bin', 'windows-helper', 'tests'].includes(entry.name)) continue;
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(js|cjs)$/.test(entry.name)) sources.push(full);
            }
        };
        walk(spoolerRoot);
        expect(sources.length).toBeGreaterThan(5);

        const undeclared = new Map();
        for (const file of sources) {
            const text = fs.readFileSync(file, 'utf8');
            for (const match of text.matchAll(/require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g)) {
                const name = match[1].startsWith('@')
                    ? match[1].split('/').slice(0, 2).join('/')
                    : match[1].split('/')[0];
                if (builtin.has(name) || name.startsWith('node:') || declared.has(name)) continue;
                undeclared.set(name, path.relative(root, file));
            }
        }
        expect([...undeclared].map(([name, file]) => `${name} (${file})`)).toEqual([]);
    });
});

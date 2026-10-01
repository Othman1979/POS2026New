// Real Vue/browser deadline and retry checks. No database or business writes.
const { chromium, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');

async function main() {
    const boot = `
          import { createApp, h, ref } from 'vue';
          import { lazyPosComponent } from './src/pos/lazyPosComponent.js';
          const open = ref(false);
          let calls = 0;
          window.errors = [];
          const dialog = lazyPosComponent(() => {
            calls++;
            if (calls === 1) return new Promise(resolve => { window.finishOld = resolve; });
            return Promise.resolve({ render: () => h('section', { role: 'dialog' }, 'Ready') });
          }, () => { open.value = false; });
          const app = createApp({ setup: () => () => [
            h('input', { value: 'preserved order note', id: 'note' }),
            h('button', { onClick: () => { open.value = true; } }, 'Open'),
            h('output', String(open.value)), open.value ? h(dialog) : null,
          ] });
          app.config.errorHandler = error => window.errors.push(error.message);
          app.mount('#app');
        `;
    const bundled = await build({ stdin: { contents: boot, resolveDir: path.resolve(__dirname, '../..') },
        bundle: true, write: false, format: 'iife', platform: 'browser',
        define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true',
            __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
    const server = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<div id="app"></div><script>' + bundled.outputFiles[0].text + '</script>');
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.clock.install();
        await page.goto(`http://127.0.0.1:${server.address().port}/lazy-dialog-fixture`);
        await page.getByRole('button', { name: 'Open' }).click();
        await expect(page.locator('output')).toHaveText('true');
        await page.clock.fastForward(15_001);
        await expect(page.locator('output')).toHaveText('false');
        await expect(page.locator('#note')).toHaveValue('preserved order note');
        await page.getByRole('button', { name: 'Open' }).click();
        await expect(page.getByRole('dialog')).toHaveText('Ready');
        await page.evaluate(() => window.finishOld({ render: () => null }));
        await expect(page.getByRole('dialog')).toHaveText('Ready');
        expect(await page.evaluate(() => window.errors)).toEqual(['Async component timed out after 15000ms.']);
        expect(errors).toEqual([]);
        console.log('PASS: stalled dialog closes, draft survives, reopen succeeds, late loader cannot replace it; no unexpected browser errors.');
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

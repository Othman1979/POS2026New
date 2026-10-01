const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');

(async () => {
    const root = path.resolve(__dirname, '../..');
    const { createServer } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const stubs = {
        useAuth: `import { ref } from 'vue'; export const useAuth = () => ({activeUser:ref({role:'cashier'})});`,
        useSocket: `import { ref } from 'vue'; export const useSocket = () => ({failedPrintJobsCount:ref(1)});`,
        usePermissions: `export const usePermissions = () => ({can:()=>true});`
    };
    const boot = `import {createApp,h} from 'vue';
        import Bell from '/src/components/pos/FailedPrintsBell.vue';
        import Settings from '/src/admin/pages/Settings.vue';
        import {t,setLanguage} from '/src/shared/i18n.js';
        const params=new URLSearchParams(location.search);
        await setLanguage(params.get('lang'));
        window.label=t; window.vueErrors=[]; window.showAdminAlert=async()=>{};
        const app=createApp({render:()=>h(params.get('screen')==='settings'?Settings:Bell)});
        app.config.globalProperties.$t=t; app.config.errorHandler=e=>window.vueErrors.push(e.message);
        window.app=app; app.mount('#app');`;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-recovery-vite-'));
    const server = await createServer({ root, cacheDir, configFile: false, envDir: false,
        resolve: { alias: { '@': path.join(root, 'src'), '@posapp/permission-policy': path.join(root, 'backend/config/permissionPolicy.cjs') } },
        optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router', 'qrcode', '@posapp/permission-policy'] },
        plugins: [{ name: 'print-recovery-fixture', enforce: 'pre',
            resolveId(id) {
                const key = Object.keys(stubs).find(key => id.replaceAll('\\', '/').endsWith('/' + key + '.js'));
                if (key) return '\0fixture:' + key;
                if (id === '/recovery-entry.js') return '\0fixture:entry';
            },
            load(id) { if (id === '\0fixture:entry') return boot; if (id.startsWith('\0fixture:')) return stubs[id.slice(9)]; },
            configureServer(s) { s.middlewares.use('/__recovery', async (_req, res) => {
                res.setHeader('Content-Type', 'text/html');
                res.end(await s.transformIndexHtml('/__recovery', '<div id="app"></div><script type="module" src="/recovery-entry.js"></script>'));
            }); }
        }, vue()], server: { host: '127.0.0.1', port: 0 } });
    let browser;
    const checks = [];
    try {
        await server.listen(); browser = await chromium.launch({ headless: true });
        for (const language of ['en', 'ar']) {
            const page = await browser.newPage();
            page.setDefaultTimeout(10000);
            const errors = [], posts = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
            let confirm = false;
            page.on('dialog', dialog => confirm ? dialog.accept('paper checked') : dialog.dismiss());
            const uncertain = { id: 17, printer_name: 'Kitchen', print_type: 'kitchen', status: 'dead_letter',
                last_failure_class: 'uncertain', last_error_code: 'WINspool_JOB_DELETED', reprintable: true, created_at: '2026-09-24 12:00:00' };
            await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                if (route.request().method() === 'POST' && url.pathname.endsWith('/reprint')) posts.push(route.request().postDataJSON());
                const json = { success: true, data: [], categories: [], settings: {}, admin_language: language,
                    jobs: [uncertain], recent: [uncertain], summary: [], printers: [],
                    stations: [{ spooler_id: 'station-a', online: true, agent_status: 'active', last_error: 'PRINTER_RECOVERY_REQUIRED' }] };
                await route.fulfill({ json });
            });
            const base = `http://127.0.0.1:${server.httpServer.address().port}/__recovery?lang=${language}`;
            await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await expect(page.locator('button.failed-prints-trigger')).toBeVisible();
            await page.locator('button.failed-prints-trigger').click();
            const reprintLabel = await page.evaluate(() => window.label('Reprint'));
            await page.getByRole('button', { name: reprintLabel, exact: true }).click();
            assert.equal(posts.length, 0, 'dismissed uncertainty confirmation sends nothing');
            confirm = true;
            await page.getByRole('button', { name: reprintLabel, exact: true }).click();
            await expect.poll(() => posts.length).toBe(1);
            assert.equal(posts[0].confirm_uncertain, true);
            await page.goto(base + '&screen=settings', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForFunction(() => typeof window.label === 'function');
            const queueLabel = await page.evaluate(() => window.label('Print queue'));
            await page.getByRole('tab', { name: queueLabel, exact: true }).click();
            await expect(page.getByRole('alert')).toContainText(await page.evaluate(() => window.label('Printer recovery required. Check the last ticket and contact support before resuming this printer.')));
            await expect(page.getByRole('button', { name: reprintLabel, exact: true }).first()).toBeVisible();
            confirm = false;
            await page.getByRole('button', { name: reprintLabel, exact: true }).first().click();
            assert.equal(posts.length, 1);
            confirm = true;
            await page.getByRole('button', { name: reprintLabel, exact: true }).first().click();
            await expect.poll(() => posts.length).toBe(2);
            assert.equal(posts[1].confirm_uncertain, true);
            assert.deepEqual(await page.evaluate(() => window.vueErrors), []);
            assert.deepEqual(errors, []);
            checks.push({ language, cashier_and_admin_confirmation: true, recovery_warning: true, console_errors: 0 });
            await page.close();
        }
        fs.mkdirSync(path.join(root, 'scratch/typst-transport-reliability'), { recursive: true });
        fs.writeFileSync(path.join(root, 'scratch/typst-transport-reliability/ui.json'), JSON.stringify(checks, null, 2));
        console.log(JSON.stringify(checks));
    } catch (error) { console.error(error); throw error; }
    finally { await browser?.close(); await server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

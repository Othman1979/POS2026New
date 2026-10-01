// Verify the shared CommonJS policy through Vite's actual development pipeline.
// No application server, database, printer, or business writes are involved.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('@playwright/test');
const output = 'scratch/permission-policy-browser';
let server, httpServer, browser;
const results = { complete: false, pageErrors: [], failedRequests: [], consoleErrors: [] };
async function run() {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(`${output}/index.html`, `<!doctype html><html lang="en"><body><p>Permission policy verification</p><script type="module">
        import policy from '@posapp/permission-policy';
        const waiter = {role:'waiter',permissions:['waiter.checkout']};
        window.policyResults = {
            counter: policy.evaluateAction(waiter, 'checkout').allowed,
            table: policy.evaluateAction(waiter, 'checkout', {tablePayment:true}).allowed,
            unknown: policy.userHas({role:'admin'}, 'unknown.permission'),
        };
    </script></body></html>`);
    const { createServer } = await import('vite');
    server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { entries: [`${output}/index.html`], force: true }, logLevel: 'error' });
    httpServer = http.createServer(server.middlewares);
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => results.pageErrors.push(error.message));
    page.on('requestfailed', request => results.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) results.failedRequests.push({ url: response.url(), status: response.status() }); });
    page.on('console', message => { if (message.type() === 'error') results.consoleErrors.push(message.text()); });
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${httpServer.address().port}/${output}/index.html`);
    await page.waitForFunction(() => window.policyResults);
    const decisions = await page.evaluate(() => window.policyResults);
    assert.deepEqual(decisions, { counter: false, table: true, unknown: false });
    assert.deepEqual(results.pageErrors, []);
    Object.assign(results, { complete: true, decisions });
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
}
run().catch(error => { results.error = error.stack; console.error(JSON.stringify(results, null, 2)); process.exitCode = 1; }).finally(async () => {
    await browser?.close();
    httpServer?.closeAllConnections();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await server?.close();
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
});

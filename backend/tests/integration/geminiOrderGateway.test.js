import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const API_KEY = 'gateway-integration-key-with-at-least-forty-eight-characters';
process.env.ORDER_INTAKE_ENABLED = 'true';
process.env.ORDER_INTAKE_CLIENT_ID = 'gemini-gateway-test';
process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(API_KEY).digest('hex');
process.env.ORDER_INTAKE_QUOTE_SECRET = 'gateway-integration-quote-secret-at-least-thirty-two';
process.env.ORDER_INTAKE_ACTOR_USER_ID = '71';
process.env.ORDER_INTAKE_RATE_LIMIT_MAX = '1000';
process.env.ORDER_INTAKE_CREATE_RATE_LIMIT_MAX = '1000';
process.env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT = '200';

const root = path.resolve(__dirname, '../../..');
const gatewayRoot = path.join(root, 'integrations', 'gemini-order-gateway');
const gatewayExe = path.join(gatewayRoot, 'bin', 'posapp-order-gateway.exe');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

let apiServer;
let apiBaseUrl;
let tempRoot;
let envFile;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server) {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function createDelayedCreateProxy(delayMs) {
    let finishUpstream;
    const upstreamFinished = new Promise(resolve => { finishUpstream = resolve; });
    const proxy = http.createServer((incoming, outgoing) => {
        const target = new URL(incoming.url, apiBaseUrl);
        const upstream = http.request(target, { method: incoming.method, headers: incoming.headers }, response => {
            if (!incoming.url.includes('/held-orders')) {
                outgoing.writeHead(response.statusCode || 502, response.headers);
                response.pipe(outgoing);
                return;
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.once('end', () => {
                finishUpstream();
                setTimeout(() => {
                    if (outgoing.destroyed) return;
                    outgoing.writeHead(response.statusCode || 502, response.headers);
                    outgoing.end(Buffer.concat(chunks));
                }, delayMs).unref?.();
            });
        });
        incoming.pipe(upstream);
    });
    await listen(proxy);
    return { proxy, upstreamFinished, baseUrl: `http://127.0.0.1:${proxy.address().port}` };
}

async function createPriceChangeProxy(changePrice) {
    let changed = false;
    const proxy = http.createServer(async (incoming, outgoing) => {
        try {
            if (incoming.url.includes('/held-orders') && !changed) {
                changed = true;
                await changePrice();
            }
            const target = new URL(incoming.url, apiBaseUrl);
            const upstream = http.request(target, {
                method: incoming.method,
                headers: incoming.headers,
            }, response => {
                outgoing.writeHead(response.statusCode || 502, response.headers);
                response.pipe(outgoing);
            });
            upstream.once('error', error => {
                if (!outgoing.headersSent) outgoing.writeHead(502);
                outgoing.end(error.message);
            });
            incoming.pipe(upstream);
        } catch (error) {
            if (!outgoing.headersSent) outgoing.writeHead(500);
            outgoing.end(error.message);
        }
    });
    await listen(proxy);
    return { proxy, baseUrl: `http://127.0.0.1:${proxy.address().port}` };
}

function buildGateway() {
    const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'scripts', 'run-go-order-gateway.ps1'), '-Action', 'build',
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (result.error || result.status !== 0) {
        throw result.error || new Error(`Go gateway build failed:\n${result.stdout}\n${result.stderr}`);
    }
}

function runGateway({ baseUrl = apiBaseUrl, callId, outboxName, timeoutMs = 10_000 }) {
    const child = spawn(gatewayExe, [
        'simulate', '--env', envFile,
        '--query', 'Test',
        '--product-id', String(SEED.product1.id),
        '--order-type-id', '1',
        '--call-id', callId,
        '--submit',
    ], {
        cwd: gatewayRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
            ...process.env,
            ORDER_INTAKE_BASE_URL: baseUrl,
            ORDER_INTAKE_API_KEY: API_KEY,
            ORDER_GATEWAY_OUTBOX_PATH: path.join(tempRoot, outboxName),
            ORDER_GATEWAY_REQUEST_TIMEOUT_MS: String(timeoutMs),
            ORDER_GATEWAY_RECOVERY_DELAY_MS: '10',
        },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Go gateway timed out:\n${stdout}\n${stderr}`));
        }, 30_000);
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Go gateway failed with code ${code}:\n${stdout}\n${stderr}`));
                return;
            }
            try { resolve(JSON.parse(stdout)); }
            catch (error) { reject(new Error(`Go gateway returned invalid JSON: ${error.message}\n${stdout}`)); }
        });
    });
}

describe('Go Gemini gateway through the real order-intake API', () => {
    beforeAll(async () => {
        buildGateway();
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-go-gateway-e2e-'));
        envFile = path.join(tempRoot, 'gateway.env');
        fs.writeFileSync(envFile, 'ORDER_INTAKE_API_KEY=integration-placeholder-key-at-least-thirty-two\n', { mode: 0o600 });
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (71, '9071', 'Gemini Gateway', 'call_center', 1)
        `);
        apiServer = http.createServer(app);
        await listen(apiServer);
        apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM order_intake_requests WHERE client_id='gemini-gateway-test'");
        await pool.query('DELETE FROM held_orders WHERE user_id=71');
    });

    afterAll(async () => {
        await close(apiServer);
        await pool.end();
        if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('creates one cashier-review hold through the compiled Go process with no sale or print side effect', async () => {
        const [[ordersBefore]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[printsBefore]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const output = await runGateway({ callId: 'call-go-gateway-e2e-0001', outboxName: 'normal.sqlite' });
        expect(output.state).toBe('quoted');
        expect(output.quote).not.toHaveProperty('quote_token');
        expect(output.result).toMatchObject({ state: 'completed', held_order: { kitchen_fired: false, active: true } });
        const [[held]] = await pool.query(
            'SELECT COUNT(*) AS count, MAX(kitchen_fired) AS kitchen_fired FROM held_orders WHERE user_id=71',
        );
        const [[ordersAfter]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[printsAfter]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(held.count)).toBe(1);
        expect(Number(held.kitchen_fired)).toBe(0);
        expect(Number(ordersAfter.count)).toBe(Number(ordersBefore.count));
        expect(Number(printsAfter.count)).toBe(Number(printsBefore.count));
    });

    it('recovers the committed hold when the create response is lost', async () => {
        const { proxy, baseUrl, upstreamFinished } = await createDelayedCreateProxy(700);
        try {
            const output = await runGateway({
                baseUrl,
                callId: 'call-go-gateway-lost-0001',
                outboxName: 'lost-response.sqlite',
                timeoutMs: 250,
            });
            await upstreamFinished;
            expect(output.result).toMatchObject({ state: 'completed', held_order: { replay: true } });
            const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=71');
            const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
            const [[prints]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(held.count)).toBe(1);
            expect(Number(orders.count)).toBe(0);
            expect(Number(prints.count)).toBe(0);
        } finally {
            await close(proxy);
        }
    });

    it('requires a corrected draft when a cashier disables the item after quoting', async () => {
        const { proxy, baseUrl } = await createPriceChangeProxy(() => pool.query(
            'UPDATE products SET is_available=0 WHERE id=?', [SEED.product1.id],
        ));
        try {
            const output = await runGateway({ baseUrl, callId: 'call-go-unavailable-0001', outboxName: 'unavailable.sqlite' });
            expect(output.result).toMatchObject({ state: 'requote_required', requires_fresh_quote: true });
            expect(output.result.quote).toBeNull();
            const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=71');
            expect(Number(held.count)).toBe(0);
        } finally {
            await pool.query('UPDATE products SET is_available=1 WHERE id=?', [SEED.product1.id]);
            await close(proxy);
        }
    });

    it('returns a replacement quote without creating a hold after a real POS price change', async () => {
        const [[original]] = await pool.query('SELECT price FROM products WHERE id=?', [SEED.product1.id]);
        const { proxy, baseUrl } = await createPriceChangeProxy(() => pool.query(
            'UPDATE products SET price=? WHERE id=?',
            [Number(original.price) + 1, SEED.product1.id],
        ));
        try {
            const output = await runGateway({
                baseUrl,
                callId: 'call-go-gateway-requote-0001',
                outboxName: 'requote.sqlite',
            });
            expect(output.result.state).toBe('requote_required');
            expect(Number(output.result.quote.total)).toBeGreaterThan(Number(output.quote.total));
            expect(output.result.quote).not.toHaveProperty('quote_token');
            const [[held]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE user_id=71');
            expect(Number(held.count)).toBe(0);
        } finally {
            await pool.query('UPDATE products SET price=? WHERE id=?', [original.price, SEED.product1.id]);
            await close(proxy);
        }
    });
});

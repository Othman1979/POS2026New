#!/usr/bin/env node
'use strict';

// Throwaway pre-implementation model for Rev 3.4. This intentionally exercises
// the plan's algorithms without importing application routes or touching MySQL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const request = require('supertest');
const { createFixedWindowThrottle, hashThrottlePart } = require('../backend/services/requestThrottle');

const tests = [];
const observations = {};
const test = (name, run) => tests.push({ name, run });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BUSY_BODY = {
    success: false,
    code: 'SERVER_BUSY',
    message: 'The server is busy. Try again in a moment.',
};

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.body = null;
        this.ended = false;
    }
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
    status(code) { this.statusCode = code; return this; }
    json(body) { this.body = body; return this.end(); }
    end() { this.ended = true; this.emit('finish'); return this; }
}

function createGlobalPreAuthGate({
    windowMs = 60_000,
    max = 600,
    maxConcurrent = 6,
    leaseWarnMs = 15_000,
    now = Date.now,
    trackConcurrency = () => true,
    warn = () => {},
} = {}) {
    const requests = createFixedWindowThrottle({ windowMs, limit: max, maxEntries: 1, now });
    let inFlight = 0;
    const rejectBusy = (res) => {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json(BUSY_BODY);
    };
    const middleware = (req, res, next) => {
        if (!requests.consume('global:preauth')) return rejectBusy(res);
        if (!trackConcurrency(req)) return next();
        if (inFlight >= maxConcurrent) return rejectBusy(res);

        inFlight += 1;
        let released = false;
        let watchdog = null;
        const release = () => {
            if (released) return;
            released = true;
            inFlight -= 1;
            if (watchdog) clearTimeout(watchdog);
        };
        watchdog = setTimeout(() => warn(), leaseWarnMs);
        watchdog.unref?.();

        const originalEnd = res.end;
        res.end = function patchedEnd(...args) {
            release();
            return originalEnd.apply(this, args);
        };
        res.once('close', release);
        try { return next(); }
        catch (error) { release(); throw error; }
    };
    middleware.inFlight = () => inFlight;
    return middleware;
}

const PRE_AUTH_ROUTES = new Set([
    'POST /api/auth/login',
    'GET /api/auth/login-policy',
    'POST /api/auth/webauthn/login/options',
    'POST /api/auth/webauthn/login/verify',
    'GET /api/auth/webauthn/status',
    'POST /api/auth/webauthn/enroll/options',
    'POST /api/auth/webauthn/enroll/verify',
    'GET /api/system/public_preferences',
    'GET /public_menu.json',
]);
const normalizePreAuthPath = (value) => {
    const pathValue = String(value || '/').toLowerCase();
    return pathValue.length > 1 ? pathValue.replace(/\/+$/, '') : pathValue;
};
const preAuthRouteKey = (req) => {
    const method = req.method === 'HEAD' ? 'GET' : String(req.method || '').toUpperCase();
    return `${method} ${normalizePreAuthPath(req.path)}`;
};
const isPreAuthRoute = (req) => PRE_AUTH_ROUTES.has(preAuthRouteKey(req));

function buildProbeApp({ max = 600, maxConcurrent = 6, leaseWarnMs = 15_000 } = {}) {
    const app = express();
    const heldResponses = [];
    const gate = createGlobalPreAuthGate({
        max,
        maxConcurrent,
        leaseWarnMs,
        trackConcurrency: (req) => normalizePreAuthPath(req.path) !== '/public_menu.json',
    });
    const tightJson = express.json({ limit: '16kb' });
    const tightForm = express.urlencoded({ extended: true, limit: '16kb' });
    app.use((req, res, next) => (isPreAuthRoute(req) ? tightJson(req, res, next) : next()));
    app.use((req, res, next) => (isPreAuthRoute(req) ? tightForm(req, res, next) : next()));
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    app.use((req, res, next) => (isPreAuthRoute(req) ? gate(req, res, next) : next()));
    app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
    app.get('/api/auth/login-policy', (req, res) => {
        if (req.query.hold === '1') return heldResponses.push(res);
        return res.json({ ok: true });
    });
    app.get('/public_menu.json', (req, res) => {
        if (req.query.stream !== '1') return res.json({ ok: true });
        res.setHeader('Content-Type', 'application/octet-stream');
        const chunk = Buffer.alloc(64 * 1024);
        while (res.write(chunk)) {}
        return undefined;
    });
    app.post('/uncovered', (req, res) => res.json({ length: req.body?.value?.length || 0 }));
    app.use((error, req, res, next) => {
        if (error?.type === 'entity.too.large') return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE' });
        if (error?.type === 'request.aborted') return undefined;
        return res.status(500).json({ code: 'PROBE_ERROR' });
    });
    return { app, gate, heldResponses };
}

function invokeGate(gate, req = {}) {
    const res = new MockResponse();
    let called = false;
    gate(req, res, () => { called = true; });
    return { res, called };
}

const DELAY_SLOTS = 4096;
const DELAY_WINDOW_MS = 5 * 60 * 1000;
const DELAY_STEPS_MS = [0, 0, 1000, 2000, 4000, 5000];
function createDelayRing({ now = Date.now } = {}) {
    const slots = Array.from({ length: DELAY_SLOTS }, () => ({ count: 0, startedAt: 0 }));
    const slotFor = (value) => parseInt(hashThrottlePart(String(value || '').trim()).slice(0, 8), 16) % DELAY_SLOTS;
    return {
        slotFor,
        pendingDelayMs(slot) {
            const state = slots[slot];
            if (now() - state.startedAt >= DELAY_WINDOW_MS) return 0;
            return DELAY_STEPS_MS[Math.min(state.count, DELAY_STEPS_MS.length - 1)];
        },
        recordFailure(slot) {
            const state = slots[slot];
            if (now() - state.startedAt >= DELAY_WINDOW_MS) { state.startedAt = now(); state.count = 0; }
            state.count += 1;
        },
        clear(slot) { slots[slot].count = 0; slots[slot].startedAt = 0; },
        size: DELAY_SLOTS,
    };
}

function createAuthModeCache({ pool, queryAuthMode, now = Date.now }) {
    const ttlMs = 5000;
    let generation = 0;
    let cached = null;
    let cachedUntil = 0;
    let inFlight = null;
    return {
        async read(executor = pool) {
            if (executor !== pool) return queryAuthMode(executor);
            if (cached && now() < cachedUntil) return cached;
            if (inFlight) return inFlight;
            const readGeneration = generation;
            const pending = queryAuthMode(pool)
                .then((mode) => {
                    if (readGeneration === generation) { cached = mode; cachedUntil = now() + ttlMs; }
                    return mode;
                })
                .finally(() => { if (inFlight === pending) inFlight = null; });
            inFlight = pending;
            return pending;
        },
        invalidate() { generation += 1; cached = null; cachedUntil = 0; inFlight = null; },
    };
}

test('normalized route aliases and both 16 KB parsers are fail-closed', async () => {
    const { app } = buildProbeApp();
    const big = 'x'.repeat(50 * 1024);
    const cases = [
        request(app).post('/api/auth/login').send({ value: big }),
        request(app).post('/api/auth/login/').send({ value: big }),
        request(app).post('/API/AUTH/LOGIN').send({ value: big }),
        request(app).post('/api/auth/login').type('form').send({ value: big }),
    ];
    const responses = await Promise.all(cases);
    assert.deepEqual(responses.map((response) => response.status), [413, 413, 413, 413]);
    const uncovered = await request(app).post('/uncovered').send({ value: big });
    assert.equal(uncovered.status, 200);
    assert.equal(uncovered.body.length, big.length);
    const query = await request(app).post('/api/auth/login/?trace=1').send({ value: big });
    assert.equal(query.status, 413);
});

test('HEAD fallback is covered; malformed path aliases do not gain access', async () => {
    const { app } = buildProbeApp({ max: 1 });
    assert.equal((await request(app).head('/api/auth/login-policy')).status, 200);
    assert.equal((await request(app).get('/api/auth/login-policy')).status, 429);
    assert.equal((await request(app).get('/api/auth//login-policy')).status, 404);
    assert.equal((await request(app).get('/api/auth/%6cogin-policy')).status, 404);
});

test('rate ceiling is exact, constant-keyed, and emits one uniform body', () => {
    let now = 1;
    const gate = createGlobalPreAuthGate({ now: () => now, max: 600, maxConcurrent: 1 });
    for (let index = 0; index < 600; index += 1) {
        const hit = invokeGate(gate, { path: '/api/auth/login', headers: { 'x-forwarded-for': `198.51.100.${index % 250}` } });
        assert.equal(hit.called, true);
        hit.res.end();
    }
    const denied = invokeGate(gate, { path: '/api/auth/login-policy', headers: { 'x-forwarded-for': '203.0.113.99' } });
    assert.equal(denied.res.statusCode, 429);
    assert.deepEqual(denied.res.body, BUSY_BODY);
    now = 60_002;
    const reset = invokeGate(gate, { path: '/api/auth/login' });
    assert.equal(reset.called, true);
    reset.res.end();
});

test('dynamic semaphore releases exactly once on end or close', () => {
    const gate = createGlobalPreAuthGate({ max: 20, maxConcurrent: 1 });
    const held = invokeGate(gate, { path: '/api/auth/login' });
    assert.equal(held.called, true);
    assert.equal(gate.inFlight(), 1);
    assert.deepEqual(invokeGate(gate, { path: '/api/auth/login' }).res.body, BUSY_BODY);
    held.res.emit('close');
    held.res.end();
    assert.equal(gate.inFlight(), 0);
    const admitted = invokeGate(gate, { path: '/api/auth/login' });
    assert.equal(admitted.called, true);
    admitted.res.end();
    assert.equal(gate.inFlight(), 0);
});

test('watchdog warns but cannot manufacture capacity', async () => {
    let warnings = 0;
    const gate = createGlobalPreAuthGate({ max: 20, maxConcurrent: 1, leaseWarnMs: 15, warn: () => { warnings += 1; } });
    const held = invokeGate(gate, { path: '/api/auth/login' });
    await sleep(35);
    assert.equal(warnings, 1);
    assert.equal(invokeGate(gate, { path: '/api/auth/login' }).res.statusCode, 429);
    assert.equal(gate.inFlight(), 1);
    held.res.end();
    const admitted = invokeGate(gate, { path: '/api/auth/login' });
    assert.equal(admitted.called, true);
    admitted.res.end();
});

test('synchronous downstream throws release their lease', () => {
    const gate = createGlobalPreAuthGate({ max: 20, maxConcurrent: 1 });
    const response = new MockResponse();
    assert.throws(() => gate({ path: '/api/auth/login' }, response, () => { throw new Error('probe'); }), /probe/);
    assert.equal(gate.inFlight(), 0);
});

test('50,000 deterministic hostile lease transitions preserve semaphore invariants', () => {
    const gate = createGlobalPreAuthGate({ max: 100_000, maxConcurrent: 6 });
    const held = [];
    let seed = 0x5eed1234;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    for (let index = 0; index < 50_000; index += 1) {
        if (held.length && random() < 0.43) {
            const selected = Math.floor(random() * held.length);
            const [res] = held.splice(selected, 1);
            if (random() < 0.5) res.end();
            else res.emit('close');
        } else {
            const hit = invokeGate(gate, { path: '/api/auth/login-policy' });
            if (hit.called) held.push(hit.res);
            else {
                assert.equal(hit.res.statusCode, 429);
                assert.deepEqual(hit.res.body, BUSY_BODY);
            }
        }
        assert.equal(gate.inFlight(), held.length);
        assert.ok(gate.inFlight() >= 0 && gate.inFlight() <= 6);
    }
    held.forEach((res) => res.end());
    assert.equal(gate.inFlight(), 0);
    observations.hostileLeaseTransitions = 50_000;
});

test('unsent request bodies do not acquire dynamic leases', async () => {
    const { app } = buildProbeApp({ maxConcurrent: 1 });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const sockets = [];
    try {
        for (let index = 0; index < 6; index += 1) {
            const socket = require('node:net').connect(port, '127.0.0.1');
            socket.write('POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"value":"');
            sockets.push(socket);
        }
        await sleep(40);
        const response = await request(server).get('/api/auth/login-policy');
        assert.equal(response.status, 200);
    } finally {
        sockets.forEach((socket) => socket.destroy());
        await new Promise((resolve) => server.close(resolve));
    }
});

test('six live dynamic handlers reject the seventh and recover after completion', async () => {
    const { app, heldResponses } = buildProbeApp({ max: 30, maxConcurrent: 6 });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const clients = [];
    try {
        for (let index = 0; index < 6; index += 1) {
            const client = http.get({ host: '127.0.0.1', port, path: '/api/auth/login-policy?hold=1' });
            client.on('error', () => {});
            clients.push(client);
        }
        for (let attempt = 0; heldResponses.length < 6 && attempt < 50; attempt += 1) await sleep(5);
        assert.equal(heldResponses.length, 6);
        const denied = await request(server).get('/api/auth/login-policy');
        assert.equal(denied.status, 429);
        assert.deepEqual(denied.body, BUSY_BODY);
        heldResponses.splice(0).forEach((res) => res.json({ released: true }));
        await sleep(10);
        assert.equal((await request(server).get('/api/auth/login-policy')).status, 200);
    } finally {
        clients.forEach((client) => client.destroy());
        heldResponses.splice(0).forEach((res) => res.destroy());
        await new Promise((resolve) => server.close(resolve));
    }
});

test('public menu is rate-only and cannot starve dynamic capacity', () => {
    const gate = createGlobalPreAuthGate({
        max: 20,
        maxConcurrent: 1,
        trackConcurrency: (req) => normalizePreAuthPath(req.path) !== '/public_menu.json',
    });
    const menu = invokeGate(gate, { path: '/public_menu.json' });
    assert.equal(menu.called, true);
    assert.equal(gate.inFlight(), 0);
    const dynamic = invokeGate(gate, { path: '/api/auth/login-policy' });
    assert.equal(dynamic.called, true);
    dynamic.res.end();
});

test('a backpressured public-menu stream cannot consume the dynamic semaphore', async () => {
    const { app } = buildProbeApp({ max: 20, maxConcurrent: 1 });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    let streamRequest;
    try {
        await new Promise((resolve, reject) => {
            streamRequest = http.get({ host: '127.0.0.1', port, path: '/public_menu.json?stream=1' }, (res) => {
                res.once('data', () => { res.pause(); resolve(); });
            });
            streamRequest.on('error', reject);
        });
        assert.equal((await request(server).get('/api/auth/login-policy')).status, 200);
    } finally {
        streamRequest?.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('keep-alive requests do not leak dynamic capacity', async () => {
    const { app, gate } = buildProbeApp({ max: 30, maxConcurrent: 1 });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const { port } = server.address();
    const get = () => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/login-policy', agent }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
    });
    try {
        for (let index = 0; index < 10; index += 1) assert.equal(await get(), 200);
        assert.equal(gate.inFlight(), 0);
    } finally {
        agent.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('delay ring stays fixed under 50,000 candidates and never exceeds 5 seconds', () => {
    let now = 1;
    const ring = createDelayRing({ now: () => now });
    let maxDelay = 0;
    for (let index = 0; index < 50_000; index += 1) {
        const slot = ring.slotFor(`candidate-${index}`);
        ring.recordFailure(slot);
        maxDelay = Math.max(maxDelay, ring.pendingDelayMs(slot));
    }
    assert.equal(ring.size, 4096);
    assert.equal(maxDelay, 5000);
    observations.delayRing = { candidates: 50_000, slots: ring.size, maxDelayMs: maxDelay };
    now += DELAY_WINDOW_MS;
    assert.equal(ring.pendingDelayMs(ring.slotFor('candidate-1')), 0);
});

test('preconditioned slot collisions remain bounded and success clears the shared slot', () => {
    const ring = createDelayRing({ now: () => 1 });
    const seen = new Map();
    let pair;
    for (let index = 0; !pair; index += 1) {
        const candidate = `collision-${index}`;
        const slot = ring.slotFor(candidate);
        if (seen.has(slot)) pair = [seen.get(slot), candidate, slot];
        else seen.set(slot, candidate);
    }
    for (let index = 0; index < 20; index += 1) ring.recordFailure(pair[2]);
    assert.equal(ring.pendingDelayMs(ring.slotFor(pair[0])), 5000);
    assert.equal(ring.pendingDelayMs(ring.slotFor(pair[1])), 5000);
    ring.clear(pair[2]);
    assert.equal(ring.pendingDelayMs(pair[2]), 0);
    observations.collision = { first: pair[0], second: pair[1], slot: pair[2] };
});

test('auth-mode cache single-flights 100 cold reads and bypasses explicit executors', async () => {
    const pool = { name: 'pool' };
    const transaction = { name: 'transaction' };
    let queries = 0;
    const cache = createAuthModeCache({
        pool,
        queryAuthMode: async (executor) => { queries += 1; await sleep(5); return executor === pool ? 'staged' : 'enforced'; },
    });
    const modes = await Promise.all(Array.from({ length: 100 }, () => cache.read()));
    assert.equal(queries, 1);
    assert.deepEqual(new Set(modes), new Set(['staged']));
    assert.equal(await cache.read(transaction), 'enforced');
    assert.equal(queries, 2);
});

test('cache invalidation defeats a stale in-flight repopulation race', async () => {
    const pool = {};
    let resolveOld;
    let query = 0;
    const cache = createAuthModeCache({
        pool,
        queryAuthMode: async () => {
            query += 1;
            if (query === 1) return new Promise((resolve) => { resolveOld = resolve; });
            return 'enforced';
        },
    });
    const staleRead = cache.read();
    cache.invalidate();
    assert.equal(await cache.read(), 'enforced');
    resolveOld('disabled');
    assert.equal(await staleRead, 'disabled');
    assert.equal(await cache.read(), 'enforced');
    assert.equal(query, 2);
});

test('HTTPS redirect and Secure-cookie policy are loop-proof and independent', () => {
    const shouldRedirect = ({ enforce = true, encrypted = false, forwardedProto }) =>
        enforce && !encrypted && String(forwardedProto || '').split(',')[0].trim().toLowerCase() === 'http';
    assert.equal(shouldRedirect({ forwardedProto: 'http' }), true);
    assert.equal(shouldRedirect({ forwardedProto: 'https' }), false);
    assert.equal(shouldRedirect({}), false);
    assert.equal(shouldRedirect({ encrypted: true, forwardedProto: 'http' }), false);
    const secureCookie = (enforceHttps) => Boolean(enforceHttps);
    assert.equal(secureCookie(true), true);
    assert.equal(secureCookie(false), false);
});

test('stateless decoys cannot exhaust ceremony rows; failed real proofs are terminal', () => {
    const ceremonies = new Map();
    const generic = JSON.stringify({ success: false, message: 'Authentication failed.' });
    const options = (exists) => {
        if (!exists) return { bodyShape: ['challenge', 'ceremony_id'], inserted: false };
        const id = crypto.randomUUID();
        ceremonies.set(id, { flow: 'authentication', attempts: 0 });
        return { bodyShape: ['challenge', 'ceremony_id'], inserted: true, id };
    };
    for (let index = 0; index < 50_000; index += 1) assert.equal(options(false).inserted, false);
    assert.equal(ceremonies.size, 0);
    const real = options(true);
    assert.equal(ceremonies.size, 1);
    const verify = (id, flow, valid) => {
        const row = ceremonies.get(id);
        if (!row || row.flow !== flow) return generic;
        if (!valid) { ceremonies.delete(id); return generic; }
        ceremonies.delete(id);
        return JSON.stringify({ success: true });
    };
    assert.equal(verify(real.id, 'enrollment', false), generic);
    assert.equal(ceremonies.size, 1);
    assert.equal(verify(real.id, 'authentication', false), generic);
    assert.equal(ceremonies.size, 0);
    assert.equal(verify(real.id, 'authentication', false), generic);
});

test('manager override single-flight isolates actors and surfaces', () => {
    const active = new Set();
    const begin = (actor, surface) => {
        const key = `${actor}:${surface}`;
        if (active.has(key)) return false;
        active.add(key);
        return () => active.delete(key);
    };
    const finish = begin('credential-1', 'void');
    assert.equal(typeof finish, 'function');
    assert.equal(begin('credential-1', 'void'), false);
    assert.equal(typeof begin('credential-2', 'void'), 'function');
    assert.equal(typeof begin('credential-1', 'discount'), 'function');
    finish();
    assert.equal(typeof begin('credential-1', 'void'), 'function');
});

test('planned login ordering releases DB work before delay and response', async () => {
    const events = [];
    const conn = {
        async commit() { events.push('commit'); },
        release() { events.push('release'); },
    };
    const run = async () => {
        events.push('db-start');
        await conn.commit();
        conn.release();
        events.push('delay-start');
        await Promise.resolve();
        events.push('delay-end');
        events.push('response');
    };
    await run();
    assert.deepEqual(events, ['db-start', 'commit', 'release', 'delay-start', 'delay-end', 'response']);
});

(async () => {
    const startedAt = Date.now();
    const failures = [];
    for (const entry of tests) {
        const before = Date.now();
        try {
            await entry.run();
            process.stdout.write(`PASS  ${entry.name} (${Date.now() - before} ms)\n`);
        } catch (error) {
            failures.push({ name: entry.name, message: error.stack || error.message });
            process.stderr.write(`FAIL  ${entry.name}\n${error.stack || error.message}\n`);
        }
    }
    process.stdout.write(`${JSON.stringify({ tests: tests.length, passed: tests.length - failures.length, failed: failures.length, durationMs: Date.now() - startedAt, observations }, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
})().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});

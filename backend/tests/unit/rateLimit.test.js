const { EventEmitter } = require('node:events');
const logger = require('../../config/logger');
const { createKeyedRateLimiter, createGlobalPreAuthGate } = require('../../middleware/rateLimit');

function responseRecorder() {
    const response = Object.assign(new EventEmitter(), {
        statusCode: null,
        body: null,
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        end() { this.ended = true; }
    });
    return response;
}

describe('global pre-authentication gate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('admits exactly the global budget without consulting request identity', () => {
        const limit = createGlobalPreAuthGate({ windowMs: 60_000, max: 600, maxConcurrent: 1 });
        const next = vi.fn();
        for (let index = 0; index < 600; index += 1) {
            const response = responseRecorder();
            limit({ headers: { 'x-forwarded-for': `198.51.100.${index}` } }, response, next);
            response.end();
        }
        const blocked = responseRecorder();
        limit({}, blocked, next);
        expect(next).toHaveBeenCalledTimes(600);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body).toEqual({ success: false, code: 'SERVER_BUSY', message: 'The server is busy. Try again in a moment.' });
        expect(blocked.headers['Retry-After']).toBe('60');
    });

    it('holds six truthful leases and releases each response exactly once', () => {
        const limit = createGlobalPreAuthGate({ max: 20, maxConcurrent: 6 });
        const next = vi.fn();
        const active = Array.from({ length: 6 }, () => responseRecorder());
        active.forEach(response => limit({}, response, next));
        const blocked = responseRecorder();
        limit({}, blocked, next);
        expect(blocked.statusCode).toBe(429);
        active[0].end();
        active[0].emit('close');
        limit({}, responseRecorder(), next);
        expect(next).toHaveBeenCalledTimes(7);
    });

    it('counts rate-only work without a lease and only warns on a stuck lease', () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const limit = createGlobalPreAuthGate({ max: 20, maxConcurrent: 1, leaseWarnMs: 10, trackConcurrency: req => !req.rateOnly });
        const next = vi.fn();
        for (let index = 0; index < 6; index += 1) limit({ rateOnly: true }, responseRecorder(), next);
        const stuck = responseRecorder();
        limit({}, stuck, next);
        vi.advanceTimersByTime(11);
        expect(warn).toHaveBeenCalled();
        const blocked = responseRecorder();
        limit({}, blocked, next);
        expect(blocked.statusCode).toBe(429);
        stuck.end();
        limit({}, responseRecorder(), next);
        expect(next).toHaveBeenCalledTimes(8);
        warn.mockRestore();
    });
});

describe('explicit identity rate limiter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requires an explicit identity function', () => {
        expect(() => createKeyedRateLimiter({ windowMs: 1000, max: 2 }))
            .toThrow('A rate-limit key function is required.');
    });

    it('gives two identities independent budgets', () => {
        const limit = createKeyedRateLimiter({
            windowMs: 1000,
            max: 1,
            message: 'slow down',
            keyForRequest: req => req.identity,
        });
        const next = vi.fn();

        limit({ identity: 'first' }, responseRecorder(), next);
        const blocked = responseRecorder();
        limit({ identity: 'first' }, blocked, next);
        limit({ identity: 'second' }, responseRecorder(), next);

        expect(next).toHaveBeenCalledTimes(2);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.headers['Retry-After']).toBe(1);
    });

    it('fails closed through next when identity is missing or keying throws', () => {
        const missing = createKeyedRateLimiter({ windowMs: 1000, max: 1, keyForRequest: () => null });
        const broken = createKeyedRateLimiter({
            windowMs: 1000,
            max: 1,
            keyForRequest: () => { throw new Error('key failed'); },
        });
        const missingNext = vi.fn();
        const brokenNext = vi.fn();

        missing({}, responseRecorder(), missingNext);
        broken({}, responseRecorder(), brokenNext);

        expect(missingNext).toHaveBeenCalledWith(expect.objectContaining({ message: 'Rate-limit identity is unavailable.' }));
        expect(brokenNext).toHaveBeenCalledWith(expect.objectContaining({ message: 'key failed' }));
    });

    it('gives each limiter instance its own bounded store', () => {
        const options = { windowMs: 1000, max: 1, maxEntries: 1, keyForRequest: req => req.identity };
        const first = createKeyedRateLimiter(options);
        const second = createKeyedRateLimiter(options);
        const nextA = vi.fn();
        const nextB = vi.fn();

        first({ identity: 'occupied' }, responseRecorder(), nextA);
        first({ identity: 'new-key' }, responseRecorder(), nextA);
        second({ identity: 'new-key' }, responseRecorder(), nextB);

        expect(nextA).toHaveBeenCalledTimes(1);
        expect(nextB).toHaveBeenCalledTimes(1);
    });
});

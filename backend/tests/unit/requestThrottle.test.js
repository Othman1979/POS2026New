const crypto = require('node:crypto');

describe('fixed-window request throttling', () => {
    it('enforces both shared-IP and IP-plus-identifier limits and resets after the window', () => {
        const { createFixedWindowThrottle, hashThrottlePart } = require('../../services/requestThrottle');
        let now = 1000;
        const clock = () => now;
        const ipBucket = createFixedWindowThrottle({ windowMs: 60000, limit: 60, now: clock });
        const identityBucket = createFixedWindowThrottle({ windowMs: 60000, limit: 12, now: clock });

        for (let candidate = 0; candidate < 60; candidate += 1) {
            expect(ipBucket.consume('192.0.2.10')).toBe(true);
            expect(identityBucket.consume(`192.0.2.10:${hashThrottlePart(candidate)}`)).toBe(true);
        }
        expect(ipBucket.consume('192.0.2.10')).toBe(false);

        const candidateKey = `192.0.2.11:${hashThrottlePart('secret-user-number')}`;
        for (let attempt = 0; attempt < 12; attempt += 1) expect(identityBucket.consume(candidateKey)).toBe(true);
        expect(identityBucket.consume(candidateKey)).toBe(false);
        expect(hashThrottlePart('secret-user-number')).toBe(crypto.createHash('sha256').update('secret-user-number').digest('hex'));
        expect(hashThrottlePart('secret-user-number')).not.toContain('secret-user-number');

        now += 60001;
        expect(ipBucket.consume('192.0.2.10')).toBe(true);
        expect(identityBucket.consume(candidateKey)).toBe(true);
    });

    it('fails closed for new keys when its bounded store is full', () => {
        const { createFixedWindowThrottle } = require('../../services/requestThrottle');
        const bucket = createFixedWindowThrottle({ windowMs: 60000, limit: 1, maxEntries: 2, now: () => 1000 });
        expect(bucket.consume('first')).toBe(true);
        expect(bucket.consume('second')).toBe(true);
        expect(bucket.consume('third')).toBe(false);
    });
});

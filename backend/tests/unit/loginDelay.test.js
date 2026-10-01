const {
    createLoginThrottle,
    LOGIN_BROWSER_COOKIE,
    FIRST_BLOCK_MS,
    REPEAT_BLOCK_MS,
    RESET_WINDOW_MS,
} = require('../../services/loginDelay');

describe('browser login throttle', () => {
    it('blocks after three failures for one minute, then escalates the next burst to five minutes', () => {
        let now = 1_000;
        const throttle = createLoginThrottle({ now: () => now });
        const key = throttle.keyFor('browser-a', '1062005');

        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(FIRST_BLOCK_MS);
        expect(throttle.retryAfterMs(key)).toBe(FIRST_BLOCK_MS);

        now += FIRST_BLOCK_MS - 1;
        expect(throttle.retryAfterMs(key)).toBe(1);
        now += 1;
        expect(throttle.retryAfterMs(key)).toBe(0);

        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(REPEAT_BLOCK_MS);
        expect(throttle.retryAfterMs(key)).toBe(REPEAT_BLOCK_MS);

        now += REPEAT_BLOCK_MS;
        expect(throttle.retryAfterMs(key)).toBe(0);
    });

    it('resets escalation after a successful login or thirty quiet minutes', () => {
        let now = 10_000;
        const throttle = createLoginThrottle({ now: () => now });
        const key = throttle.keyFor('browser-a', 'cashier');

        for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure(key);
        now += FIRST_BLOCK_MS;
        throttle.clear(key);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(FIRST_BLOCK_MS);

        now += FIRST_BLOCK_MS;
        throttle.recordFailure(key);
        now += RESET_WINDOW_MS;
        expect(throttle.retryAfterMs(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(0);
        expect(throttle.recordFailure(key)).toBe(FIRST_BLOCK_MS);
    });

    it('isolates two users across two browser identities', () => {
        const throttle = createLoginThrottle({ now: () => 1_000 });
        const browserAUser1 = throttle.keyFor('browser-a', 'user-1');
        const browserAUser2 = throttle.keyFor('browser-a', 'user-2');
        const browserBUser1 = throttle.keyFor('browser-b', 'user-1');
        const browserBUser2 = throttle.keyFor('browser-b', 'user-2');

        for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure(browserAUser1);

        expect(throttle.retryAfterMs(browserAUser1)).toBe(FIRST_BLOCK_MS);
        expect(throttle.retryAfterMs(browserAUser2)).toBe(0);
        expect(throttle.retryAfterMs(browserBUser1)).toBe(0);
        expect(throttle.retryAfterMs(browserBUser2)).toBe(0);
    });

    it('keeps storage bounded under hostile browser and candidate churn', () => {
        const throttle = createLoginThrottle({ now: () => 1_000, maxEntries: 64 });
        for (let index = 0; index < 10_000; index += 1) {
            throttle.recordFailure(throttle.keyFor(`browser-${index}`, `user-${index}`));
        }
        expect(throttle.size).toBeLessThanOrEqual(64);
    });

    it('issues and reuses an HttpOnly browser cookie', () => {
        const throttle = createLoginThrottle({ now: () => 1_000 });
        const headers = {};
        const res = {
            getHeader: name => headers[name],
            setHeader: (name, value) => { headers[name] = value; },
        };

        const browserId = throttle.browserIdFor({ headers: {} }, res, { enforceHttps: true });
        const setCookie = headers['Set-Cookie'][0];
        expect(browserId).toMatch(/^[a-f0-9]{32}$/);
        expect(setCookie).toContain(`${LOGIN_BROWSER_COOKIE}=${browserId}`);
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('Secure');
        expect(setCookie).toContain('SameSite=Strict');

        const secondHeaders = {};
        const reused = throttle.browserIdFor(
            { headers: { cookie: `${LOGIN_BROWSER_COOKIE}=${browserId}` } },
            { getHeader: () => undefined, setHeader: (name, value) => { secondHeaders[name] = value; } },
            { enforceHttps: true },
        );
        expect(reused).toBe(browserId);
        expect(secondHeaders['Set-Cookie']).toBeUndefined();
    });
});

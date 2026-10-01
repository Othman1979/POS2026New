describe('manager override attempt serialization', () => {
    it('allows one verifier per actor and surface and releases on server error', async () => {
        const { beginOverrideAttempt, finishOverrideAttempt } = require('../../services/ManagerOverrideService');
        const key = 'permission_override:user:42';
        await beginOverrideAttempt(key);
        await expect(beginOverrideAttempt(key)).rejects.toMatchObject({ statusCode: 429 });
        finishOverrideAttempt(key, 'server-error');
        await expect(beginOverrideAttempt(key)).resolves.toBeUndefined();
        finishOverrideAttempt(key, 'success');
    });

    it('keeps the in-flight guard and an unexpired lockout across a window rollover', async () => {
        const { beginOverrideAttempt, overrideAttempts } = require('../../services/ManagerOverrideService');
        const stale = Date.now() - (6 * 60 * 1000); // older than the 5-minute window

        // A verification straddling the window boundary keeps its serialization guard,
        // and neither the lazy reset nor the periodic sweep may evict it.
        const busy = 'permission_override:user:900';
        overrideAttempts.set(busy, { count: 1, firstAttemptAt: stale, lockedUntil: 0, inFlight: true });
        await expect(beginOverrideAttempt(busy)).rejects.toMatchObject({ statusCode: 429 });

        // firstAttemptAt is preserved across failures, so a lockout set by a late fifth
        // failure must not be shed when the window measured from the first one expires.
        const locked = 'permission_override:user:901';
        overrideAttempts.set(locked, { count: 5, firstAttemptAt: stale, lockedUntil: Date.now() + 60_000, inFlight: false });
        await expect(beginOverrideAttempt(locked)).rejects.toMatchObject({ statusCode: 429 });

        // Genuinely expired state still resets.
        const done = 'permission_override:user:902';
        overrideAttempts.set(done, { count: 5, firstAttemptAt: stale, lockedUntil: stale + 1000, inFlight: false });
        await expect(beginOverrideAttempt(done)).resolves.toBeUndefined();

        [busy, locked, done].forEach(key => overrideAttempts.delete(key));
    });

    it('keeps different actors and surfaces independent', async () => {
        const { beginOverrideAttempt, finishOverrideAttempt } = require('../../services/ManagerOverrideService');
        const keys = ['manager_override:user:50', 'permission_override:user:50', 'manager_override:user:51'];
        for (const key of keys) await expect(beginOverrideAttempt(key)).resolves.toBeUndefined();
        for (const key of keys) finishOverrideAttempt(key, 'success');
    });
});

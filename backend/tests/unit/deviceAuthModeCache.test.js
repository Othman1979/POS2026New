const pool = require('../../config/db');
const { readAuthMode, invalidateAuthModeCache } = require('../../services/deviceAccess');

describe('device authentication mode cache', () => {
    beforeEach(() => invalidateAuthModeCache());
    afterEach(() => vi.restoreAllMocks());

    it('single-flights concurrent default-pool reads for five seconds', async () => {
        const query = vi.spyOn(pool, 'query').mockResolvedValue([[{ setting_value: 'staged' }]]);
        const values = await Promise.all(Array.from({ length: 100 }, () => readAuthMode()));
        expect(new Set(values)).toEqual(new Set(['staged']));
        expect(query).toHaveBeenCalledTimes(1);
        expect(await readAuthMode()).toBe('staged');
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('never caches an explicit transaction executor', async () => {
        const executor = { query: vi.fn().mockResolvedValue([[{ setting_value: 'enforced' }]]) };
        expect(await readAuthMode(executor)).toBe('enforced');
        expect(await readAuthMode(executor)).toBe('enforced');
        expect(executor.query).toHaveBeenCalledTimes(2);
    });

    it('does not let an invalidated in-flight read repopulate stale mode', async () => {
        let resolveOld;
        const oldRead = new Promise(resolve => { resolveOld = resolve; });
        const query = vi.spyOn(pool, 'query')
            .mockReturnValueOnce(oldRead)
            .mockResolvedValue([[{ setting_value: 'enforced' }]]);
        const staleCaller = readAuthMode();
        invalidateAuthModeCache();
        expect(await readAuthMode()).toBe('enforced');
        resolveOld([[{ setting_value: 'staged' }]]);
        expect(await staleCaller).toBe('staged');
        expect(await readAuthMode()).toBe('enforced');
        expect(query).toHaveBeenCalledTimes(2);
    });
});

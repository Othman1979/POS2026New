import { describe, expect, it } from 'vitest';
import cache from '../../config/cache.js';

describe('catalog generation token', () => {
    it('stays equal until the catalog cache is invalidated', () => {
        const before = cache.getCatalogGenerationToken();
        expect(cache.getCatalogGenerationToken()).toBe(before);
        cache.invalidateCatalogCache();
        expect(cache.getCatalogGenerationToken()).not.toBe(before);
    });
});

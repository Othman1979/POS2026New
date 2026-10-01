import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

// The Arabic dictionary is fetched as an asset at runtime; tests serve it from disk.
export function serveArabicDictionary() {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => catalog }));
}

import { fetchJson } from '@/shared/http.js';
// Session-scoped cache for the static-ish `api/system/settings` payload.
// Plain-function helper: no Vue hook, no refs.
//
// Local saves and admin realtime settings/reconnect events invalidate this
// cache. Every read-only consumer shares one fetch after each invalidation.
//
// CONTRACT: the resolved object is shared by reference — treat it as READ-ONLY.

let cached = null;      // last successful parsed response
let inFlight = null;    // dedupe concurrent callers during a fetch
let generation = 0;

export async function getSystemSettings({ force = false } = {}) {
    if (force) invalidateSystemSettings();
    if (cached) return cached;
    if (inFlight) return inFlight;

    const requestGeneration = generation;
    inFlight = (async () => {
        try {
            const data = await fetchJson('api/system/settings');
            // An in-flight read may predate a save. Its callers must join the
            // current read too, otherwise a late response can repaint old flags.
            if (requestGeneration !== generation) return getSystemSettings();
            // Only cache successful payloads; failures fall through so the
            // next caller retries instead of being pinned to an error.
            if (data && data.success) cached = data;
            return data;
        } finally {
            if (requestGeneration === generation) inFlight = null;
        }
    })();

    return inFlight;
}

export function invalidateSystemSettings() {
    generation += 1;
    cached = null;
    inFlight = null;
}

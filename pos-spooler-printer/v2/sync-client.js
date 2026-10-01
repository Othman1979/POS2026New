const crypto = require('crypto');
const { fetchTextWithTimeout } = require('../http-client');
const V2_SYNC_WAIT_MS = 6000;

function invalidResponse() {
    return Object.assign(new Error('SPOOLER_RESPONSE_INVALID'), { code: 'SPOOLER_RESPONSE_INVALID' });
}

function createSyncClient({
    baseUrl,
    agentId,
    secret,
    bootstrapKey,
    spoolerId,
    spoolerName = spoolerId,
    agentVersion,
    fetchFn = fetch,
    timeoutMs = 15000
}) {
    const origin = String(baseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin)) throw new Error('CLOUD_SERVER_URL_INVALID');
    const credential = Buffer.from(secret).toString('base64url');

    async function post(route, headers, body, { signal = null } = {}) {
        const { response, text } = await fetchTextWithTimeout(`${origin}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        }, timeoutMs, fetchFn, signal);
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        if (!response.ok) {
            const error = new Error(payload?.code || `HTTP_${response.status}`);
            error.code = payload?.code || `HTTP_${response.status}`;
            error.status = response.status;
            error.response = payload;
            throw error;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success === false) throw invalidResponse();
        return payload;
    }

    return {
        register(options) {
            return post('/api/spooler/v2/register', { 'x-spooler-key': bootstrapKey }, {
                protocol_version: 2,
                agent_id: agentId,
                spooler_id: spoolerId,
                token_hash: crypto.createHash('sha256').update(credential).digest('hex'),
                name: spoolerName,
                agent_version: agentVersion
            }, options);
        },
        async sync(body, options) {
            const payload = await post('/api/spooler/v2/sync', {
                'x-agent-id': agentId,
                'x-agent-token': credential
            }, { ...body, spooler_id: spoolerId, wait_ms: V2_SYNC_WAIT_MS }, options);
            if (typeof payload.agent_status !== 'string' || !payload.agent_status.trim() || !Array.isArray(payload.jobs)
                || ['confirmed_accepted', 'confirmed_results', 'cancel_requested'].some(key => payload[key] != null && !Array.isArray(payload[key]))) {
                throw invalidResponse();
            }
            return payload;
        }
    };
}

module.exports = { createSyncClient, V2_SYNC_WAIT_MS };

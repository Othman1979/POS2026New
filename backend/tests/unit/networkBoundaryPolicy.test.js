const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('network boundary policy', () => {
    it('never trusts forwarded proxy identity', () => {
        expect(serverSource).not.toContain("require('./backend/config/trustProxy')");
        expect(serverSource).not.toMatch(/app\.set\(['"]trust proxy['"]/);
    });

    it('never decides the redirect from req.protocol', () => {
        expect(serverSource).not.toMatch(/req\.protocol/);
    });

    describe('with HTTPS enforced', () => {
        let httpsApp;

        beforeAll(() => {
            const serverPath = require.resolve('../../../server');
            const previous = process.env.ENFORCE_HTTPS;
            process.env.ENFORCE_HTTPS = 'true';
            // server.js reloads .env.test with override under NODE_ENV=test; keep it from resetting the flag.
            const loadEnv = vi.spyOn(require('dotenv'), 'config').mockReturnValue({ parsed: {} });
            delete require.cache[serverPath];
            try {
                httpsApp = require(serverPath).app;
            } finally {
                loadEnv.mockRestore();
                delete require.cache[serverPath];
                if (previous === undefined) delete process.env.ENFORCE_HTTPS;
                else process.env.ENFORCE_HTTPS = previous;
            }
        });

        it('redirects a request the proxy reports as plaintext to the same HTTPS URL', async () => {
            const res = await request(httpsApp)
                .get('/api/health?probe=1')
                .set('Host', 'pos.example')
                .set('X-Forwarded-Proto', 'HTTP, https');

            expect(res.statusCode).toBe(301);
            expect(res.headers.location).toBe('https://pos.example/api/health?probe=1');
        });

        it('serves forwarded HTTPS without redirecting', async () => {
            const res = await request(httpsApp)
                .get('/api/health')
                .set('Host', 'pos.example')
                .set('X-Forwarded-Proto', 'https');

            expect(res.statusCode).toBe(200);
            expect(res.headers.location).toBeUndefined();
        });

        it('serves a request with no forwarded protocol without redirecting', async () => {
            const res = await request(httpsApp).get('/api/health').set('Host', 'pos.example');

            expect(res.statusCode).toBe(200);
            expect(res.headers.location).toBeUndefined();
        });
    });

    it('does not keep identity-less API or checkout buckets in the server', () => {
        expect(serverSource).not.toContain('apiRateLimit');
        expect(serverSource).not.toContain("app.use('/api/pos/checkout', checkoutRateLimit)");
        expect(serverSource).not.toContain(['createIp', 'RateLimiter'].join(''));
        expect(serverSource).not.toContain('publicRateLimit');
    });

    it('normalizes Express route aliases and parses tight bodies before acquiring a lease', () => {
        expect(serverSource).toContain("req.method === 'HEAD' ? 'GET'");
        expect(serverSource).toContain(".toLowerCase()");
        expect(serverSource).toContain("replace(/\\/+$/, '')");
        const jsonParser = serverSource.indexOf('tightPreAuthJson(req, res, next)');
        const formParser = serverSource.indexOf('tightPreAuthForm(req, res, next)');
        const gate = serverSource.indexOf('preAuthGate(req, res, next)');
        expect(jsonParser).toBeGreaterThan(0);
        expect(formParser).toBeGreaterThan(jsonParser);
        expect(gate).toBeGreaterThan(formParser);
        expect(serverSource).toContain("normalizePreAuthPath(req.path) !== '/public_menu.json'");
    });

    // The gate and the tight parsers match on req.path. Any middleware mounted below them
    // that rewrites req.url creates an alias for a covered route that the matcher cannot
    // see, silently removing the only pre-auth control. A legacy `.php` normalizer did
    // exactly that. This asserts the class, not the one suffix.
    it('never rewrites a request path after the gate has matched it', () => {
        const gate = serverSource.indexOf('preAuthGate(req, res, next)');
        expect(gate).toBeGreaterThan(0);
        expect(serverSource.slice(gate)).not.toMatch(/req\.url\s*=/);
        expect(serverSource).not.toContain(".endsWith('.php')");
    });
});

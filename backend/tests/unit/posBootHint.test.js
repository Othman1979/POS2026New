const fs = require('fs');
const path = require('path');
const { POS_BOOT_HINT_SCRIPT, POS_BOOT_HINT_SCRIPT_HASH } = require('../../config/posBootHint');

const ROOT = path.resolve(__dirname, '../../..');

describe('POS boot hint', () => {
    it('index.html carries exactly the inline script the CSP hash allows', () => {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
        expect(inline).toEqual([POS_BOOT_HINT_SCRIPT]);
        expect(POS_BOOT_HINT_SCRIPT_HASH).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    });

    it('the server CSP allows the boot hint by hash and nothing inline besides it', async () => {
        const request = require('supertest');
        const { app } = require('../../../server');
        const response = await request(app).get('/api/health');
        const directives = Object.fromEntries(String(response.headers['content-security-policy'] || '')
            .split(';').map(part => part.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values]));
        for (const name of ['script-src', 'script-src-elem']) {
            expect(directives[name]).toEqual(["'self'", POS_BOOT_HINT_SCRIPT_HASH]);
        }
    });

    it('marks a signed-out browser and leaves a signed-in one alone', () => {
        const run = storage => {
            const classes = new Set();
            const sandbox = { localStorage: storage, document: { documentElement: { classList: { add: name => classes.add(name) } } } };
            new Function('localStorage', 'document', POS_BOOT_HINT_SCRIPT)(sandbox.localStorage, sandbox.document);
            return classes.has('pos-boot-signed-out');
        };
        expect(run({ getItem: () => null })).toBe(true);
        expect(run({ getItem: () => '7' })).toBe(false);
        // Blocked storage (private mode) must not break the page.
        expect(run({ getItem: () => { throw new Error('denied'); } })).toBe(false);
    });
});

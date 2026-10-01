const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { createCorsPolicy } = require('../../config/corsPolicy');

const socketAllowed = (policy, headers) => new Promise(resolve => {
    policy.allowSocketRequest({ headers }, (error, allowed) => resolve({ error, allowed }));
});

describe('browser origin policy', () => {
    it('defaults HTTP to no cross-origin headers and Socket.IO to same-host requests', async () => {
        const policy = createCorsPolicy('');
        const app = express().use(cors(policy.httpOptions)).get('/health', (_req, res) => res.json({ ok: true }));

        const crossOrigin = await request(app).get('/health').set('Origin', 'https://attacker.example');
        expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined();
        await expect(socketAllowed(policy, { host: 'pos.local:3000', origin: 'http://pos.local:3000' }))
            .resolves.toEqual({ error: null, allowed: true });
        await expect(socketAllowed(policy, { host: 'pos.local:3000', origin: 'https://attacker.example' }))
            .resolves.toEqual({ error: 'Origin not allowed.', allowed: false });
        await expect(socketAllowed(policy, { host: 'pos.local:3000' }))
            .resolves.toEqual({ error: null, allowed: true });
    });

    it('normalizes explicit origins for HTTP and Socket.IO without allowing another site', async () => {
        const policy = createCorsPolicy(' https://pos.example.com/path,https://pos.example.com ');
        const app = express().use(cors(policy.httpOptions)).get('/health', (_req, res) => res.json({ ok: true }));

        expect(policy.origins).toEqual(['https://pos.example.com']);
        const allowed = await request(app).get('/health').set('Origin', 'https://pos.example.com');
        expect(allowed.headers['access-control-allow-origin']).toBe('https://pos.example.com');
        const denied = await request(app).get('/health').set('Origin', 'https://attacker.example');
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
        await expect(socketAllowed(policy, { host: 'internal.local:3000', origin: 'https://pos.example.com' }))
            .resolves.toEqual({ error: null, allowed: true });
        await expect(socketAllowed(policy, { host: 'internal.local:3000', origin: 'https://attacker.example' }))
            .resolves.toEqual({ error: 'Origin not allowed.', allowed: false });
    });

    it.each(['*', 'pos.example.com', 'file:///tmp/pos'])('rejects unsafe configured origin %s', value => {
        expect(() => createCorsPolicy(value)).toThrow('CORS_ORIGIN entries must be explicit HTTP(S) origins.');
    });
});

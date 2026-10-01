import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import frontendStaticHeaders from '../../http/frontendStaticHeaders.js';

const { setFrontendStaticHeaders } = frontendStaticHeaders;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-static-headers-'));
fs.writeFileSync(path.join(root, 'PosTerminal-Abc_1234.js'), 'export default 1;');
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>POS</title>');
fs.writeFileSync(path.join(root, 'public_menu.json'), '{}');
const app = express();
app.use(express.static(root, { setHeaders: setFrontendStaticHeaders }));

afterAll(() => {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())
        || !path.basename(resolved).startsWith('posapp-static-headers-')) {
        throw new Error('Refusing to remove an unexpected static-header fixture directory.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
});

describe('frontend static cache headers', () => {
    it('lets a browser reuse a fingerprinted build file without revalidation', async () => {
        const response = await request(app).get('/PosTerminal-Abc_1234.js');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it.each(['index.html', 'public_menu.json'])('keeps %s revalidating after deployment', async (file) => {
        const response = await request(app).get(`/${file}`);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=0');
    });
});

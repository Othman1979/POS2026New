import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const moduleUrl = pathToFileURL(path.join(ROOT, 'backend/services/webauthn/config.js')).href;

const validEnv = (overrides = {}) => ({
    DEVICE_AUTH_ALLOWED_ORIGINS: 'https://hashemi.shawermajwana.com',
    ...overrides
});

describe('registered-browser origin configuration', () => {
    it('loads exact HTTPS origins without deriving anything from request headers', async () => {
        const { loadWebAuthnConfig, validateWebAuthnOrigin } = await import(moduleUrl);
        const config = loadWebAuthnConfig(validEnv());

        expect(config).toEqual({ expectedOrigins: ['https://hashemi.shawermajwana.com'] });
        expect(validateWebAuthnOrigin(config, 'https://hashemi.shawermajwana.com')).toBe(true);
        expect(validateWebAuthnOrigin(config, 'https://attacker.example')).toBe(false);
    });

    it('accepts an explicit canonical subdomain without requiring an obsolete RP ID', async () => {
        const { loadWebAuthnConfig } = await import(moduleUrl);
        const config = loadWebAuthnConfig(validEnv({
            DEVICE_AUTH_ALLOWED_ORIGINS: 'https://pos.example.com'
        }));

        expect(config.expectedOrigins).toEqual(['https://pos.example.com']);
    });

    it('allows only the localhost HTTP exception and rejects direct IP origins', async () => {
        const { loadWebAuthnConfig } = await import(moduleUrl);

        expect(loadWebAuthnConfig({
            DEVICE_AUTH_ALLOWED_ORIGINS: 'http://localhost:3000'
        }).expectedOrigins).toEqual(['http://localhost:3000']);

        for (const value of [
            'http://192.168.1.10:3000',
            'https://127.0.0.1:3000',
            'https://hashemi.shawermajwana.com/path'
        ]) {
            expect(() => loadWebAuthnConfig({
                DEVICE_AUTH_ALLOWED_ORIGINS: value
            })).toThrow();
        }
    });

    it('rejects wildcard, host-header-shaped, credentialed, and duplicate origin input', async () => {
        const { loadWebAuthnConfig } = await import(moduleUrl);
        for (const overrides of [
            { DEVICE_AUTH_ALLOWED_ORIGINS: 'https://*.example.com' },
            { DEVICE_AUTH_ALLOWED_ORIGINS: 'example.com' },
            { DEVICE_AUTH_ALLOWED_ORIGINS: 'https://user:pass@example.com' },
            { DEVICE_AUTH_ALLOWED_ORIGINS: 'https://example.com, https://example.com' }
        ]) {
            expect(() => loadWebAuthnConfig(overrides)).toThrow();
        }
    });

    it('fails closed for staged or enforced mode when configuration or HTTPS policy is incomplete', async () => {
        const { assertWebAuthnRuntimeReady, loadWebAuthnConfig } = await import(moduleUrl);

        expect(() => assertWebAuthnRuntimeReady({
            config: null,
            mode: 'disabled',
            enforceHttps: false
        })).not.toThrow();

        expect(() => assertWebAuthnRuntimeReady({
            config: null,
            mode: 'staged',
            enforceHttps: true
        })).toThrow(/configuration/i);

        const online = loadWebAuthnConfig(validEnv());
        expect(() => assertWebAuthnRuntimeReady({ config: online, mode: 'enforced', enforceHttps: false })).toThrow(/HTTPS/i);

        const local = loadWebAuthnConfig({
            DEVICE_AUTH_ALLOWED_ORIGINS: 'http://localhost:3000'
        });
        expect(() => assertWebAuthnRuntimeReady({ config: local, mode: 'staged', enforceHttps: false })).not.toThrow();
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
const crypto = require('crypto');
const { readOrderIntakeConfig, isReservedOrderIntakeActor } = require('../../modules/orderIntake/config');
const { requireOrderIntakeAuth } = require('../../modules/orderIntake/auth');
const { normalizeDraftInput, normalizeCustomerLookup } = require('../../modules/orderIntake/contract');
const { requestHash, createQuoteToken, verifyQuoteToken } = require('../../modules/orderIntake/quoteToken');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

function validConfig(overrides = {}) {
    return readOrderIntakeConfig({
        ORDER_INTAKE_ENABLED: 'true',
        ORDER_INTAKE_CLIENT_ID: 'test-client',
        ORDER_INTAKE_API_KEY_SHA256: crypto.createHash('sha256').update('x'.repeat(48)).digest('hex'),
        ORDER_INTAKE_QUOTE_SECRET: 'q'.repeat(48),
        ORDER_INTAKE_ACTOR_USER_ID: '70',
        ...overrides,
    });
}

function draft(overrides = {}) {
    return {
        external_request_id: 'call-12345678',
        order_type_id: 1,
        customer: { name: 'Test Customer', phone: '079-123-4567', address: 'Amman' },
        items: [{ product_id: 1, quantity: 1 }],
        ...overrides,
    };
}

describe('order-intake configuration and authentication', () => {
    it('stays disabled by default and validates every required secret when enabled', () => {
        expect(readOrderIntakeConfig({})).toMatchObject({ enabled: false, valid: false });
        expect(validConfig()).toMatchObject({ enabled: true, valid: true, activeHoldLimit: 200 });
        expect(validConfig({ NODE_ENV: 'production', ENFORCE_HTTPS: 'false' })).toMatchObject({
            enabled: true,
            valid: false,
        });
        expect(validConfig({ NODE_ENV: 'production', ENFORCE_HTTPS: 'true' })).toMatchObject({
            enabled: true,
            valid: true,
        });
        expect(isReservedOrderIntakeActor(70, { ORDER_INTAKE_ACTOR_USER_ID: '70' })).toBe(true);
        expect(isReservedOrderIntakeActor(71, { ORDER_INTAKE_ACTOR_USER_ID: '70' })).toBe(false);
        expect(isReservedOrderIntakeActor(70, { ORDER_INTAKE_ACTOR_USER_ID: 'invalid' })).toBe(false);
    });

    it('accepts only the configured bearer key and never a query or cookie credential', () => {
        const raw = 'a'.repeat(48);
        process.env.ORDER_INTAKE_ENABLED = 'true';
        process.env.ORDER_INTAKE_CLIENT_ID = 'test-client';
        process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(raw).digest('hex');
        process.env.ORDER_INTAKE_QUOTE_SECRET = 'q'.repeat(48);
        process.env.ORDER_INTAKE_ACTOR_USER_ID = '70';
        const response = {
            headers: {},
            set(name, value) { this.headers[name] = value; return this; },
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        };
        const next = vi.fn();
        requireOrderIntakeAuth({ get: () => `Bearer ${raw}` }, response, next);
        expect(next).toHaveBeenCalledOnce();

        const denied = { ...response, headers: {}, set: response.set, status: response.status, json: response.json };
        requireOrderIntakeAuth({ get: () => '' }, denied, vi.fn());
        expect(denied.statusCode).toBe(401);
        expect(denied.body).toMatchObject({ code: 'ORDER_INTAKE_AUTH_REQUIRED' });

        const rotated = 'b'.repeat(48);
        process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(rotated).digest('hex');
        const oldKey = { ...response, headers: {}, set: response.set, status: response.status, json: response.json };
        requireOrderIntakeAuth({ get: () => `Bearer ${raw}` }, oldKey, vi.fn());
        expect(oldKey.statusCode).toBe(401);
        const rotatedNext = vi.fn();
        requireOrderIntakeAuth({ get: () => `Bearer ${rotated}` }, response, rotatedNext);
        expect(rotatedNext).toHaveBeenCalledOnce();

        process.env.ORDER_INTAKE_ENABLED = 'false';
        const disabled = { ...response, headers: {}, set: response.set, status: response.status, json: response.json };
        requireOrderIntakeAuth({ get: () => `Bearer ${rotated}` }, disabled, vi.fn());
        expect(disabled.statusCode).toBe(404);
        expect(disabled.body).toMatchObject({ code: 'ORDER_INTAKE_DISABLED' });
    });
});

describe('order-intake contract and quote authority', () => {
    it('normalizes the provider-neutral draft and rejects price authority', () => {
        expect(normalizeDraftInput(draft())).toMatchObject({
            customer: { phone: '0791234567' },
            items: [{ product_id: 1, quantity: 1 }],
        });
        expect(() => normalizeDraftInput(draft({ items: [{ product_id: 1, quantity: 1, price: 0.01 }] })))
            .toThrow(/unsupported fields: price/);
        const oversizedPhone = `079123${' '.repeat(1000)}`;
        expect(() => normalizeDraftInput(draft({ customer: { name: 'Test Customer', phone: oversizedPhone, address: 'Amman' } })))
            .toThrow(/Customer phone is too long/);
        expect(() => normalizeCustomerLookup({ phone: oversizedPhone })).toThrow(/Customer phone is too long/);
    });

    it('uses a non-PII signed quote and rejects tampering, expiry, and another draft', () => {
        const config = validConfig();
        const normalized = normalizeDraftInput(draft());
        const digest = requestHash(normalized);
        const created = createQuoteToken({
            config,
            actorUserId: 70,
            requestDigest: digest,
            quoteDigest: 'b'.repeat(64),
            now: 1_000_000,
        });
        expect(created.token).not.toContain('Test Customer');
        expect(verifyQuoteToken(created.token, {
            config,
            actorUserId: 70,
            requestDigest: digest,
            now: 1_001_000,
        })).toMatchObject({ quote_hash: 'b'.repeat(64) });
        expect(() => verifyQuoteToken(`${created.token}x`, {
            config, actorUserId: 70, requestDigest: digest, now: 1_001_000,
        })).toThrow(/invalid/i);
        expect(() => verifyQuoteToken(created.token, {
            config, actorUserId: 70, requestDigest: requestHash(normalizeDraftInput(draft({ order_note: 'changed' }))), now: 1_001_000,
        })).toThrow(/does not match/i);
        expect(() => verifyQuoteToken(created.token, {
            config, actorUserId: 70, requestDigest: digest, now: 2_000_000,
        })).toThrow(/expired/i);
    });
});

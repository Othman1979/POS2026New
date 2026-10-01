// globalSetup.mjs — runs ONCE before any test worker is spawned.
// Must be ESM (.mjs) because Vitest's globalSetup runs in the main ESM context.
//
// Critical: set DB_NAME before db.js is loaded in any worker.
// The mysql2 pool is initialized at module-load time when db.js is required,
// so we must override env vars BEFORE that happens.

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const { createConnection } = createRequire(import.meta.url)('mysql2/promise');
const { getTestDatabaseOptions } = createRequire(import.meta.url)('./testDatabase.cjs');
let lockConnection;
let lockName;

export function configureTestEnvironment() {
    // Load .env.test, overriding any variables already set by .env
    config({ path: resolve(root, '.env.test'), override: true });

    // Force test-safe defaults if .env.test is missing keys
    process.env.NODE_ENV = 'test';
    process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
    process.env.ENFORCE_HTTPS = 'false';
    process.env.LOG_LEVEL = 'silent'; // suppress Pino output during tests
    // Private .env.test files are intentionally untracked and are absent in fresh
    // worktrees/CI. Keep abuse controls enabled in production while preventing a long
    // Supertest suite from rate-limiting itself. Throttles are now keyed by credential
    // then user rather than by IP, and the suite drives hundreds of checkouts as a single
    // actor, so the per-actor checkout budget is the one that needs lifting here. The
    // pre-auth gate and the print limiters are not raised: measured against the full
    // suite, neither is reached.
    process.env.CHECKOUT_RATE_LIMIT_MAX = process.env.CHECKOUT_RATE_LIMIT_MAX || '9999';
    getTestDatabaseOptions();
}

export async function setup() {
    configureTestEnvironment();
    const { database, ...connectionOptions } = getTestDatabaseOptions();
    lockConnection = await createConnection(connectionOptions);
    lockName = `${database}:vitest`;
    try {
        const [[lock]] = await lockConnection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
        if (Number(lock.acquired) !== 1) {
            throw new Error(`The ${database} test database is already in use by another Vitest run.`);
        }
    } catch (error) {
        await lockConnection.end();
        lockConnection = undefined;
        throw error;
    }
}

export async function teardown() {
    if (!lockConnection) return;
    try {
        await lockConnection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
        await lockConnection.end();
        lockConnection = undefined;
    }
}

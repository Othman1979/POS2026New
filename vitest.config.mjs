import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@posapp/permission-policy': fileURLToPath(new URL('./backend/config/permissionPolicy.cjs', import.meta.url)),
        },
    },
    test: {
        // Run tests in Node.js environment — required for CommonJS backend code
        environment: 'node',
        globals: true,
        fileParallelism: false,
        maxWorkers: 1,

        // Load .env.test before any test file is imported so the DB pool
        // is initialized against posapp_test, not posapp.
        globalSetup: ['./backend/tests/globalSetup.mjs'],

        // Per-test-file setup: inject and reset the Socket.IO route test double.
        setupFiles: ['./backend/tests/setup.js'],

        // Glob patterns for all test files
        include: [
            'backend/tests/unit/**/*.test.js',
            'backend/tests/integration/**/*.test.js',
            'src/**/*.spec.js',
        ],

        // Disable Vite's transform pipeline for CommonJS — let Node.js handle require()
        // natively. This avoids transform errors with mysql2 and other native modules.
        server: {
            deps: {
                // Do not transform anything — all backend code is CommonJS
                inline: [],
            },
        },

        // Sequence: run unit tests before integration tests (unit = faster, no DB)
        sequence: {
            shuffle: false,
        },

        // 30-second timeout per test — integration tests hit MySQL
        testTimeout: 30000,
        hookTimeout: 30000,

        // Coverage output when running with --coverage
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: [
                'backend/services/**',
                'backend/middleware/**',
                'backend/http/jsonResponse.js',
                'backend/modules/orders/SavedOrderLines.js',
                'backend/modules/checkout/executeCheckout.js',
                'backend/routes/pos/checkout.js',
            ],
        },
    },
});

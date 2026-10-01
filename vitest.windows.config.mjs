import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: [
            'backend/tests/unit/installerPackageContract.test.js',
            'backend/tests/unit/installerUpdateContract.test.js',
            'backend/tests/windows/deploymentSourceArchive.test.js',
        ],
        testTimeout: 30000,
    },
});

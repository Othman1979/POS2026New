import config from './vitest.config.mjs';

// Frontend tests use API doubles and do not need an Express server or MySQL lock.
export default {
    ...config,
    test: {
        ...config.test,
        globalSetup: [],
        setupFiles: [],
        include: ['src/**/*.spec.js'],
    },
};

// Review-only database isolation. Used with NODE_OPTIONS=--require=<this file>.
const path = require('node:path');
const dotenv = require('dotenv');
const originalConfig = dotenv.config;
const { requiredInteger } = require('../../backend/config/databasePoolOptions');
const name = process.env.POSAPP_REVIEW_DB;
if (!/^posapp_review_recipe_p1_[a-f0-9]{12}$/.test(name || '')) {
    throw new Error('A dedicated POSAPP_REVIEW_DB name is required.');
}
function isolate() {
    if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST || '127.0.0.1')) {
        throw new Error('Review requires a loopback database host.');
    }
    process.env.DB_NAME = name;
    if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT != null) {
        process.env.DB_CONNECTION_LIMIT = String(requiredInteger(
            'POSAPP_REVIEW_CONNECTION_LIMIT', process.env.POSAPP_REVIEW_CONNECTION_LIMIT, 10, { max: 100 }
        ));
    }
    process.env.NODE_ENV = 'test';
    process.env.ENFORCE_HTTPS = 'false';
    process.env.LOG_LEVEL = 'silent';
    if (!process.env.CHECKOUT_RATE_LIMIT_MAX) {
        process.env.CHECKOUT_RATE_LIMIT_MAX = '100000';
    }
}
dotenv.config = function (options) {
    const result = originalConfig.call(this, options);
    isolate();
    return result;
};
dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: true, quiet: true });

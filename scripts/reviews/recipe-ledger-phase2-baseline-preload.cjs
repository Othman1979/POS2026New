// Run the final Phase 2 regression tests against the reviewed application code
// without reverting files in the shared checkout. NODE_OPTIONS also reaches workers.
require('./recipe-ledger-phase1-preload.cjs');
const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = '50cebe3f';
const files = new Set([
    'backend/modules/orders/SavedOrderLines.js',
    'backend/modules/tables/splitChecks.js',
    'backend/services/RecipeLedgerService.js',
    'backend/services/RefundService.js',
    'backend/modules/refunds/voidOpenTableOrder.js',
    'backend/routes/admin/subscriptions.js',
    'backend/modules/checkout/executeCheckout.js',
    'backend/routes/system.js'
]);
const original = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    if (!files.has(relative)) return original(module, filename);
    const source = execFileSync('git', ['show', baseline + ':' + relative], { cwd: root, encoding: 'utf8' });
    module._compile(source, filename);
};

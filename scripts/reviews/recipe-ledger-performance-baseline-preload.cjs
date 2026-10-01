// Pre-ledger application source, with current test fixtures and scratch isolation.
// The shared checkout is never reverted or switched.
require('./recipe-ledger-phase1-preload.cjs');
const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = '74820d4b';
const git = args => execFileSync('git', args, {cwd:root,encoding:'utf8'});
const existed = new Set(git(['ls-tree','-r','--name-only',baseline,'--','backend','server.js']).trim().split('\n'));
const changed = new Set(git(['diff','--name-only',baseline,'dfb5262d','--','backend','server.js']).trim().split('\n')
    .filter(file => existed.has(file) && file.endsWith('.js') && !file.startsWith('backend/tests/')));
const original = Module._extensions['.js'];
Module._extensions['.js'] = function(module,filename) {
    const relative = path.relative(root,filename).replaceAll('\\','/');
    if (!changed.has(relative)) return original(module,filename);
    module._compile(git(['show',baseline+':'+relative]),filename);
};

const assert = require('assert');

const {
    createBeepCommand,
    getCommandNames,
    parseArgs,
} = require('../beep-tester');

assert.deepStrictEqual(getCommandNames(), ['esc-b', 'esc-b-init', 'esc-c', 'esc-c-init', 'bel', 'rs', 'star']);
assert.strictEqual(createBeepCommand('esc-b', { count: 3, duration: 5 }).toString('hex'), '1b420305');
assert.strictEqual(createBeepCommand('esc-b-init', { count: 3, duration: 5 }).toString('hex'), '1b401b420305');
assert.strictEqual(createBeepCommand('esc-c', { count: 3, duration: 5 }).toString('hex'), '1b43030501');
assert.strictEqual(createBeepCommand('esc-c-init', { count: 3, duration: 5 }).toString('hex'), '1b401b43030501');
assert.strictEqual(createBeepCommand('bel').toString('hex'), '07');
assert.strictEqual(createBeepCommand('rs').toString('hex'), '1e');
assert.strictEqual(createBeepCommand('star', { count: 2, duration: 4 }).toString('hex'), '1b1d07020404');
assert.throws(() => createBeepCommand('unknown'), /Unknown beep command/);
assert.strictEqual(parseArgs(['--network', '192.168.1.50', '--port', '9100']).port, 9100);
assert.strictEqual(parseArgs(['--hex', '1B 42 03 05']).hex, '1B 42 03 05');

console.log('beep-tester tests passed');

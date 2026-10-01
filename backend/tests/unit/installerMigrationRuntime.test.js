const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');

function jsFiles(directory) {
    return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(directory, entry.name));
}

describe('installer migration runtime', () => {
    it('packages every backend/migrations module that runtime code requires', () => {
        // The installers exclude backend/migrations and copy back only this allowlist.
        const script = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const allowlist = new Set([...script.match(/\$migrationRuntimeFiles = @\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)]
            .map(match => match[1].split(String.fromCharCode(92)).join('/')));
        const sources = ['server.js', ...jsFiles('backend/services'), ...jsFiles('deployment/tools'), 'backend/migrations/runPendingMigrations.js'];
        const required = new Set();
        for (const file of sources) {
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            for (const match of text.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
                let target = path.posix.normalize(path.posix.join(path.posix.dirname(file.split(path.sep).join('/')), match[1]));
                if (!target.startsWith('backend/migrations/')) continue;
                if (!/\.(js|json)$/.test(target)) target += '.js';
                required.add(target);
            }
        }
        expect(required.size).toBeGreaterThan(0);
        for (const target of required) expect(allowlist, target).toContain(target);
    });
});

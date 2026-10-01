const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}

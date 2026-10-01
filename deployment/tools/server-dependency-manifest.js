const fs = require('fs');
const path = require('path');
const { collectInventory } = require('./spooler-layer-manifest');

function createServerDependencyManifest(root) {
    return {
        format: 1,
        kind: 'server-dependencies',
        nodeVersion: '22.23.0',
        platform: 'win32',
        arch: 'x64',
        dependencies: collectInventory(root, ['node_modules'], { ignoreNpmHiddenLock: true }),
    };
}

if (require.main === module) {
    try {
        const [root, outputPath] = process.argv.slice(2);
        if (!root || !outputPath) throw new Error('Usage: server-dependency-manifest.js <root> <output>');
        const manifest = createServerDependencyManifest(root);
        fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify({ dependenciesId: manifest.dependencies.id, files: manifest.dependencies.files.length })}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { createServerDependencyManifest };

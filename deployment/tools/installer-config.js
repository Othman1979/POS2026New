const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

function validatePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
    return port;
}

function checkPort(value, host = '127.0.0.1') {
    const port = validatePort(value);
    return new Promise((resolve) => {
        const server = net.createServer();
        const finish = (available) => {
            server.removeAllListeners();
            server.close(() => resolve(available));
        };
        server.once('error', () => finish(false));
        server.listen(port, host, () => finish(true));
    });
}

async function suggestAvailablePort(preferred, isAvailable = checkPort) {
    const start = validatePort(preferred);
    for (let port = start; port <= 65535; port += 1) {
        if (await isAvailable(port)) return port;
    }
    throw new Error('No available port found.');
}

function generateSecret(bytes = 32) {
    if (!Number.isInteger(bytes) || bytes < 16) throw new Error('Secret size must be at least 16 bytes.');
    return crypto.randomBytes(bytes).toString('base64url');
}

function generateNumericCode(digits = 8) {
    if (!Number.isInteger(digits) || digits < 1 || digits > 15) throw new Error('Numeric code length must be between 1 and 15 digits.');
    const minimum = digits === 1 ? 0 : 10 ** (digits - 1);
    return String(crypto.randomInt(minimum, 10 ** digits));
}

function renderTemplate(template, values) {
    const rendered = String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key) => {
        if (!Object.prototype.hasOwnProperty.call(values, key) || values[key] == null) throw new Error(`Missing template value: ${key}`);
        return String(values[key]);
    });
    const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g);
    if (unresolved) throw new Error(`Unresolved template values: ${unresolved.join(', ')}`);
    return rendered;
}

function writeAtomic(file, contents) {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
}

function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        result[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    return result;
}

async function main(argv = process.argv.slice(2)) {
    const [command] = argv;
    const args = parseArgs(argv.slice(1));
    if (command === 'generate-secrets') {
        const output = path.resolve(args.output);
        writeAtomic(output, JSON.stringify({ rootPassword: generateSecret(), appPassword: generateSecret(), maintenancePassword: generateSecret(), blowfishSecret: generateSecret(24), spoolerKey: generateSecret(), programmerUserNumber: generateNumericCode(12) }));
    } else if (command === 'check-port') {
        process.stdout.write(JSON.stringify({ port: validatePort(args.port), available: await checkPort(args.port) }) + '\n');
    } else if (command === 'suggest-port') {
        process.stdout.write(`${await suggestAvailablePort(args.port)}\n`);
    } else if (command === 'write-server-config' || command === 'write-spooler-config') {
        const templatePath = path.resolve(args.template);
        const outputPath = path.resolve(args.output);
        const values = JSON.parse(fs.readFileSync(path.resolve(args.values), 'utf8'));
        writeAtomic(outputPath, renderTemplate(fs.readFileSync(templatePath, 'utf8'), values));
    } else {
        throw new Error('Usage: generate-secrets|check-port|suggest-port|write-server-config|write-spooler-config');
    }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { validatePort, checkPort, suggestAvailablePort, generateSecret, generateNumericCode, renderTemplate, writeAtomic };

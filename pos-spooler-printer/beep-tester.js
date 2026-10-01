const { sendNetwork, sendWindows } = require('./raw-print');

const COMMANDS = {
    'esc-b': ({ count, duration }) => Buffer.from([0x1b, 0x42, count, duration]),
    'esc-b-init': ({ count, duration }) => Buffer.from([0x1b, 0x40, 0x1b, 0x42, count, duration]),
    'esc-c': ({ count, duration }) => Buffer.from([0x1b, 0x43, count, duration, 0x01]),
    'esc-c-init': ({ count, duration }) => Buffer.from([0x1b, 0x40, 0x1b, 0x43, count, duration, 0x01]),
    bel: () => Buffer.from([0x07]),
    rs: () => Buffer.from([0x1e]),
    star: ({ count, duration }) => Buffer.from([0x1b, 0x1d, 0x07, count, duration, duration]),
};

function clampByte(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(1, Math.min(255, parsed));
}

function parsePort(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function createBeepCommand(name, options = {}) {
    if (name === 'hex') {
        return createHexCommand(options.hex);
    }

    const command = COMMANDS[name];
    if (!command) {
        throw new Error(`Unknown beep command "${name}". Options: ${getCommandNames().join(', ')}`);
    }

    return command({
        count: clampByte(options.count, 3),
        duration: clampByte(options.duration, 5),
    });
}

function createHexCommand(hex) {
    const clean = String(hex || '').replace(/0x/gi, '').replace(/[^a-fA-F0-9]/g, '');
    if (!clean || clean.length % 2 !== 0) {
        throw new Error('Invalid --hex value. Example: --hex "1B 42 03 05"');
    }
    return Buffer.from(clean, 'hex');
}

function getCommandNames() {
    return Object.keys(COMMANDS);
}

function parseArgs(argv) {
    const args = {
        command: 'esc-b',
        count: 3,
        duration: 5,
        port: 9100,
        gapMs: 1500,
        dryRun: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        if (arg === '--network') {
            args.network = next;
            i += 1;
        } else if (arg === '--windows') {
            args.windows = next;
            i += 1;
        } else if (arg === '--command') {
            args.command = next;
            i += 1;
        } else if (arg === '--hex') {
            args.command = 'hex';
            args.hex = next;
            i += 1;
        } else if (arg === '--count') {
            args.count = clampByte(next, args.count);
            i += 1;
        } else if (arg === '--duration') {
            args.duration = clampByte(next, args.duration);
            i += 1;
        } else if (arg === '--port') {
            args.port = parsePort(next, args.port);
            i += 1;
        } else if (arg === '--gap-ms') {
            args.gapMs = Math.max(100, Number.parseInt(next, 10) || args.gapMs);
            i += 1;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        }
    }

    return args;
}

function usage() {
    return `
Usage:
  node beep-tester.js --network 192.168.1.50 --command esc-b
  node beep-tester.js --windows "POS-80C" --command all
  node beep-tester.js --network 192.168.1.50 --command esc-b --count 5 --duration 8
  node beep-tester.js --windows "POS-80C" --hex "1B 42 03 05"
  node beep-tester.js --command all --dry-run

Commands:
  esc-b  ESC/POS buzzer: 1B 42 count duration
  esc-b-init  ESC @, then ESC/POS buzzer
  esc-c  Xprinter buzzer/alarm command: 1B 43 count duration 01
  esc-c-init  ESC @, then Xprinter buzzer/alarm command
  bel    BEL control byte: 07
  rs     ASCII Record Separator: 1E
  star   Star-compatible buzzer: 1B 1D 07 count duration duration
  all    Try all commands with a pause between them
  --hex  Send any raw hex bytes directly

Notes:
  --duration is usually in 100ms units for ESC/POS-style commands.
  --windows uses the same raw copy path as server.js: \\\\127.0.0.1\\PRINTER_NAME
`.trim();
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendCommand(args, commandName) {
    const buffer = createBeepCommand(commandName, args);
    const hex = buffer.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
    console.log(`Trying ${commandName}: ${hex}`);

    if (args.dryRun) return;
    if (args.network) {
        await sendNetwork(args.network, args.port, buffer);
        return;
    }
    if (args.windows) {
        await sendWindows(args.windows, buffer, { log: console.log });
        return;
    }

    throw new Error('Choose a target printer with --network IP or --windows "PRINTER_NAME", or use --dry-run.');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return;
    }

    const commands = args.command === 'all' ? getCommandNames() : [args.command];
    for (let i = 0; i < commands.length; i += 1) {
        await sendCommand(args, commands[i]);
        if (i < commands.length - 1) await sleep(args.gapMs);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`Beep test failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    createBeepCommand,
    getCommandNames,
    parseArgs,
};

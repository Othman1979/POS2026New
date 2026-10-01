#!/usr/bin/env node
'use strict';

// Print-width calibration strip.
//
// The compiled documents this agent renders are exactly 576 dots wide and symmetric -
// measured, not assumed: a receipt's ink runs from column 10 to column 565, ten dots of
// padding on each side. So when a ticket looks off-centre on paper, the cause is where the
// printer puts those 576 dots, not how they were drawn.
//
// The job stream this agent sends is: raster bands, optional beep, optional drawer kick,
// feed, cut. It contains no ESC @ and no margin command, so placement is entirely the
// printer's own configuration. This strip makes that configuration visible.
//
// It prints:
//   1. a solid bar across all 576 dots, with an inward notch at each end
//   2. a tick ruler - a tall tick every 64 dots, a short one every 8
//   3. a solid bar 640 dots wide
//
// Read it like this:
//   * Bars 1 and 3 the same width  -> the printer clips at its printable width; 576 is all
//     there is and the ticket cannot be widened. Uneven paper margins are mechanical:
//     the roll is not centred under the head, or the paper guide needs moving.
//   * Bar 3 wider than bar 1       -> the head has dots past 576 and the document width can
//     be raised. Read the extra width off the ruler before changing anything.
//   * Bar 3 wraps onto a second line -> the printer refused the wider raster. 576 stands.
//
// Usage:
//   node print-width-calibration.js --windows "XP-80C (Copy 1)"   (printer name or share name)
//   node print-width-calibration.js --network 192.168.1.50 [--port 9100]
//   node print-width-calibration.js --dry-run [--out calibration.bin]
//
// --windows accepts either the printer's name or its share name and resolves between
// them. The raw copy path addresses \\127.0.0.1\<SHARE>, and a share name is often
// nothing like the printer name, so passing the printer name unresolved fails with
// "The network name cannot be found" - which reads like the printer is unplugged.
//
//   --no-init   omit the leading ESC @, reproducing exactly what a real print job sends
//               (use this to check whether stale printer state is moving the image)

const fs = require('fs');
const path = require('path');
const { sendNetwork, sendWindows } = require('./raw-print');

const DOCUMENT_WIDTH = 576;
const OVERFLOW_WIDTH = 640;

// One GS v 0 raster band. rows is an array of Uint8Array bitmaps, one bit per dot.
function rasterBand(rows, widthDots) {
    const rowBytes = Math.ceil(widthDots / 8);
    const band = Buffer.alloc(8 + rowBytes * rows.length);
    band.set([0x1d, 0x76, 0x30, 0x00], 0);
    band.writeUInt16LE(rowBytes, 4);
    band.writeUInt16LE(rows.length, 6);
    rows.forEach((row, index) => band.set(row, 8 + index * rowBytes));
    return band;
}

function blankRow(widthDots) {
    return new Uint8Array(Math.ceil(widthDots / 8));
}

function setDot(row, x) {
    row[x >> 3] |= 0x80 >> (x & 7);
}

// A solid bar with the first and last `notch` dots left blank on the top and bottom rows,
// so the exact extent of the bar is readable even when it runs off the paper edge.
function solidBar(widthDots, height, notch = 6) {
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const row = blankRow(widthDots);
        const edgeRow = y === 0 || y === height - 1;
        for (let x = 0; x < widthDots; x += 1) {
            if (edgeRow && (x < notch || x >= widthDots - notch)) continue;
            setDot(row, x);
        }
        rows.push(row);
    }
    return rows;
}

// Tall tick every 64 dots, short tick every 8. The tall ticks are the ones to count.
function tickRuler(widthDots, height = 24) {
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const row = blankRow(widthDots);
        for (let x = 0; x < widthDots; x += 1) {
            const tall = x % 64 === 0;
            const short = x % 8 === 0;
            if (tall || (short && y < height / 3)) setDot(row, x);
        }
        rows.push(row);
    }
    return rows;
}

// ESC/POS positioning commands, in dots.
const escInit = () => Buffer.from([0x1b, 0x40]);                                   // ESC @
const gsLeftMargin = dots => Buffer.from([0x1d, 0x4c, dots & 0xff, (dots >> 8) & 0xff]);   // GS L
const gsPrintWidth = dots => Buffer.from([0x1d, 0x57, dots & 0xff, (dots >> 8) & 0xff]);   // GS W

const escAbsolutePosition = dots => Buffer.from([0x1b, 0x24, dots & 0xff, (dots >> 8) & 0xff]); // ESC $

// POSITIVE CONTROLS. An earlier version of this strip set the left margin to zero and
// compared - which proves nothing, because zero is the likely default: "unchanged" reads
// identically whether there was no margin to reclaim or the firmware ignored the command.
// XP-80C-class firmware very often ignores GS L and GS W outright.
//
// So each bar now asks for something whose effect is unmistakable. If a bar looks exactly
// like the baseline, that command was ignored - not that its setting was already correct.
//
//   1  baseline
//   2  GS L 96   -> must start 96 dots (about 12mm) FURTHER RIGHT
//   3  GS W 384  -> must be clipped to two thirds width, obviously SHORTER
//   4  ESC $ 96  -> same shift as 2, asked for through a different command family
//
// Bars 2-4 identical to bar 1 means this printer takes no positioning command at all, and
// where the image sits is fixed in hardware: the roll's position under the head, or the
// printer's own width configuration. No byte we send will move it.
const VARIANTS = [
    { height: 8, width: DOCUMENT_WIDTH, prefix: () => escInit() },
    { height: 16, width: DOCUMENT_WIDTH, prefix: () => Buffer.concat([escInit(), gsLeftMargin(96)]) },
    { height: 26, width: DOCUMENT_WIDTH, prefix: () => Buffer.concat([escInit(), gsPrintWidth(384)]) },
    { height: 38, width: DOCUMENT_WIDTH, prefix: () => Buffer.concat([escInit(), escAbsolutePosition(96)]) }
];

function buildVariantStrip() {
    const chunks = [];
    VARIANTS.forEach((variant, index) => {
        chunks.push(variant.prefix());
        chunks.push(rasterBand(solidBar(variant.width, variant.height, 0), variant.width));
        // Generous gap so the bars cannot be mistaken for one block.
        chunks.push(Buffer.from(index === VARIANTS.length - 1 ? [0x0a] : [0x0a, 0x0a, 0x0a]));
    });
    chunks.push(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]));
    return Buffer.concat(chunks);
}

function buildCalibration({ init = true } = {}) {
    const chunks = [];
    // ESC @ so the strip reports the printer's *default* placement rather than whatever a
    // previous job happened to leave behind. --no-init drops it to reproduce a real job.
    if (init) chunks.push(Buffer.from([0x1b, 0x40]));

    chunks.push(rasterBand(solidBar(DOCUMENT_WIDTH, 18), DOCUMENT_WIDTH));
    chunks.push(Buffer.from([0x0a]));
    chunks.push(rasterBand(tickRuler(DOCUMENT_WIDTH), DOCUMENT_WIDTH));
    chunks.push(Buffer.from([0x0a, 0x0a]));
    chunks.push(rasterBand(solidBar(OVERFLOW_WIDTH, 18), OVERFLOW_WIDTH));

    // Feed clear of the tear bar, then a full cut - the same ending a real job uses.
    chunks.push(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]));
    return Buffer.concat(chunks);
}

function parseArgs(argv) {
    const args = { port: 9100, init: true };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--windows') { args.windows = next; i += 1; }
        else if (arg === '--network') { args.network = next; i += 1; }
        else if (arg === '--port') { args.port = Number(next); i += 1; }
        else if (arg === '--out') { args.out = next; i += 1; }
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--no-init') args.init = false;
        else if (arg === '--variants') args.variants = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
    }
    return args;
}

// Transport lives in raw-print.js, shared with beep-tester.js: the share-name lookup
// and the direct UNC write were written twice, with the same three faults both times.

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.windows && !args.network && !args.dryRun)) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n')
            .filter(line => line.startsWith('//')).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
        return;
    }

    const buffer = args.variants ? buildVariantStrip() : buildCalibration({ init: args.init });
    if (args.variants) {
        console.log(`positioning probe: ${buffer.length} bytes  (4 bars, thin to thick)`);
        console.log('  1 thinnest  ESC @ only      - baseline');
        console.log('  2           + GS L 96       - MUST start ~12mm further RIGHT');
        console.log('  3           + GS W 384      - MUST be clipped to two thirds width');
        console.log('  4 thickest  + ESC $ 96      - same shift as 2, different command family');
        console.log('');
        console.log('  Any bar identical to bar 1 = that command was ignored.');
        console.log('  All four identical = the printer takes no positioning command; placement is');
        console.log('  fixed in hardware and no byte we send will move it.');
    } else {
        console.log(`calibration strip: ${buffer.length} bytes  (${DOCUMENT_WIDTH}-dot bar, ruler, ${OVERFLOW_WIDTH}-dot bar)${args.init ? '' : '  [no ESC @]'}`);
    }

    if (args.dryRun) {
        const out = args.out || path.join(__dirname, 'calibration.bin');
        fs.writeFileSync(out, buffer);
        console.log(`dry run - wrote ${out}`);
        return;
    }
    if (args.network) await sendNetwork(args.network, args.port, buffer);
    else await sendWindows(args.windows, buffer, { log: console.log });
    console.log('sent.');
}

if (require.main === module) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildCalibration, buildVariantStrip, VARIANTS, rasterBand, solidBar, tickRuler, parseArgs, DOCUMENT_WIDTH, OVERFLOW_WIDTH };

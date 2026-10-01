'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTypstRenderer } = require('../v2/typst-renderer');
const { jobs: representativeJobs } = require('./fixtures/typst-reports.cjs');
const pinnedFonts = process.env.SPOOLER_TYPST_FONT_DIR || path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'fonts');

function count(bytes, needle) {
    let found = 0;
    for (let i = 0; i <= bytes.length - needle.length; i++) {
        if (bytes.subarray(i, i + needle.length).equals(needle)) found++;
    }
    return found;
}
function rasterRows(bytes) {
    const rows = [];
    for (let i = 0; i <= bytes.length - 8; i++) {
        if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) rows.push(bytes.readUInt16LE(i + 6));
    }
    return rows;
}

const executable = [process.env.SPOOLER_TYPST_EXE,
    path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'typst.exe'),
    path.join(__dirname, '..', '..', 'deployment', 'out', 'stage', 'spooler', '.cache', 'typst', '0.15.1', 'typst.exe')
].find(candidate => candidate && fs.existsSync(candidate));

(async () => {
    if (!executable) {
        console.log('Native report artifact check skipped: Typst executable is unavailable.');
        return;
    }
    assert(fs.existsSync(pinnedFonts), 'pinned Typst fonts are required');
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-native-reports-'));
    const renderer = createTypstRenderer({ stateRoot, executable, fontPath: pinnedFonts });
    try {
        const jobs = [
            ...representativeJobs,
            { queue_id: 15, print_type: 'y_held_items_report', data: { items: Array.from({ length: 100 }, (_, i) => ({
                item_name: `Item ${i}`, qty_sold: 1, gross_revenue: i + 1
            })) } },
            { queue_id: 16, print_type: 'audit_report', data: { ...representativeJobs.find(job => job.print_type === 'audit_report').data,
                shifts: Array.from({ length: 200 }, (_, i) => ({
                    ...representativeJobs.find(job => job.print_type === 'audit_report').data.shifts[0], shift_id: i + 1
                })) } }
        ];
        for (const job of jobs) {
            assert(renderer.supports(job));
            const artifact = await renderer.render(job);
            const bytes = fs.readFileSync(artifact.path);
            assert.equal(artifact.width, 576);
            assert(artifact.height > 100);
            assert.equal(artifact.renderer, 'typst');
            assert.equal(count(bytes, Buffer.from([0x1d, 0x56, 0x00])), 1, 'one final cut per report job');
            assert.equal(rasterRows(bytes).reduce((sum, rows) => sum + rows, 0), artifact.height,
                'raster bands cover the full native report height');
            const drawerSlip = ['expense_slip', 'expense_cancel_slip'].includes(job.print_type) && job.data.source === 'drawer';
            assert.equal(count(bytes, Buffer.from([0x1b, 0x70])), drawerSlip ? 1 : 0,
                'only drawer expense slips pulse the cash drawer');
        }
    } finally {
        await renderer.close();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    console.log('Native report artifact raster, split, and cut checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

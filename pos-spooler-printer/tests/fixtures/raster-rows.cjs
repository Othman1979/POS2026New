const assert = require('node:assert/strict');
const fs = require('node:fs');

function rasterRows(artifact) {
    const bytes = fs.readFileSync(artifact.path);
    const counts = [];
    const bounds = [];
    let offset = 0;
    const command = Buffer.from([0x1d, 0x76, 0x30, 0]);
    while (bytes.subarray(offset, offset + 4).equals(command)) {
        const width = bytes.readUInt16LE(offset + 4), rows = bytes.readUInt16LE(offset + 6);
        assert.equal(width, 72);
        assert(rows > 0 && rows <= 256);
        assert(offset + 8 + width * rows <= bytes.length);
        for (let y = 0; y < rows; y++) {
            const row = bytes.subarray(offset + 8 + y * width, offset + 8 + (y + 1) * width);
            counts.push(row.filter(byte => byte !== 0).length);
            bounds.push({ left: row.findIndex(byte => byte !== 0) * 8, right: row.findLastIndex(byte => byte !== 0) * 8 + 7 });
        }
        offset += 8 + width * rows;
    }
    assert.equal(counts.length, artifact.height, 'every raster row reaches the artifact');
    assert.deepEqual(bytes.subarray(-6), Buffer.from([10, 10, 10, 0x1d, 0x56, 0]));
    return { counts, bounds, firstInk: counts.findIndex(n => n > 0), lastInk: counts.findLastIndex(n => n > 0), tail: bytes.subarray(offset) };
}
module.exports = { rasterRows };

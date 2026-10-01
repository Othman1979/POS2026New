const assert = require('assert');
const zlib = require('zlib');
const { decodePng, encodePng } = require('../v2/png');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, body) {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    // The decoder does not verify CRCs; zeros keep the fixture simple.
    return out;
}

// Encode samples (width * channels bytes per row) with the given filter per row, as a PNG writer would.
function filtered(width, height, channels, colorType, samples, filters, { bitDepth = 8, interlace = 0 } = {}) {
    const stride = width * channels;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const filter = filters[y % filters.length];
        raw[y * (stride + 1)] = filter;
        for (let i = 0; i < stride; i += 1) {
            const value = samples[y * stride + i];
            const left = i >= channels ? samples[y * stride + i - channels] : 0;
            const up = y > 0 ? samples[(y - 1) * stride + i] : 0;
            const upLeft = y > 0 && i >= channels ? samples[(y - 1) * stride + i - channels] : 0;
            const p = left + up - upLeft;
            const pa = Math.abs(p - left);
            const pb = Math.abs(p - up);
            const pc = Math.abs(p - upLeft);
            const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
            raw[y * (stride + 1) + 1 + i] = (value - predictor) & 0xff;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([bitDepth, colorType, 0, 0, interlace], 8);
    return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const width = 7;
const height = 10;
const noise = (length, seed) => Buffer.from(Array.from({ length }, (_, i) => (i * 37 + seed * 91 + ((i * i) % 13) * 17) & 0xff));

for (const [colorType, channels] of [[0, 1], [2, 3], [4, 2], [6, 4]]) {
    const samples = noise(width * height * channels, channels);
    const decoded = decodePng(filtered(width, height, channels, colorType, samples, [0, 1, 2, 3, 4]));
    assert.strictEqual(decoded.width, width);
    assert.strictEqual(decoded.height, height);
    const expected = Buffer.alloc(width * height * 4);
    for (let p = 0; p < width * height; p += 1) {
        const s = p * channels;
        const gray = channels <= 2;
        expected[p * 4] = samples[s];
        expected[p * 4 + 1] = gray ? samples[s] : samples[s + 1];
        expected[p * 4 + 2] = gray ? samples[s] : samples[s + 2];
        expected[p * 4 + 3] = channels === 2 ? samples[s + 1] : channels === 4 ? samples[s + 3] : 255;
    }
    assert(Buffer.from(decoded.data).equals(expected), `color type ${colorType} decodes to RGBA with every filter`);
}

const rgba = noise(width * height * 4, 9);
const round = decodePng(encodePng(width, height, rgba));
assert.deepStrictEqual([round.width, round.height], [width, height]);
assert(Buffer.from(round.data).equals(rgba), 'encode then decode round-trips');
assert.strictEqual(encodePng(432, 8, Buffer.alloc(432 * 8 * 4, 255)).readUInt32BE(16), 432);

for (const bad of [
    Buffer.from('not a png'),
    filtered(width, height, 4, 6, noise(width * height * 4, 1), [0], { bitDepth: 16 }),
    filtered(width, height, 4, 6, noise(width * height * 4, 1), [0], { interlace: 1 }),
    filtered(width, height, 1, 3, noise(width * height, 1), [0]),
    encodePng(width, height, rgba).subarray(0, 60)
]) {
    assert.throws(() => decodePng(bad), error => error.code === 'TYPST_OUTPUT_INVALID' && error.failureClass === 'transient_safe');
}
console.log('PNG codec checks passed.');

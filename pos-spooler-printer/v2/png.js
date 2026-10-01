'use strict';
// Minimal PNG codec on Node's zlib. Typst writes 8-bit, non-interlaced PNGs; anything else is rejected.
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function pngError(message) {
    const error = new Error(message);
    error.code = 'TYPST_OUTPUT_INVALID';
    error.failureClass = 'transient_safe';
    return error;
}

function crc32(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Returns { width, height, data } with data as RGBA bytes.
function decodePng(bytes) {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw pngError('Typst did not produce a valid PNG.');
    let width = 0;
    let height = 0;
    let channels = 0;
    let colorType = -1;
    const idat = [];
    let sawEnd = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const start = offset + 8;
        if (start + length + 4 > bytes.length) throw pngError('Typst PNG is truncated.');
        if (type === 'IHDR') {
            if (length !== 13) throw pngError('Typst PNG header is invalid.');
            width = bytes.readUInt32BE(start);
            height = bytes.readUInt32BE(start + 4);
            colorType = bytes[start + 9];
            channels = CHANNELS[colorType];
            if (bytes[start + 8] !== 8 || !channels) throw pngError('Typst PNG format is unsupported.');
            if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] !== 0) throw pngError('Typst PNG format is unsupported.');
        } else if (type === 'IDAT') {
            idat.push(bytes.subarray(start, start + length));
        } else if (type === 'IEND') {
            sawEnd = true;
            break;
        }
        offset = start + length + 4;
    }
    if (!channels || !sawEnd || idat.length === 0 || width < 1 || height < 1) throw pngError('Typst PNG could not be decoded.');
    const stride = width * channels;
    let raw;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
    } catch {
        throw pngError('Typst PNG could not be decoded.');
    }
    if (raw.length !== (stride + 1) * height) throw pngError('Typst PNG could not be decoded.');

    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        const source = y * (stride + 1) + 1;
        const row = y * stride;
        const above = row - stride;
        if (filter > 4) throw pngError('Typst PNG could not be decoded.');
        for (let i = 0; i < stride; i += 1) {
            const left = i >= channels ? pixels[row + i - channels] : 0;
            const up = y > 0 ? pixels[above + i] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = (left + up) >> 1;
            else if (filter === 4) {
                const upLeft = y > 0 && i >= channels ? pixels[above + i - channels] : 0;
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            pixels[row + i] = (raw[source + i] + predictor) & 0xff;
        }
    }
    if (channels === 4) return { width, height, data: pixels };
    const data = Buffer.alloc(width * height * 4);
    for (let p = 0, s = 0, d = 0; p < width * height; p += 1) {
        const value = pixels[s];
        const gray = channels === 1 || channels === 2;
        data[d] = value;
        data[d + 1] = gray ? value : pixels[s + 1];
        data[d + 2] = gray ? value : pixels[s + 2];
        data[d + 3] = channels === 2 ? pixels[s + 1] : 255;
        s += channels;
        d += 4;
    }
    return { width, height, data };
}

function chunk(type, body) {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
}

// RGBA -> 8-bit RGBA PNG, filter 0.
function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };

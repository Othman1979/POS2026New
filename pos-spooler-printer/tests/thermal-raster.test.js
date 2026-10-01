const assert = require('assert');
const { encodeRasterBands, DEFAULT_RASTER_BAND_HEIGHT } = require('../thermal-raster');

function pixels(width, height, pixelAt) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const [r, g, b, a] = pixelAt(x, y);
            data.set([r, g, b, a], (y * width + x) * 4);
        }
    }
    return { data, width, height };
}

function readBand(buffer) {
    assert.deepStrictEqual([...buffer.subarray(0, 4)], [0x1d, 0x76, 0x30, 0x00]);
    const rowBytes = buffer.readUInt16LE(4);
    const height = buffer.readUInt16LE(6);
    assert.strictEqual(buffer.length, 8 + rowBytes * height);
    return { rowBytes, height, data: buffer.subarray(8) };
}

(() => {
    assert.strictEqual(DEFAULT_RASTER_BAND_HEIGHT, 256);

    const exactBits = encodeRasterBands(pixels(8, 1, x => (
        [0, 2, 5, 7].includes(x) ? [0, 0, 0, 255] : [255, 255, 255, 255]
    )));
    assert.strictEqual(exactBits.length, 1);
    assert.strictEqual(readBand(exactBits[0]).data[0], 0b10100101, 'pixels must be packed most-significant bit first');

    const threshold = readBand(encodeRasterBands({
        width: 4,
        height: 1,
        data: new Uint8ClampedArray([
            0, 0, 0, 50,
            0, 0, 0, 51,
            129, 129, 129, 255,
            130, 130, 130, 255,
        ])
    })[0]);
    assert.strictEqual(threshold.data[0], 0b01100000, 'alpha and luminance boundaries must match the previous thermal threshold');

    const ordered = readBand(encodeRasterBands(pixels(4, 4, () => [127, 127, 127, 255]), {
        mode: 'ordered'
    })[0]);
    assert.deepStrictEqual(
        [...ordered.data],
        [0b10100000, 0b01010000, 0b10100000, 0b01010000],
        'ordered mode must preserve half-tone coverage with a deterministic four-by-four pattern'
    );

    const opaqueExtremes = readBand(encodeRasterBands(pixels(8, 1, x => (
        x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    )), { mode: 'ordered' })[0]);
    assert.strictEqual(opaqueExtremes.data[0], 0b11110000, 'ordered mode must preserve solid black and white pixels exactly');

    const grayCoverage = readBand(encodeRasterBands(pixels(4, 4, () => [127, 127, 127, 255]), { mode: 'ordered' })[0]);
    const alphaCoverage = readBand(encodeRasterBands(pixels(4, 4, () => [0, 0, 0, 128]), { mode: 'ordered' })[0]);
    assert.deepStrictEqual(
        [...alphaCoverage.data],
        [...grayCoverage.data],
        'ordered mode must composite transparent glyph coverage onto white before bilevel conversion'
    );

    const whole = readBand(encodeRasterBands(pixels(4, 2, () => [127, 127, 127, 255]), { mode: 'ordered' })[0]);
    const splitTop = readBand(encodeRasterBands(pixels(4, 1, () => [127, 127, 127, 255]), { mode: 'ordered' })[0]);
    const splitBottom = readBand(encodeRasterBands(pixels(4, 1, () => [127, 127, 127, 255]), {
        mode: 'ordered', originY: 1
    })[0]);
    assert.deepStrictEqual(
        [...whole.data],
        [...splitTop.data, ...splitBottom.data],
        'ordered coverage must stay continuous across bounded raster surfaces'
    );

    const padded = readBand(encodeRasterBands(pixels(9, 1, x => (
        x === 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    )))[0]);
    assert.strictEqual(padded.rowBytes, 2);
    assert.deepStrictEqual([...padded.data], [0, 0b10000000], 'unused tail bits must remain white');

    for (const invalid of [
        { width: 0, height: 1, data: new Uint8ClampedArray() },
        { width: 1, height: -1, data: new Uint8ClampedArray() },
        { width: 1.5, height: 1, data: new Uint8ClampedArray(8) },
        { width: 2, height: 1, data: new Uint8ClampedArray(4) },
    ]) {
        assert.throws(() => encodeRasterBands(invalid), /image data|dimensions/i);
    }
    assert.throws(
        () => encodeRasterBands(pixels(1, 1, () => [0, 0, 0, 255]), { bandHeight: 0 }),
        /band height/i
    );
    assert.throws(
        () => encodeRasterBands(pixels(1, 1, () => [0, 0, 0, 255]), { mode: 'unknown' }),
        /raster mode/i
    );
    assert.throws(
        () => encodeRasterBands(pixels(1, 1, () => [0, 0, 0, 255]), { mode: 'ordered', originY: 0.5 }),
        /origins/i
    );

    const tall = pixels(576, 5000, (x, y) => ((x + y) % 11 === 0
        ? [0, 0, 0, 255]
        : [255, 255, 255, 255]));
    const bands = encodeRasterBands(tall);
    assert.strictEqual(bands.length, 20);
    const parsed = bands.map(readBand);
    assert(parsed.every(band => band.rowBytes === 72));
    assert(parsed.every(band => band.height <= DEFAULT_RASTER_BAND_HEIGHT));
    assert.deepStrictEqual(parsed.map(band => band.height), [...Array(19).fill(256), 136]);

    let sourceY = 0;
    for (const band of parsed) {
        for (let bandY = 0; bandY < band.height; bandY += 1) {
            for (let x = 0; x < tall.width; x += 1) {
                const actual = (band.data[bandY * band.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
                const expected = (x + sourceY) % 11 === 0;
                assert.strictEqual(actual, expected, `pixel mismatch at ${x},${sourceY}`);
            }
            sourceY += 1;
        }
    }
    assert.strictEqual(sourceY, 5000, 'all source rows must be encoded exactly once');

    console.log('thermal-raster tests passed');
})();

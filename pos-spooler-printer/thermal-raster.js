const DEFAULT_RASTER_BAND_HEIGHT = 256;
const ORDERED_DITHER_4X4 = Object.freeze([
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
].map(value => (value + 0.5) * 255 / 16));

function orderedPixelIsBlack(data, source, x, y) {
    const alpha = data[source + 3];
    if (alpha === 0) return false;
    const red = data[source];
    const green = data[source + 1];
    const blue = data[source + 2];
    const luminance = red === green && red === blue ? red : red * 0.299 + green * 0.587 + blue * 0.114;
    const darkness = (255 - luminance) * (alpha === 255 ? 1 : alpha / 255);
    return darkness > ORDERED_DITHER_4X4[(y & 3) * 4 + (x & 3)];
}

function encodeRasterBands(imageData, {
    bandHeight = DEFAULT_RASTER_BAND_HEIGHT,
    mode = 'threshold',
    originX = 0,
    originY = 0
} = {}) {
    const width = Number(imageData?.width);
    const height = Number(imageData?.height);
    const data = imageData?.data;

    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new TypeError('Thermal raster dimensions must be positive integers.');
    }
    if (!Number.isInteger(bandHeight) || bandHeight <= 0 || bandHeight > 0xffff) {
        throw new TypeError('Thermal raster band height must be an integer from 1 to 65535.');
    }
    if (!['threshold', 'ordered'].includes(mode)) throw new TypeError('Thermal raster mode is invalid.');
    if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
        throw new TypeError('Thermal raster origins must be safe integers.');
    }

    const expectedBytes = width * height * 4;
    if (!ArrayBuffer.isView(data) || data.byteLength < expectedBytes) {
        throw new TypeError('Thermal raster image data is incomplete.');
    }

    const rowBytes = Math.ceil(width / 8);
    if (rowBytes > 0xffff) throw new RangeError('Thermal raster width exceeds the ESC/POS limit.');

    const bands = [];
    for (let startY = 0; startY < height; startY += bandHeight) {
        const rows = Math.min(bandHeight, height - startY);
        const band = Buffer.alloc(8 + rowBytes * rows);
        band.set([0x1d, 0x76, 0x30, 0x00], 0);
        band.writeUInt16LE(rowBytes, 4);
        band.writeUInt16LE(rows, 6);

        for (let bandY = 0; bandY < rows; bandY += 1) {
            const sourceRow = (startY + bandY) * width;
            const targetRow = 8 + bandY * rowBytes;
            for (let x = 0; x < width; x += 1) {
                const source = (sourceRow + x) * 4;
                let black;
                if (mode === 'ordered') {
                    black = orderedPixelIsBlack(data, source, originX + x, originY + startY + bandY);
                } else {
                    if (data[source + 3] <= 50) continue;
                    const luminance = data[source] * 0.299 + data[source + 1] * 0.587 + data[source + 2] * 0.114;
                    black = luminance < 130;
                }
                if (black) band[targetRow + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
        bands.push(band);
    }

    return bands;
}

module.exports = { DEFAULT_RASTER_BAND_HEIGHT, encodeRasterBands };

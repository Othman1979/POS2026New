const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const MAX_ROWS = 50000;
const MAX_CELLS = 300000;
function badImport(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function normalizeLegacyCell(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return !text || text.toUpperCase() === 'NULL' ? null : value;
}

function mappedLegacyRows(workbook, rawMapping, xlsx) {
    let mapping;
    try {
        mapping = JSON.parse(rawMapping);
    } catch {
        throw badImport('Legacy column mapping is invalid.');
    }
    const fields = ['name', 'price', 'category', 'tax'];
    const columns = fields.map(field => mapping?.[field]);
    if (columns.some(column => !Number.isInteger(column) || column < 0) || new Set(columns).size !== fields.length) {
        throw badImport('Choose four different columns for product name, price, category, and tax rate.');
    }
    mapping = Object.fromEntries(fields.map((field, index) => [field, columns[index]]));
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columns.some(column => column >= width)) throw badImport('A selected legacy column is outside the worksheet.');

    const categories = new Map();
    const products = [];
    for (const [index, row] of rows.entries()) {
        const values = Object.fromEntries(fields.map(field => [field, normalizeLegacyCell(row[mapping[field]])]));
        if (fields.every(field => values[field] === null)) continue;
        const category = values.category == null ? '' : String(values.category).trim();
        if (category && !categories.has(category.toLowerCase())) categories.set(category.toLowerCase(), { Name: category });
        products.push({
            Name: values.name,
            Price: values.price,
            Category: values.category,
            'Tax Rate': values.tax,
            __legacyRow: index + 1
        });
    }
    return { catRows: [...categories.values()], prodRows: products };
}


function parseWorkbook(buffer, mapping) {
    // This dependency lives only in the short-lived parsing worker.
    const xlsx = require('xlsx');
    const workbook = xlsx.read(buffer, { type: 'buffer', sheetRows: MAX_ROWS + 2 });
    let cells = 0;
    for (const sheet of Object.values(workbook.Sheets)) {
        const ref = sheet['!fullref'] || sheet['!ref'];
        if (!ref) continue;
        const range = xlsx.utils.decode_range(ref);
        cells += (range.e.r + 1) * (range.e.c + 1);
        if (range.e.r > MAX_ROWS || range.e.c >= 128 || cells > MAX_CELLS) {
            throw badImport('Workbook is too large. Use at most 50,000 rows, 128 columns and 300,000 cells.');
        }
    }
    const catSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'categories');
    const prodSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'products');
    const legacyFormat = !catSheetName || !prodSheetName;
    if (legacyFormat && !mapping) throw badImport('This workbook has no catalog template headers. Choose the legacy column mapping before importing.');
    const rows = legacyFormat ? mappedLegacyRows(workbook, mapping, xlsx) : {
        catRows: xlsx.utils.sheet_to_json(workbook.Sheets[catSheetName]),
        prodRows: xlsx.utils.sheet_to_json(workbook.Sheets[prodSheetName])
    };
    return { ...rows, legacyFormat };
}

function parseCatalogWorkbook(buffer, mapping) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > 5 * 1024 * 1024 || buffer.readUInt32LE(0) !== 0x04034b50) {
        return Promise.reject(badImport('Invalid .xlsx workbook.'));
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { buffer, mapping },
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
        });
        let result, failure;
        const timer = setTimeout(() => {
            failure = badImport('Workbook parsing timed out. Import a smaller file.');
            void worker.terminate();
        }, 30000);
        worker.once('message', message => {
            if (message.error) failure = badImport(message.error);
            else result = message.result;
        });
        worker.once('error', () => { failure = badImport('Unable to parse this workbook. Import a smaller valid .xlsx file.'); });
        worker.once('exit', code => {
            clearTimeout(timer);
            if (failure || code !== 0 || !result) reject(failure || badImport('Workbook parsing failed.'));
            else resolve(result);
        });
    });
}

if (!isMainThread && require.main === module) {
    try { parentPort.postMessage({ result: parseWorkbook(Buffer.from(workerData.buffer), workerData.mapping) }); }
    catch (error) { parentPort.postMessage({ error: error.statusCode === 400 ? error.message : 'Invalid .xlsx workbook.' }); }
}
module.exports = { parseCatalogWorkbook };

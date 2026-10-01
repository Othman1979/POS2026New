import * as XLSX from 'xlsx';

const LEGACY_MAPPING = { name: 0, price: 1, category: 12, tax: 15 };

function usefulSample(cell) {
  if (!cell || cell.t === 'e' || cell.t === 'z') return null;
  const text = String(cell.v ?? '').trim();
  return text && text.toUpperCase() !== 'NULL' ? text : null;
}

export function inspectCatalogWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetNames = new Set(workbook.SheetNames.map((name) => name.toLowerCase()));

  if (sheetNames.has('categories') && sheetNames.has('products')) {
    return { kind: 'template' };
  }

  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rangeText = firstSheet?.['!ref'];
  if (!rangeText) throw new Error('empty workbook');

  const range = XLSX.utils.decode_range(rangeText);
  const width = range.e.c - range.s.c + 1;
  if (!width) throw new Error('empty workbook');

  const samples = Array.from({ length: width }, () => []);
  let incompleteColumns = width;

  for (let row = range.s.r; row <= range.e.r && incompleteColumns > 0; row += 1) {
    for (let offset = 0; offset < width; offset += 1) {
      if (samples[offset].length >= 3) continue;
      const column = range.s.c + offset;
      const cell = firstSheet[XLSX.utils.encode_cell({ r: row, c: column })];
      const sample = usefulSample(cell);
      if (sample !== null) samples[offset].push(sample);
      if (samples[offset].length === 3) incompleteColumns -= 1;
    }
  }

  return {
    kind: 'legacy',
    mapping: Object.fromEntries(
      Object.entries(LEGACY_MAPPING).map(([field, index]) => [field, index < width ? index : null]),
    ),
    columns: samples.map((columnSamples, index) => ({ index, samples: columnSamples })),
  };
}

export function createCatalogTemplate() {
  const categories = XLSX.utils.aoa_to_sheet([
    ['Category Name', 'Parent Category', 'Is Notes'],
    ['Appetizers', '', 0],
    ['Cold Drinks', '', 0],
    ['Hot Drinks', '', 0],
    ['Extra Meat Notes', 'Appetizers', 1],
  ]);
  const products = XLSX.utils.aoa_to_sheet([
    ['Product Name', 'Category Name', 'Price', 'Tax Rate', 'Barcode', 'Stock', 'Background Color'],
    ['Hummus Plain', 'Appetizers', 2.250, 0.16, '744101', 100, '#10b981'],
    ['Mutabbal', 'Appetizers', 2.500, 0.16, '744102', 100, '#059669'],
    ['Fresh Orange Juice', 'Cold Drinks', 3.000, 0.00, '744201', 50, '#3b82f6'],
    ['Turkish Coffee Single', 'Hot Drinks', 1.500, 0.16, '', '', ''],
  ]);

  categories['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 10 }];
  products['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 10 }, { wch: 18 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, categories, 'Categories');
  XLSX.utils.book_append_sheet(workbook, products, 'Products');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

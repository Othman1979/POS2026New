import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createCatalogTemplate, inspectCatalogWorkbook } from '../catalogWorkbookOperations.js';

function workbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, sheet] of sheets) {
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

function baselineLegacyMetadata(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: true,
  });
  const width = rows.reduce((largest, row) => Math.max(largest, row.length), 0);
  return Array.from({ length: width }, (_, index) => ({
    index,
    samples: rows
      .map((row) => String(row[index] ?? '').trim())
      .filter((value) => value && value.toUpperCase() !== 'NULL')
      .slice(0, 3),
  }));
}

describe('catalog workbook operations', () => {
  it('recognizes the named template workflow without requesting legacy mapping', () => {
    const categories = XLSX.utils.aoa_to_sheet([['Category Name'], ['Drinks']]);
    const products = XLSX.utils.aoa_to_sheet([['Product Name'], ['Tea']]);

    expect(inspectCatalogWorkbook(workbookBuffer([
      ['Categories', categories],
      ['Products', products],
    ]))).toEqual({ kind: 'template' });
  });

  it('preserves legacy width, defaults, and the first three useful samples for sparse sheets', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Price', null, null, null, null, null, null, null, null, null, null, 'Category', null, null, 'Tax'],
      ['  Hummus  ', 2.25, null, null, null, null, null, null, null, null, null, null, 'Starters', null, null, 0.16],
      ['NULL', '', null, null, null, null, null, null, null, null, null, null, 'NULL', null, null, 0],
      ['Mutabbal', 2.5, null, null, null, null, null, null, null, null, null, null, 'Starters', null, null, 0.16],
      ['Labneh', 1.75, null, null, null, null, null, null, null, null, null, null, 'Breakfast', null, null, 0.08],
      ['Ignored fourth sample', 9],
    ]);

    expect(inspectCatalogWorkbook(workbookBuffer([['Legacy', sheet]]))).toEqual({
      kind: 'legacy',
      mapping: { name: 0, price: 1, category: 12, tax: 15 },
      columns: [
        { index: 0, samples: ['Name', 'Hummus', 'Mutabbal'] },
        { index: 1, samples: ['Price', '2.25', '2.5'] },
        ...Array.from({ length: 10 }, (_, offset) => ({ index: offset + 2, samples: [] })),
        { index: 12, samples: ['Category', 'Starters', 'Starters'] },
        { index: 13, samples: [] },
        { index: 14, samples: [] },
        { index: 15, samples: ['Tax', '0.16', '0'] },
      ],
    });
  });

  it('uses null defaults when a legacy workbook is narrower than the old column layout', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Name', 'Price'], ['Tea', 1.25]]);

    expect(inspectCatalogWorkbook(workbookBuffer([['Legacy', sheet]])).mapping).toEqual({
      name: 0,
      price: 1,
      category: null,
      tax: null,
    });
  });

  it('numbers columns relative to a sparse sheet range that starts after column A', () => {
    const sheet = {};
    sheet.C2 = { t: 's', v: 'Name' };
    sheet.E2 = { t: 's', v: 'Tax' };
    sheet.C4 = { t: 's', v: 'Tea' };
    sheet.E4 = { t: 'n', v: 0.16 };
    sheet['!ref'] = 'C2:E4';

    const buffer = workbookBuffer([['Legacy', sheet]]);
    expect(inspectCatalogWorkbook(buffer).columns).toEqual([
      { index: 0, samples: ['Name', 'Tea'] },
      { index: 1, samples: [] },
      { index: 2, samples: ['Tax', '0.16'] },
    ]);
    expect(inspectCatalogWorkbook(buffer).columns).toEqual(baselineLegacyMetadata(buffer));
  });

  it('matches the old raw sample conversion for strings, numbers, booleans, errors, and formulas', () => {
    const sheet = {
      A1: { t: 's', v: 'Text' },
      B1: { t: 'n', v: 42 },
      C1: { t: 'b', v: true },
      D1: { t: 'e', v: 7 },
      E1: { t: 'n', f: '1+1', v: 2 },
      F1: { t: 'z' },
      A2: { t: 's', v: 'NULL' },
      B2: { t: 'n', v: 0 },
      C2: { t: 'b', v: false },
      '!ref': 'A1:F2',
    };
    const buffer = workbookBuffer([['Legacy', sheet]]);

    expect(inspectCatalogWorkbook(buffer).columns).toEqual(baselineLegacyMetadata(buffer));
  });

  it('rejects empty workbooks', () => {
    expect(() => inspectCatalogWorkbook(workbookBuffer([['Empty', XLSX.utils.aoa_to_sheet([])]]))).toThrow();
  });

  it('preserves template sheet names, values, and column widths', () => {
    const workbook = XLSX.read(createCatalogTemplate(), { type: 'array', cellStyles: true });

    expect(workbook.SheetNames).toEqual(['Categories', 'Products']);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Categories, { header: 1, defval: '', raw: true })).toEqual([
      ['Category Name', 'Parent Category', 'Is Notes'],
      ['Appetizers', '', 0],
      ['Cold Drinks', '', 0],
      ['Hot Drinks', '', 0],
      ['Extra Meat Notes', 'Appetizers', 1],
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Products, { header: 1, defval: '', raw: true })).toEqual([
      ['Product Name', 'Category Name', 'Price', 'Tax Rate', 'Barcode', 'Stock', 'Background Color'],
      ['Hummus Plain', 'Appetizers', 2.25, 0.16, '744101', 100, '#10b981'],
      ['Mutabbal', 'Appetizers', 2.5, 0.16, '744102', 100, '#059669'],
      ['Fresh Orange Juice', 'Cold Drinks', 3, 0, '744201', 50, '#3b82f6'],
      ['Turkish Coffee Single', 'Hot Drinks', 1.5, 0.16, '', '', ''],
    ]);
    expect(workbook.Sheets.Categories['!cols'].map((column) => column.wch)).toEqual([20, 20, 10]);
    expect(workbook.Sheets.Products['!cols'].map((column) => column.wch)).toEqual([25, 20, 12, 10, 15, 10, 18]);
  });
});

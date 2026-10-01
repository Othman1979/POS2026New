const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  renderReceiptDocument,
  renderKitchenDocument
} = require('../../../pos-spooler-printer/renderDocument');

const fixtureDir = resolve(__dirname, '../fixtures/printGoldens');
const fixtureIndex = resolve(fixtureDir, 'cases.json');
const requiredCaseIds = [
  'receipt-exclusive',
  'receipt-inclusive',
  'receipt-tax-exempt',
  'receipt-item-discount',
  'receipt-order-discount',
  'receipt-bundle-service-charge',
  'receipt-cash',
  'receipt-card',
  'receipt-split',
  'receipt-guest-check',
  'receipt-arabic-multiline-notes',
  'receipt-zero-items',
  'receipt-fifty-items',
  'receipt-long-name',
  'receipt-custom-layout-safe',
  'receipt-custom-layout-required-omitted',
  'receipt-jofotara-accepted-before-qr',
  'kitchen-normal',
  'kitchen-void',
  'kitchen-primary-other'
];

function normalizeInterTagWhitespace(html) {
  return String(html).replace(/\r\n?/g, '\n').replace(/>\s+</g, '><').trim();
}

function materializeInput(testCase) {
  const input = structuredClone(testCase.input);
  if (testCase.repeatItems) {
    input.items = Array.from({ length: testCase.repeatItems.count }, (_, index) => ({
      ...testCase.repeatItems.item,
      name: `${testCase.repeatItems.prefix}${index + 1}`
    }));
    input.subtotal = testCase.repeatItems.count * Number(testCase.repeatItems.item.price);
    input.total = input.subtotal + Number(input.tax || 0);
  }
  return input;
}

function withFrozenNow(value, render) {
  if (!value) return render();
  const RealDate = Date;
  const frozenTime = new RealDate(value).getTime();
  global.Date = class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozenTime]));
    }

    static now() {
      return frozenTime;
    }
  };
  try {
    return render();
  } finally {
    global.Date = RealDate;
  }
}

function renderCase(testCase) {
  const renderer = testCase.document === 'receipt'
    ? renderReceiptDocument
    : renderKitchenDocument;
  return withFrozenNow(testCase.now, () => renderer(materializeInput(testCase)));
}

describe('spooler print goldens', () => {
  it('stores deterministic receipt and kitchen fixture cases', () => {
    expect(existsSync(fixtureIndex)).toBe(true);
  });

  const cases = existsSync(fixtureIndex)
    ? JSON.parse(readFileSync(fixtureIndex, 'utf8'))
    : [];

  it('covers every agreed receipt and kitchen baseline', () => {
    expect(cases.map(testCase => testCase.id)).toEqual(requiredCaseIds);
  });

  it.each(cases)('$id matches its frozen $document document', (testCase) => {
    const expected = readFileSync(resolve(fixtureDir, `${testCase.id}.html`), 'utf8');
    expect(normalizeInterTagWhitespace(renderCase(testCase)))
      .toBe(normalizeInterTagWhitespace(expected));
  });
});

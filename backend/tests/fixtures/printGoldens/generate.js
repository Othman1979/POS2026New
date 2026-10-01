const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  renderReceiptDocument,
  renderKitchenDocument
} = require('../../../../pos-spooler-printer/renderDocument');

const fixtureDir = __dirname;
const cases = JSON.parse(readFileSync(resolve(fixtureDir, 'cases.json'), 'utf8'));

function normalizeInterTagWhitespace(html) {
  return String(html).replace(/>\s+</g, '><').trim();
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

for (const testCase of cases) {
  const renderer = testCase.document === 'receipt'
    ? renderReceiptDocument
    : renderKitchenDocument;
  const html = withFrozenNow(testCase.now, () => renderer(materializeInput(testCase)));
  writeFileSync(
    resolve(fixtureDir, `${testCase.id}.html`),
    `${normalizeInterTagWhitespace(html)}\n`
  );
}

console.log(`generated ${cases.length} print goldens`);

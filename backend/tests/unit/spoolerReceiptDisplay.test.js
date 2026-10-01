const { buildReceiptPresentation, validateReceiptPresentation } = require('../../services/ReceiptPresentation');
const { escapeHtml, renderReceiptItems, renderReceiptSummary } = require('../../../pos-spooler-printer/receipt-display.cjs');
const { renderReceiptDocument } = require('../../../pos-spooler-printer/renderDocument.js');
const { buildTypstDocument } = require('../../../pos-spooler-printer/v2/compiled-document-typst');
const { compileTemplate } = require('../../services/printTemplateEngine');
const { getBuiltinTemplate, getTemplateFixture, listTemplateFixtures } = require('../../services/printTemplateDefaults');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spoolerSource = fs.readFileSync(path.resolve(__dirname, '../../../pos-spooler-printer/server.js'), 'utf8');
const rendererSource = fs.readFileSync(path.resolve(__dirname, '../../../pos-spooler-printer/renderDocument.js'), 'utf8');

describe('physical receipt renderers', () => {
  it('wires the deployable renderer into physical receipt rows and totals', () => {
    expect(spoolerSource).toContain("require('./v2/typst-renderer')");
    expect(rendererSource).toContain("require('./receipt-display.cjs')");
    expect(rendererSource.match(/data\.receipt_display_v1 !== undefined/g)).toHaveLength(2);
    expect(rendererSource).toContain('renderReceiptItems(data.receipt_display_v1)');
    expect(rendererSource).toContain('renderReceiptSummary(data.receipt_display_v1)');
  });

  it('escapes receipt, legacy-row, kitchen, and report identity text', () => {
    const renderSources = `${spoolerSource}\n${rendererSource}`;
    for (const rawInterpolation of [
      '${data.storeInfo.store_name}',
      '${data.cashier}',
      '${data.note || data.order_note}',
      '${data.customer_name || \'N/A\'}',
      '${item.name}',
      '${lines}',
      '${type.order_type_name || \'Standard\'}',
      '${formattedQty}x',
      '${s.cashier_name}',
      '${t.order_type_name}'
    ]) {
      expect(renderSources, rawInterpolation).not.toContain(rawInterpolation);
    }
    expect(renderSources).not.toContain('value => value');
    expect(rendererSource).toContain('escapeHtml(data.storeInfo.store_name)');
    expect(rendererSource).toContain('escapeHtml(item.name)');
    expect(rendererSource).toContain('escapeHtml(lines)');
  });

  it.each(['receipt', 'kitchen'])('validates the native %s document before physical rendering', async printType => {
    const fixture = getTemplateFixture(printType, listTemplateFixtures(printType)[0].key);
    const { artifact } = await compileTemplate(getBuiltinTemplate(printType), fixture, {
      mode: 'runtime', templateRevisionId: `builtin:${printType}-v1`
    });
    const job = { print_type: printType, data: { compiled_document_v1: artifact } };
    expect(buildTypstDocument(job).width).toBe(576);
    artifact.nativeLayout.bands.push({ id: 'hostile', layout: 'flow', nodes: [{ type: 'raw', source: '#read("secret")' }] });
    expect(() => buildTypstDocument(job)).toThrow(/does not support|unsupported/i);
  });

  it('renders split receipts as separate Cash and Card tenders', () => {
    const html = renderReceiptDocument({
      storeInfo: { receipt_config: JSON.stringify({ layout: ['payment'] }) },
      payment_method: 'split',
      cash_amount: 3.25,
      card_amount: 7.5
    });
    expect(html).toMatch(/>Cash<\/span><span>3\.25 JD</);
    expect(html).toMatch(/>Card<\/span><span>7\.50 JD</);
  });

  it('escapes user strings and renders net/discount rows', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'x', name: '<img onerror=alert(1)>', note: '& note', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 1.6, total: 11.6 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    const html = renderReceiptItems(model);
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
    expect(html).toContain('&amp; note');
    expect(html).not.toContain('<img');
  });

  it('prints only inclusive item totals and the final summary total', () => {
    const html = renderReceiptSummary(buildReceiptPresentation({
      items: [{ key: 'x', name: 'Sample', qty: 1, unitPrice: 0.1 }],
      summary: { subtotal: 0.1, tax: 0, total: 0.09 },
      orderDiscount: { type: 'percent', value: 1, amount: 0 },
      taxMode: 'inclusive'
    }));
    expect(html).not.toContain('Subtotal');
    expect(html).not.toContain('Tax');
    expect(html).not.toContain('Included in prices');
    expect(html).toMatch(/Rounding/);
    expect(html).toContain('0.09 JD');
  });

  it('keeps legacy inclusive receipts total-only when v1 is unavailable', () => {
    const html = renderReceiptDocument({
      storeInfo: {
        receipt_config: JSON.stringify({ layout: ['totals'] }),
        tax_inclusive_pricing: '1'
      },
      subtotal: 10,
      tax: 1.6,
      total: 11.6
    });
    expect(html).not.toContain('Subtotal');
    expect(html).not.toContain('>Tax<');
    expect(html).toContain('11.60 JD');
  });

  it('renders the supplied tax-exempt label instead of a numeric zero', () => {
    const html = renderReceiptSummary(buildReceiptPresentation({
      items: [{ key: 'x', name: 'Meal', qty: 1, unitPrice: 17 }],
      summary: { subtotal: 17, tax: 0, total: 17 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive', taxExempt: true
    }));
    expect(html).toContain('(معفي من الضريبة)');
    expect(html).not.toContain('0.00 JD');
  });

  it('does not print retired receivable collection rows', () => {
    const reportSource = fs.readFileSync(path.resolve(__dirname, '../../../pos-spooler-printer/v2/report-typst.js'), 'utf8');
    expect(reportSource).not.toContain('Receivable Cash Collections');
    expect(reportSource).not.toContain('Receivable Card Collections');
  });

  it('renders receivable due and outstanding facts from v1 without recomputing them', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'x', name: 'Plan', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive',
      billing: { terms: 'receivable', issuedOn: '2026-07-30', dueOn: '2026-08-31', invoiceTotal: 10, collectedAmount: 2, outstandingAmount: 8 }
    });
    const html = renderReceiptSummary(model);
    expect(html).toContain('Issued');
    expect(html).toContain('Due date');
    expect(html).toContain('2026-08-31');
    expect(html).toContain('Collected');
    expect(html).toContain('2.00 JD');
    expect(html).toContain('Outstanding');
    expect(html).toContain('8.00 JD');
  });

  it('renders line discount as label Off (-amount JD) matching browser renderers', () => {
    const html = renderReceiptItems(buildReceiptPresentation({
      items: [{ key: 'd', name: 'Item', qty: 2, unitPrice: 10, discountType: 'fixed', discountValue: 2 }],
      summary: { subtotal: 16, tax: 0, total: 16 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    }));
    expect(html).toContain('2.00 x 2 Off (-4.00 JD)');
  });

  it('does not print the internal service-charge marker from a persisted v1 receipt', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'fee', name: '10% Service Charge', note: 'Auto-Gratuity', qty: 1, unitPrice: 0.79 }],
      summary: { subtotal: 0.79, tax: 0, total: 0.79 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    model.rows[0].note = 'Auto-Gratuity';

    expect(renderReceiptItems(model)).not.toContain('Auto-Gratuity');
  });

  it('fails closed for present malformed v1', () => {
    expect(() => renderReceiptSummary({ version: 1 })).toThrow(/invalid receipt presentation/i);
  });

  it.each([
    ['large rounding', model => ({ ...model, summary: { ...model.summary, roundingAdjustment: 89, total: 90 } })],
    ['bundle child money', model => ({ ...model, rows: [...model.rows, { ...model.rows[0], key: 'child', kind: 'bundle_child', netAmount: 1 }] })],
    ['negative tax', model => ({ ...model, summary: { ...model.summary, taxAmount: -1, total: 0 } })],
    ['numeric-string summary money', model => ({ ...model, summary: { ...model.summary, subtotal: '1', total: '1' } })],
    ['non-string row note', model => ({ ...model, rows: [{ ...model.rows[0], note: { a: 1 } }] })],
    ['impossible row discount display', model => ({ ...model, rows: [{ ...model.rows[0], lineDiscountAmount: 2, lineDiscountLabel: '2.00 x 1' }] })],
    ['unlabeled row discount display', model => ({ ...model, rows: [{ ...model.rows[0], lineDiscountAmount: 1, lineDiscountLabel: null }] })]
  ])('matches backend rejection for %s', (_name, mutate) => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 1 }],
      summary: { subtotal: 1, tax: 0, total: 1 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    const malformed = mutate(valid);
    expect(() => validateReceiptPresentation(malformed)).toThrow(/invalid receipt presentation/i);
    expect(() => renderReceiptSummary(malformed)).toThrow(/invalid receipt presentation/i);
  });

  it('escapes header, customer, and footer strings through the exported helper', () => {
    expect(escapeHtml(`A&B <Store> "quoted" 'single'`))
      .toBe('A&amp;B &lt;Store&gt; &quot;quoted&quot; &#39;single&#39;');
  });

  it('strips dangerous control bytes while preserving multiline print whitespace', () => {
    expect(escapeHtml('A\x00\x07\x1b\tB\r\nC\x7f<&'))
      .toBe('A\tB\r\nC&lt;&amp;');
  });

  it('loads from an isolated print-machine directory without the web repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-spooler-'));
    const deployed = path.join(dir, 'receipt-display.cjs');
    fs.copyFileSync(path.resolve(__dirname, '../../../pos-spooler-printer/receipt-display.cjs'), deployed);
    fs.copyFileSync(path.resolve(__dirname, '../../../pos-spooler-printer/report-html.js'), path.join(dir, 'report-html.js'));
    try {
      const isolated = require(deployed);
      expect(isolated.renderReceiptSummary(buildReceiptPresentation({
        items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 1 }],
        summary: { subtotal: 1, tax: 0, total: 1 },
        orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
      }))).toContain('1.00');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

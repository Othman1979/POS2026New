'use strict';
// Real receipt/kitchen print jobs: backend template compiler + built-in fixtures, rendered by the
// spooler's own renderer router in the Typst-only mode. Nothing here touches a DB or printer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const SPOOLER = path.join(ROOT, 'pos-spooler-printer');
const { compileTemplate } = require(path.join(ROOT, 'backend/services/printTemplateEngine'));
const { getBuiltinTemplate, getTemplateFixture } = require(path.join(ROOT, 'backend/services/printTemplateDefaults'));
const { createRendererRouter } = require(path.join(SPOOLER, 'v2/renderer-router'));
const { createTypstRenderer } = require(path.join(SPOOLER, 'v2/typst-renderer'));
const { createRawArtifactRenderer } = require(path.join(SPOOLER, 'v2/raw-artifact-renderer'));

const TYPST_RUNTIME = process.env.REPRO_TYPST_RUNTIME;
if (!TYPST_RUNTIME) throw new Error('Set REPRO_TYPST_RUNTIME to the staged Typst directory (typst.exe and fonts).');

const NAMES = ['Chicken Shawarma', 'شاورما دجاج', 'Mixed Grill Platter', 'فتوش', 'Hummus', 'منسف', 'Falafel Wrap', 'Mint Lemonade'];

async function receiptJob(invoice, items) {
    const fixture = getTemplateFixture('receipt', 'receipt-basic');
    fixture.meta.invoiceDisplayNo = `INV-${invoice}`;
    fixture.meta.orderDisplayNo = String(invoice);
    const base = fixture.rows[0];
    fixture.rows = Array.from({ length: items }, (_, k) => ({
        ...base, key: `item-${k}`, name: `${NAMES[k % NAMES.length]} ${k + 1}`, note: k % 3 === 0 ? 'بدون بصل · no onion' : '',
        qty: 1 + (k % 3), unitPrice: 2.5, extendedPrice: 2.5 * (1 + (k % 3)), netAmount: 2.5 * (1 + (k % 3))
    }));
    const { artifact } = await compileTemplate(getBuiltinTemplate('receipt'), fixture, {
        mode: 'runtime', templateRevisionId: 'builtin:receipt-v1', printRequestedAt: '2026-09-24T19:30:00.000Z'
    });
    return { label: `receipt ${invoice} (${items} items)`, print_type: 'receipt', data: { compiled_document_v1: artifact } };
}

async function kitchenJob(order, items) {
    const fixture = getTemplateFixture('kitchen', 'kitchen-normal');
    fixture.meta.ticketDisplayNo = String(order);
    fixture.meta.orderDisplayNo = String(order);
    fixture.items = Array.from({ length: items }, (_, k) => ({
        name: `${NAMES[k % NAMES.length]} ${k + 1}`, qty: 1 + (k % 4), note: k % 2 === 0 ? 'EXTRA GARLIC · بدون مخلل' : '',
        bundleLabel: '', isOther: false
    }));
    const { artifact } = await compileTemplate(getBuiltinTemplate('kitchen'), fixture, {
        mode: 'runtime', templateRevisionId: 'builtin:kitchen-v1', printRequestedAt: '2026-09-24T19:30:00.000Z'
    });
    return { label: `kitchen #${order} (${items} items)`, print_type: 'kitchen', data: { compiled_document_v1: artifact } };
}

function asQueueJob(spec, queueId, printer) {
    const job = { queue_id: queueId, print_type: spec.print_type, data: spec.data, ...printer };
    job.idempotency_key = `repro-${queueId}`;
    job.payload_hash = crypto.createHash('sha256').update(JSON.stringify(spec.data)).digest('hex');
    return job;
}

function createRenderer(stateRoot, env = {}) {
    return createRendererRouter({
        createRaw: () => createRawArtifactRenderer({ stateRoot }),
        createTypst: () => createTypstRenderer({
            stateRoot,
            executable: path.join(TYPST_RUNTIME, 'typst.exe'),
            fontPath: path.join(TYPST_RUNTIME, 'fonts'),
            env
        })
    });
}

module.exports = { receiptJob, kitchenJob, asQueueJob, createRenderer, SPOOLER, ROOT };

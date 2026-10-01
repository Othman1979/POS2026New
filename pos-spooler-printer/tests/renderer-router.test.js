const assert = require('node:assert/strict');
const { createRendererRouter } = require('../v2/renderer-router');
const { jobs: reportJobs } = require('./fixtures/typst-reports.cjs');

(async () => {
    let created = 0, calls = 0, closes = 0;
    const failure = Object.assign(new Error('unavailable'), { code: 'TYPST_UNAVAILABLE', failureClass: 'transient_safe' });
    const router = createRendererRouter({
        createRaw: () => ({ render: async () => ({ renderer: 'raw' }), close: () => { closes++; } }),
        createTypst: () => { created++; return {
            render: async job => { calls++; if (job.fail) throw failure; return { renderer: 'typst' }; },
            close: () => { closes++; }, health: () => ({ state: 'ready' })
        }; }
    });
    assert.equal(router.health().state, 'cold');
    assert.equal((await router.render({ print_type: 'cash_drawer' })).renderer, 'raw');
    assert.equal(created, 0, 'drawer must not start document compilation');
    const types = ['receipt', 'kitchen', 'x_report', 'z_report', 'audit_report',
        'category_items_report', 'y_held_items_report', 'daily_summary_report',
        'daily_sales_report', 'daily_refunds_report', 'daily_expenses_report',
        'expense_slip', 'expense_cancel_slip'];
    assert.deepEqual(new Set(reportJobs.map(job => job.print_type)), new Set(types.slice(2)), 'every report route has a real render fixture');
    for (const print_type of types) {
        assert.equal((await router.render({ print_type })).renderer, 'typst');
    }
    assert.equal(created, 1, 'all document families share the warm compiler');
    await assert.rejects(router.render({ print_type: 'receipt', fail: true }), error => error === failure);
    assert.equal(calls, types.length + 1, 'a failure must never invoke a second renderer or replay');
    assert.deepEqual(router.health(), { state: 'ready', mode: 'typst-only', counters: { typst_rendered: types.length } });
    await router.close();
    assert.equal(closes, 2);
    console.log('renderer-router tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

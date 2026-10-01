const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const workflows = [
    { script: 'permissions-browser.cjs', report: 'scratch/permissions-browser/results.json' },
    { script: 'table-void-revision-browser.cjs', report: 'scratch/table-void-revision-browser/results.json' },
    { script: 'checkout-ui-browser.cjs', report: 'scratch/checkout-ui-browser-results.json' }
];

function verifyBrowserResult(script, result) {
    if (script === 'checkout-ui-browser.cjs') {
        assert.equal(result.passed, true, 'Checkout recovery did not pass');
        assert(result.checks?.length > 0, 'Checkout recovery did not execute any checks');
        return;
    }
    assert.equal(result.complete, true, `${script} did not complete`);
    assert.equal(result.removed, true, `${script} did not remove its fixture`);
    assert.deepEqual(result.pageErrors, []);
    for (const [language, width] of [['en', 1440], ['ar', 390]]) {
        const runs = result.runs.filter(run => run.language === language && run.width === width);
        if (script === 'permissions-browser.cjs') {
            assert.equal(runs.length, 1, `Missing ${language} staff/table workflow`);
            assert.equal(runs[0].firstSave, 200);
            assert.equal(runs[0].laterEditDenied, 403);
            assert.equal(runs[0].lostCreateReplyRecovered, true);
            assert.equal(runs[0].approvalKeepsCashierRole, true);
        } else {
            assert.equal(runs.length, 2, `Missing ${language} void recovery with/without fees`);
            for (const fee of [false, true]) {
                const run = runs.find(value => value.fee === fee);
                assert.equal(run?.staleClear, 409);
                assert.equal(run?.committedRemoveReplyLost, true);
                assert.equal(run?.duplicateRemove, 409);
                assert.equal(run?.reopenedClear, 200);
            }
        }
    }
}

function run() {
    const summary = { complete: false, workflows: [] };
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
    // An interrupted rerun must not leave a previous successful summary behind.
    fs.writeFileSync(path.join(root, 'scratch/release-browser.json'), JSON.stringify(summary, null, 2));
    try {
        for (const workflow of workflows) {
            const report = path.join(root, workflow.report);
            fs.rmSync(report, { force: true }); // Never accept evidence from an earlier run.
            const child = spawnSync(process.execPath, [path.join(root, 'scripts/reviews', workflow.script)], {
                cwd: root,
                env: { ...process.env, PERMISSIONS_UI_BASELINE: '0' },
                stdio: 'inherit', timeout: 10 * 60 * 1000
            });
            if (child.error || child.status !== 0) throw new Error(`${workflow.script} failed: ${child.error?.message || child.signal || child.status}`);
            verifyBrowserResult(workflow.script, JSON.parse(fs.readFileSync(report, 'utf8')));
            summary.workflows.push({ ...workflow, passed: true });
        }
        summary.complete = true;
    } finally {
        fs.writeFileSync(path.join(root, 'scratch/release-browser.json'), JSON.stringify(summary, null, 2));
    }
}

if (require.main === module) {
    try { run(); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { verifyBrowserResult };

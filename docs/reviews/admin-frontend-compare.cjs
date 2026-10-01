/* Compare saved, sequential loopback measurements; never starts the app or a database. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const labels = ['inventory-12', 'inventory-search', 'sales-100', 'sales-2000', 'sales-filter', 'inspect-xlsx-20000x16', 'inventory-10-events', 'jofotara-10-events'];
const result = {
  baselineHarnessRevision: 'ec102023',
  units: 'bytes and milliseconds; heap in bytes, forced GC, main page only',
  method: 'Three fresh contexts per CPU rate and paired EN desktop / AR mobile case. Synthetic loopback gzip/no-store. Main-thread TaskDuration and elapsed action/readiness include a 250ms settle interval. Worker CPU is not included in main-thread TaskDuration; page CPU throttling is not equivalent worker throttling or a four-core device equivalent. No total browser/process RAM measurement.',
  harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'docs/reviews/admin-frontend-audit.cjs'))).digest('hex'),
  comparisons: [],
};
for (const cpuRate of [1, 4]) {
  const before = read(`scratch/admin-frontend-audit/results-cpu${cpuRate}.json`);
  const after = read(`scratch/admin-frontend-after/results-cpu${cpuRate}.json`);
  for (const batch of [before, after]) {
    if (batch.unknown.length || batch.runs.length !== 6 || batch.runs.some(run => run.errors.length)) throw new Error('Incomplete or invalid measurement batch');
  }
  for (const lang of ['en', 'ar']) {
    const summarize = batch => {
      const runs = batch.runs.filter(run => run.lang === lang);
      return {
        revision: batch.revision, node: batch.node, chromium: batch.chromium, cpu: batch.cpu, spreadsheetBytes: batch.spreadsheetBytes,
        steps: labels.map(label => {
          const samples = runs.map(run => run.steps.find(step => step.label === label));
          const values = key => samples.map(step => step[key]);
          return {
            label, taskMs: values('taskMs'), medianTaskMs: median(values('taskMs')),
            elapsedMs: values('elapsedMs'), medianElapsedMs: median(values('elapsedMs')),
            longestTaskMs: samples.map(step => Math.max(0, ...step.longTasks.map(task => task.duration))),
            connectedElements: values('nodes'), rows: values('rows'), requestCounts: samples.map(step => step.requests.length),
            requestURLs: samples[0].requests,
            scriptResources: samples[0].resources.filter(resource => resource.name.endsWith('.js')),
            gzipJsBytes: samples.map(step => step.resources.filter(resource => resource.name.endsWith('.js')).reduce((total, resource) => total + resource.encoded, 0)),
            documentOverflow: values('overflow'),
          };
        }),
        heaps: runs.map(run => ({ cold: run.coldHeap, warmAndCycles: run.heap })),
      };
    };
    result.comparisons.push({ cpuRate, lang, before: summarize(before), after: summarize(after) });
  }
}
const acceptance = read('scratch/admin-frontend-acceptance/results-cpu4.json');
if (acceptance.unknown.length || acceptance.runs.length !== 4 || acceptance.runs.some(run => run.errors.length || run.acceptance?.length !== 11)) {
  throw new Error('Incomplete or invalid browser acceptance evidence');
}
result.acceptance = acceptance.runs.map(run => ({ lang: run.lang, width: run.width, checks: run.acceptance, errors: run.errors }));
const tests = read('scratch/admin-frontend-final-tests.json');
result.frontendTests = { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests };
if (!tests.success) throw new Error('Frontend tests failed');
fs.writeFileSync(path.join(root, 'docs/reviews/2026-09-10-admin-frontend-resource-cuts-measurements.json'), JSON.stringify(result, null, 2) + '\n');
for (const comparison of result.comparisons) {
  console.log(`CPU ${comparison.cpuRate}, ${comparison.lang}`);
  for (let index = 0; index < labels.length; index += 1) {
    const before = comparison.before.steps[index], after = comparison.after.steps[index];
    console.log(`${before.label}: task ${before.medianTaskMs.toFixed(1)} -> ${after.medianTaskMs.toFixed(1)} ms; elapsed ${before.medianElapsedMs.toFixed(1)} -> ${after.medianElapsedMs.toFixed(1)} ms; requests ${before.requestCounts} -> ${after.requestCounts}; JS ${before.gzipJsBytes[0]} -> ${after.gzipJsBytes[0]}`);
  }
}

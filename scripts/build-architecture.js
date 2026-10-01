#!/usr/bin/env node
/**
 * Validates docs/architecture.json against the real tree and renders docs/architecture.html.
 *
 *   node scripts/build-architecture.js            validate + render
 *   node scripts/build-architecture.js --check    validate only (CI / pre-merge)
 *
 * The map is only worth reading if it is true, so every referenced path is
 * checked against disk and every edge against the node list. Line numbers drift
 * silently; a missing file or a dangling edge is a hard error.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'docs/architecture.json');
const TEMPLATE = path.join(ROOT, 'docs/architecture.template.html');
const OUT = path.join(ROOT, 'docs/architecture.html');
const PLACEHOLDER = '__ARCHDATA__';

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const layerIds = new Set(data.layers.map((l) => l.id));
const byId = new Map();

for (const node of data.nodes) {
    if (byId.has(node.id)) fail(`duplicate node id: ${node.id}`);
    byId.set(node.id, node);
    if (!layerIds.has(node.layer)) fail(`node ${node.id} has unknown layer "${node.layer}"`);
    if (!node.label) fail(`node ${node.id} has no label`);
}

// A path may carry a :line suffix; only the file part is checked against disk.
const seenPaths = new Map();
function checkPath(ref, where) {
    if (!ref) return;
    const [file, line] = String(ref).split(':');
    if (!seenPaths.has(file)) seenPaths.set(file, fs.existsSync(path.join(ROOT, file)));
    if (!seenPaths.get(file)) fail(`${where} points at a file that does not exist: ${file}`);
    else if (line !== undefined) {
        const total = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
        if (Number(line) > total) fail(`${where} points past end of ${file} (line ${line} > ${total})`);
    }
}

for (const node of data.nodes) checkPath(node.file, `node ${node.id}`);

const flowIds = new Set();
for (const flow of data.flows) {
    if (flowIds.has(flow.id)) fail(`duplicate flow id: ${flow.id}`);
    flowIds.add(flow.id);
    if (flow.actor && !byId.has(flow.actor)) fail(`flow ${flow.id} has unknown actor ${flow.actor}`);
    if (!flow.steps || !flow.steps.length) fail(`flow ${flow.id} has no steps`);
    flow.steps.forEach((step, i) => {
        if (step.n !== i + 1) warn(`flow ${flow.id} step ${i + 1} is numbered ${step.n}`);
        for (const end of ['from', 'to']) {
            if (!byId.has(step[end])) fail(`flow ${flow.id} step ${step.n}: dangling ${end} "${step[end]}"`);
        }
        checkPath(step.file, `flow ${flow.id} step ${step.n}`);
    });
}

const defectIds = new Set();
for (const defect of data.defects || []) {
    if (defectIds.has(defect.id)) fail(`duplicate defect id: ${defect.id}`);
    defectIds.add(defect.id);
    if (!['critical', 'major', 'minor'].includes(defect.severity)) fail(`defect ${defect.id} has bad severity "${defect.severity}"`);
    checkPath(defect.file, `defect ${defect.id}`);
    for (const id of defect.nodes || []) if (!byId.has(id)) fail(`defect ${defect.id} references unknown node ${id}`);
}

// Every defect id a node claims must resolve, and vice versa.
for (const node of data.nodes) {
    for (const id of node.defects || []) if (!defectIds.has(id)) fail(`node ${node.id} claims unknown defect ${id}`);
}

for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\n${errors.length} integrity error(s). The map does not match the tree.`);
    process.exit(1);
}

const stats = `${data.nodes.length} nodes, ${data.flows.length} flows, ${data.flows.reduce((n, f) => n + f.steps.length, 0)} steps, ${(data.defects || []).length} defects, ${seenPaths.size} distinct files — all present`;
if (process.argv.includes('--check')) {
    console.log(`architecture.json OK: ${stats}`);
    process.exit(0);
}

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (!template.includes(PLACEHOLDER)) throw new Error(`Template is missing ${PLACEHOLDER}.`);
// </script> inside the payload would close the host tag early.
const payload = JSON.stringify(data, null, 2).replace(/<\/script/gi, '<\\/script');
fs.writeFileSync(OUT, template.replace(PLACEHOLDER, payload), 'utf8');
console.log(`Wrote docs/architecture.html — ${stats}`);

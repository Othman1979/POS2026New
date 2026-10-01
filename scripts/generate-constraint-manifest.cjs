#!/usr/bin/env node
// Writes backend/services/schemaConstraintManifest.json: every named foreign key and CHECK rule
// of the canonical fresh schema. Startup uses it to restore constraints an old or imported
// database lost (see backend/services/constraintRepair.js). Run after changing the baseline.
const fs = require('fs');
const path = require('path');

function parseConstraints(sql) {
    const foreignKeys = [];
    const checks = [];
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/)) {
        const head = statement.match(/(?:CREATE TABLE (?:IF NOT EXISTS )?|ALTER TABLE )`?(\w+)`?/i);
        if (!head) continue;
        const table = head[1];
        const fk = /CONSTRAINT\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?\s+FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+`?(\w+)`?\s*\(([^)]+)\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET NULL|RESTRICT|NO ACTION))*)/gi;
        const list = value => value.replace(/`/g, '').split(',').map(item => item.trim());
        let match;
        while ((match = fk.exec(statement))) {
            foreignKeys.push({
                name: match[1], table, columns: list(match[2]), references: match[3],
                referencedColumns: list(match[4]), actions: match[5].replace(/\s+/g, ' ').trim()
            });
        }
        const check = /CONSTRAINT\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?\s+CHECK\s*\(/gi;
        while ((match = check.exec(statement))) {
            let depth = 1;
            let index = check.lastIndex;
            for (; index < statement.length && depth; index += 1) {
                if (statement[index] === '(') depth += 1;
                else if (statement[index] === ')') depth -= 1;
            }
            checks.push({ name: match[1], table, expression: statement.slice(check.lastIndex, index - 1).replace(/\s+/g, ' ').trim() });
        }
    }
    return { foreignKeys, checks };
}

module.exports = { parseConstraints };

if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const baseline = fs.readFileSync(path.join(root, 'deployment/database/baseline.sql'), 'utf8');
    const manifest = parseConstraints(baseline);
    fs.writeFileSync(path.join(root, 'backend/services/schemaConstraintManifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${manifest.foreignKeys.length} foreign keys, ${manifest.checks.length} checks`);
}

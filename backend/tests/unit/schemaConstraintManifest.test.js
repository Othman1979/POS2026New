const fs = require('fs');
const path = require('path');
const { parseConstraints } = require('../../../scripts/generate-constraint-manifest.cjs');
const manifest = require('../../services/schemaConstraintManifest.json');

describe('schema constraint manifest', () => {
    it('matches every named foreign key and CHECK rule of the fresh baseline', () => {
        const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8');
        expect(manifest).toEqual(parseConstraints(baseline));
        // Includes the rules the baseline adds with ADD CONSTRAINT IF NOT EXISTS.
        expect(manifest.checks.map(check => check.name)).toEqual(expect.arrayContaining(['ck_stock_item_availability', 'ck_stock_item_attention']));
    });
});

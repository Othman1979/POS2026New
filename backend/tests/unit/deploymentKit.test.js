const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateFreshDatabaseSql, initialUserSeed } = require('../../../deployment/tools/export-fresh-database');
const { snapshotKit, publishKit, verifyCandidate } = require('../../../scripts/prepare-deployment-kit.cjs');

const seed = "INSERT INTO users (user_number, name, role, admin_pin, is_active, xyz, table_access_scope)\nVALUES ('001234', 'Site Admin', 'admin', NULL, 1, 0, 'all'),\n('123456789012', 'Site Programmer', 'programmer', NULL, 1, 1, 'all');";
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

describe('fresh deployment SQL export', () => {
    it('preserves the existing identities and seed flags while using the current canonical catalog', async () => {
        const sql = await generateFreshDatabaseSql(seed);
        expect(initialUserSeed(sql)).toBe(seed);
        expect(sql).toContain(require('../../config/permissionCatalog').permissionCatalogSql());
        expect(sql).not.toMatch(/^\s*(?:USE\s|(?:CREATE|ALTER)\s+(?:DATABASE|USER)\b|GRANT\s|FLUSH\s)/im);
        expect(sql).not.toContain('export-only');
        expect(sql).toContain('SET FOREIGN_KEY_CHECKS = 1;');
    });
    it('preserves legacy seeds while supplying the new explicit table scope', async () => {
        const legacy = seed.replace(', table_access_scope', '').replaceAll(", 'all'", '');
        const sql = await generateFreshDatabaseSql(legacy);
        expect(initialUserSeed(sql)).toBe(legacy);
        expect(sql).toContain("UPDATE users SET table_access_scope='all' WHERE role IN ('admin','programmer');");
    });
    it.each(['', `${seed}\n${seed}`, seed.replace('NULL', 'LOAD_FILE(\'/private\')'), seed.replace("'001234'", "'bad;value'")])('rejects an unsupported seed without carrying arbitrary SQL forward', value => {
        expect(() => initialUserSeed(value)).toThrow();
    });
});

describe('verified kit replacement', () => {
    let workspace, target, candidate, backup;
    function makeKit(directory, label) {
        fs.mkdirSync(directory);
        const files = { '.env': 'existing-private-config', 'INITIAL-LOGIN.txt': 'existing-private-login',
            'fresh-database.sql': `${label}-sql`, 'POSAPP-Hostinger-source.zip': `${label}-zip`, 'SETUP.txt': `${label}-setup` };
        for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text);
        fs.writeFileSync(path.join(directory, 'VERIFICATION.json'), JSON.stringify({ commit: 'revision',
            sourceZipSha256: sha(files['POSAPP-Hostinger-source.zip']), sqlSha256: sha(files['fresh-database.sql']),
            exactSqlImport: 'passed', schemaValidator: 'passed', removed: true, initialIdentitiesMatch: true,
            pendingMigrations: 0, allBusinessTablesEmpty: true }));
    }
    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-kit-test-'));
        target = path.join(workspace, 'kit'); candidate = path.join(workspace, 'candidate'); backup = path.join(workspace, 'previous');
        makeKit(target, 'previous'); makeKit(candidate, 'new');
    });
    afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const options = () => ({ target, candidate, backup, original: snapshotKit(target), verified: snapshotKit(candidate) });
    it('promotes the complete verified set and preserves private file bytes', () => {
        const args = options();
        expect(verifyCandidate(candidate, 'revision', args.original)).toEqual(args.verified);
        publishKit(args);
        expect(snapshotKit(target)).toEqual(args.verified);
        expect(snapshotKit(backup)).toEqual(args.original);
    });
    it('restores the entire previous kit if promotion fails halfway through', () => {
        const args = options();
        const rename = (from, to) => { if (from === candidate) throw new Error('disk error'); fs.renameSync(from, to); };
        expect(() => publishKit(args, rename)).toThrow('disk error');
        expect(snapshotKit(target)).toEqual(args.original);
        expect(snapshotKit(candidate)).toEqual(args.verified);
        expect(fs.existsSync(backup)).toBe(false);
    });
    it('refuses a concurrent private-file edit without replacing it', () => {
        const args = options(); fs.appendFileSync(path.join(target, '.env'), '-user-edit');
        expect(() => publishKit(args)).toThrow('Maintained kit changed');
        expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe('existing-private-config-user-edit');
        expect(fs.existsSync(backup)).toBe(false);
    });
    it('refuses candidates corrupted after verification', () => {
        const args = options(); fs.appendFileSync(path.join(candidate, 'fresh-database.sql'), '-tampered');
        expect(() => publishKit(args)).toThrow('Candidate changed');
        expect(snapshotKit(target)).toEqual(args.original);
        expect(() => verifyCandidate(candidate, 'revision', args.original)).toThrow('SQL hash mismatch');
    });
    it('rejects an incomplete kit or successful-looking report without completed database checks', () => {
        const original = snapshotKit(target);
        const reportPath = path.join(candidate, 'VERIFICATION.json');
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        fs.writeFileSync(reportPath, JSON.stringify({ ...report, removed: false }));
        expect(() => verifyCandidate(candidate, 'revision', original)).toThrow('fixture was not removed');
        fs.rmSync(path.join(candidate, 'fresh-database.sql'));
        expect(() => snapshotKit(candidate)).toThrow('six maintained kit files');
    });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NODE = process.execPath;
const bootstrap = path.join(ROOT, 'deployment/tools/bootstrap-database.js');
const verify = path.join(ROOT, 'deployment/tools/verify-install.js');
const require = createRequire(import.meta.url);
const { readConfig: readVerifyConfig } = require('../../../deployment/tools/verify-install.js');

function run(file, args) {
    return spawnSync(NODE, [file, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function writeConfig(values = {}) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-installer-cli-')), 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        host: '127.0.0.1', port: 3306, adminUser: 'root', adminPassword: 'admin-secret',
        database: 'posapp', appUser: 'posapp_runtime', appPassword: 'app-secret',
        maintenanceUser: 'posapp_maintenance', maintenancePassword: 'maintenance-secret',
        adminUserNumber: '009384', adminName: 'Administrator',
        dbPassword: 'app-secret', healthUrl: 'http://127.0.0.1:3000/health',
        phpMyAdminUrl: 'http://127.0.0.1:8081/', backupFile: path.join(ROOT, 'missing.sql.gz'),
        expectedBackupSha256: 'a'.repeat(64), expectedVersion: '1.0.0', expectedCommit: 'b'.repeat(40),
        expectedSchemaVersion: 'posapp-fresh-baseline-v1', ...values
    }, null, 2));
    return file;
}

describe('fresh installer CLIs', () => {
    it('validates a protected bootstrap config without connecting', () => {
        const result = run(bootstrap, ['--check', writeConfig()]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"valid":true');
    });

    it('rejects missing or unsupported bootstrap arguments', () => {
        expect(run(bootstrap, []).status).not.toBe(0);
        expect(run(bootstrap, ['--config', path.join(ROOT, 'missing-installer.json')]).status).not.toBe(0);
    });

    it('requires an explicit verification config', () => {
        expect(run(verify, []).status).not.toBe(0);
        expect(run(verify, ['--config', path.join(ROOT, 'missing-installer.json')]).status).not.toBe(0);
    });

    it('requires exact release and schema identity before verification starts', () => {
        expect(readVerifyConfig(writeConfig())).toMatchObject({ expectedVersion: '1.0.0', expectedSchemaVersion: 'posapp-fresh-baseline-v1' });
        expect(() => readVerifyConfig(writeConfig({ expectedSchemaVersion: '' }))).toThrow(/release identity/i);
    });
});

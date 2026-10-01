import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect } from 'vitest';
import net from 'net';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('installed POS configuration ownership', () => {
    it('requires production DB credentials and honors DB_PORT', () => {
        const source = read('backend/config/db.js')
            + read('backend/config/databasePoolOptions.js')
            + read('backend/services/databaseRuntime.js');
        expect(source).toContain('port:');
        expect(source).toContain('DB_PORT');
        expect(source).toContain("NODE_ENV === 'production'");
        expect(source).toContain(
            'connectionTelemetrySnapshot: { enumerable: false, value: databaseRuntime.snapshot }'
        );
        expect(source).toContain(
            'databaseRuntime: { enumerable: false, value: databaseRuntime }'
        );
    });

    it('routes mutable files through ProgramData variables', () => {
        expect(read('server.js')).toContain('POSAPP_UPLOAD_DIR');
        expect(read('backend/config/logger.js')).toContain('POSAPP_LOG_DIR');
        expect(read('scripts/db-backup.js')).toContain('POSAPP_BACKUP_DIR');
        expect(read('scripts/db-backup.js')).not.toContain('C:\\xampp\\mysql');
    });

    it('validates ports, suggests an available port, and renders complete templates', async () => {
        const { validatePort, suggestAvailablePort, generateSecret, generateNumericCode, renderTemplate } = await import(pathToFileURL(path.join(ROOT, 'deployment/tools/installer-config.js')).href);
        expect(validatePort('3000')).toBe(3000);
        expect(() => validatePort('0')).toThrow();
        expect(() => validatePort('65536')).toThrow();
        expect(await suggestAvailablePort(3000, async (port) => port !== 3000)).toBe(3001);
        expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(generateNumericCode()).toMatch(/^[1-9][0-9]{7}$/);
        expect(() => renderTemplate('x={{MISSING}}', {})).toThrow(/MISSING/);
        expect(renderTemplate('x={{VALUE}}', { VALUE: 'ok' })).toBe('x=ok');
    });

    it('passes a fresh per-installation programmer number only through bootstrap and the one-time result', () => {
        const configTool = read('deployment/tools/installer-config.js');
        const installer = read('deployment/windows/Install-PosServer.ps1');
        const serverEnv = read('deployment/templates/pos.env.template');

        expect(configTool).toContain('programmerUserNumber: generateNumericCode(12)');
        expect(installer).toContain('programmerUserNumber=$secrets.programmerUserNumber');
        expect(installer).toContain('Programmer login number:');
        expect(installer).toMatch(/if \(-not \$repair\)[\s\S]*Programmer login number:/);
        expect(serverEnv).not.toContain('PROGRAMMER');
        expect(installer).not.toMatch(/\$installMetadata\s*=\s*@\{[^}]*programmer/i);
        expect(read('deployment/tools/bootstrap-database.js')).toContain("/^[1-9][0-9]{11}$/");
        expect(read('deployment/tools/verify-install.js')).toContain("[0-9]{11}$");
    });

    it('does not require a programmer seed while verifying a repair install', () => {
        const verifier = read('deployment/tools/verify-install.js');
        const freshCheck = verifier.indexOf('if (options.expectFresh !== false)');

        expect(freshCheck).toBeGreaterThan(-1);
        expect(verifier.slice(0, freshCheck)).not.toContain("role = 'programmer'");
        expect(verifier.slice(freshCheck)).toContain("role = 'programmer'");
    });

    it('detects a genuinely occupied loopback port without stopping the listener', async () => {
        const { checkPort } = await import(pathToFileURL(path.join(ROOT, 'deployment/tools/installer-config.js')).href);
        const listener = net.createServer();
        await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const port = listener.address().port;
        await expect(checkPort(port)).resolves.toBe(false);
        await new Promise((resolve) => listener.close(resolve));
        await expect(checkPort(port)).resolves.toBe(true);
    });

    it('keeps private web tools loopback-only and secret-free by default', () => {
        const apache = read('deployment/templates/httpd.conf.template');
        const php = read('deployment/templates/php.ini.template');
        const phpMyAdmin = read('deployment/templates/config.inc.php.template');
        const spooler = read('deployment/templates/spooler.env.template');
        const server = read('deployment/templates/pos.env.template');
        expect(apache).toContain('Listen 127.0.0.1:{{PHPMYADMIN_PORT}}');
        expect(apache).toContain('Require local');
        expect(apache).toContain('Options -Indexes');
        expect(php).toContain('display_errors=Off');
        expect(php).toContain('session.save_path="{{SESSION_DIR}}"');
        expect(phpMyAdmin).toContain("auth_type'] = 'cookie'");
        expect(phpMyAdmin).toContain("host'] = '127.0.0.1'");
        expect(spooler).toContain('SPOOLER_KEY={{SPOOLER_KEY}}');
        expect(server).toContain('SPOOLER_SYNC_INTERVAL_MS=500');
    });
});

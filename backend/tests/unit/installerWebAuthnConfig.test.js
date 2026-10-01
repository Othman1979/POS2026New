import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..', '..');

function readTemplate(name) {
    return fs.readFileSync(path.join(ROOT, 'deployment', 'templates', name), 'utf8');
}

describe('installer registered-browser configuration contract', () => {
    it('keeps origins explicit and does not provision a bootstrap secret', () => {
        const pos = readTemplate('pos.env.template');
        const hostinger = readTemplate('hostinger.env.template');

        expect(pos).toContain('DEVICE_AUTH_ALLOWED_ORIGINS=http://localhost:{{POS_PORT}}');
        expect(hostinger).toContain('DEVICE_AUTH_ALLOWED_ORIGINS=https://hashemi.shawermajwana.com');
        expect(`${pos}\n${hostinger}`).not.toContain(['TRUST', 'PROXY='].join('_'));
        expect(pos).toContain('ENFORCE_HTTPS=false');
        expect(hostinger).toContain('ENFORCE_HTTPS=true');
        expect(`${pos}\n${hostinger}`).not.toMatch(/WEBAUTHN_RP_(?:ID|NAME)\s*=/);
        expect(`${pos}\n${hostinger}`).not.toMatch(/(?:DEVICE_AUTH|WEBAUTHN)_BOOTSTRAP_SECRET\s*=/);
    });

    it('packages the dependency change only through the server runtime transition', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-installers.ps1'), 'utf8');
        const updater = fs.readFileSync(path.join(ROOT, 'deployment', 'windows', 'Update-PosServer.ps1'), 'utf8');

        expect(pkg.dependencies['@simplewebauthn/server']).toBeUndefined();
        expect(pkg.dependencies['@simplewebauthn/browser']).toBeUndefined();
        expect(lock.packages['node_modules/@simplewebauthn/server']).toBeUndefined();
        expect(lock.packages['node_modules/@simplewebauthn/browser']).toBeUndefined();
        expect(build).toMatch(/\$serverRuntimeRoots\s*=\s*@\(\$serverApplicationRoots \+ 'node_modules'\)/);
        expect(build).toContain("Write-UpdateManifest $serverUpdateRuntimeStage 'server-update-runtime'");
        expect(updater).toMatch(/dependenciesId[\s\S]{0,300}runtime_transition_required/);
    });
});

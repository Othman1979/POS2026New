import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SERVICE = 'pos-spooler-printer/service';
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('copy-the-folder spooler service', () => {
    const script = read(`${SERVICE}/spooler-service.ps1`);
    const code = script.split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n');

    it('ships a wrapper for every action it declares', () => {
        const declared = script.match(/\[ValidateSet\(([^)]+)\)\]/)[1]
            .split(',').map(value => value.trim().replace(/'/g, ''));
        expect(declared).toContain('install');
        for (const verb of declared) {
            const wrapper = path.join(ROOT, SERVICE, `${verb}.cmd`);
            expect(fs.existsSync(wrapper), `${verb}.cmd missing`).toBe(true);
            expect(read(`${SERVICE}/${verb}.cmd`)).toContain(`-Action ${verb}`);
        }
    });

    it('stands alone: no runtime dependency outside pos-spooler-printer', () => {
        // The point of this copy is that the folder can be moved anywhere. The
        // deployment/ variant stages into Program Files and needs its support tree
        // beside it, so it cannot be handed to a till on its own.
        expect(code).not.toContain('deployment');
        expect(code).not.toContain('Install-Spooler.ps1');
        for (const pinned of ['$NodeUrl =', '$NodeSha256 =', '$NssmUrl =', '$NssmSha256 =']) {
            expect(code).toContain(pinned);
        }
        expect(code).toContain('Get-FileHash');
    });

    it('puts the bundled runtime on PATH before npm runs', () => {
        // npm writes a shim per bin that falls back to a bare `node`. A till has no
        // system Node - the runtime is only ever called by full path - so any
        // install script that spawns `node` dies
        // with "'node' is not recognized" unless the runtime is on PATH.
        const onPath = code.indexOf('$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"');
        expect(onPath).toBeGreaterThan(-1);
        expect(onPath).toBeLessThan(code.indexOf("@('ci', '--omit=dev'"));
        expect(code).not.toContain('setup-browser');
        expect(code).toContain("'.cache\\typst\\0.15.1\\typst.exe'");
    });

    it('judges a native command on its exit code, not on stderr output', () => {
        // ErrorActionPreference=Stop plus 2>&1 makes every stderr line terminating.
        // npm exits 0 while warning about deprecated packages, and that killed an
        // install that had already succeeded.
        const body = code.slice(code.indexOf('function Invoke-Native'));
        const guarded = body.slice(0, body.indexOf('$LASTEXITCODE'));
        expect(guarded).toContain("$ErrorActionPreference = 'Continue'");
        expect(guarded).toContain('finally { $ErrorActionPreference = $previous }');
    });
});

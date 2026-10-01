import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    AFTER,
    BEFORE,
    ORIGINAL_SHA256,
    PATCHED_SHA256,
    patchBuffer,
    patchFile,
    sha256
} from '../../../deployment/tools/patch-typst-fast-watch.js';

function controlledFixture({ duplicate = false } = {}) {
    const bytes = Buffer.concat([
        Buffer.from('controlled-prefix'),
        BEFORE,
        Buffer.from('controlled-suffix'),
        ...(duplicate ? [BEFORE] : [])
    ]);
    const patched = Buffer.from(bytes);
    AFTER.copy(patched, bytes.indexOf(BEFORE));
    return { bytes, patched };
}

describe('Typst fast-watch binary patch', () => {
    it('pins the official and optimized Typst 0.15.1 executable identities', () => {
        expect(ORIGINAL_SHA256).toBe('081217a463adb006f8894b44227fe4b9c9e91fc85f5463d5948e8370db9bb31e');
        expect(PATCHED_SHA256).toBe('726d603b83bb39278646e0eb82f8d19f5cfa40c37d2133dcfadef2e1ac5da6b2');
        expect(BEFORE.toString('hex')).toBe('c744242000e1f505');
        expect(AFTER.toString('hex')).toBe('c7442420404b4c00');
    });

    it('changes exactly one verified instruction and is idempotent', () => {
        const { bytes, patched } = controlledFixture();
        const options = { originalSha256: sha256(bytes), patchedSha256: sha256(patched) };
        const first = patchBuffer(bytes, options);
        expect(first.changed).toBe(true);
        expect(first.bytes.equals(patched)).toBe(true);
        expect(first.bytes.reduce((count, value, index) => count + Number(value !== bytes[index]), 0)).toBe(4);

        const second = patchBuffer(first.bytes, options);
        expect(second.changed).toBe(false);
        expect(second.bytes.equals(patched)).toBe(true);
    });

    it('refuses an unknown executable or an ambiguous patch site', () => {
        const { bytes } = controlledFixture();
        expect(() => patchBuffer(Buffer.from('unknown'), {
            originalSha256: sha256(bytes),
            patchedSha256: crypto.createHash('sha256').update('never').digest('hex')
        })).toThrow(/unexpected input hash/i);

        const duplicate = controlledFixture({ duplicate: true }).bytes;
        expect(() => patchBuffer(duplicate, {
            originalSha256: sha256(duplicate),
            patchedSha256: crypto.createHash('sha256').update('never').digest('hex')
        })).toThrow(/exactly one verified watcher instruction/i);
    });

    it('publishes a fully verified file and removes its temporary file', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-patch-'));
        const target = path.join(root, 'typst.exe');
        const { bytes, patched } = controlledFixture();
        const options = { originalSha256: sha256(bytes), patchedSha256: sha256(patched) };
        try {
            fs.writeFileSync(target, bytes);
            const result = patchFile(target, options);
            expect(result).toMatchObject({ changed: true, sha256: options.patchedSha256 });
            expect(fs.readFileSync(target).equals(patched)).toBe(true);
            expect(fs.readdirSync(root)).toEqual(['typst.exe']);
            expect(patchFile(target, options)).toMatchObject({ changed: false, sha256: options.patchedSha256 });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

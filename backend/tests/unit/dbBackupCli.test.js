import path from 'path';
import fs from 'fs';
import os from 'os';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCliArgs, execDump } = require('../../../scripts/db-backup.js');

describe('database backup CLI', () => {
    it('keeps scheduled backups on the timestamped default', () => {
        expect(parseCliArgs([])).toEqual({});
    });

    it('accepts one exact absolute gzip output path for installer verification', () => {
        const output = path.resolve('initial.sql.gz');
        expect(parseCliArgs(['--output', output])).toEqual({ output });
    });

    it('rejects ambiguous or unsafe output arguments', () => {
        expect(() => parseCliArgs(['--output', 'relative.sql.gz'])).toThrow(/absolute/);
        expect(() => parseCliArgs(['--output', path.resolve('initial.sql')])).toThrow(/\.sql\.gz/);
        expect(() => parseCliArgs(['--unknown', 'x'])).toThrow(/Usage/);
    });

    it('streams dumps larger than child-process callback buffers', async () => {
        const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-backup-stream-')), 'dump.sql');
        await execDump(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], output, process.env);
        expect(fs.statSync(output).size).toBe(2 * 1024 * 1024);
    });
});

'use strict';
// Builds the real PosSpoolerPlatform.cs with its winspool/kernel32 P/Invoke declarations
// redirected to FakeWinspool. Every other line of the helper is compiled unchanged; the
// script asserts that. Uses the installer's own csc flags (scripts/build-installers.ps1).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = path.resolve(__dirname, '../../../windows-helper/PosSpoolerPlatform.cs');
const forward = {
    OpenPrinter: 'private static bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault) { return FakeWinspool.OpenPrinter(pPrinterName, out phPrinter); }',
    ClosePrinter: 'private static bool ClosePrinter(IntPtr hPrinter) { return FakeWinspool.ClosePrinter(hPrinter); }',
    StartDocPrinter: 'private static int StartDocPrinter(IntPtr hPrinter, int level, ref DOC_INFO_1 documentInfo) { return FakeWinspool.StartDocPrinter(hPrinter, documentInfo.pDocName, documentInfo.pDataType); }',
    EndDocPrinter: 'private static bool EndDocPrinter(IntPtr hPrinter) { return FakeWinspool.EndDocPrinter(hPrinter); }',
    AbortPrinter: 'private static bool AbortPrinter(IntPtr hPrinter) { return FakeWinspool.AbortPrinter(hPrinter); }',
    StartPagePrinter: 'private static bool StartPagePrinter(IntPtr hPrinter) { return FakeWinspool.StartPagePrinter(hPrinter); }',
    EndPagePrinter: 'private static bool EndPagePrinter(IntPtr hPrinter) { return FakeWinspool.EndPagePrinter(hPrinter); }',
    WritePrinter: 'private static bool WritePrinter(IntPtr hPrinter, byte[] buffer, int count, out int written) { return FakeWinspool.WritePrinter(hPrinter, buffer, count, out written); }',
    SetJob: 'private static bool SetJob(IntPtr hPrinter, int jobId, int level, IntPtr job, int command) { return FakeWinspool.SetJob(hPrinter, jobId, command); }',
    GetJob: 'private static bool GetJob(IntPtr hPrinter, int jobId, int level, IntPtr job, int bufferSize, out int needed) { return FakeWinspool.GetJob(hPrinter, jobId, job, bufferSize, out needed); }',
    GetPrinter: 'private static bool GetPrinter(IntPtr hPrinter, int level, IntPtr buffer, int bufferSize, out int needed) { return FakeWinspool.GetPrinter(hPrinter, buffer, bufferSize, out needed); }',
    FindFirstPrinterChangeNotification: 'private static IntPtr FindFirstPrinterChangeNotification(IntPtr hPrinter, int filter, int options, IntPtr notifyOptions) { return FakeWinspool.FindFirstChange(hPrinter); }',
    FindNextPrinterChangeNotification: 'private static bool FindNextPrinterChangeNotification(IntPtr changeHandle, out int change, IntPtr options, IntPtr notifyInfo) { return FakeWinspool.FindNextChange(changeHandle, out change); }',
    FindClosePrinterChangeNotification: 'private static bool FindClosePrinterChangeNotification(IntPtr changeHandle) { return FakeWinspool.FindCloseChange(changeHandle); }',
    WaitForSingleObject: 'private static uint WaitForSingleObject(IntPtr handle, uint milliseconds) { return FakeWinspool.Wait(handle, milliseconds); }',
    WaitForMultipleObjects: 'private static uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds) { return FakeWinspool.WaitMany(handles, milliseconds); }'
};

function build(outDir) {
    const variant = 'as-is';
    const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
    const output = [];
    const replaced = [];
    for (let index = 0; index < lines.length; index++) {
        const attribute = /^\s*\[DllImport\("(winspool\.drv|kernel32\.dll)"/.test(lines[index]);
        const extern = lines[index + 1]?.match(/^(\s*)private static extern \S+ (\w+)\(/);
        if (attribute && extern) {
            assert.ok(forward[extern[2]], `no forwarder for ${extern[2]}`);
            output.push(`${extern[1]}${forward[extern[2]]}`);
            replaced.push(extern[2]);
            index++;
            continue;
        }
        assert.ok(!/static extern/.test(lines[index]), `unhandled P/Invoke: ${lines[index]}`);
        output.push(lines[index]);
    }
    assert.deepEqual([...replaced].sort(), Object.keys(forward).sort());
    assert.equal(output.length, lines.length - replaced.length);
    const fakeSource = path.join(outDir, variant === 'as-is' ? 'PosSpoolerPlatform.fake.cs' : `PosSpoolerPlatform.fake.${variant}.cs`);
    fs.writeFileSync(fakeSource, output.join('\n'));
    const exe = path.join(outDir, variant === 'as-is' ? 'PosSpoolerPlatform-fake.exe' : `PosSpoolerPlatform-fake.${variant}.exe`);
    const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, '/r:System.Web.Extensions.dll', '/r:System.Security.dll',
        fakeSource, path.join(__dirname, 'FakeWinspool.cs')], { stdio: 'inherit' });
    return { exe, replaced: replaced.length, unchangedLines: output.length - replaced.length };
}

module.exports = { build };
if (require.main === module) console.log(build());

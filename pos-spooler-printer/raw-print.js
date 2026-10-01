'use strict';

// Sending raw ESC/POS bytes at a printer, for the diagnostic CLIs in this package.
//
// This exists because the same three faults were written twice. Both tools reached for
// `copy /B <file> \\127.0.0.1\NAME` through cmd.exe, and all three problems come from that
// one choice:
//
//   * \\127.0.0.1\NAME addresses a printer by its SHARE name, which is a different string
//     from the printer name and often nothing like it - one machine's "XP-80C (Copy 1)" is
//     shared as "cash". Passing the printer name fails with "The network name cannot be
//     found", which reads as though the printer were unplugged.
//   * The paths need shell quoting that has to be exactly right, and getting it wrong
//     reports "The filename, directory name, or volume label syntax is incorrect" - a
//     message that names nothing about quoting.
//   * It needs a temporary file, and both tools wrote it into __dirname. This package is
//     tracked deployable source, so a kill between the write and the unlink strands a
//     binary in the repository.
//
// Measured against a real share, a direct write to the UNC path succeeds and removes all
// three at once: no temporary file, no subprocess, and nothing that a name containing
// spaces or parentheses can break.

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');

// Accepts either the printer's name or its share name and reports which is which, so a
// caller can tell "not shared" and "no such printer" apart from a transport failure.
function resolveShareName(name) {
    return new Promise(resolve => {
        const quoted = String(name).replace(/'/g, "''");
        const script = "$ErrorActionPreference='SilentlyContinue';"
            + `$p = Get-Printer | Where-Object { $_.Name -eq '${quoted}' -or $_.ShareName -eq '${quoted}' } | Select-Object -First 1;`
            + "if ($p) { if ($p.Shared) { Write-Output ('SHARE:' + $p.ShareName) } else { Write-Output 'NOTSHARED' } } else { Write-Output 'NOTFOUND' }";
        execFile('powershell.exe', ['-NoProfile', '-Command', script], (error, stdout) => {
            if (error) return resolve({ kind: 'unknown' });
            const out = String(stdout).trim();
            if (out.startsWith('SHARE:')) return resolve({ kind: 'share', share: out.slice(6).trim() });
            if (out === 'NOTSHARED') return resolve({ kind: 'notshared' });
            if (out === 'NOTFOUND') return resolve({ kind: 'notfound' });
            resolve({ kind: 'unknown' });
        });
    });
}

async function sendWindows(printerName, buffer, { log = () => {} } = {}) {
    let target = printerName;
    const resolved = await resolveShareName(printerName);
    if (resolved.kind === 'share' && resolved.share && resolved.share !== printerName) {
        log(`  "${printerName}" is shared as "${resolved.share}" - sending there.`);
        target = resolved.share;
    } else if (resolved.kind === 'notshared') {
        throw new Error(`Printer "${printerName}" is not shared. The raw path needs a share name.\n`
            + 'Share it (Printer properties -> Sharing), then pass the share name.');
    } else if (resolved.kind === 'notfound') {
        throw new Error(`No printer or share named "${printerName}" on this machine.`);
    }
    fs.writeFileSync(`\\\\127.0.0.1\\${target}`, buffer);
}

function sendNetwork(ip, port, buffer, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.setTimeout(timeoutMs);
        client.on('error', error => { client.destroy(); reject(error); });
        client.on('timeout', () => { client.destroy(); reject(new Error(`TCP connection timeout to ${ip}:${port}`)); });
        client.connect(port, ip, () => client.write(buffer, () => { client.destroy(); resolve(); }));
    });
}

module.exports = { resolveShareName, sendWindows, sendNetwork };

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const INSTALL_SOURCE = read('deployment/windows/Install-Spooler.ps1');
const UPDATE_SOURCE = read('deployment/windows/Update-Spooler.ps1');

assert(INSTALL_SOURCE.includes('Configure-NssmService'), 'Install must configure the one NSSM service');
assert(INSTALL_SOURCE.includes('Assert-ExclusiveInstallService'), 'Install must reject duplicate service ownership');
assert(UPDATE_SOURCE.includes('Assert-OwnedService'), 'Update must verify exact service ownership');
assert(INSTALL_SOURCE.includes('[Threading.Mutex]::new'), 'Install must serialize service mutation');
assert(UPDATE_SOURCE.includes('[Threading.Mutex]::new'), 'Update must serialize service mutation');

for (const source of [INSTALL_SOURCE, UPDATE_SOURCE]) {
    assert(!source.includes('update-transaction.json'), 'Spooler install/update must not use a persistent transaction journal');
    assert(!source.includes('SpoolerTransactionJournal'), 'Spooler install/update must not use transaction helpers');
    assert(!source.includes('Repair-SpoolerStartup.ps1'), 'Spooler install/update must not delegate to boot-time recovery');
}

const stop = UPDATE_SOURCE.indexOf("$phase = 'stop spooler'");
const replace = UPDATE_SOURCE.indexOf("$phase = 'replace application'", stop);
const start = UPDATE_SOURCE.indexOf("$phase = 'start spooler'", replace);
assert(stop > -1 && replace > stop && start > replace, 'Update must stop, replace, then start');
assert(UPDATE_SOURCE.includes('Assert-EnvUnchanged'), 'Update must preserve spooler.env byte-for-byte');
assert(UPDATE_SOURCE.includes('Assert-SpoolerPayloadHash'), 'Update must reject a corrupt payload before stopping the service');
assert(UPDATE_SOURCE.includes('runtimeSha256'), 'Core updates must retain a minimal runtime compatibility marker');
assert(!UPDATE_SOURCE.includes('spooler-installed-layers.json'), 'Update must not use installed layer attestation');

console.log('installerUpdateContract tests passed');

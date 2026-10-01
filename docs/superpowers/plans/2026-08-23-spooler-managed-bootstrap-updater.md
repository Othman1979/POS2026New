# Managed spooler bootstrap and updater recovery plan

## Evidence and fixed decisions

- The field updater displayed only `Check ...\updater-error.txt`. Current source names `update-error.txt`, and `Update-Spooler.ps1` writes no result JSON for unexpected exceptions. The updater title (`1.2.9`) is therefore not enough to identify the built artifact or explain the failure.
- The lightweight copy installer currently runs the service from the extracted folder, stores `.env` there, omits the updater layer attestation, and treats `Running` as success. That layout cannot pass the packaged updater's Program Files, ProgramData, ownership, attestation, and fresh-sync gates.
- The packaged `Install-Spooler.ps1` already owns the correct service layout, ACLs, durable recovery journal, and registration proof. There must not be a second installer implementation.
- A configured `SPOOLER_ID` can currently differ from the station bound to an existing `agent.json`; a valid old token then keeps syncing the old station. New agents must send their configured station on every sync, and the server must reject a mismatch before claiming or settling work.
- Existing printer rows are customer routing data. This work will not rewrite them automatically. The already-landed admin station picker must be deployed separately and operators must deliberately assign existing printers.

## Task 1 - Make updater failures truthful

1. Add a focused contract test proving every caught updater failure writes a structured result once, including unexpected exceptions after rollback handling.
2. Make `Write-Result` track successful result emission. In the outer catch, write a `blocked_incomplete` result with phase, error, and log path only when no earlier result exists.
3. Make the Inno wrapper fall back to the actual updater log contents before showing a final generic message.
4. Run only `backend/tests/unit/installerUpdateContract.test.js` and commit.

## Task 2 - Replace the hand-copy service with a managed bootstrap

1. Rewrite the lightweight service script so the extracted folder is only input. It must:
   - require Windows x64 build 17763 or newer;
   - refuse to overwrite an existing service and give a precise one-time legacy removal instruction;
   - copy application/support files into an ACL-protected temporary ProgramData staging directory;
   - download the vendor-locked Node and NSSM archives with SHA-256 verification;
   - always run locked `npm ci` plus the browser setup in the fresh staging directory;
   - generate the format-2 runtime manifest and installed-layer attestation from the hydrated bytes;
   - pass an ACL-protected response file to the canonical `Install-Spooler.ps1`;
   - rely on that installer for Program Files, ProgramData, service ownership, recovery, and fresh-sync verification;
   - delete temporary secrets/staging and delete the source `.env` only after a verified install.
2. Keep start/stop/restart/status/uninstall as small service controls, but refuse uninstalling an unrecognized service.
3. Change the bundle builder to ship the canonical installer support files, vendor lock, manifest tool, and a generated application-root list. Do not ship Node, NSSM, dependencies, browser, or `.env`.
4. Rewrite the focused bootstrap contract tests and run only those tests plus a lightweight bundle build.
5. Commit.

## Task 3 - Bind every new-agent sync to its configured station

1. Add a client test proving `spooler_id` is sent on every sync.
2. Add a server integration test proving a mismatched submitted station returns `409 station_mismatch` before queue mutation; temporarily accept an omitted station for older deployed agents.
3. Implement the one-field client envelope and the pre-sync server comparison.
4. Run the spooler sync-runtime test and the focused backend integration file, then commit.

## Task 4 - Adversarial closeout

1. Attack these cases with focused checks: raw updater exception, duplicate result emission, missing `.env`, placeholder key, stale dependencies, tampered download, existing unknown service, source secret cleanup timing, station mismatch with pending work, and omitted station compatibility.
2. Update `docs/architecture.json` and regenerate/check its HTML for the managed-bootstrap and per-sync station boundary.
3. Confirm the worktree contains no generated runtime, dependency, browser, secret, or unrelated changes.
4. Report the exact field transition: uninstall the old hand-copy service once, run the new managed bootstrap, deliberately assign printers to the registered station, rebuild/redeploy the admin bundle, and use only rebuilt updater artifacts afterward.

## Non-goals

- No production deploy, push, database mutation, printer reassignment, or installer execution on a customer machine.
- No automatic adoption of an unknown Windows service. Failing closed is safer than deleting or repointing a service whose rollback cannot be proven.
- No duplicate bootstrap updater or alternate service layout.

# Lightweight managed spooler bootstrap

Use this bundle when copying the full spooler installer to a till is inconvenient.
It downloads the heavy runtime, but the final installation is identical to the
packaged installer and works with future spooler updaters.

## Build

```text
node scripts/build-spooler-bundle.js
```

The command writes `deployment/out/POSAPP-Spooler-Files.zip`. It refuses a dirty
worktree or a staged payload whose release commit is not the current `HEAD`; this
prevents an old helper/application from being repackaged under the current version.

The zip contains application code and the canonical installer support files. It
does not contain Node, NSSM, `node_modules`, Chromium, Typst, fonts, or `.env`.

## Fresh install

1. Extract the zip.
2. Put `.env` next to `server.js`. Use `.env.example` as the starting point and set
   `CLOUD_SERVER_URL`, `SPOOLER_KEY`, `SPOOLER_ID`, and `SPOOLER_NAME`.
3. Run `spooler-service\install.cmd`.

The bootstrap checks Windows x64 build 17763+, verifies the POS server, creates an
ACL-protected temporary payload, downloads the pinned Node, NSSM, Typst and font
artifacts with SHA-256 checks, runs locked `npm ci`, and
stamps the canonical payload and runtime hashes. It then calls the canonical installer.

Success means all of these are true:

- service code is under `C:\Program Files\POS-Spooler`;
- configuration, state, and logs are under protected `C:\ProgramData\POS-Spooler`;
- the service is owned by the expected NSSM/Node paths;
- the agent registered for the requested station and completed a fresh sync;
- future packaged core/runtime updaters can verify the installed layers.

After verification, the plaintext source `.env` and protected temporary payload are
removed. Supported beep and timeout overrides are retained in the protected config.

## One-time migration from the Aug 23 hand-copy service

The earlier copy-folder script ran directly from the extracted folder. The updater
correctly refuses that layout. Do not repoint or delete an unknown service silently.

If `install.cmd` reports that the existing service is not updater-managed:

1. In the folder that currently runs the spooler, run `spooler-service\uninstall.cmd`.
2. Confirm that it says configuration and state were preserved.
3. Run the new bundle's `spooler-service\install.cmd`.

The uninstall command acts only when the service executable and working directory
match either the current source folder or the canonical Program Files folder. It
refuses any other service ownership.

## Controls

`start.cmd`, `stop.cmd`, `restart.cmd`, and `status.cmd` operate only on a recognized
source or managed spooler service. After editing the installed
`C:\ProgramData\POS-Spooler\config\spooler.env`, run `refresh.cmd` to restart and prove
that the existing identity completed a new authenticated sync. If `CLOUD_SERVER_URL`
or `SPOOLER_ID` changed and the server rejects the old binding, first drain or
force-replace the old station in Admin, then run `rebind.cmd`. Rebind refuses while
the local journal contains unsettled jobs, retires rather than deletes `agent.json`,
and succeeds only after the new identity completes a fresh sync. `uninstall.cmd`
removes the service and startup ownership but preserves ProgramData configuration
and state.

The extracted folder is never a long-term application directory. Replacing files in
it does not update the managed service; use the packaged updater after installation.

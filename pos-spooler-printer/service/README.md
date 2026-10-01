# Copy-the-folder spooler service

Hand-install for a till when running `POSAPP-Spooler-Typst-Only-Setup.exe` is inconvenient.
In the repository checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-spooler-typst.ps1` first. Copy the complete `pos-spooler-printer\` folder, including its `.cache\typst\0.15.1\` runtime, to the machine. Put a real `.env` next to `server.js`,
then run `service\install.cmd` as an administrator (it elevates itself if you
forget).

The service installer downloads missing Node, NSSM, and npm dependencies on the till; it requires an internet connection for those files. The pinned Typst executable and fonts are prepared in the checkout and copied with the folder. No browser is installed.

## What it does

Registers **one** service, `POS Print Spooler`, running `server.js` under NSSM.
One is correct: `server.js` loads the V2 agent in-process and spawns the C#
platform helper as its own child, so a second "agent" service would start a
second agent against the same state directory and be rejected by the state-root
lock with `STATE_ROOT_LOCKED`.

- Node and NSSM land in `runtime\` next to `server.js`, verified by SHA-256
  against the same pins the packaged installer uses.
- State and logs go to `C:\ProgramData\POS-Spooler\`.
- Startup is automatic, so the till comes back on its own after a power cut.

## Commands

| Command         | What it does                                                 |
|-----------------|--------------------------------------------------------------|
| `install.cmd`   | Downloads Node/NSSM/dependencies, registers and starts service |
| `start.cmd`     | Starts the service                                            |
| `stop.cmd`      | Stops the service                                             |
| `restart.cmd`   | Stops then starts - use after editing `.env`                  |
| `status.cmd`    | Service state, the exact command it runs, last log lines      |
| `uninstall.cmd` | Removes the service; leaves the folder and ProgramData state  |

## If install fails

`status.cmd` prints the tail of `C:\ProgramData\POS-Spooler\logs\` and the exact
foreground command to reproduce the failure with the service's own environment.
Run that command in a console and the spooler will say what it is unhappy about.

The usual cause is `.env`: `CLOUD_SERVER_URL` and `SPOOLER_KEY` are mandatory
under `NODE_ENV=production`, and the service crash-loops without them.

## Relationship to `deployment\spooler-service\`

That one stages into `C:\Program Files\POS-Spooler` and hands off to the
canonical `Install-Spooler.ps1`, so it needs the `deployment\` support tree
beside it and produces a layout the packaged updaters can verify. This one is
standalone: it runs the spooler from the folder you copied and reaches nothing
outside `pos-spooler-printer\`. Use this when you want a folder you can copy
anywhere; use that one when the till should be updatable by the packaged updater.

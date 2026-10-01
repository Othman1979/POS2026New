# POS Windows Service kit

Runs the POS app (`server.js`, i.e. what `npm start` runs) as a **Windows service** so it
starts automatically on boot — even before anyone logs in — and restarts itself if it crashes.
Built on [NSSM](https://nssm.cc) (the service wrapper). All scripts are path‑independent: keep
this `service\` folder inside the project (`...\posapp\service\`).

## Prerequisites (on the restaurant server)

1. **Node.js installed** and on `PATH` (the same Node that runs `npm start`).
2. **MySQL running** (XAMPP). The app needs the database up.
3. The project's **`.env`** is configured for local use (DB user/pass/name, `PORT=3000`).
4. The database contains the managed `schema_migrations` baseline. The configured DB user
   must be able to create/alter schema objects during startup; the app still validates the
   exact schema before accepting traffic.
5. Internet on first install (to download `nssm.exe` once). No internet? Download NSSM
   manually and drop `win64\nssm.exe` into this folder, then install.

## Install (one time)

Right‑click **`install-pos-service.bat`** → **Run as administrator**.

That creates a service named **PosApp**, sets it to auto‑start, and starts it now.
Open the POS at `http://localhost:3000` (or `http://<server-LAN-IP>:3000` from other terminals).

> If MySQL runs as a Windows service (XAMPP can install it as `mysql`), open
> `install-pos-service.bat`, set `MYSQL_SERVICE=mysql` near the top before installing, so the
> POS waits for the database on boot.

## Daily control (Run as administrator)

| Action            | Script              | Also works |
|-------------------|---------------------|------------|
| Start             | `start-pos.bat`     | `net start PosApp` |
| Stop              | `stop-pos.bat`      | `net stop PosApp` |
| Restart           | `restart-pos.bat`   | |
| Status + logs     | `status-pos.bat`    | `services.msc` |
| Remove service    | `uninstall-pos-service.bat` | |

## Updating to a new version

Run **`update-pos.bat`** as administrator. It will:

1. **Stop** the service.
2. Pause so you can **copy the new files** in.
3. **Rebuild** the frontend (`npm run build`). If the build fails it leaves the service
   stopped (so it never serves a broken UI) and tells you.
4. **Start** the service again. Startup runs the ordered automatic migration chain and its
   additive schema reconciliation before opening the POS port.

The automatic repair may create missing known tables, columns, indexes, constraints, settings,
or permissions. It never deletes data or guesses how to resolve an incompatible definition.
After repair, strict schema validation still refuses startup if the database is unsafe or
ambiguous. If automatic migration cannot run, import
`deployment\database\hostinger-manual-migrations.sql` as the emergency fallback and inspect
`service\logs\pos-err.log` before restarting.

## No service, just run it

`run-pos-console.bat` runs the app in a console window (no install, no admin). Closing the
window stops it. Handy for a quick test or to read startup errors live.

## Logs

`service\logs\pos-out.log` and `pos-err.log` (auto‑rotated at ~10 MB).

## Notes

- The service runs `node server.js` directly (same as `npm start`) for clean start/stop signals.
- Stop is graceful: NSSM sends Ctrl‑C, `server.js` drains connections and closes the MySQL pool.
- This service runs **only the web app**. The thermal‑printer **spooler** is a separate app on
  the terminal that has the printer (`pos-spooler-printer\`); install/run it there separately.

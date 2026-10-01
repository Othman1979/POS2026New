# Spooler field install — what we shipped and what stopped it

**Date:** 2026-08-23
**Branch:** `master`, `f07163a2` → `3d569ab8`, seven commits, 22 files, +911 / −13
**Trigger:** a customer till would not accept the spooler installer
**Outcome:** the till is running; four defects found on the way, three of them latent in shipped code

This is the field record, written to be reviewed. The ordering is how it actually
happened, because the sequence is the interesting part: each fix uncovered the next
failure, and three of the four had been shipping for days without anyone noticing.

---

## Timeline

| # | Symptom at the till | Actual cause | Commit |
| --- | --- | --- | --- |
| 1 | "This program does not support the version of Windows your computer is running" | `MinVersion=10.0.19045` is Windows 10 **22H2**, not Windows 10 | `7215e1eb` |
| 2 | wanted a copy-a-folder install, the old `install.bat` was gone | removed for a good reason, but nothing replaced the convenience | `da8bd352`, `c509d3e1`, `eed14425` |
| 3 | "Failed to start service", no reason given | `dotenv` required but never declared — **shipped broken since Aug 19** | `b6ea8261`, `ecdb564e` |
| 4 | station registered, invisible on the Printers page | admin UI read `spoolers`; the API sends `stations` | `3d569ab8` |

---

## 1. The Windows version gate was four years stricter than the software

**Symptom.** Inno Setup's own rejection dialog. Not our Windows Server check — that
has its own message — so it was one of two lines in the `.iss`.

**The machine.** Windows 10 Enterprise LTSC 2019, version 1809, **build 17763**,
x64, Lenovo ThinkCentre, i3-4170. The licence literally reads "POS". Microsoft
supports it until January 2029.

**Cause.** `MinVersion=10.0.19045`. That is Windows 10 22H2 *specifically*. Windows
11 passes because it is build 22000+; every other Windows 10 is rejected. The commit
that introduced it was titled "gate installers to Windows 10 and 11 x64", and the
plan behind it said:

> "Supported installation target: Windows 10 22H2 (build 19045)... Reject older
> builds... instead of pretending they are supported."

Defensible intent — do not claim support you have not tested. But **the build we
test on became the minimum we allow**, and nobody noticed because every machine so
far happened to be 22H2 or 11.

**How the real floor was established.** Not from documentation — by reading the PE
headers and import tables of the binaries that actually ship:

| Component | Measured | On 17763 |
| --- | --- | --- |
| `node.exe` 22.23.0 | PE OS version **6.0**, 11 classic DLLs, 424 imports, zero `api-ms-win-*` sets | loads |
| `chrome-headless-shell` **146.0.7680.76** | PE OS version **10.0**, which 17763 satisfies; no post-1809 static imports | loads |
| C# helper | SHA256, FileStream, JavaScriptSerializer — .NET 3.5-era; 1809 ships 4.7.2 in-box | runs |
| VC++ redistributable | **not needed**, both binaries statically link the CRT | n/a |

A first scan flagged `GetProcessInformation` and `SetThreadInformation` as
post-1809. Both are Windows 8 APIs — false positives from an over-broad regex, and
worth recording because the same regex will produce the same false alarm next time.

**Fix.** Floor lowered to `10.0.17763` in both `.iss` files, the contract test that
asserts the directive, and the two smoke-test guards that run against an install
target. `run-update-sandbox.ps1` keeps its 19045 host guard — that gates the machine
hosting Windows Sandbox, which genuinely needs 1903+, and is a rig capability rather
than a support statement. The acceptance matrix gained a **1809 row marked PENDING**:
the change rests on static dependency evidence, not a physical install, and the
README says so.

**Rule.** *The configuration you test on is not the same statement as the minimum
you accept.* Write the floor from what the dependencies require, and record the
tested configuration separately.

---

## 2. Restoring the copy-a-folder install

`pos-spooler-printer/install.bat` used to make this one double-click. It was deleted
in `58052234` on 2026-08-19, and the reason matters:

> "It registered a **node-windows** service, which `Get-ServiceOwnerState` cannot
> recognise, so a station installed this way is invisible to the updater."

That is the *"Spooler service ownership is not exact"* failure that cost two days
earlier this week. The removal was right. But the convenience went with it and
nothing replaced it, which is why we were hand-assembling folders at a customer site.

**What was built.** `deployment/spooler-service/` — one PowerShell script plus six
`.cmd` wrappers (install / start / stop / restart / status / uninstall). It
registers through **NSSM with the packaged installer's exact layout**, so the updater
and `Test-SpoolerServiceOwnership.ps1` still recognise the service. Same convenience,
without the trap.

It bootstraps only what is missing:

- **Node** into the spooler's own `runtime\node`, not machine-wide, so upgrading or
  removing a system Node cannot break the spooler later. Better than the old
  `install.bat`, which installed an MSI system-wide.
- **NSSM** if neither the payload nor the folder carries the archive.
- **Dependencies** via `npm ci` against the lockfile, then the headless browser.

Both archives are **SHA-256 verified against `deployment/vendor-lock.json`** before
extraction. They are unpacked by an admin and then executed as SYSTEM; the old
`install.bat` downloaded an MSI and ran it unverified.

**The bundle.** `node scripts/build-spooler-bundle.js` produces a **98 KB** zip —
37 files, everything that cannot be downloaded and nothing that can. Against 765 MB
for the repo folder, most of which is a full Chrome under `.cache\puppeteer\chrome`
that the spooler never uses; it renders with `chrome-headless-shell`.

Two decisions in the bundler worth reviewing:

- The file list is `APPLICATION_ROOTS` from `deployment/tools/spooler-layer-manifest.js`
  — the same list the packaged update payload is built from. A second hardcoded list
  would go stale the first time a module is added, and a test asserts the bundler
  reads the shared list rather than copying it.
- It sources from the **staged payload**, not `pos-spooler-printer/`, because
  `bin\PosSpoolerPlatform.exe` is compiled during the installer build — the repo copy
  was already a day behind its own source — and the repo folder has no `release.json`.
  The bundler refuses to run if the staged helper is older than its `.cs`.

**Verified** by extracting the zip and installing from it: `npm ci` resolved 132
packages, `canvas` built its native binary, every entry point parsed, and
`.puppeteerrc.cjs` resolved the browser cache inside the unpacked folder.

---

## 3. The one that had been shipping broken for four days

**Symptom.** `Failed to start service 'POS Print Spooler'`. Nothing else.

**Cause.** `server.js:2` requires `dotenv`. **`dotenv` has never been in
`package.json` or the lockfile.** It is the only undeclared module — `puppeteer` and
`canvas` are both declared.

**Why nobody caught it.** Node walks parent directories looking for `node_modules`.
The staged payload sits at `…\posapp\deployment\out\stage\spooler`, so it resolved
`dotenv` from `C:\xampp\htdocs\posapp\node_modules` — **six levels up**, the server's
copy. Proven:

```
staged server.js resolves dotenv from:
    C:\xampp\htdocs\posapp\node_modules\dotenv\lib\main.js
```

Every build, every test and every check on the dev machine passed for that reason.
On a till there is no parent tree, and it dies at line 2.

**Blast radius.** `require('dotenv')` was added in `8cbeb5d6` on 2026-08-19. **Every
payload built since then ships a spooler that cannot start** — `POSAPP-Spooler-Setup.exe`
included. A core update does not touch `node_modules`, so it inherits whatever the
station already had, which also never contained dotenv. This was the first real field
install of 1.2.9, which is why it surfaced now and not in testing.

**Fix.** `dotenv@17.3.1` pinned, lockfile updated — exactly one entry, no deletions.
`spoolerPackageContract.test.js` now walks the spooler source, collects every bare
`require`, and fails when one is not a declared dependency. Verified it fails with
exactly this defect by removing the declaration again.

**A second, smaller defect surfaced in the same failure.** The service script had
`$ErrorActionPreference = 'Stop'`, so `Start-Service` **threw**, and the error-log
dump sitting on the very next line never ran. A failed install printed a PowerShell
stack trace and nothing about the cause. Fixed in `ecdb564e`: catch it, tail both
logs, print the exact foreground command to reproduce with the service's own
environment.

**Rules.**

- *A dev machine's parent `node_modules` will hide an undeclared dependency
  indefinitely.* Test module resolution somewhere without an ancestor tree, or assert
  the declaration.
- *Diagnostics must survive the failure they exist to explain.* An error handler
  downstream of a throwing call is not an error handler.

---

## 4. The station that registered and stayed invisible

**Symptom.** The agent connected with no errors, appeared on the print-queue panel,
and could not be selected on the Printers page — which offered only `primary`.

**Two false leads, both worth recording** because they cost time and both were
plausible:

1. *`SPOOLER_ID` is read once at startup and only transmitted at registration.*
   True, and a real design flaw: editing `.env` afterwards is a silent no-op, because
   `sync` carries only `x-agent-id` and the server reads the station from the
   database row. We deleted `agent.json` to force re-registration. Correct reasoning,
   did not fix it.
2. *NSSM lives in the spooler folder rather than ProgramData.* Correct by design —
   `Install-Spooler.ps1:107` does exactly the same. Install root holds the program;
   ProgramData holds state and logs.

**What settled it** was one command printing what the process actually sees:

```
SPOOLER_ID  = "main-cashier"
agent.json  CreationTime 8/23/2026 8:19:32 PM
SPOOLER_ENV_FILE=D:\spooler\.env
```

Env parsed, identity fresh, path right. The agent had registered correctly as
`main-cashier` all along. The bug was in the admin UI.

**Cause.** `Settings.vue:953` built the station dropdown from
`printQueueHealth.value.spoolers`. The health endpoint returns
`{ success, summary, recent, printers, spooler, stations }` — **there is no
`spoolers` key and there never has been.** So the array was always empty, the loop
never ran, and the dropdown could only ever contain its one hardcoded seed. Nothing
threw, because iterating an empty array is not an error.

A second bug sat behind it: even with data, it did `stations.set(station.id, …)`, and
stations carry `spooler_id`, not `id`.

**Why it mattered more than a missing dropdown entry.** `printers.spooler_id`
defaults to `'primary'`, so every printer created while the picker was broken is
bound to a station the agent does not serve — jobs queued for a station nobody polls.
That would have been the next mystery.

**Fix.** Iterate `stations`, key by `spooler_id`. The health query now also selects
`spooler_agents.name` so the picker can label by name and fall back to the id.
`printerStationPicker.spec.js` parses the keys out of the endpoint's own `res.json`
block and fails when the client reads one it does not send — rather than restating
the shape by hand, which is how it drifted.

**Rule.** *When a client reads a key off a response, something must tie it to the
response.* A typo in a property name is invisible: no error, no warning, just a
silently empty collection.

---

## What these four have in common

Three of the four were **silent**. The version gate produced a generic dialog with no
diagnosis, the missing dependency produced "Failed to start service", and the station
picker produced an empty dropdown. Only one — the missing `dotenv` — left a stack
trace, and our own script threw that away.

All four were **latent in shipped code**, not introduced this week. All four were
invisible on the development machine, for four different reasons: the dev box runs
22H2, has a parent `node_modules`, and had never exercised a second spooler station.

The through-line worth taking to the next piece of deployment work: **a development
machine is a poor oracle for a deployment defect.** Every one of these needed either
a real till or a deliberate check against the real artefact — PE imports, module
resolution without an ancestor tree, the endpoint's own response keys.

---

## State and what is still open

Seven commits on `master`, `f07163a2` → `3d569ab8`, **not pushed**. Installers were
rebuilt after the version-floor change; **they need rebuilding again** for the dotenv
fix, and the admin bundle needs deploying for the station picker.

Open items:

- **The 1809 acceptance row is PENDING.** Static evidence only; no packaged installer
  has been physically validated on 17763.
- **`npm run setup-browser` and service registration are unverified by us** — both
  ran for the first time on the customer's machine, not here.
- **Chrome 146 on Windows 1809 is still unproven.** `warm()` is never called at
  startup, so the browser does not launch until the first print job. The service
  starting tells us nothing about it. **Verify a real print on that till.**
- **`SPOOLER_NAME` is dead** — present in `.env.example`, read by nothing. The agent
  registers `name` from `SPOOLER_ID`. Remove the line so nobody sets it expecting a
  friendly label.
- **`SPOOLER_ID` changes are silently ignored after first registration.** Worth making
  the agent detect the mismatch at startup and either re-bind or fail loudly, instead
  of syncing along as the wrong station.
- **Any printer created before the picker fix is bound to `primary`.** Re-point them.
- **The `primary` station row from the first registration is orphaned.** Harmless,
  worth cleaning up server-side.
- **The pre-shared spooler key for that venue was pasted in plaintext during
  debugging.** Rotate it on the server and the tills.

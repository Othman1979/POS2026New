# POS Print Spooler

This directory is the deployable source of truth for the Windows print service. Runtime modules, installers, package manifests and tests are versioned together. Local secrets and generated files are excluded by the repository `.gitignore`.

## Local setup

1. Use Node.js 22.12 or newer (the installer bundles Node 22.23). Development may use `.env`; installed services use `C:\ProgramData\POS-Spooler\config\spooler.env` through `SPOOLER_ENV_FILE`. Preserve the station URL/key/identity and durable state when updating.
2. Run `npm ci` in this directory. From the repository root, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-spooler-typst.ps1` to prepare the pinned compiler and fonts.
3. Run `npm test`.
4. Start `node server.js` for interactive diagnosis. Packaged stations use the maintained installer/runtime updater. The [copy-the-folder service workflow](service/README.md) has its own installation layout.

Typst is the only document renderer. Receipts, kitchen tickets, X/Z, audit,
category/Y, daily reports and expense/cancellation slips render locally, without
HTML/CSS interpretation or a browser process. Cash-drawer jobs write their raw
five-byte pulse without starting the compiler. `SPOOLER_RENDERER` is retired;
old machine values cannot activate another renderer.

The runtime pins Typst 0.15.1, Noto Sans, Noto Sans Arabic and Noto Emoji under
`.cache/typst/0.15.1`. For a source checkout using an external prepared runtime,
set `SPOOLER_TYPST_EXE` and `SPOOLER_TYPST_FONT_DIR` in the process environment.
Normal receipts use one warm compiler. Long reports compile bounded sections,
assemble one durable artifact, and cut once after the complete document.

Use the runtime updater for installations containing the retired browser runtime.
It installs the sole `typst-only` profile while preserving ProgramData settings,
identity, jobs and recovery markers. There is no browser fallback or browser
runtime installation target. Do not remove or reset the journal to perform an update.
Drain the server print queue and each station's pending jobs before transitioning.
The updater blocks unresolved local work on a former browser station. Historical
custom HTML-only templates without `nativeLayout` cannot be reproduced by Typst;
they must finish before upgrading. Newly compiled custom templates carry their
native layout, and older built-in jobs can use their saved structured payload.

Windows printers use event-driven Winspool job completion with a bounded polling
watchdog. Set `SPOOLER_WINDOWS_DRAIN_STRATEGY=poll` to restore polling immediately
if a printer driver does not deliver job-change notifications; restart the spooler
service after changing the setting.

Never commit `.env`, certificates, private keys, archives, `.cache` or `node_modules`.

## Deployment

Deploy through the maintained installer/runtime-update workflow so the pinned Typst runtime travels with the tracked application. Preserve the machine's existing ProgramData configuration/state, run `npm test`, restart the `POS Print Spooler` service and confirm its version and printer status in the admin print queue.

Receipt payloads containing `receipt_display_v1` print backend-computed rows and totals. Old queued payloads use their saved structured data for native rendering. A present malformed v1 payload fails closed instead of printing recomputed money.

Physical printer acceptance remains mandatory; follow `docs/printing-runbook.md` after automated checks pass.

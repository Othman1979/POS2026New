# Owned POS Spooler — Strict Execution Prompt

Own `pos-spooler-printer/` as a normal, deployable, reviewable part of this repository. Repair the missing receipt-presentation integration and spooler HTML safety without introducing a framework, a second renderer, or a manual patch workflow.

## Evidence that must remain true

- The backend already emits validated `receipt_display_v1` payloads from checkout, print, order and table paths.
- The tracked physical spooler currently ignores that model and recomputes receipt money through `receiptItemDisplayTotal()`.
- `spooler-shared/receiptDisplayV1.cjs` is tested but is not present beside the deployed `server.js`.
- The old patch is obsolete: applying it to the current server would duplicate the existing `escapeHtml` declaration.
- The blanket `.gitignore` rule hides runtime dependencies, package manifests, installers and tests required by a clean spooler checkout.
- Local `.env`, private keys, certificates, archives, caches and `node_modules` are machine state and must never be committed.
- `sanitizePrintString()` currently removes newlines as control characters, collapsing multiline receipt and kitchen notes.

## Non-negotiable scope

1. Replace the blanket spooler ignore with explicit machine-only exclusions.
2. Track the spooler's package manifests, installers, runtime modules, safe configuration template and all existing tests.
3. Keep exactly one canonical receipt-v1 renderer, deployed beside `server.js`; remove the obsolete shared copy and patch.
4. Wire `receipt_display_v1` into physical receipt items and totals. If the property is present but invalid, fail closed. If absent, preserve the legacy fallback for old queued jobs.
5. Escape all dynamic receipt and kitchen text, including the legacy fallback. Harden Puppeteer so injected markup cannot execute or make network requests.
6. Preserve CR/LF/TAB formatting in printable notes while continuing to strip ESC/POS and other dangerous control bytes.
7. Make `npm test` inside `pos-spooler-printer/` run every spooler test and syntax-check `server.js`.
8. Update deployment documentation to copy the tracked spooler directory, install with the lockfile, retain each machine's `.env`, restart, and run physical verification.

## Design constraints

- Ponytail full: reuse `escapeHtml`; no dependencies, controllers, factories, page objects or generic renderer framework.
- No broad backend, POS UI, money-model or printer-routing refactor.
- Do not delete or expose any local secret.
- Do not apply the historical patch to production code.
- Do not weaken legacy compatibility or split-tender printing.
- Tests must fail for the missing behavior before production edits and pass afterward.
- A source-wiring contract is acceptable for the hardware-coupled server, but renderer behavior must execute real functions.

## Required adversarial checks

- V1 rows and summary override contradictory legacy money.
- Malformed present v1 is rejected rather than silently falling back.
- Absent v1 still uses the legacy path.
- `<`, `>`, `&`, quotes and script/image markup print as text in receipt, kitchen and report fields.
- Multiline notes retain line boundaries; ESC, GS, NUL and DEL are removed.
- Split Cash/Card fields remain present.
- Every relative runtime import resolves inside the tracked spooler package.
- `git ls-files pos-spooler-printer` includes source, manifests, installers and tests but excludes `.env`, keys, certificates, archives, caches and dependencies.
- The deployable package passes `npm test`, focused backend receipt/print tests, syntax validation and a headless Puppeteer smoke test.

## Completion standard

Finish only when the repository contains one owned spooler implementation, the stale patch path is gone, automated checks exercise the actual wiring, documentation matches the checked-in package, no secret is staged, and remaining physical-printer verification is stated honestly rather than claimed.

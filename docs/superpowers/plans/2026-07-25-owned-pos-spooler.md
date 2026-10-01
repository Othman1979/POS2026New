# Owned POS Spooler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the physical POS spooler a fully tracked deployable program and complete the missing receipt-v1, HTML-safety and printable-note contracts.

**Architecture:** `pos-spooler-printer/` becomes the deployable source of truth. Its existing monolithic hardware process remains intact; one standalone `receiptDisplayV1.cjs` owns validated receipt rows and totals, while the existing `report-html.js` continues to own shared HTML escaping and report fragments. Legacy receipt payloads remain supported, but new payloads use backend-computed presentation money.

**Tech Stack:** Node.js CommonJS, Puppeteer, ESC/POS, Socket.IO client, Node `assert`, Vitest source contracts, npm lockfile.

## Global Constraints

- Work inline on `master`; do not create a worktree.
- Use Ponytail full and add no dependency or framework.
- Never track `.env`, keys, certificates, archives, caches or `node_modules`.
- Preserve printer routing, durable queue identity, alerts, split tender and old queued-job compatibility.
- Use red-green tests before production behavior changes.

---

### Task 1: Define the tracked deployment boundary

**Files:**
- Modify: `.gitignore`
- Create: `pos-spooler-printer/.env.example`
- Modify: `pos-spooler-printer/package.json`
- Track existing: `pos-spooler-printer/package-lock.json`, installers, runtime helpers and tests
- Test: `backend/tests/unit/spoolerPackageContract.test.js`

**Interfaces:**
- Consumes: the relative `require('./...')` imports in `server.js`.
- Produces: a clean-clone spooler package whose runtime imports and npm scripts resolve locally.

- [ ] Add a failing package contract that requires manifests, runtime helpers, installers, configuration template and tests to exist, and rejects secret/artifact paths.
- [ ] Run the contract and confirm it fails because ignored files and `.env.example` are absent from the tracked boundary.
- [ ] Replace the blanket ignore with explicit spooler machine-state exclusions and add the safe environment template.
- [ ] Set package scripts to run `node --check server.js` and all `tests/*.test.js` files using Node only.
- [ ] Run the contract and spooler baseline tests.

### Task 2: Make receipt v1 deployable and wire the physical server

**Files:**
- Move: `spooler-shared/receiptDisplayV1.cjs` to `pos-spooler-printer/receiptDisplayV1.cjs`
- Delete: `spooler-shared/pos-spooler-server-receipt-v1.patch`
- Modify: `pos-spooler-printer/server.js`
- Modify: `backend/tests/unit/spoolerReceiptDisplay.test.js`

**Interfaces:**
- Consumes: `data.receipt_display_v1` and the renderer's `renderReceiptItems(model)` / `renderReceiptSummary(model)` functions.
- Produces: v1-first physical receipt rendering with absent-only legacy fallback.

- [ ] Add failing assertions that the deployed server imports the local renderer and selects it in both items and totals blocks.
- [ ] Confirm the test fails against the legacy-only server.
- [ ] Move the canonical renderer beside the server and update test imports.
- [ ] Add the two minimal `receipt_display_v1 !== undefined` branches while preserving the existing legacy blocks unchanged beneath `else`.
- [ ] Confirm malformed present v1 fails closed through the real renderer and split tender remains wired.

### Task 3: Close printable HTML injection paths

**Files:**
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/report-html.test.js`
- Modify: `backend/tests/unit/spoolerReceiptDisplay.test.js`

**Interfaces:**
- Consumes: the existing `escapeHtml(value)` exported from `report-html.js`.
- Produces: escaped dynamic receipt/kitchen/report text and a non-executable, network-isolated Puppeteer document.

- [ ] Add failing source and renderer checks for raw receipt header/meta/customer/footer, legacy item/note, normal kitchen item/note, and audit identity interpolation.
- [ ] Confirm the security checks fail on representative dangerous markup.
- [ ] Wrap dynamic text with `escapeHtml` without escaping trusted HTML fragments or numeric formatting.
- [ ] Disable JavaScript and abort page network requests before `setContent`; use `domcontentloaded`.
- [ ] Remove Chromium's explicit no-sandbox flags and run a real headless smoke launch.
- [ ] Re-run receipt, report, split-tender and syntax tests.

### Task 4: Preserve safe multiline print notes

**Files:**
- Modify: `backend/tests/unit/printText.test.js`
- Modify: `backend/services/printText.js`

**Interfaces:**
- Consumes: arbitrary printable string input.
- Produces: `sanitizePrintString(value, maxLen)` preserving `\r`, `\n` and `\t` while removing other C0 controls, ESC, GS and DEL.

- [ ] Change the test first to require multiline/tab preservation and dangerous control removal.
- [ ] Confirm it fails because the current regex collapses line boundaries.
- [ ] Narrow the control-byte regex to exclude TAB, LF and CR.
- [ ] Re-run print sanitization plus receipt/kitchen routing tests.

### Task 5: Replace obsolete rollout instructions

**Files:**
- Modify: `docs/printing-runbook.md`
- Modify: `docs/SPOOLER-CHANGES.md`
- Modify: `README.md` only if it links the obsolete deployment process

**Interfaces:**
- Consumes: the tracked `pos-spooler-printer/` package.
- Produces: one deployment procedure with no patch application or hidden source files.

- [ ] Remove claims that the spooler source is git-ignored and remove patch/copy instructions for the deleted shared renderer.
- [ ] Document preserving `.env`, deploying the tracked directory, running `npm ci`, restarting the service and verifying the reported version.
- [ ] Keep the six physical scenarios and mark them pending until actually printed.
- [ ] Search the repository for stale patch names, ignored-spooler claims and obsolete shared renderer paths; correct every operational reference.

### Task 6: Verify and commit the owned spooler

**Files:**
- Review all changed and newly tracked spooler files.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: one reviewable commit with a deployable spooler and explicit physical-test caveat.

- [ ] Run `npm test` inside `pos-spooler-printer/`.
- [ ] Run focused Vitest receipt, print-text, print authorization/queue and spooler ownership suites.
- [ ] Run a Puppeteer HTML-injection smoke test with JavaScript and network disabled.
- [ ] Run `npm run build` only if shared application code or package configuration requires it.
- [ ] Run `git diff --check`, inspect all staged paths, and prove secrets/artifacts remain ignored.
- [ ] Run Ponytail and security self-review; remove duplication and stale patch artifacts.
- [ ] Commit with a message naming the root cause: the deployable spooler was partially ignored and receipt v1 was never wired.

## Self-review

- Scope coverage: tracking, runtime completeness, receipt v1, fallback, escaping, notes, tests and deployment are each owned by a task.
- Placeholders: none; physical tests remain explicitly pending because hardware cannot be fabricated by automation.
- Type consistency: the renderer retains its current CommonJS API and the backend `receipt_display_v1` schema remains unchanged.

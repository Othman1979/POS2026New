# Dependency Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every currently reported npm vulnerability from the POS application and tracked spooler without changing application behavior or launching a broad dependency upgrade.

**Architecture:** Keep existing direct application and spooler interfaces intact. Resolve `socket.io-parser`, `nanoid`, `dompurify`, and `js-yaml` through the patch versions already allowed by their parents, and replace only the abandoned npm-registry `xlsx@0.18.5` package with SheetJS's official `0.20.3` tarball. Treat the two package lockfiles as the deployment authority and verify the real catalog-import, Socket.IO/spooler, production-build, and reproducible-install paths.

**Tech Stack:** Node.js 22 deployment runtime, npm lockfiles, Vue/Vite, Express/Socket.IO, SheetJS, Vitest, tracked POS spooler.

## Global Constraints

- Ponytail full: make the smallest dependency-only change that clears the confirmed advisories.
- Use test-first RED/GREEN evidence: the initial `npm audit` failures are the RED contract; both audits reporting zero are GREEN.
- Do not change runtime JavaScript/Vue behavior unless an existing compatibility test proves the secure dependency requires a minimal adaptation.
- Do not add an abstraction, security wrapper, audit framework, override block, or new dependency manager.
- Do not upgrade Vite, Puppeteer, Socket.IO, html2pdf.js, jsPDF, Vue, or other direct packages to a new major version.
- Keep POS server `1.0.2` and spooler `1.2.2` unchanged in this phase; installer rebuilding/versioning is a separate release action.
- Do not touch database schema, migrations, migration runner, permission ownership, refund ownership, JoFotara, receipts, installers, or business workflows.
- Use the official SheetJS distribution URL exactly: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. SheetJS documents the public npm package as stale and this URL as the authoritative Node package source.
- Preserve both committed lockfiles and prove clean installation with `npm ci` in each package.
- Work on `codex/dependency-security-hardening`; commit but do not merge or push.

---

### Task 1: Resolve the six confirmed dependency advisories and verify behavior

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify only if npm's safe patch resolution requires it: `pos-spooler-printer/package.json`
- Modify: `pos-spooler-printer/package-lock.json`
- Test: existing catalog, Socket.IO, spooler, installer-contract, and build checks listed below

**Interfaces:**
- Consumes: current `xlsx` imports in `src/admin/components/ImportModal.vue` and `backend/routes/admin/import.js`; current Socket.IO client/server interfaces; current spooler package entry point.
- Produces: the same `xlsx` module name and APIs, the same Socket.IO interfaces, and reproducible lockfiles with zero npm-audit findings.

- [ ] **Step 1: Record RED security evidence before editing dependencies**

Run from the repository root:

```powershell
npm audit
npm --prefix pos-spooler-printer audit
```

Expected RED:

- Root exits non-zero with four findings: `socket.io-parser` high, `nanoid` high, `xlsx` high, and `dompurify` moderate.
- Spooler exits non-zero with two high findings: `socket.io-parser` and `js-yaml`.

- [ ] **Step 2: Install the authoritative SheetJS package and safe transitive patches**

Run:

```powershell
npm install --save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
npm audit fix
npm --prefix pos-spooler-printer audit fix
```

Then inspect the diff before continuing:

```powershell
git diff -- package.json package-lock.json pos-spooler-printer/package.json pos-spooler-printer/package-lock.json
```

Required result:

- `package.json` records `xlsx` using the exact official URL.
- Root lock resolves secure `xlsx@0.20.3`, `socket.io-parser@4.2.7` or newer compatible 4.x, `nanoid@3.3.17` or newer compatible 3.x, and a patched `dompurify` version.
- Spooler lock resolves `socket.io-parser@4.2.7` or newer compatible 4.x and a patched `js-yaml` version.
- No unrelated direct dependency or major version changes.
- If npm proposes a semver-major direct upgrade or modifies unrelated direct dependencies, revert that unrelated part and resolve only the named vulnerable transitive package within its existing parent range.

- [ ] **Step 3: Verify GREEN security evidence and reproducible installs**

Run:

```powershell
npm audit
npm --prefix pos-spooler-printer audit
npm ci
npm --prefix pos-spooler-printer ci
npm audit
npm --prefix pos-spooler-printer audit
```

Expected GREEN: all four commands report zero vulnerabilities and both `npm ci` commands succeed using only the committed manifests and lockfiles.

- [ ] **Step 4: Verify the real affected workflows**

Run:

```powershell
npx vitest run src/admin/components/__tests__/importModal.spec.js backend/tests/integration/products.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/unit/frontendRuntimePaths.test.js backend/tests/unit/installerPackageContract.test.js
npm --prefix pos-spooler-printer test
npm run build
```

Expected:

- Catalog template parsing, legacy workbook mapping, replacement imports, and rollback cases pass with SheetJS `0.20.3`.
- Server/spooler communication and frontend runtime-path contracts pass with the patched Socket.IO parser.
- The tracked spooler suite passes with patched Socket.IO parser and `js-yaml`.
- The production Vite build succeeds with patched DOMPurify/nanoid and SheetJS.

- [ ] **Step 5: Review scope and commit**

Run:

```powershell
git diff --check
git status --short
```

Confirm only the plan and four package manifest/lockfile surfaces changed, except for a narrowly proven compatibility adjustment if Step 4 exposed one. Commit:

```powershell
git add docs/superpowers/plans/2026-08-10-dependency-security-hardening.md package.json package-lock.json pos-spooler-printer/package.json pos-spooler-printer/package-lock.json
git commit -m "fix: resolve POS dependency advisories"
```

If `pos-spooler-printer/package.json` is unchanged, omit it from `git add`.

## Self-Review

- Spec coverage: all six current audit findings are explicitly resolved; actual import, socket, spooler, installer-package, clean-install, and production-build paths are verified.
- Scope: migration safety and backend/database ownership remain separate future phases; the already-completed nine-FK authority repair is not repeated.
- Ponytail: no custom audit runner, override hierarchy, framework migration, or speculative runtime guard is added.
- Placeholder scan: no TODO/TBD or unspecified implementation step remains.
- Type/interface consistency: `xlsx` remains importable as `xlsx`; Socket.IO and spooler callers retain their current interfaces.

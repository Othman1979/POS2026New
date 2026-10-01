# Frontend HTTP Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated immediate frontend fetch-and-JSON mechanics through the existing native HTTP seam without refactoring pages or changing request, response, status, or error behavior.

**Architecture:** Keep `fetchJson()` as the data-only primitive and add one `fetchJsonResponse()` companion for callers that immediately parse JSON but still inspect the native `Response`. Migrate call sites in place and retain native `fetch()` for conditional parsing, non-JSON bodies, ignored responses, and the existing specialized order-session owner.

**Tech Stack:** Vue 3, JavaScript, native Fetch API, Vitest, Vite.

## Global Constraints

- Use ponytail full: one companion helper, no production file proliferation.
- No page/component decomposition and no state-ownership refactor.
- No endpoint, option, response-shape, sequencing, message, or error-policy changes.
- No dependency, TypeScript, backend production, schema, template, styling, or package changes. Narrow test-only assertion updates are allowed when they pin the migrated request primitive.
- Preserve all semantically justified native `fetch()` calls.
- The four recorded baseline static-test failures are unrelated and must not increase.

---

### Task 1: Pin the shared HTTP contracts

**Files:**
- Modify: `src/shared/http.js`
- Modify: `src/shared/__tests__/http.spec.js`

**Interfaces:**
- Produces: `fetchJson(resource, options) -> Promise<any>` with its existing contract.
- Produces: `fetchJsonResponse(resource, options) -> Promise<{ response: Response, data: any }>`.

- [x] **Step 1: Add failing tests**

Add tests proving that `fetchJsonResponse()` forwards arguments, returns the exact response alongside parsed data, does not reject solely because `response.ok` is false, and propagates JSON failure unchanged. Extend the existing `fetchJson()` test to use a response with `ok: false` and prove data still resolves.

- [x] **Step 2: Run the focused test and confirm the new export is missing**

Run:

```powershell
npx vitest run src/shared/__tests__/http.spec.js
```

Expected before implementation: failure because `fetchJsonResponse` is not exported.

- [x] **Step 3: Implement the minimum helper**

Use exactly this behavior:

```js
export async function fetchJsonResponse(resource, options) {
    const response = await fetch(resource, options);
    const data = await response.json();
    return { response, data };
}

export async function fetchJson(resource, options) {
    const { data } = await fetchJsonResponse(resource, options);
    return data;
}
```

- [x] **Step 4: Run the focused test**

Run the same Vitest command. Expected: all HTTP helper tests pass.

### Task 2: Migrate proven data-only JSON calls

**Files:**
- Modify existing runtime callers under `src/shared`, `src/utils`, `src/router.js`, `src/menu`, `src/components`, `src/pos`, and `src/admin` identified in the evidence inventory.
- Modify source-contract tests only where they intentionally pin a migrated request primitive.

**Interfaces:**
- Consumes: `fetchJson(resource, options)`.
- Produces: unchanged feature behavior with one fewer local response variable per data-only request.

- [x] **Step 1: Replace immediate data-only pairs**

For each proven pair:

```js
const response = await fetch(resource, options);
const data = await response.json();
```

where `response` has no later use, write:

```js
const data = await fetchJson(resource, options);
```

Preserve the original parsed-data variable name.

- [x] **Step 2: Replace the two promise chains**

Replace only `.then(response => response.json())` with a `fetchJson()` call while preserving the existing `.finally()`, pending-request ownership, and downstream data behavior.

- [x] **Step 3: Add or merge imports without reordering unrelated code**

Import from `@/shared/http.js`. Do not create re-export barrels or API modules.

- [x] **Step 4: Inspect feature tests that pin raw request source**

Update only expectations whose implementation primitive intentionally changed. Do not loosen endpoint, method, body, signal, or response-behavior assertions.

### Task 3: Migrate immediate response-aware JSON pairs

**Files:**
- Modify the response-aware callers identified in evidence, including category copy/price list/import, thermal printing, JoFotara operations, refund reports, order-note mutations, product mutations, terminal printing, expense flows, and any equivalent immediate pair confirmed during execution.

**Interfaces:**
- Consumes: `fetchJsonResponse(resource, options)`.
- Produces: the same local response and data variables used by existing status and payload checks.

- [x] **Step 1: Replace each immediate response-aware pair**

Use destructuring aliases so downstream code is unchanged:

```js
const { response, data } = await fetchJsonResponse(resource, options);
```

or:

```js
const { response: res, data } = await fetchJsonResponse(resource, options);
```

Do not migrate a call if it checks status before parsing.

- [x] **Step 2: Re-scan direct calls**

Run:

```powershell
rg -n "\bfetch\s*\(" src -g "*.js" -g "*.vue" -g "!**/__tests__/**" -g "!*.spec.js"
```

Read every remaining call and record why it remains native. Do not chase a zero count.

### Task 4: Focused verification and adversarial review

**Files:**
- Modify production code only if review finds a real migration defect.
- Update: `docs/superpowers/evidence/2026-07-24-frontend-http-consistency.md` with final counts and verification.

- [x] **Step 1: Run focused tests**

Run the HTTP helper test plus every existing frontend/source-contract test covering changed request owners. Include the admin subscription and JoFotara request tests, POS request-owner tests, authentication hydration tests, and affected modal/page tests discovered by `rg`.

- [x] **Step 2: Run static scope checks**

Confirm:

```powershell
git diff --check
git diff -- package.json package-lock.json backend -- ':!backend/tests/**'
rg -n "\bfetch\s*\(" src -g "*.js" -g "*.vue" -g "!**/__tests__/**" -g "!*.spec.js"
```

Expected: no whitespace errors; no package/backend-production diff; every remaining direct call belongs to a documented exclusion.

- [x] **Step 3: Build production assets**

Run:

```powershell
npm run build
```

Expected: successful production build.

- [x] **Step 4: Run the full unit suite once**

Run:

```powershell
npm run test:unit
```

Expected: no new failures beyond the four recorded stale static assertions. If any changed HTTP owner fails, fix it before proceeding.

- [x] **Step 5: Review the diff manually**

For every changed request verify URL, method, headers, body, signal, cache mode, parse timing, response checks, catch path, and local return behavior. Reject any page refactor or new abstraction beyond the two shared helpers.

### Task 5: Commit rollback-sized deliverables

- [x] **Step 1: Commit the helper contract**

```powershell
git add src/shared/http.js src/shared/__tests__/http.spec.js
git commit -m "refactor: preserve native JSON response access"
```

- [x] **Step 2: Commit the call-site migration and evidence**

Stage only the scoped frontend callers, adjusted tests, prompt, plan, and evidence.

```powershell
git commit -m "refactor: standardize frontend JSON requests"
```

- [x] **Step 3: Confirm branch cleanliness and commit scope**

Run `git status --short`, `git log --oneline master..HEAD`, and `git diff --stat master...HEAD`.

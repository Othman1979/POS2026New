# Frontend HTTP Consistency — Strict Execution Prompt

You own a behavior-preserving frontend HTTP consistency migration in the POS repository. Treat the evidence record and implementation plan as contracts, not suggestions.

## Mission

Route every proven immediate `fetch() -> response.json()` duplication through `src/shared/http.js`, while leaving semantic special cases on native `fetch()`. Improve consistency without refactoring pages, inventing feature API layers, or changing error behavior.

## Mandatory reasoning loop

For every call site:

1. Read the complete enclosing function.
2. Confirm whether JSON is parsed immediately and unconditionally.
3. If only parsed data is used, replace the pair with `fetchJson()`.
4. If both parsed data and the `Response` are used after immediate parsing, replace the pair with `fetchJsonResponse()` and preserve the local variable names through destructuring aliases.
5. If parsing is conditional, response content is not JSON, or the body is intentionally ignored, keep native `fetch()`.
6. Compare URL, options, signal, request order, error path, and returned value before moving on.

## Hard scope limits

- Do not split or shorten Vue pages.
- Do not create per-page, per-feature, or per-endpoint API files.
- Do not move state or methods between components/composables.
- Do not add TypeScript, dependencies, interceptors, retries, timeouts, authentication injection, automatic headers, caching, logging, or error classes.
- Do not make `fetchJson()` throw on `!response.ok`.
- Do not convert text/XML, blob, fire-and-forget, logout, idle ping, conditional-parse, or tolerant-parse requests.
- Do not touch backend production code, endpoint shapes, package manifests, CSS, templates, or database files. Narrow test-only assertion updates are permitted when a test pins the migrated request primitive.
- Do not fix unrelated baseline static tests.

## Ponytail gate

One existing file may grow by one small helper. No new production file is allowed. If a proposed abstraction needs configuration or more than `{ response, data }`, reject it. A remaining native `fetch()` is correct when semantics require it; zero raw calls is not the goal.

## Verification discipline

- Add direct unit coverage for the companion helper and the unchanged non-throwing status behavior.
- Run tests that inspect changed source files and all HTTP helper tests.
- Run the production build.
- Run the full unit suite once and compare failures to the recorded four-test baseline.
- Use `git diff --check`, inspect every remaining runtime `fetch()`, and verify package/backend negative scope checks.
- Never claim completion from counts alone; manually inspect the final diff and remaining calls.

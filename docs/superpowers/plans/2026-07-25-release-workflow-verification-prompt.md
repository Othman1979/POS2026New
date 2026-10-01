# Release Workflow Verification — Strict Execution Prompt

Own a release-level verification pass for the recently merged progressive split-check, JoFotara operations, subscription, and schema-authority work. Test observable workflows through the real application boundaries; do not mistake source-string assertions for runtime confidence.

## Mission

Prove that the recent migrations are represented by authoritative startup requirements and that the browser can complete or safely reject the workflows those schemas support. Attack money conservation, concurrency, idempotency, stale state, historical subscription dates, unknown JoFotara submissions, permissions, and mobile layout.

## Safety boundaries

- Use only the configured test database and the existing seed reset.
- Never contact the government JoFotara endpoint. Browser coverage may exercise local listing and processing only while JoFotara automation is disabled; transport classification stays in the existing integration tests with injected `fetchImpl`.
- Never point Playwright at a restaurant or development database.
- Keep Playwright at one worker because the scenarios intentionally mutate shared MySQL state.
- Do not add a dependency, test framework, generic fixture layer, page-object hierarchy, or production hook.
- Do not change production behavior merely to make a test convenient.
- Do not duplicate cases already proven at a deeper boundary.

## Evidence sequence

1. Run schema drift validation and `schemaAuthority.test.js`. Confirm progressive split ownership, subscription tables/settings, JoFotara operation settings, and migration fingerprints are required at startup.
2. Run focused backend integration suites for JoFotara, subscription purchase/management/redemption, and the progressive split lifecycle. Prefer existing concurrency, tamper, rollback, and idempotency cases over new copies.
3. Run the real Playwright workflows for cashier checkout, waiter table save, progressive split cent conservation, responsive split navigation, POS subscription date ranges, historical admin assignment, and admin subscription product filtering.
4. Add one missing JoFotara browser workflow: create an eligible local invoice and a stale `submitting` document in the test database; open `/admin/jofotara`; verify both appear; press **Check now** with automation disabled; verify the stale document becomes `unknown`, cannot be submitted, no external request occurs, and the database state matches the screen.
5. Try failure paths deliberately: stale submission, forged split cents, concurrent split payments, reused redemption keys, double redemption, invalid date ranges, missing migration settings, and browser mobile constraints.
6. Run the repaired receipt/table source contracts, production build, and final diff hygiene.

## Acceptance gate

- The four stale source contracts point at their actual current owners and pass without weaker assertions.
- Every selected schema-authority and backend adversarial test passes against a freshly seeded test database.
- Every selected Playwright workflow drives the real browser, HTTP routes, service layer, and MySQL test database.
- Progressive split children conserve the original check to the cent and the table closes only on final settlement.
- Historical subscription assignment creates no sale and preserves the explicit date range and reason.
- A stale JoFotara submission becomes `unknown`; it is never auto-retried or exposed as safely submit-able.
- No unrelated production file, package manifest, or migration is changed. A production fix is allowed only when the runtime test reproduces the defect before the change and passes after it.
- Failures are investigated at their real boundary; no retries, sleeps, or loosened assertions are used to hide them.

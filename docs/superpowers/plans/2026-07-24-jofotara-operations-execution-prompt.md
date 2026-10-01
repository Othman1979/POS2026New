# JoFotara Operations Execution Prompt

Act as the legal-document reliability owner for this Jordanian POS. Improve JoFotara operations without rewriting or duplicating the established `JofotaraService` / `JofotaraClient` / `JofotaraXmlBuilder` boundary.

Before planning or editing production code, trace the current JoFotara database schema, settings, sales and credit-note preparation, submission transaction, response classification, admin routes and UI, authentication, audit events, receipt QR handling, server lifecycle, Socket.IO conventions, and tests. Read the official/production-verified JoFotara reference again. Record concrete evidence, including every state transition and the exact meaning of `pending`, `submitting`, `accepted`, `rejected`, and `unknown`.

Use the smallest design that proves these outcomes:

- Administrators can see unresolved JoFotara sales invoices and credit notes, with useful counts, age, attempt information, safe error details, and links to the source document.
- Accepted documents are immutable and never resubmitted.
- `unknown` and interrupted `submitting` outcomes never retry automatically; they remain explicit manual-review cases.
- Automatic/background retry, if evidence justifies it, is limited to outcomes proven not to have reached JoFotara. A timeout, abort, connection reset, malformed success response, or lost response is not proof of rejection.
- POS checkout and refunds commit independently of JoFotara availability. Any enqueue or discovery mechanism must be post-commit or derive from already-finalized local documents.
- Credentials never enter responses, events, logs, UI state, audit payloads, or test snapshots.
- Existing XML generation, exact money precision, legal snapshots, UUID/idempotency rules, credit-note billing references, and manual submit endpoints remain authoritative.

Apply ponytail strictly. Prefer extending the existing JoFotara documents table, service, admin route, existing Orders/Settings surfaces, polling/realtime conventions, and server timers. Do not create a generic adapter, connector framework, job framework, webhook platform, event bus, repository layer, state-machine library, scheduler dependency, or separate frontend store. Do not add a migration unless current persisted facts cannot support the required workflow. Do not auto-create speculative JoFotara documents for historical sales.

Use TDD for every behavior change: write the smallest behavioral test, run it and prove the expected RED, then implement only enough to pass. Include authorization, SQL parameterization, duplicate/concurrent worker behavior, accepted/unknown safety, restart recovery, retry classification, checkout independence, credential redaction, UI state, and build verification where relevant. Never weaken a test to fit implementation. If evidence makes any requested behavior legally unsafe, narrow the plan and document why instead of guessing.

At the end, aggressively review the complete diff for duplicate queries, competing state ownership, excessive files, secret leakage, blind retry paths, accepted-document mutation, timer overlap, unbounded work, stale frontend paths, and missing migration authority. Run focused and cross-boundary suites, schema validation when applicable, production build, and `git diff --check` before claiming completion.

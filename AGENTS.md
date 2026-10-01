# POSApp

A restaurant POS running at live venues on slow links: Vue 3 frontends (`src/`), Express 5 + MySQL backend with Socket.IO realtime (`server.js`, `backend/`), a Windows print spooler (`pos-spooler-printer/`), JoFotara e-invoicing and a Go phone-ordering gateway (`integrations/gemini-order-gateway/`). Money, inventory, printing and sessions are production-critical.

This file gives intent and a few hard lines; everything else is your judgment. Read the real code path before changing it, fix the root cause with the simplest complete change, prove it, and report limits honestly. Carry authorized work through implementation, verification and corrections; ask only when a missing decision changes scope or needs new authority.

## Hard lines

- No deployment, production test or production data change without the owner's explicit approval for that task. A merge or push is not approval.
- Integration is by pull request: one PR per coherent change, merged in order once its local verification passes (focused tests plus one full suite), then the branch is deleted. CI and the self-hosted `Release gate` runner are not part of the flow unless the owner asks for them.
- Secrets and machine state never enter commits: `.env*`, keys, certificates, `gateway.env`, caches, archives, `node_modules`.
- Work on a named `codex/` branch in the shared checkout (no worktree unless asked). Other agents share it: stage only your files and never revert or reformat work you did not make.
- `pos-spooler-printer/` is tracked deployable source; each installed machine keeps its own `.env`.

## How we build

- **Performance is already paid for; don't give it back.** Keep queries bounded and out of loops, reads coalesced, lists bounded, lazy loading lazy, and timers, listeners and workers released. On a hot path, measure before and after (queries, rows, latency, locks). Loopback timings are not customer numbers.
- **Event-driven, not polling.** Refresh and recovery ride existing socket events and the socket heartbeat, so a healthy client sends nothing extra. Bounded retries are fine; standing timers are not.
- **Simple over clever.** Reuse existing services and dependencies. Add an abstraction, cache, index or table only for a concrete need.
- **UI** follows `DESIGN.md` and `PRODUCT.md` in English and Arabic (RTL). New content mounts on the same frame as the user's action, with enter-only fades and never `mode="out-in"` on something the user is switching to.
- Small changes need no plan document or spec interview.

## Verification

- Tests prove behavior, not wording or implementation shape. For a new guard, show that its test fails without it.
- Run focused tests while working, and the full backend suite once before completion or merge: `npm run test:isolated:shards` (about five minutes) runs it as parallel shards, each on its own throwaway MariaDB server. If it fails, rerun only the failing files, then do one final full run. Never run two Vitest processes against the shared `posapp_test` database; isolated runs each own their database. Run the suite from a working tree nothing else is changing.
- After a merge of already-tested, unchanged content, check Git state instead of re-running suites. Inspect the test setup before assuming a database is disposable.
- Commands, fixtures and per-area browser checks are in [verification.md](docs/agents/verification.md). Read its "Core commands" section, then jump to your area.

## Scratch

Throwaway output goes in `scratch/<task>/`, which is ignored. Nothing there is authoritative. Delete your folder when the task closes, and put durable findings in `docs/reviews/`.

## References when relevant

- Migrations: [database-migrations.md](docs/agents/database-migrations.md). Permissions: [permissions.md](docs/agents/permissions.md).
- JoFotara: [project skill](skills/jofotara-invoice-integration/SKILL.md). It takes precedence over any global copy.
- Deployment kits: [deployment-kit.md](docs/agents/deployment-kit.md). Keep the single current kit in `C:\Users\bash\Documents\New folder`.
- Cross-file flows: `docs/architecture.json` (confirm symbols in source). After a major change to a flow, service boundary, table ownership or deployment, update it and run `npm run architecture` and `npm run architecture:check`. Never hand-edit `docs/architecture.html`.
- Plans and reviews under `docs/` are records, not instructions.

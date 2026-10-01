# Deferred React/Next POS migration

Status: deferred after audit. No migration code has been started.

This report preserves the migration decision, evidence, and safe working method so the work can resume without changing the current Vue production application prematurely.

## Decision

If the POS frontend is migrated, migrate the register and tables frontend to React first while preserving the existing Express, MySQL, Socket.IO, printing, checkout, and migration systems. Do not rewrite the backend into Next.js as part of the frontend migration.

Next.js can provide the application shell and future product structure, but most register and tables screens will remain Client Components because they depend on browser state, local drafts, sockets, keyboard input, and interactive dialogs. If the goal remains only a browser POS, React with Vite is the simpler option. Next.js becomes more valuable if POSApp is expected to grow into a broader product family with shared web surfaces.

## Current scope measured during the audit

- The register and tables area contains 17 Vue screens and dialogs.
- Those files contain approximately 3,314 template lines, 3,336 component-script lines, and 1,573 scoped-style lines.
- Another approximately 6,739 JavaScript lines are coupled to Vue or Pinia in the POS workflow.
- Approximately 1,545 POS production JavaScript lines are already framework-neutral and are candidates for direct reuse.
- `src/pos/stores/orderSessionStore.js` is approximately 3,046 lines, with 241 tests in a 5,485-line test file.
- `src/pos/stores/orderSession/tableOrderWorkflow.js` is approximately 1,747 lines.
- There are 54 relevant frontend and browser test files.
- The POS area received approximately 253 commits since June, so running the migration while the same workflow changes quickly would materially increase merge and parity risk.
- The existing backend contains approximately 49,305 production lines, 246 HTTP route declarations, 1,250 database query sites, 222 migrations, and 88 socket-related sites.
- The complete frontend contains 91 Vue files and approximately 67,548 lines across 307 JavaScript, Vue, and JSON files.

These are planning measurements rather than fixed contractual counts. Re-measure them when the migration resumes.

## What the migration would buy

- A larger hiring and library ecosystem.
- A clearer path to a shared component system across future products.
- Better alignment with future Electron or React Native work if those products are actually planned.
- A good opportunity to introduce TypeScript contracts at the API and domain boundaries.
- Explicit error boundaries and a more deliberate state architecture.

It does not automatically improve load time, memory usage, checkout queries, printing, bundle size, or reliability. Those benefits depend on architecture and measurements. A direct line-for-line component rewrite could be equal or worse.

Estimated return for the existing POS alone was roughly 5/10. The return rises to roughly 8/10 if POSApp is becoming a family of products that can share React code, engineers, and tooling.

## Recommended architecture

1. Extract the order domain before replacing the UI. Cart calculations, held-order transitions, table draft rules, checkout preparation, and recovery behavior should expose framework-neutral interfaces.
2. Keep API, storage, Socket.IO, and printing behind adapters. React components should not reproduce protocol and lifecycle rules internally.
3. Use an external store suited to state shared across screens and callbacks, such as a small Zustand store or a vanilla store consumed through `useSyncExternalStore`. Preserve crash-safe draft persistence.
4. Preserve current CSS classes, ARIA labels, and stable test identifiers during parity work. Visual redesign belongs after behavioral parity.
5. Keep the current lazy-loading behavior. Load uncommon dialogs on demand and preload likely next actions during idle time.
6. Avoid a custom Next.js server. It removes some built-in optimizations and conflicts with standalone output. Run Next separately behind the existing reverse proxy, or use a static export served by Express when the application shape permits it.

## Safe isolated lab

Use a separate clean clone, for example `C:\work\posapp-react-lab`. Keep the production checkout at `C:\xampp\htdocs\posapp` unchanged.

The lab should use:

- Branch: `codex/react-pos-lab`.
- New frontend: `apps/pos-next/`, while the Vue application stays intact.
- Express port: 3110.
- React/Next port: 3200.
- A dedicated disposable lab database whose name passes the repository's test and isolation guards.
- No production `.env`, customer database, Hostinger credentials, real printers, spooler installation, deployment ZIP, or deployment automation.

Create the lab with a clean Git clone rather than copying the XAMPP directory. Rename its remote to `upstream` and initially disable the push URL so the lab can fetch updates without accidentally publishing experimental commits. Sync changes one way from `master` into the lab.

Run Vue and React side by side against the same isolated backend and database. Parameterize the existing Playwright flows so the same scenarios can run against both interfaces.

## Delivery order

1. Create the isolated lab and prove that it cannot reach production resources.
2. Extract and test framework-neutral order state and adapters without changing Vue behavior.
3. Build a pixel-matched register shell under `/pos-next`.
4. Port catalog browsing, cart editing, modifiers, notes, and held orders.
5. Port checkout and recovery only after the earlier flows have parity.
6. Port the table floor, saved-table lifecycle, transfers, splits, and permission behavior.
7. Run the same English and Arabic browser workflows against Vue and React and compare API requests, database outcomes, Socket.IO events, printing requests, and screenshots.
8. Pilot React behind separate routes. Keep Vue as the immediate fallback until the new interface has sustained real usage without parity defects.

## Time estimate

- Pixel prototype: 1–2 weeks.
- Feature-complete register and tables beta: 8–11 weeks.
- Production-safe register and tables migration: 12–16 weeks for one experienced developer with Codex and a feature freeze.
- With active changes continuing in the Vue product: 16–22 weeks.
- With two experienced engineers and clear ownership: 8–12 weeks.
- Full frontend migration: approximately 5–7 months.
- Rewriting the Express backend into Next.js as well: approximately 9–15 months total and not recommended as one migration.

## Cutover gates

Do not switch production routes until all of these are true:

- Register and table behavior matches the Vue implementation for permissions, drafts, holds, checkout, recovery, refunds, and printing.
- The same end-to-end scenarios pass against both frontends.
- Database and Socket.IO effects match for each tested workflow.
- English and Arabic layout, keyboard operation, and receipt-triggering flows have been visually checked.
- Startup transfer, interaction latency, retained memory, and long-shift stability are measured on representative low-end Windows hardware.
- A controlled customer pilot has a documented rollback to the Vue routes.

## Resume checklist

- Re-measure the repository because the POS changes frequently.
- Decide whether the product roadmap justifies Next.js or whether React with Vite is the better fit.
- Freeze the register and table contracts long enough to prevent permanent parity drift.
- Create the isolated clone and database before writing migration code.
- Start with the order-domain seam, then one vertical register workflow.

## References

- [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Next.js single-page applications](https://nextjs.org/docs/app/guides/single-page-applications)
- [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading)
- [Next.js custom server](https://nextjs.org/docs/app/guides/custom-server)
- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

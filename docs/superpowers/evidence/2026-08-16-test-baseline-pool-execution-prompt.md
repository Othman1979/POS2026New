# Execution prompt: test baseline and pool acquisition hardening

Execute `docs/superpowers/plans/2026-08-16-test-baseline-and-pool-acquisition-hardening.md` exactly on branch `codex/test-baseline-pool-hardening`.

For every task:

1. Reproduce the named failure or establish RED before production code.
2. Make only the files and behavior authorized by that task.
3. Run the focused GREEN command and inspect the complete result.
4. Attack the adjacent failure modes named in the adversarial gate.
5. Inspect the diff, stage explicit paths only, and commit that task separately.

Hard boundaries:

- Never change production checkout accounting, receipt/kitchen rendering, remittance behavior, split behavior, or frontend runtime imports to make stale tests pass.
- The database timer begins only for a mysql2 queued waiter after `enqueue`. It never owns connection establishment or running SQL.
- Preserve late-waiter ownership and release any late connection exactly once.
- Add no dependency, environment setting, schema change, installer/updater change, deployment, migration, merge, or push.
- Preserve and never stage unrelated working-tree files.
- Stop on any plan stop condition. Do not improvise around a failing gate by weakening a test or raising/bypassing the timeout.

Completion requires the focused 43-test gate, the complete Vitest suite, architecture generation/check, admin build, diff review, and a clean accounting of every planned versus pre-existing file.

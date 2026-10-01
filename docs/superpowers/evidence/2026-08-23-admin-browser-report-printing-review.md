# Admin Browser Report Printing — post-implementation review

**Branch:** `codex/admin-browser-report-printing`
**Reviewed at:** `f0a1b212` (all four plan tasks implemented)
**Result:** 13 failing tests → 3049/3049 passing, build green, architecture check green.
**Changed by this review:** 7 files, +314 / −59.

This is written for the implementer. Each entry is: what was wrong, how it was found, why it happened, what the fix was, and the rule that generalises. The point is the rules at the end of each section, not the individual bugs.

---

## What was done well, so the criticism below lands in proportion

- The transport is genuinely careful: popup opened synchronously, listener installed before navigation, origin + source + nonce + layout checked on both ends, blocked-popup and readiness-timeout paths handled, `false` treated as a quiet cancellation, `popup.closed` rechecked after the provider, `window.focus()` before the confirm.
- `assertBrowserSafePayload` fails **closed** with 409 on a stored document that predates the narrowing. That is the correct direction to fail.
- `markBrowserReady` probes `information_schema` before writing the new enum value and degrades to a logged warning. An un-migrated database cannot 500 an already-committed, serial-consuming audit document because of a bookkeeping column.
- The Y transaction was preserved byte-for-byte through commit, and the printer precondition was removed without touching the archive/delete sequence.
- `buildShiftReportPayload` is a faithful extraction — same queries, same order, same authorisation check.
- `docs/architecture.html` regenerates byte-identical, so it was generated and not hand-edited.

One place where the implementation **improved on the plan**: the plan said to leave `payload_hash` stale after redacting a stored audit document. `redactPrintPayloadSecrets.js` instead recomputes the hash and writes an `audit_events` row recording old→new in the same transaction. That is better than what was specified — the printed hash still verifies against its own payload, and the rewrite is itself auditable. The plan was wrong; the implementation was right.

---

## Defect 1 — presentation derived from payload keys (the big one)

### Symptom

`AdminReportA4.vue` built ledger rows by walking whatever the payload object happened to hold:

```js
const label = `${prefix}${key.replaceAll('_', ' ')}`;
const isCount = /(count|orders|shifts|state|hour|id)$/i.test(key);
return [{ name: label, amount: typeof value === 'number' ? (isCount ? number(value) : money(value)) : String(value ?? '—') }];
```

Rendered output of the **official Z audit** — the serialised, hashed document that goes to an accountant:

```
تفاصيل المبيعات | البيان | القيمة
total orders           | 60
sales incl tax         | 1360.70 د.أ
net sales pre tax      | 1172.50 د.أ
avg check              | 22.68 د.أ
```

English machine keys under Arabic headings, in an RTL document. And on the refunds report:

```
refund rate            | 2.66 د.أ
```

`refund_rate` is a **percentage** — `ReportsRefunds.vue:32` renders it with `formatPercent`. On the printed report it became a currency amount. The key does not end in `count|orders|shifts|state|hour|id`, so the regex classified it as money.

Three more instances of the same root cause, found by sweeping every report type:

| Where | What it printed | Should have printed |
| --- | --- | --- |
| `comparison` | row labelled `sales_collected`; order **count** as `5.00 JD`; null percent as `0%` | named label; `5`; "no prior period" |
| `cash_status.state` | the raw enum token `balanced` | `Balanced` / `مطابق` |
| `moneyRows` count column | `0` for rows that have no count | empty |
| `blockers.open_shifts` | rows like `open shifts 1 / user id` = 9 | a shift table with no internal id |

### How it was found

Not by reading — by rendering. The repo has no `@vue/test-utils` and vitest runs in a `node` environment, but `@vue/compiler-sfc`, `esbuild` and `vue/server-renderer` are all already installed:

```js
const { descriptor } = parse(readFileSync('src/print/AdminReportA4.vue', 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'probe', inlineTemplate: true, templateOptions: { ssr: true } });
writeFileSync('./probe-component.mjs', (await transform(script.content, { loader: 'ts', target: 'es2022' })).code);
const Component = (await import('./probe-component.mjs')).default;
const html = await renderToString(createSSRApp(Component, { printType, data }));
```

Two things that will cost you time if you rebuild this: `compileScript` does **not** strip TypeScript, so the output must go through esbuild's `ts` loader; and the compiled module must be written to a file **inside the repo**, because a `data:` URL cannot resolve the bare `vue` specifier.

The same harness then swept all nine report types with `{}` and all-null payloads. No crashes — that part was solid.

### Why it happened

A reflective dumper looks like coverage. It appears to handle every field, including fields that do not exist yet, so it feels more robust than a hand-written list. It is the opposite. It guarantees that every field is displayed, and guarantees nothing about whether the display is *correct*.

The file already contained the right pattern — `products`, `events`, `shifts` and `entries` all had explicit column/row maps. The dumper was used exactly where the payload was an object rather than an array, which is an argument about data shape, not about whether the output needs to be right.

### Fix

Named field specs — key, English, Arabic, kind — with an explicit formatter:

```ts
type FieldKind = 'money' | 'count' | 'percent' | 'text' | 'state';
type FieldSpec = [key: string, english: string, arabic: string, kind: FieldKind];

const labelled = (source: ReportData, spec: FieldSpec[]) =>
    spec.flatMap(([key, english, arabic, kind]) => {
        const value = (source || {})[key];
        if (value === undefined) return [];
        return [{ name: tr(english, arabic), amount: formatField(value, kind) }];
    });
```

Nine call sites converted. `blockers` became a real table. `platform_reconciliation`'s three nested nine-category objects are flattened under named group headings with zero-value rows dropped. On a realistic payload that turned 27 machine-named category rows such as `deductions by category / service fee` into the 3 that were actually non-zero, named `الحسومات — عمولة` and so on.

A field the spec does not name is **not printed**. That is a deliberate choice with a cost: a new server field would silently vanish. So the guard test closes it by reading the builder's own object literal:

```js
const produced = blockKeys(read('backend/services/auditReportBuilder.js'), 'summary');
expect(specKeys('AUDIT_SUMMARY_FIELDS')).toEqual(expect.arrayContaining(produced));
```

Proved RED by deleting `avg_check` from the spec — the test fails naming the missing key.

### Rules

1. **On a financial document, never derive a label or a unit from a key name.** A key name tells you what a field is called, not what it means. `refund_rate` and `refund_total` differ by one word and by a unit.
2. **When a file already contains the explicit pattern, the reflective shortcut is not a different technique — it is the same job done less carefully.** Look for the pattern that already exists before inventing a generic one.
3. **A whitelist that silently drops unknown input needs a test that fails when the input grows.** Read the producer's source in the test; do not restate its fields in a literal that will drift.
4. **Render the thing.** Source-string assertions (`expect(a4).toContain('summary')`) passed the entire time this defect existed. They assert that a word appears in a file, not that the document is correct.

---

## Defect 2 — `.stop` on a keydown handler inside a modal

### Symptom

With the shift modal open and focus on the Print button, **Escape did not close the modal**.

### Root cause

```vue
<div ref="root" class="report-print-menu" @keydown.esc.stop.prevent="closeMenu()">
```

`closeMenu()` early-returns when the dropdown is closed — but `.stop` and `.prevent` are applied by the compiled handler regardless. `ModalShell.vue:35-38` closes on a **bubble-phase listener attached to `document`**:

```js
const onEscKey = (e) => { if (e.key === 'Escape') emit('close'); };
if (open) document.addEventListener('keydown', onEscKey);
```

`document` is the last node in the bubble path. Anything that calls `stopPropagation` below it wins permanently.

### Fix

```js
function onEscape(event) {
    if (!open.value) return;   // let the modal have it
    event.stopPropagation();
    event.preventDefault();
    closeMenu();
}
```

The existing spec asserted `@keydown.esc.stop.prevent` — it was pinning the bug. Replaced with an assertion that the guard precedes the `stopPropagation` call, plus a read of `ModalShell.vue` so the coupling that makes it matter is recorded next to the assertion.

### Rules

5. **Vue event modifiers run unconditionally; your handler's early return does not undo them.** If swallowing an event is conditional, do it in code, not in a modifier.
6. **Before stopping propagation, ask what is listening above you.** A `document`-level listener has nothing below it to recover a stopped event, and that is where app-wide shortcuts live.

---

## Defect 3 — the baseline checksum was not updated (this one shipped)

### Symptom

```
$ node deployment/tools/bootstrap-database.js --check config.json
Fresh database baseline checksum mismatch.
EXIT=1
```

**Every fresh install would refuse to bootstrap.** Not a test artefact — that is the installer path.

### Root cause

`deployment/database/baseline.sql` was edited for the enum. `deployment/database/manifest.json` carries a SHA-256 of that file, `bootstrap-database.js:31` verifies it, and nothing regenerates it. Confirmed the manifest matched the baseline at `f07163a2` and was stale only on this branch.

### Fix

Recomputed the digest with the same normalisation the tool uses (`CRLF → LF`, then sha256). `--check` now returns `{"valid":true}`.

### Rules

7. **Grep for the file you edited.** `baseline.sql` is referenced by a checksum in a manifest, by two integration tests and by the installer. Editing a file that something else fingerprints means updating the fingerprint in the same commit.
8. **When a test failure names a tool, run the tool.** `installerCli.test.js` asserted `status === 0`. Running the CLI by hand printed the actual reason in one line; the assertion alone said only "expected 1 to be 0".

---

## Defect 4 — a new migration silently rewired the migration tests

### Symptom

Eight failures in `backend/tests/integration/automaticMigrations.test.js` and two in `installerBaseline.test.js`, all shaped like "expected N applied, received N−1".

### Root cause A — relative slices

Each scenario seeds the ledger with everything except the last N migrations, then asserts exactly those N apply:

```js
const prior = manifest.migrations.slice(0, -7);
```

`N` is hard-coded. Adding a 21st migration slides the window by one, so a scenario that existed to prove the MariaDB implicit-index repair **stopped exercising that repair** — it was pre-seeded as already applied. The test still failed, but for the wrong reason, and had the expectation been "fixed" by editing the name list instead, it would have gone green while testing nothing.

Fixed by bumping all five slices by one, so the same set of migrations is still exercised.

### Root cause B — mysql2 silently drops extra parameters

Two statements in that file carry one placeholder per name:

```js
'... WHERE migration_name IN (?, ?, ?, ?, ?, ?, ?, ?)', [EIGHT, ..., NAMES, NEW_NAME]   // 9 params
```

mysql2 binds the first eight and **discards the ninth without erroring**. Both statements were affected:

- the ledger `SELECT` (line 158) filtered on 18 of 19 names, so the new migration's row was never returned and the ledger assertion saw 18 rows instead of 19;
- the `DELETE` (line 1225) removed 8 of 9 rows, leaving the new migration in the ledger, so the scenario's retry pass listed it as *skipped* rather than *applied*.

The second one is why the symptom looked like "the runner is not applying the migration" when the runner was correct the whole time — the first pass applied it fine, and the assertion that failed was the one after the incomplete `DELETE`.

Fixed by balancing both lists, then auditing every `IN (…)` in the file programmatically. Note that a naive `[A-Z_]+_NAME` regex miscounts, because `SPOOLER_V2_NAME` contains a digit.

### Root cause C — a frozen manifest tail

`installerPackageContract.test.js` pinned `manifest.migrations.at(-1)` by name. That assertion breaks on **every** migration, forever, for no reason of its own. Replaced with a structural check: the tail's file matches its name, its checksums are well-formed, it chains to the previous entry, and its file exists on disk. The chain itself is already covered by `automaticMigrations.test.js` and by each migration's own predecessor test.

### How the runner was cleared of suspicion

Before touching `runPendingMigrations.js`, its behaviour was reproduced standalone — seed the same ledger against a scratch database, call the runner, print the result. It returned all nine migrations correctly. That established the runner was fine and the fault was in the test's own SQL, which is what stopped a correct piece of production code from being "fixed".

A worktree at the merge-base (`git worktree add`, symlink `node_modules`, copy `.env.test`) confirmed 11/11 passing before the branch, so these were the branch's regressions and not pre-existing noise.

### Rules

9. **A test whose fixture is computed from a live manifest changes meaning when the manifest grows.** Prefer naming the floor explicitly over `slice(0, -N)`; if you keep the relative form, adjust it in the same commit as the migration.
10. **mysql2 does not error on a parameter/placeholder mismatch.** An unbalanced list produces a wrong result, not a clear failure. Count both sides whenever you extend one.
11. **Do not pin a moving value in a test whose subject is something else.** Assert the structure the test actually cares about.
12. **When a test says production code is wrong, reproduce the production code standalone first.** Half of this section's time went to suspecting a runner that was correct.
13. **Get the baseline before diagnosing.** A worktree at the merge-base answers "did I break this?" in five minutes and removes every subsequent guess.

---

## Method notes

- **Prove, do not argue.** Every defect above was demonstrated by executing the shipped code against realistic payload shapes taken from the actual builders. The `refund_rate` bug was argued from the regex first, then proven by rendering — and only the rendering was convincing.
- **Use the real shapes.** `platform_reconciliation`'s shape came from `PlatformRemittanceService.getRangeTotals`, `cash_status`'s from `dailyReportBuilder.js`, the audit summary's from `auditReportBuilder.js`. Inventing plausible payloads would have missed the nested category objects entirely.
- **One vitest process at a time.** They share `posapp_test`. Two concurrent runs produce results that look like real failures and are not; one was started by accident during this review and cost a round of confusion.
- **The in-app browser pane blocks `window.open` even from a real click**, so the popup handshake cannot be driven end-to-end there. The print window also auto-calls `window.print()` after 500 ms, and the native dialog then blocks further page scripting until dismissed. Drive the child directly through the legacy localStorage path when probing the print app.

---

## Left alone deliberately

- The four **daily-report** thermal branches keep their original styling. The plan only mandated the audit-family branches, so this is faithful — but the app now prints two different thermal grammars, and those four still do not match `renderReportSection` in the spooler. Worth an explicit decision.
- **Page numbers** are absent from the A4 running header. Chrome does not support `@page` margin boxes, so "page n of m" is not reachable from CSS; the browser's own "Headers and footers" print option covers it. Dropping it was right, but it should be recorded rather than silently omitted.
- Three pre-existing untranslated strings in `Shifts.vue` (`Platform Sales (Not collected)`, `Receivable Cash Collections`, `Receivable Card Collections (Not in drawer)`). They predate this branch.

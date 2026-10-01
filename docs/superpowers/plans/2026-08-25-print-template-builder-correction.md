# Print Template Builder Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin print-template builder behave like a real direct-manipulation editor — free movement, real multi-selection, column resizing, and adding elements anywhere — without changing the template schema, the render engine's layout model, or any financial/legal invariant.

**Architecture:** The blocking constraints are almost entirely in the editor UI, not in the schema. The engine already accepts absolute `row` nodes inside repeating bands, arbitrary child counts, and arbitrary pixel widths — all three were proven by direct compilation against the live engine (see Evidence). This plan therefore *deletes* invented UI constraints, keeps every guard that mirrors a real engine rule, and adds three missing gestures: insert-into-row, column-divider resize, and marquee multi-select.

**Tech Stack:** Vue 3 Composition API (`<script setup>`), Vite, native Pointer Events (no drag-and-drop library), Node.js/CommonJS backend, Vitest, Playwright.

**Reviewed fixed point:** `master` at `cb15bc82be5f061f44732a3737149428ff121290` on 2026-08-25. Every task below was re-checked against that source. Line numbers are anchors; symbols and behavior are authoritative.

## Global Constraints

- **No schema change, no engine layout change, no database migration.** `schemaVersion` stays `1`. Proven unnecessary — see Evidence E1/E2.
- **No new runtime dependency.** Pointer Events and the native HTML5 drag API only. `src/admin/pages/__tests__/printTemplatesPage.spec.js:87` asserts the absence of GrapesJS / SortableJS / VueDraggable and must stay green.
- **Paper width is exactly 576px.** Usable width inside a `row` is 556px (`PAPER_WIDTH_PX - 20`).
- **Never weaken these engine invariants:** money values are bindings not expressions; exactly one `jofotara_qr` node, never hideable; required field *presence* counts in `validateReceiptStructure` / `validateKitchenStructure`; resource caps (300 nodes, depth 5, 256KB artifact).
- **Deferred, explicitly out of scope:** making the print template the single source of truth — i.e. deleting the spooler's legacy `renderReceiptDocument`/`renderKitchenDocument`, unifying the browser receipt path (`ReceiptPreviewModal.vue`), and default-vs-spooler layout parity. Owner decision, 2026-08-25.
- **Test runner is Vitest** (`npx vitest run`), never Jest. Exactly one Vitest process at a time — the suite shares the `posapp_test` database. Focused files during implementation; full suite exactly once before completion.
- **Do not deploy, migrate, merge, or push as part of this plan.**

## Evidence this plan is built on

Each of these was executed against the real modules, not inferred from reading.

- **E1 — A four-column item row is already legal.** Rebuilding the built-in receipt's `receipt-item-row` with four children (`qty|name|unitPrice|netAmount` at widths 56/240/120/140, summing to 556) passes `validateTemplate()` and `compileTemplate()` and renders `2x  Smash Burger  5.00 JD  10.00 JD`. Nothing server-side blocks a new column.
- **E2 — Absolute rows are legal inside repeat bands.** `printTemplateEngine.js:430` restricts absolute layout to `once` **bands**; the `row` node branch (`:243-259`) has no band-kind check. `printTemplateDefaults.js:61-65` already ships `receipt-item-row` as `layout:'absolute', height:40`.
- **E3 — Movement stops at the container edge, not at other elements.** Overlap is permitted (`warnPositionedOverlaps`, `:554`, warns only). `clampedMoves` (`PrintTemplatePreview.vue:131-138`) clamps to container bounds. The default item row's children sum to exactly 556px, so `receipt-item-total` has `maximumX = 556 - 424 - 132 = 0` and cannot move right at all. Row `height:40` with `heightPx:36` leaves exactly 4px of vertical travel.
- **E4 — There is no code path that inserts into `row.nodes`.** `addNode()` (`PrintTemplateEditor.vue:295-300`) always splices into `band.nodes`. `placeAdjacentItemBeside()` (`:343`) requires `depth === 0`. `duplicateNode()` (`:281`) does target `row.nodes` but is blocked by `isLockedNode`, and `qty`/`name`/`netAmount` are locked by `requiredField` (`:260-266`). All three routes are closed.
- **E5 — Resize is unilateral and corner-only.** `PrintTemplatePreview.vue:175` triggers resize only within 14×14px of the bottom-right corner; `:179` emits a patch for the dragged node alone, so a neighbour never yields.
- **E6 — A validation failure blanks the canvas.** `usePrintTemplates.js:139-142` sets `previewArtifact.value = null` on any preview error, including a 422 `TEMPLATE_*` validation rejection.
- **E7 — `allowAbsoluteOnce` is dead.** Hardcoded `true` at `printTemplateManager.js:36`, `printDocumentCompiler.js:184,196`, `routes/admin/printTemplates.js:176,181`. `TEMPLATE_FEATURE_NOT_ENABLED` is unreachable.
- **E8 — Bundle children render wrong.** Compiling the built-in receipt with a `kind:'bundle_child'` row produces a full-width row `1x  Fries (in combo)  0.00 JD`. The template has zero `kind` logic; the spooler's own renderer shows `• Fries x1` indented with no total. The fixtures contain no bundle child (`rows` kinds are `["item","item"]`), which is why no test caught it.
- **E9 — `note` is required on kitchen rows but not receipt rows.** `printTemplateEngine.js:368-372` requires `name`/`qty`/`netAmount`; `:402-406` additionally requires `note`. `activateTemplateRevision` (`printTemplateManager.js:430-467`) never re-validates.
- **E10 — No `@vue/test-utils`.** Root `devDependencies` are `@playwright/test`, `@vitest/coverage-v8`, `cross-env`, `supertest`, `vitest`. SFC behaviour must be proven by Playwright, not unit tests.

## The rule this plan applies to guards

A UI guard is legitimate **only if it mirrors a rule the engine actually enforces**. Otherwise it is an invented constraint and gets deleted.

| Guard | Mirrors an engine rule? | Action |
|---|---|---|
| `requiredField()` / `isLockedNode()` / `isLockedBand()` | No — engine counts field *instances* (`:365-383`), it never forbids editing a specific node | **Delete** |
| `isOnlyBandNode()` | Yes — `TEMPLATE_EMPTY_BAND` (`:444-445`) | Keep |
| `canAddToBand()` QR/logo `once`-band rules | Yes — `:269`, `:276` | Keep |
| `hasQr` single-QR limit | Yes — exactly-one at `:384` | Keep |
| `window.innerWidth >= 1100` drag gate | No | **Delete** |
| Pair-selection two-element cap | No | **Delete** |
| Flow↔absolute confirm modals | No | **Delete** |

## File map

| File | Responsibility after this plan |
|---|---|
| `backend/services/printTemplateEngine.js` | Adds `note` to the receipt primary-row requirement; boolean fields stop emitting `'true'`/`'false'`; `profile` flag removed |
| `backend/services/printTemplateDefaults.js` | Built-in receipt renders bundle children as children; adds a bundle fixture |
| `backend/services/printTemplateManager.js` | Re-validates on activation; `profile` flag removed |
| `backend/services/printDocumentCompiler.js`, `backend/routes/admin/printTemplates.js` | `profile` flag removed |
| `src/admin/composables/usePrintTemplates.js` | Preserves the last good artifact on a validation error; exposes `validationError` |
| `src/admin/components/PrintTemplateEditor.vue` | Loses the lock model and the layout confirm modals; gains insert-into-row |
| `src/admin/components/PrintTemplatePreview.vue` | Loses the 1100px gate and pair-selection; gains marquee select, group move, column-divider resize |
| `src/admin/pages/PrintTemplates.vue` | Owns an unbounded selection set instead of a primary/companion pair |
| `tests/e2e/specs/admin.print-templates.spec.js` | Behavioural proof for every frontend task |

---

## Phase 0 — Correctness before freedom

These three are independent of the refactor and shippable on their own. **Task 1 must land before Task 5**: removing the UI lock model makes deleting the note node easier, and today that silently ships receipts with no notes.

### Task 1: Require `note` on the receipt primary row

**Precondition — verify before starting.** This tightens validation, so any already-published custom revision lacking a `note` field would stop validating. Confirm none exist:

```sql
SELECT t.document_type, 'active' AS slot, r.id AS revision_id, r.definition_json
FROM print_templates t
JOIN print_template_revisions r ON r.id = t.active_revision_id
UNION ALL
SELECT t.document_type, 'draft' AS slot, r.id AS revision_id, r.definition_json
FROM print_templates t
JOIN print_template_revisions r ON r.id = t.draft_revision_id
ORDER BY document_type, slot;
```

Expected: zero rows, or every returned **receipt** definition has exactly one unfiltered `repeat` band with `source:'rows'`, and that band's node tree contains a relative field with `path:'note'`. Do not use a raw `JSON_SEARCH('note')`: `meta.note` can create a false pass. If an active or draft receipt revision lacks the row note, **stop and report** — the fix then needs a repair path, not a stricter validator.

**Files:**
- Modify: `backend/services/printTemplateEngine.js:368-372`
- Modify: `backend/services/printTemplateManager.js:430-467`
- Test: `backend/tests/unit/printTemplateEngine.test.js`, `backend/tests/unit/printTemplateManager.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature change. `validateReceiptStructure` gains one required relative path.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/unit/printTemplateEngine.test.js`:

```js
it('rejects a receipt whose primary row omits the item note', () => {
    const definition = getBuiltinTemplate('receipt');
    const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
    items.nodes = items.nodes.filter(node => node.path !== 'note');
    expect(() => validateTemplate(definition, { allowAbsoluteOnce: true, allowStoreLogo: true }))
        .toThrow(/Receipt primary row requires note/);
});

it('allows a receipt whose item note is present but conditionally hidden', () => {
    const definition = getBuiltinTemplate('receipt');
    expect(() => validateTemplate(definition, { allowAbsoluteOnce: true, allowStoreLogo: true })).not.toThrow();
});
```

The second test pins the asymmetry deliberately: the built-in note node carries `visibleWhen: { path: 'note', op: 'truthy' }`, so `note` must be required to *exist* but must not be subject to the can't-be-hidden check — exactly how kitchen already treats it at `:402-406`.

Also add `field('note', 'note', { visibleWhen: { path: 'note', op: 'truthy', value: null } })` to the shared `receiptTemplate()` test helper. That helper feeds most engine tests; leaving it stale would turn the whole file red for the wrong reason.

In `backend/tests/unit/printTemplateManager.test.js`, use the existing `trackedExecutor()` rather than invented seed helpers. Return the stored definition from the locked revision query and assert no update occurs:

```js
it('refuses to activate a revision whose definition no longer validates', async () => {
    const definition = getBuiltinTemplate('receipt');
    const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
    items.nodes = items.nodes.filter(node => node.path !== 'note');
    const db = trackedExecutor([
        [[{ id: 1, active_revision_id: null, lock_version: 1 }]],
        [[{ id: 11, definition_json: JSON.stringify(definition) }]]
    ]);

    await expect(manager.activateTemplateRevision(db, {
        docType: 'receipt', revisionId: 11, reason: 'test', expectedLockVersion: 1
    })).rejects.toMatchObject({ code: 'TEMPLATE_REQUIRED_STRUCTURE_MISSING' });
    expect(db.calls.some(call => /UPDATE print_templates/i.test(call.sql))).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateManager.test.js`
Expected: FAIL — the engine test reports no throw; the manager test reports the activation succeeded.

- [ ] **Step 3: Implement**

In `printTemplateEngine.js`, replace the receipt required-path loop at `:368-372`:

```js
    // note mirrors the kitchen rule at :402 — the field must EXIST so a template
    // cannot silently drop item notes, but it stays hideable because the built-in
    // binds it behind `visibleWhen: note truthy`.
    for (const path of ['name', 'qty', 'netAmount', 'note']) {
        const fields = countFields(state, { path, band: primary[0], scope: 'relative' });
        if (fields.length === 0) fail('TEMPLATE_REQUIRED_STRUCTURE_MISSING', `Receipt primary row requires ${path}`);
        if (path !== 'note' && fields.some(field => field.hidden)) fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Receipt primary row ${path} cannot be hidden`);
    }
```

In `printTemplateManager.js`, make the locked revision query select `id, definition_json`. After the ownership check and before the `UPDATE`, validate that exact stored definition against the requested document type:

```js
    // Activation used to trust that a revision validated when it was saved. A
    // stricter validator (or a hand-edited row) can make a stored revision
    // invalid after the fact; publishing it would ship a broken document.
    normalizedDefinition(docType, revisionRows[0].definition_json);
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateManager.test.js`
Expected: PASS

- [ ] **Step 5: Prove the fix by mutation**

Revert the `'note'` entry in the required-path array, re-run, confirm the first test goes red, then restore it. A required-field rule that does not go red when removed is not testing anything.

- [ ] **Step 6: Commit**

```bash
git add backend/services/printTemplateEngine.js backend/services/printTemplateManager.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateManager.test.js
git commit -m "fix(print-templates): require the item note on receipt rows"
```

---

### Task 2: Render bundle children as children on the built-in receipt

**Files:**
- Modify: `backend/services/printTemplateDefaults.js:60-69` (item repeat band), `:218-268` (fixtures)
- Test: `backend/tests/unit/printTemplateParity.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a new fixture key `receipt-bundle` from `listTemplateFixtures('receipt')`, usable by the admin preview dropdown.

- [ ] **Step 1: Write the failing test**

```js
it('renders a bundle child as an indented child line with no money column', async () => {
    const model = getTemplateFixture('receipt', 'receipt-bundle');
    const child = model.rows.find(row => row.kind === 'bundle_child');
    expect(child).toBeTruthy();

    const result = await compileTemplate(getBuiltinTemplate('receipt'), model, {
        mode: 'preview', templateRevisionId: 'preview:unpublished',
        profile: { allowAbsoluteOnce: true, allowStoreLogo: true }
    });

    const html = result.artifact.html;
    const childStart = html.indexOf('data-node="receipt-item-child"');
    expect(childStart).toBeGreaterThan(-1);
    const childRegion = html.slice(childStart, childStart + 500);
    expect(childRegion).toContain(child.name);
    expect(childRegion).not.toContain('receipt-item-total');
    expect(childRegion).not.toMatch(/0\.00(?:\s+JD)?/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/printTemplateParity.test.js`
Expected: FAIL — first on the missing `receipt-bundle` fixture, then on the `0.00` money column once the fixture exists.

- [ ] **Step 3: Add the fixture**

In the `FIXTURES.receipt` object in `printTemplateDefaults.js`, alongside `receipt-basic`, add a `receipt-bundle` entry. Copy `receipt-basic` and insert a child row directly after its first item, matching exactly what `ReceiptPresentation.normalizeLine` emits for a bundle child (`ReceiptPresentation.js:17-55` — `netAmount` and `extendedPrice` are forced to `0`, and `:180-181` forbids any discount on a child):

```js
{ key: 'row-bundle-child', kind: 'bundle_child', name: 'Fries', note: null, qty: 1,
  unitPrice: 0, extendedPrice: 0, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 0 }
```

- [ ] **Step 4: Split the item repeat band by `kind`**

`kind` is already in `RECEIPT_ROW` (`printTemplateEngine.js:62`) and `visibleWhen` supports `eq`/`neq` on a text field, so this needs no engine change. In `receiptBlocks()`, give the existing positioned row a parent-only condition and add a sibling child line:

```js
repeat('items', 'rows', null, [
    { id: 'receipt-item-row', type: 'row', layout: 'absolute', height: 40,
      style: { fontSize: 'item', fontWeight: 'bold', marginBottom: 4 },
      visibleWhen: { path: 'kind', op: 'neq', value: 'bundle_child' },
      nodes: [ /* qty, name, netAmount — unchanged */ ] },
    // Bundle children carry no money of their own (netAmount is forced to 0
    // upstream), so they print as an indented child line with no total column,
    // matching what the spooler's own renderer has always shown.
    field('receipt-item-child', 'name', '', { fontSize: 'note', marginInlineStart: 64, marginBottom: 4 },
          { path: 'kind', op: 'eq', value: 'bundle_child' }),
    field('receipt-item-note', 'note', '', /* unchanged */),
    field('receipt-item-discount-label', /* unchanged */),
    field('receipt-item-discount-amount', /* unchanged */)
]),
```

**Note for the implementer:** `validateReceiptStructure` counts `name`/`qty`/`netAmount` instances in the primary band and rejects any that are `hidden` — where `hidden` includes "carries a `visibleWhen`" (`:220`). Adding `visibleWhen` to `receipt-item-row` therefore makes its three children conditional and **will fail** `TEMPLATE_REQUIRED_STRUCTURE_HIDDEN`. Run the test after this step to see it. Resolve it in Step 5, not here.

- [ ] **Step 5: Resolve the required-visibility conflict**

The engine must accept a required row field gated on `kind` — that is a data partition, not a way to suppress money. Mirror the existing `canonicalKitchenFilter` approach (`:292-294`), which already whitelists one exact condition shape:

```js
// A `kind` partition splits parent rows from bundle children; it is not a
// visibility escape hatch, because every row still matches exactly one branch.
// Same reasoning as canonicalKitchenFilter's isOther split at :292.
const isCanonicalRowKindBranch = condition =>
    condition !== null && condition.path === 'kind' &&
    ['eq', 'neq'].includes(condition.op) && condition.value === 'bundle_child';

const hasOnlyCanonicalRowKindBranch = field =>
    field.visibility.length === 1 && isCanonicalRowKindBranch(field.visibility[0]);
```

Use `hasOnlyCanonicalRowKindBranch(field)` in the receipt required-field check so the required `name`/`qty`/`netAmount` fields are accepted only when their sole visibility condition is the exact non-child partition. Do not whitelist arbitrary additional conditions or manual `hidden:true`.

- [ ] **Step 6: Run to verify it passes, and refresh the goldens**

Run: `npx vitest run backend/tests/unit/printTemplateParity.test.js backend/tests/unit/printTemplateEngine.test.js`
Expected: PASS. `ARTIFACT_GOLDENS` (`printTemplateParity.test.js:14-27`) are SHA-256 snapshots of compiled artifacts. Regenerate only keys that actually changed (the existing `receipt-bundle-service-charge` case is expected to change); do not blindly rewrite every receipt hash. Add an assertion that `listTemplateFixtures('receipt')` contains `receipt-bundle`.

- [ ] **Step 7: Commit**

```bash
git add backend/services/printTemplateDefaults.js backend/services/printTemplateEngine.js backend/tests/unit/printTemplateParity.test.js
git commit -m "fix(print-templates): print bundle children without a money column"
```

---

### Task 3: Stop boolean bindings printing `true` / `false`

**Files:**
- Modify: `backend/services/printTemplateEngine.js:546`
- Test: `backend/tests/unit/printTemplateEngine.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('renders a boolean field as its label when true and omits the node when false', async () => {
    const render = async voidTicket => {
        const model = { ...getTemplateFixture('kitchen', 'kitchen-normal'), voidTicket };
        const definition = kitchenTemplate();
        definition.bands[0].nodes.push(field('void-ticket-flag', 'voidTicket', {
            label: label('VOID')
        }));
        const result = await compileTemplate(definition, model, {
            mode: 'preview', templateRevisionId: 'preview:unpublished',
            profile: { allowAbsoluteOnce: true, allowStoreLogo: true }
        });
        return result.artifact.html;
    };
    expect(await render(true)).toContain('VOID');
    expect(await render(false)).not.toContain('data-node="void-ticket-flag"');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/printTemplateEngine.test.js -t boolean`
Expected: FAIL — the rendered HTML contains the literal `false`.

- [ ] **Step 3: Implement**

In `renderNode`, after resolving `rawValue` and before formatting, omit a false boolean node. Then make a true boolean format as an empty value so the node's label is the visible text:

```js
    // A boolean binding exists to switch a line on, not to print English. True
    // renders the node's own label; false renders nothing, matching how an empty
    // text binding already blanks its node at :580.
    if (entry.type === 'boolean' && rawValue === false) return '';
    // inside formatField:
    if (entry.type === 'boolean') formatted = '';
```

Do not rely on `escapeHtml(null)` to remove the node: it returns an empty string but still renders the label wrapper. Verify the true case still renders the label and the false case emits no `data-node` element.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/tests/unit/printTemplateEngine.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/printTemplateEngine.js backend/tests/unit/printTemplateEngine.test.js
git commit -m "fix(print-templates): stop boolean fields printing true and false"
```

---

## Phase 1 — Remove the invented constraints

### Task 4: Keep the last good preview when a draft is invalid

Prerequisite for Task 5: once locks are gone, invalid intermediate states are normal, and blanking the canvas on every one of them is unusable.

**Files:**
- Modify: `src/admin/composables/usePrintTemplates.js:118-146`
- Modify: `src/admin/pages/PrintTemplates.vue` (render the new banner)
- Test: `src/admin/composables/__tests__/usePrintTemplates.spec.js`

**Interfaces:**
- Produces: `validationError` — a `ref<string>` exported from `usePrintTemplates()`, non-empty only while the current draft fails server validation. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Use a real loaded workspace. Mock, in order: the workspace response, one successful preview, then one 422 preview. Do not call `preview()` before `loadWorkspace()` because `loading` starts true and no fixture is selected.

```js
it('keeps the previous artifact and reports the reason when a draft fails validation', async () => {
    const definition = receiptDefinitionFixture();
    fetchJsonResponse
        .mockResolvedValueOnce(workspaceResponse(definition))
        .mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: { success: true, artifact: { html: 'good' }, warnings: [] } })
        .mockResolvedValueOnce({ response: { ok: false, status: 422 }, data: { success: false, code: 'TEMPLATE_REQUIRED_STRUCTURE_MISSING', message: 'Receipt primary row requires note' } });

    const templates = usePrintTemplates();
    await templates.loadWorkspace();
    await templates.preview();                       // first, valid
    const good = templates.previewArtifact.value;
    expect(good).toBeTruthy();

    await templates.preview();

    expect(templates.previewArtifact.value).toBe(good);
    expect(templates.validationError.value).toBe('Receipt primary row requires note');
    expect(templates.error.value).toBe('');
});
```

Add tiny `receiptDefinitionFixture()` and `workspaceResponse()` helpers beside the existing test setup. Keep them local to this file; no production test utility is needed.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/admin/composables/__tests__/usePrintTemplates.spec.js`
Expected: FAIL — `previewArtifact` is `null` and `validationError` is undefined.

- [ ] **Step 3: Implement**

Add `const validationError = ref('');` beside the other refs, return it from the composable, and replace the `catch` block at `:139-142`:

```js
        } catch (previewError) {
            if (previewError.name === 'AbortError' || controller.signal.aborted || previewController !== controller) return;
            // A validation rejection is an expected editing state, not a failure:
            // the admin is mid-edit. Keep the last good paper on screen and say
            // what is wrong. Anything else is a real error and still blanks.
            if (previewError.status === 422) { validationError.value = previewError.message; return; }
            previewArtifact.value = null;
            previewWarnings.value = [];
            error.value = previewError.message;
        }
```

Clear `validationError.value = ''` on every successful preview, next to `previewArtifact.value = data.artifact`. Confirm `errorFor()` carries `response.status` onto the thrown error; if it does not, add it there rather than re-parsing the message.

In `PrintTemplates.vue`, render `validationError` as a persistent inline banner above the preview with class `print-template-validation` and `role="status"` — not a modal, not a toast. It must not disable Save; the server remains the authority and will 422 on its own.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/admin/composables/__tests__/usePrintTemplates.spec.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/composables/usePrintTemplates.js src/admin/pages/PrintTemplates.vue src/admin/composables/__tests__/usePrintTemplates.spec.js
git commit -m "feat(print-templates): keep the preview alive while a draft is invalid"
```

---

### Task 5: Delete the UI lock model

**Files:**
- Modify: `src/admin/components/PrintTemplateEditor.vue` — remove `requiredField` (`:260-266`), `isLockedNode` (`:267`), `isLockedBand` (`:268`), every template/computed/style reference to them, and the associated guard clauses
- Test: `tests/e2e/specs/admin.print-templates.spec.js`

**Interfaces:**
- Consumes: `validationError` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Write the failing e2e test**

```js
test('lets an admin delete a required field and shows what the server rejects', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const subtotal = workspace.locator('.print-template-editor__node').filter({ hasText: 'summary.subtotal' });
    await subtotal.getByRole('button', { name: 'Content block actions' }).click();
    await subtotal.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('.print-template-validation')).toContainText(/subtotal/i);
    // the paper must still be on screen — an invalid draft is an editing state
    await expect(page.locator('.print-template-preview__paper')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "delete a required field"`
Expected: FAIL — the Delete button is disabled, so the click times out.

- [ ] **Step 3: Implement**

Delete the three functions and **all** references to them: lock badges/classes, `canEditVisibility`, disabled bindings, and mutation guards. End with `rg -n "requiredField|isLockedNode|isLockedBand" src/admin/components/PrintTemplateEditor.vue` returning no matches. Keep `isOnlyBandNode` in `deleteNode`'s guard — it mirrors `TEMPLATE_EMPTY_BAND`. Keep `canAddToBand` and `hasQr` untouched — they mirror engine rules `:269`, `:276`, `:384`.

`deleteNode` becomes:

```js
function deleteNode(entry) {
    if (isOnlyBandNode(entry)) return;   // mirrors TEMPLATE_EMPTY_BAND at engine :444
    entry.siblings.splice(entry.index, 1); selectBand(entry.band); sync();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js`
Expected: PASS. The existing test `uses one built-in layout and lets an admin hide optional printed elements` (`:62`) may assert disabled states — update it to the new behaviour rather than restoring a lock.

- [ ] **Step 5: Verify the invariant still holds server-side**

Run: `npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/printTemplates.test.js`
Expected: PASS — deleting a required field must still be rejected at save. If any of these go green *because* the check moved to the client, the task has failed.

- [ ] **Step 6: Commit**

```bash
git add src/admin/components/PrintTemplateEditor.vue tests/e2e/specs/admin.print-templates.spec.js
git commit -m "refactor(print-templates): let the engine own template validity"
```

---

### Task 6: Unblock movement — drop the gate, the modals, and fill-to-container sizing

**Files:**
- Modify: `src/admin/components/PrintTemplatePreview.vue:151-157` (the 1100px gate)
- Modify: `src/admin/components/PrintTemplateEditor.vue:329,333,363,367` (four confirms), `:323-324` (`nodeBox`/`defaultPosition`), `:343-358` (`placeAdjacentItemBeside`)
- Modify: `backend/services/printTemplateEngine.js`, `printTemplateManager.js`, `printDocumentCompiler.js`, `routes/admin/printTemplates.js` (remove `allowAbsoluteOnce`)
- Test: `tests/e2e/specs/admin.print-templates.spec.js`

- [ ] **Step 1: Write the failing e2e test**

```js
test('a positioned element has room to move on both axes', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await page.setViewportSize({ width: 1024, height: 900 });   // below the old 1100 gate
    const total = page.locator('[data-editor-node-id="receipt-item-total"]');
    const before = await total.boundingBox();
    await dragBy(page, total, -24, 4);
    const after = await total.boundingBox();
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
});
```

Define `dragBy(page, locator, dx, dy)` beside the existing Playwright tests using `boundingBox()`, `page.mouse.down()`, one moved point, and `page.mouse.up()`. Do not assume a helper that is not currently in the file. The negative X delta is deliberate: the built-in total column sits against the right edge, so moving farther right must remain clamped.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "room to move"`
Expected: FAIL because the drag handler returns early below 1100px. Container-bound clamping remains correct.

- [ ] **Step 3: Remove the viewport gate**

In `PrintTemplatePreview.vue`, delete the `window.innerWidth` condition from `selectFromPreview` (`:151`) and `startPosition` (`:157`). Pointer Events already cover touch; the numeric X/Y inputs remain as the keyboard and small-screen path. Do not add a second mobile code path. Add `:data-editor-node-id="entry.node.id"` to each outer overlay button; tests must target the editor overlay, not unreachable iframe internals.

- [ ] **Step 4: Stop sizing children to fill their container**

`placeAdjacentItemBeside` (`:349-352`) gives its two children `heightPx: rowHeight - 4` and widths summing to exactly 556, which leaves no group travel. Place the pair inside an 8px inset on every side: divide 540px (`556 - 16`) between the children, start the first at `x:8`, make the second touch it, set `y:4`, and leave 4px below. This preserves a real outer margin without changing the engine.

```js
// Leave slack on purpose. A box that exactly fills its container clamps to zero
// travel in clampedMoves, which reads to the user as "it will not move".
const POSITION_SLACK_PX = 8;
```

Apply the same principle to `defaultPosition` (`:324`). The editor has no preview-DOM measurement input, so do **not** invent one: pass the container width and use a deterministic fallback of `Math.min(240, containerWidth - 16)` for ordinary nodes, with the existing intrinsic square size for QR/logo. Keep full-width divider/spacer behavior inset by 8px.

- [ ] **Step 5: Remove the four layout confirm modals**

Delete the `window.showAdminConfirm` calls in `toggleBandLayout` (`:329`, `:333`) and `toggleRowLayout` (`:363`, `:367`). Flow→absolute is non-destructive. Absolute→flow does drop coordinates, so make that direction reversible without a modal: keep snapshots in a module-local `Map` keyed by container id and child id. Never attach backup properties to template nodes; `sync()` clones the node tree and would persist them, while the engine rejects unknown keys. Clear stale snapshots when a genuinely different definition replaces the editor draft.

- [ ] **Step 6: Delete the dead feature flag**

Remove the `profile.allowAbsoluteOnce` checks and both associated `TEMPLATE_FEATURE_NOT_ENABLED` throws (`:250`, `:429`), then remove the dead property everywhere `rg -n "allowAbsoluteOnce" backend src tests` finds it. This includes `printTemplateEngine.test.js`, `printTemplateParity.test.js`, and `spoolerPackageContract.test.js`, not just production call sites. Rewrite the feature-gate unit test so absolute layout is accepted while `allowStoreLogo` remains gated. Keep the `profile` object only for `allowStoreLogo`.

- [ ] **Step 7: Run the full check**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js` then `npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/admin/components/PrintTemplatePreview.vue src/admin/components/PrintTemplateEditor.vue backend/services/printTemplateEngine.js backend/services/printTemplateManager.js backend/services/printDocumentCompiler.js backend/routes/admin/printTemplates.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/spoolerPackageContract.test.js tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): give positioned elements room to move"
```

---

## Phase 2 — The three missing gestures

### Task 7: Insert elements into a positioned row

**Files:**
- Modify: `src/admin/components/PrintTemplateEditor.vue:295-300` (`addNode`), `:310-320` (drop handlers), template drop targets
- Modify: `src/shared/i18n/ar.json` (one natural allocation-error translation)
- Test: `tests/e2e/specs/admin.print-templates.spec.js`

**Interfaces:**
- Consumes: deterministic positioned sizing from Task 6.
- Produces: `addNode(type, { container, band }, index)` where `container` is a band or a `row`, and `band` is always the owning band used for catalog/QR/logo rules.

- [ ] **Step 1: Write the failing e2e test**

```js
test('adds a fourth column to the item row', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await workspace.locator('.print-template-editor__select').filter({ hasText: 'receipt-item-row' }).click();
    await page.getByRole('button', { name: /add field/i }).click();
    await page.getByLabel('Field').selectOption('unitPrice');

    const paper = workspace.locator('iframe[title="Screen layout preview"]').contentFrame();
    await expect(paper.locator('[data-node="receipt-item-row"] [data-node]')).toHaveCount(4);
    await page.getByRole('button', { name: /save revision/i }).click();
    await expect(page.locator('.print-template-validation')).toHaveCount(0);
});
```

Evidence E1 proves the server accepts this shape, so a validation failure here means the editor produced bad geometry, not that the engine refused a fourth column.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "fourth column"`
Expected: FAIL — the new node lands in the band, so the row still has three children.

- [ ] **Step 3: Generalise `addNode` to any container**

```js
// A container is a band or an absolute row — both hold a `nodes` array, and the
// engine validates a row's children exactly like a band's (engine :258-259).
function targetFor(entry) {
    return entry?.node?.type === 'row'
        ? { container: entry.node, band: entry.band }
        : { container: entry?.band || targetBand.value, band: entry?.band || targetBand.value };
}

function addNode(type, target = targetFor(selectedEntry.value), index = target?.container?.nodes?.length) {
    const { container, band } = target || {};
    if (!container || !band) return;
    if (!canAddToBand(type, band)) return;          // QR/logo band rules still apply
    const node = makeNode(type, band);
    if (container.layout === 'absolute') Object.assign(node, defaultPosition(container, node));
    container.nodes.splice(index, 0, node); selectNode(node); sync(); emit('request-properties');
}
```

`canAddToBand` and `makeNode` must keep receiving the owning **band**, not the selected band and not the row — field catalogs and QR/logo rules are band-scoped. A drop into a row belonging to a non-selected band must still use that row's real band.

- [ ] **Step 4: Make rows a drop target**

In `dropOnNode` (`:317`), when the drop target is a `row` and the payload is a palette drag, insert into `row.nodes` at the computed index rather than appending to the band. Keep the existing same-parent restriction for reordering drags. Moving existing nodes between containers is out of scope; Task 8 resizes columns and does not provide cross-container moves.

- [ ] **Step 5: Give a new column real geometry**

A new child in an absolute row must not overlap its siblings on arrival. First use the widest grid-aligned gap of at least `MIN_COLUMN_PX` (16px). If none exists, split the widest sibling only when both resulting widths remain at least 16px: shrink that sibling and place the new node in the released touching span. If no legal span exists, leave the definition unchanged and show `No room remains in this row. Resize or remove a column first.` inline; add the natural Arabic catalog entry `لا توجد مساحة كافية في هذا الصف. غيّر حجم أحد الأعمدة أو احذف عمودًا أولًا.` Do not insert invalid geometry or silently do nothing. Keep every box within the row's actual 556px bounds.

- [ ] **Step 6: Run to verify it passes**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/admin/components/PrintTemplateEditor.vue src/shared/i18n/ar.json tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): add elements inside a positioned row"
```

---

### Task 8: Column divider resize

**Files:**
- Modify: `src/admin/components/PrintTemplatePreview.vue` — `interactiveNodes` (`:86-93`), overlay template (`:21-27`), `startPosition` (`:156-206`)
- Modify: `src/admin/pages/PrintTemplates.vue:198-199` (`movePreviewNodes`)
- Test: `tests/e2e/specs/admin.print-templates.spec.js`

**Interfaces:**
- Consumes: nothing.
- Produces: replaces the `move-node` / `move-nodes` emits with one `patch-nodes` emit carrying `Array<{ id, x?, y?, widthPx?, heightPx? }>`. `PrintTemplates.vue` applies each patch to its cloned definition and sends one draft update.

- [ ] **Step 1: Write the failing e2e test**

```js
test('dragging the divider between two columns resizes both', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const qty = page.locator('[data-editor-node-id="receipt-item-qty"]');
    const name = page.locator('[data-editor-node-id="receipt-item-name"]');
    const qtyBefore = await qty.boundingBox();
    const nameBefore = await name.boundingBox();

    await dragBy(page, page.locator('[data-divider="receipt-item-qty|receipt-item-name"]'), 40, 0);

    const qtyAfter = await qty.boundingBox();
    const nameAfter = await name.boundingBox();
    expect(qtyAfter.width).toBeGreaterThan(qtyBefore.width);
    expect(nameAfter.width).toBeLessThan(nameBefore.width);
    expect(Math.round(qtyAfter.width + nameAfter.width)).toBe(Math.round(qtyBefore.width + nameBefore.width));
});
```

The third assertion is the point: the pair's combined span is conserved. Without it the test would pass on today's unilateral resize, which grows one element *over* its neighbour.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "divider"`
Expected: FAIL — no `[data-divider]` element exists.

- [ ] **Step 3: Derive divider positions**

Add a computed that, for each absolute container, sorts its positioned children by `x` and yields a handle between each adjacent pair:

```js
const columnDividers = computed(() => {
    const byContainer = new Map();
    for (const entry of interactiveNodes.value) {
        if (!entry.positioned) continue;
        if (!byContainer.has(entry.containerKey)) byContainer.set(entry.containerKey, []);
        byContainer.get(entry.containerKey).push(entry);
    }
    const handles = [];
    for (const entries of byContainer.values()) {
        const sorted = [...entries].sort((a, b) => a.node.x - b.node.x);
        for (let index = 0; index < sorted.length - 1; index += 1) {
            const left = sorted[index]; const right = sorted[index + 1];
            if (left.node.x + left.node.widthPx !== right.node.x) continue; // only touching columns have a real shared boundary
            handles.push({ key: `${left.node.id}|${right.node.id}`, left, right });
        }
    }
    return handles;
});
```

- [ ] **Step 4: Implement the conserving drag**

```js
// Move the boundary, never the pair's outer edges: the left column gains
// exactly what the right column loses, so the row's total span is unchanged.
function resizeColumns(handle, dx) {
    const { left, right } = handle;
    const offset = Math.max(MIN_COLUMN_PX - left.node.widthPx,
                   Math.min(right.node.widthPx - MIN_COLUMN_PX, snap(dx)));
    return [
        { id: left.node.id, widthPx: left.node.widthPx + offset },
        { id: right.node.id, x: right.node.x + offset, widthPx: right.node.widthPx - offset }
    ];
}
```

`MIN_COLUMN_PX` must be at least the engine's 4px floor (`validateAbsoluteBox`, `:200`); use 16 so a column stays grabbable.

The upper clamp is based on the **right column's width**, not the pair span. Using the span admits a negative right width whenever a gap exists.

- [ ] **Step 5: Render the handles**

Add a sibling loop to the overlay with `:data-divider="handle.key"`. Derive screen placement from the measured left/right `nodeRects` (the stage is scaled): center an 8px hit target on `rightRect.left`, span the shared row height, and keep it above the marquee surface but below focused node labels. Give each an `aria-label` naming both columns and support Left/Right arrows for keyboard resizing through the same `resizeColumns` function. Do not render a handle when either measured rect is missing.

- [ ] **Step 6: Widen the emit and drop the two-element assertion**

Replace `move-node`/`move-nodes` with `patch-nodes`, and delete the `moves.length !== 2` check in `PrintTemplates.vue:198-199`. Keep the single atomic draft update on `pointerup` — the mid-drag local styling path (`:185-191`) is what keeps the preview from reloading during a gesture and must survive.

- [ ] **Step 7: Run to verify it passes**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/admin/components/PrintTemplatePreview.vue src/admin/pages/PrintTemplates.vue tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): resize columns from their shared divider"
```

---

### Task 9: Real multi-selection

**Files:**
- Modify: `src/admin/pages/PrintTemplates.vue:135-136`, `:155`, `:198-213`
- Modify: `src/admin/components/PrintTemplatePreview.vue:11` (pair status), `:123-129` (`canToggle`, `pairedEntries`), `:159-163`
- Modify: `src/shared/i18n/runtime.js`, `src/shared/i18n/ar.json`
- Test: `src/shared/__tests__/i18nCatalog.spec.js`
- Test: `tests/e2e/specs/admin.print-templates.spec.js`

**Interfaces:**
- Consumes: `patch-nodes` from Task 8.
- Produces: `selectedNodeIds` becomes an unbounded array of positioned nodes; `selectedNodeId` is always a member and is the most recently added primary. Marquee emits one atomic `set-selection` event rather than a burst of toggles.

- [ ] **Step 1: Write the failing e2e test**

```js
test('marquee-selects three elements and moves them together', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await marqueeOver(page, ['receipt-item-qty', 'receipt-item-name', 'receipt-item-total']);
    await expect(page.locator('.print-template-preview__selection-status')).toContainText('3 selected');

    const before = await boundingBoxes(page, ['receipt-item-qty', 'receipt-item-name', 'receipt-item-total']);
    await page.locator('[data-editor-node-id="receipt-item-total"]').focus();
    await page.keyboard.press('ArrowDown');
    const after = await boundingBoxes(page, ['receipt-item-qty', 'receipt-item-name', 'receipt-item-total']);
    for (const id of Object.keys(before)) expect(after[id].y - before[id].y).toBe(4);
});
```

Define `boundingBoxes(page, ids)` and `marqueeOver(page, ids)` in this test file using `[data-editor-node-id]`. `marqueeOver` must compute the union of the requested overlay buttons' `boundingBox()` values, start just outside the first box, and drag just outside the union. Do not assume helpers that do not exist at the reviewed fixed point. Focus one selected overlay button before sending arrow keys; the marquee surface itself does not own the existing keyboard movement handler.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "marquee"`
Expected: FAIL — selection caps at two and there is no marquee surface.

- [ ] **Step 3: Remove the two-element cap**

Replace `togglePreviewNode` (`PrintTemplates.vue:210-213`) with a set toggle that also maintains the primary invariant: adding an id makes it `selectedNodeId`; removing the primary promotes the most recently added remaining id; the array is never non-empty while the primary sits outside it. Add `setPreviewSelection(ids, primaryId)` for marquee's one atomic event. Delete `pairedEntries` (`:127-129`) and replace it with `movableEntries(entry)`, which returns the selected entries only when all are positioned; otherwise it returns just the interacted positioned entry. `clampedMoves` already generalises to N positioned entries.

- [ ] **Step 4: Relax `canToggle`**

Today it requires both nodes to share a `containerKey` (`:123-126`). Remove the two-item/same-container restriction for **positioned** selection: positioned nodes across containers can share one delta because `clampedMoves` intersects each node's local legal range. Do not include flow nodes in marquee or group movement; they have no `x/y/widthPx/heightPx`, and passing them to `clampedMoves` produces `NaN`. Shared-property multi-edit is not part of this plan, so do not claim or build it.

- [ ] **Step 5: Add the marquee surface**

Add a full-size `<div>` behind the overlay buttons that starts a rubber-band only on `pointerdown.self`. Convert viewport pointer coordinates back into the 576px model using the stage `getBoundingClientRect()` and `scale`; `nodeRects` are unscaled model coordinates. Track the model-space rect locally, render it as an outline, and on `pointerup` atomically emit every **positioned** entry whose measured rect intersects it. Shift-drag unions those ids with the current positioned selection. Use the same pointer-capture/cleanup idiom as `startPosition`, and ensure divider and node controls remain above the marquee hit surface.

- [ ] **Step 6: Replace the pair status UI**

`PrintTemplatePreview.vue:11` renders a `2 selected` chip gated on `selectedIds.length === 2`. Rename the class to `print-template-preview__selection-status`, render `{{ selectedIds.length }} selected` for any count above one, rename the accessible action to `Clear selection`, and keep the polite live region. Update the existing pair-selection E2E assertions rather than deleting them.

Add `Clear selection: إلغاء التحديد` to `ar.json` and one dynamic `^([0-9]+) selected$` rule in `runtime.js` so Arabic does not fall back to English for three or more selections. Preserve the existing natural dual form for `2 selected`; cover `2 selected` and `3 selected` in `i18nCatalog.spec.js`.

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/shared/__tests__/i18nCatalog.spec.js` then `npx playwright test tests/e2e/specs/admin.print-templates.spec.js`
Expected: PASS. The existing test `moves exactly two positioned sibling elements together without preview reloads` (`:127`) is now a special case of group movement — rewrite it as a two-element case of the same behaviour rather than deleting the coverage.

- [ ] **Step 8: Commit**

```bash
git add src/admin/pages/PrintTemplates.vue src/admin/components/PrintTemplatePreview.vue src/shared/i18n/runtime.js src/shared/i18n/ar.json src/shared/__tests__/i18nCatalog.spec.js tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): select and move any number of elements"
```

---

## Completion gate

- [ ] `npx vitest run` — full backend suite, exactly once, green.
- [ ] `npx playwright test tests/e2e/specs/admin.print-templates.spec.js` — green.
- [ ] `npm run build` — green.
- [ ] `npm run architecture:check` — green. The traced print flow does not change (compilation still happens at the enqueue seam), so `docs/architecture.json` should need no edit; confirm rather than assume.
- [ ] Manually confirm in the builder: add a fourth column to the item row, drag its divider, marquee three elements and nudge them, delete a required field and read the inline reason, then restore it and save.
- [ ] Confirm a published revision still prints: save, publish, and print one receipt through a real spooler. The engine changes in Tasks 1–3 alter compiled output, so paper proof is warranted here even though the plan changes no transport.

## Self-review notes

**Sequencing that matters.** Task 1 before Task 5 — removing the locks without requiring `note` makes an existing silent defect easier to trigger. Task 4 before Task 5 — invalid intermediate states become normal once locks are gone, and blanking the canvas on each one is unusable. Task 8 before Task 9 — Task 8 introduces the `patch-nodes` emit that Task 9's group movement depends on.

**Known conflict, deliberately surfaced.** Task 2 Step 4 will fail validation on purpose; Step 5 resolves it. That is written as two steps rather than one so the implementer sees the engine's `hidden` semantics (`:220`) directly instead of working around them.

**What this plan does not do.** It does not touch the binding system — one-node-one-field, the fixed money format, the absent date formatting, and the hand-maintained catalog (`printTemplateEngine.js:44-77`) are all real gaps but none of them block the movement, selection, resizing, or insertion problems this plan exists to fix. They belong to a second plan. It also does not address the browser receipt path, where `print_method` defaults to `'browser'` (`src/pos/useTerminal.js:24`) and published templates have no effect at all — that is part of the deferred source-of-truth work and should be decided before any client is told their custom template is live.

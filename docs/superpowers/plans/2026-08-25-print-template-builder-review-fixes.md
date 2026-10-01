# Print Template Builder — Review Fixes

> **For agentic workers:** Execute in order on `codex/print-template-builder-correction`. Tasks 1–2 must land before anything else ships.

**Goal:** Close the eleven findings from the task-by-task review of the builder correction branch.

**Scope:** Fixes only. No new capability, no schema change, no migration. Same global constraints as `2026-08-25-print-template-builder-correction.md`.

**Reviewed fixed point:** branch head `37856ae7`.

## Findings map

| ID | Sev | Where | Task |
|---|---|---|---|
| F1 | HIGH | `printTemplateEngine.js:339` | 1 |
| F7 | HIGH | `PrintTemplateEditor.vue:302` | 2 |
| F8 | MED | `PrintTemplateEditor.vue:307` | 3 |
| F9 | MED | `PrintTemplateEditor.vue` `columnPosition` | 3 |
| F5 | MED | `PrintTemplateEditor.vue:329-330` | 4 |
| F6 | MED | `PrintTemplateEditor.vue` `toggleBandLayout`/`toggleRowLayout` | 4 |
| F10 | MED | `PrintTemplatePreview.vue` `startDivider` | 5 |
| F11 | MED | `PrintTemplatePreview.vue` `startDivider` | 5 |
| F2 | MED | `printTemplateParity.test.js` | 6 |
| F3 | LOW | `printTemplateEngine.test.js` | 6 |
| F4 | MED | missing e2e for Tasks 5/6/7 | 6 |

---

## Task 1: Pin the bundle-child branch direction (F1)

A template gated `kind eq bundle_child` on the money row currently validates and prints a receipt with **no priced line items** but a full total.

**Files:** `backend/services/printTemplateEngine.js`, `backend/tests/unit/printTemplateEngine.test.js`

- [ ] **Step 1: Failing test**

```js
it('rejects a receipt whose money row renders only for bundle children', () => {
    const definition = getBuiltinTemplate('receipt');
    const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
    items.nodes.find(node => node.id === 'receipt-item-row').visibleWhen = { path: 'kind', op: 'eq', value: 'bundle_child' };
    expect(() => validateTemplate(definition, { allowStoreLogo: true }))
        .toThrow(/cannot be hidden/);
});
```

- [ ] **Step 2:** `npx vitest run backend/tests/unit/printTemplateEngine.test.js -t "only for bundle children"` → FAIL (no throw).

- [ ] **Step 3: Implement.** Replace `hasOnlyCanonicalRowKindBranch` and flip the check from "no instance may be hidden" to "at least one instance qualifies", so the built-in's `eq`-gated child line stays legal:

```js
// Only the parent branch may gate a required money field. `eq bundle_child`
// would hide every paid line — exactly what this rule exists to prevent.
// Kitchen pins its isOther split the same way at canonicalKitchenFilter.
function isParentRowKindBranch(field) {
    return field.visibility.length === 1 && field.visibility[0]?.path === 'kind' &&
        field.visibility[0]?.op === 'neq' && field.visibility[0]?.value === 'bundle_child';
}
```

In `validateReceiptStructure`:

```js
        if (path !== 'note' && !fields.some(field => !field.hidden || isParentRowKindBranch(field))) {
            fail('TEMPLATE_REQUIRED_STRUCTURE_HIDDEN', `Receipt primary row ${path} cannot be hidden`);
        }
```

Delete `isCanonicalRowKindBranch` and `hasOnlyCanonicalRowKindBranch` — nothing else calls them.

- [ ] **Step 4:** `npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js` → PASS. The built-in must still validate (its row is `neq`).

- [ ] **Step 5: Mutation.** Restore `['eq','neq'].includes(op)`; the new test must go red. Restore the fix.

- [ ] **Step 6: Commit** — `fix(print-templates): keep every paid line on the receipt`

---

## Task 2: Fix the `$t` crash (F7)

`$t` is only `app.config.globalProperties.$t` — templates only. In `<script setup>` it is an undefined identifier and throws. Confirmed present in the built bundle.

**Files:** `src/admin/components/PrintTemplateEditor.vue`, `src/admin/pages/__tests__/printTemplatesPage.spec.js`

- [ ] **Step 1: Failing guard test.** The page spec already source-scrapes; add a rule that catches this class permanently:

```js
it('never calls the template-only $t helper from script scope', () => {
    const script = editor.slice(editor.indexOf('<script setup>'));
    expect(script).not.toMatch(/\$t\(/);
});
```

- [ ] **Step 2:** `npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js` → FAIL.

- [ ] **Step 3: Implement.** At `PrintTemplateEditor.vue:302`, `$t(` → `t(`. `t` is already imported at `:178`.

- [ ] **Step 4:** Re-run → PASS. Then `npm run build` and confirm the bundle no longer contains `$t("No room remains`.

- [ ] **Step 5: Commit** — `fix(print-templates): use the script-scope translator in the editor`

---

## Task 3: Column insertion geometry (F8, F9)

Two independent defects in the same function pair.

**F8:** `addNodeFromPalette` validates against one band and inserts into another, so adding a `store_logo` while the items band is selected drops it into a repeat band.

**F9:** the widest-column split leaves a 4px overlap whenever the column width is not a multiple of 8 — and Task 8's divider requires exact adjacency, so no handle appears to fix it.

**Files:** `src/admin/components/PrintTemplateEditor.vue`, `backend/tests/unit/` (none), `tests/e2e/specs/admin.print-templates.spec.js`

- [ ] **Step 1: Failing test** (pure-function level; extract nothing, assert through the e2e path)

```js
test('splitting a column leaves the pair exactly adjacent', async ({ page }) => {
    await openReceiptBuilder(page);
    await selectStructureNode(page, 'receipt-item-total');       // 132px, not a multiple of 8
    await resizeSelectedTo(page, { widthPx: 132 });
    await selectStructureNode(page, 'receipt-item-row');
    await page.getByRole('button', { name: /add field/i }).click();
    // a divider only renders between touching columns, so its presence proves adjacency
    await expect(page.locator('[data-divider]')).toHaveCount(3);
});
```

- [ ] **Step 2:** `npx playwright test tests/e2e/specs/admin.print-templates.spec.js -g "exactly adjacent"` → FAIL (2 dividers; the split pair overlaps).

- [ ] **Step 3: Fix F9.** In `columnPosition`, derive the new width as the remainder so the pair is adjacent by construction:

```js
    const widest = ordered.reduce((best, node) => !best || node.widthPx > best.widthPx ? node : best, null);
    if (!widest || widest.widthPx < 32) return null;
    // Split into keep + remainder. Deriving the new width from what is left over
    // guarantees the pair touches; halving both sides independently rounds apart
    // by 4px whenever the width is not a multiple of 8, and a non-touching pair
    // gets no divider handle to repair it.
    const keep = Math.floor((widest.widthPx / 2) / 4) * 4;
    const widthPx = widest.widthPx - keep;
    const x = widest.x + keep;
    widest.widthPx = keep;
    return { x, y: widest.y, widthPx, heightPx: widest.heightPx };
```

- [ ] **Step 4: Fix F8.** Insert into whichever band was validated:

```js
function addNodeFromPalette(type) {
    const target = targetFor();
    if (canAddToBand(type, target.band)) return addNode(type, target);
    // The selected band cannot hold this type. Fall back to a band that can —
    // and insert there too, rather than validating one band and splicing another.
    const band = draft.value.bands.find(item => canAddToBand(type, item));
    if (band) addNode(type, { container: band, band });
}
```

- [ ] **Step 5:** Re-run the e2e file → PASS.

- [ ] **Step 6: Commit** — `fix(print-templates): keep inserted columns adjacent and in their own band`

---

## Task 4: Restore safety on the layout toggle (F5, F6)

**F6:** absolute→flow silently deletes every coordinate — no confirm, no undo. Strictly less safe than before the branch.
**F5:** `nodeBox` still returns `widthPx: 360` for every node, so switching a band to Positioned produces elements that cannot sit side by side in 576px. This is the owner's original "put tax beside subtotal" scenario and it is still blocked.

**Files:** `src/admin/components/PrintTemplateEditor.vue`, `tests/e2e/specs/admin.print-templates.spec.js`

- [ ] **Step 1: Failing test**

```js
test('restores coordinates when positioning is switched off and back on', async ({ page }) => {
    await openReceiptBuilder(page);
    await selectStructureNode(page, 'receipt-item-total');
    const before = await readNodeBox(page, 'receipt-item-total');
    await page.getByRole('button', { name: /proportional/i }).click();
    await page.getByRole('button', { name: /position/i }).click();
    expect(await readNodeBox(page, 'receipt-item-total')).toEqual(before);
});

test('two elements fit side by side after enabling positioning', async ({ page }) => {
    await openReceiptBuilder(page);
    await selectStructureNode(page, 'totals');
    await page.getByRole('button', { name: /enable visual positioning/i }).click();
    const boxes = await readBandBoxes(page, 'totals');
    expect(Math.max(...boxes.map(box => box.widthPx))).toBeLessThanOrEqual(276);
});
```

- [ ] **Step 2:** Run both → FAIL (coordinates lost; widths are 360).

- [ ] **Step 3: Fix F6.** Stash coordinates in editor-only state, keyed by node id, and restore on the return trip. Never write the stash into the definition — `object()` at engine `:212` whitelists node properties and rejects unknown ones.

```js
const positionMemory = new Map();   // nodeId -> { x, y, widthPx, heightPx }

function dropPositions(nodes) {
    nodes.forEach(node => {
        if (Number.isInteger(node.x)) positionMemory.set(node.id, Object.fromEntries(POSITION_KEYS.map(key => [key, node[key]])));
        POSITION_KEYS.forEach(key => delete node[key]);
    });
}
function restorePositions(container, node) {
    const remembered = positionMemory.get(node.id);
    return remembered || (container.type === 'row' ? columnPosition(container) : defaultPosition(container, node));
}
```

Call `dropPositions` in both flow branches and `restorePositions` in both absolute branches.

- [ ] **Step 4: Fix F5.** Halve the default box so two elements fit in one band, and keep it on the 4px grid:

```js
// 360px is wider than half the 576px band, so two defaults can never sit side by
// side — which is the whole point of switching a band to Positioned.
function nodeBox(node) {
    const square = ['jofotara_qr', 'store_logo'].includes(node.type) ? node.size : null;
    if (square) return { widthPx: square, heightPx: square };
    return { widthPx: ['divider', 'spacer', 'row'].includes(node.type) ? 560 : 272, heightPx: node.type === 'row' ? node.height || 40 : 32 };
}
```

- [ ] **Step 5:** Re-run both tests → PASS. Re-run the whole e2e file — `positions a top-level element on both axes` asserts default geometry and may need its expected numbers updated.

- [ ] **Step 6: Commit** — `fix(print-templates): make positioning reversible and side-by-side capable`

---

## Task 5: Divider drag polish (F10, F11)

**F10:** no `pointercancel` handler, so a cancelled drag permanently leaks a global `pointermove` listener.
**F11:** `activeInteraction` is never set, so columns do not move until pointerup — the flagship gesture is performed blind.

**Files:** `src/admin/components/PrintTemplatePreview.vue`

- [ ] **Step 1: Failing test**

```js
test('shows both columns resizing while the divider is dragged', async ({ page }) => {
    await openReceiptBuilder(page);
    const divider = page.locator('[data-divider]').first();
    const qty = page.locator('[data-editor-node-id="receipt-item-qty"]');
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + 44, box.y + 4, { steps: 4 });
    const during = await qty.boundingBox();          // still held down
    await page.mouse.up();
    expect(during.width).toBeGreaterThan(60);
});
```

- [ ] **Step 2:** Run → FAIL (width unchanged until release).

- [ ] **Step 3: Implement.** Mirror `startPosition`: set `activeInteraction.value` on each move so the overlay follows, and register a `pointercancel` that clears listeners without emitting.

```js
function startDivider(event, handle) {
    event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); emit('interaction-start');
    const startX = event.clientX; let patches = null;
    const move = pointer => {
        patches = resizeColumns(handle, (pointer.clientX - startX) / scale.value);
        activeInteraction.value = { moves: patches, styles: resizeStyles(handle, patches) };
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
        activeInteraction.value = null;
    };
    // Without a cancel path a interrupted drag leaves `move` bound to window forever.
    const cancel = () => { cleanup(); emit('interaction-end', false); };
    const up = () => { cleanup(); if (patches) emit('patch-nodes', patches); emit('interaction-end', Boolean(patches)); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
}
```

`resizeStyles` builds the two overlay rects from `nodeRects` plus the patch, the same way `movementStyles` does for moves.

- [ ] **Step 4:** Re-run → PASS.

- [ ] **Step 5: Commit** — `feat(print-templates): show column widths while the divider moves`

---

## Task 6: Make the tests protect their fixes (F2, F3, F4)

Three tests do not fail when their fix is reverted, proven by mutation. Tasks 5, 6 and 7 of the previous plan shipped with no test at all.

**Files:** `backend/tests/unit/printTemplateParity.test.js`, `backend/tests/unit/printTemplateEngine.test.js`, `tests/e2e/specs/admin.print-templates.spec.js`

- [ ] **Step 1: Fix F2.** The bundle-child assertion slices forward from the child node, so a money row rendered *before* it is invisible to the test. Assert on the whole band instead:

```js
    const band = html.split('<section').find(section => section.includes('data-node="receipt-item-child"'));
    expect(band).toContain(child.name);
    expect(band).not.toContain('receipt-item-total');
```

- [ ] **Step 2: Fix F3.** The boolean test only proves the label renders. Add the missing half:

```js
    expect(await render(true)).not.toMatch(/>true</);
```

- [ ] **Step 3: Fix F4.** Add the three e2e tests the previous plan specified and that were never written — Task 5's `lets an admin delete a required field and shows what the server rejects`, Task 6's `a positioned element has room to move on both axes`, and Task 7's `adds a fourth column to the item row`. Copy them verbatim from `2026-08-25-print-template-builder-correction.md`.

- [ ] **Step 4: Mutation-prove all five.** For each: revert its fix, confirm that test alone goes red, restore. A test that stays green is not finished.

- [ ] **Step 5: Commit** — `test(print-templates): make builder tests fail when their fix is reverted`

---

## Completion gate

- [ ] `npx vitest run` — full suite, once, green. Baseline at branch head `37856ae7` was **282 files / 3116 tests, all passing** (~20 min). Any failure after these fixes is caused by them, not inherited.
- [ ] `npx playwright test tests/e2e/specs/admin.print-templates.spec.js` — green.
- [ ] `npm run build` — green, and `grep '$t("No room' dist/chunks/PrintTemplates-*.js` returns nothing.
- [ ] Re-run the F1 attack by hand: set the money row to `kind eq bundle_child`, confirm save is rejected.

## Not in scope

Deferred by owner decision and unchanged here: print-template-as-source-of-truth, the browser receipt path (`print_method` still defaults to `'browser'`, so published templates do nothing on those installs), default-vs-spooler parity, and the binding system (one-node-one-field, fixed money format, no date control, hand-maintained catalog).

Two known limitations left deliberately: `adjacentPlacement` still requires immediately-adjacent siblings, so pairing Subtotal with Tax still needs a reorder first; and `columnDividers` uses exact adjacency, so any gap between columns hides the handle.

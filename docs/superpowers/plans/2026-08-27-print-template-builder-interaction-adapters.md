# Print Template Builder Interaction Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing print-template builder feel like a real layout editor: directly resize a full-row element into a narrower column, add content beside it, marquee-select and move positioned elements, reorder structure on mouse or touch, and undo/redo changes without changing the print schema or creating a second rendering authority.

**Architecture:** The server-rendered `compiled_document_v1` iframe remains the visual truth. Vue interaction adapters target only the transparent editor overlay outside that iframe. They may display live movement, but they commit only snapped and bounded `x`, `y`, `widthPx`, `heightPx`, array-order, or row-wrapper changes back to `draftDefinition`. The existing backend validator/compiler remains the final authority, and the spooler continues to consume the compiled artifact unchanged.

**Tech Stack:** Vue 3.5, Vite 6, Vitest 4, Playwright 1.60, `@vueuse/core@14.4.0`, `vue3-moveable@0.28.0`, `vue3-selecto@1.12.3`, `vue-draggable-plus@0.6.1`.

## Global Constraints

- No database change, migration, template schema-version change, backend compiler change, spooler change, installer change, or deployment work.
- `backend/services/printTemplateEngine.js` stays authoritative: paper width 576px, positioned-row width 556px, 4px grid, 40–1200px positioned height, nesting/resource limits, and receipt/kitchen required-field rules remain unchanged.
- Never mutate iframe DOM as saved state. The iframe stays sandboxed without `allow-scripts`; all gesture targets remain overlay elements keyed by server `data-node` attributes.
- Never persist CSS `transform`, scale, rotation, skew, or library-specific state. Only existing schema fields and node order may be persisted.
- Live pointer frames must not call the preview endpoint. Pause preview at interaction start, update overlay-only styles while moving, commit one definition change at interaction end, then let the existing debounce compile once.
- Selection/group movement is allowed only when every node is positioned inside the same `containerKey`.
- A flow node must not receive coordinates directly. Direct flow resize atomically replaces it with one positioned `row`, preserving the original node id and content.
- Empty-space guidance is editor-only. Never persist placeholder/drop-zone nodes or unknown node types.
- Preserve arrow-key positioning, shared-divider keyboard resize, Move up/Move down menus, palette click-to-add, 44px touch targets, and native text-input undo.
- Keep schema `x` physical and left-based in LTR and RTL. Do not mirror saved geometry with admin language.
- New packages stay in the lazy print-template admin chunk. Never import them from `App.vue`, POS register code, backend, or spooler.
- Reka UI, Splitpanes, a new theme system, and template/spooler single-source consolidation are deferred. They are independent redesigns and do not solve this geometry problem.
- Use focused tests during Tasks 1–4. Run the complete print-template E2E file, admin build, and architecture check once in Task 5. Do not run the repository-wide suite.
- Do not merge, push, deploy, bump versions, rebuild installers, or modify Hostinger under this plan.

## Evidence Fixed Point

- Planning fixed point: `master` at `38f5c620` (`fix(print-templates): close builder interaction gaps`), clean tracked worktree.
- Baseline focused tests pass: 17/17 across `printTemplatesPage.spec.js` and `usePrintTemplates.spec.js`.
- `PrintTemplatePreview.vue` currently hand-implements pointer capture, marquee math, movement, resize hit testing, divider dragging, scale conversion, and teardown.
- `PrintTemplateEditor.vue` currently hand-implements native HTML5 palette, band, and flattened-node drag/drop plus keyboard/menu fallbacks.
- The current workaround is `Place next item beside this`; an admin cannot resize one full-width flow item first and then choose what goes beside it.
- `printTemplateEngine.validateAbsoluteBox()` accepts coordinates only on direct children of positioned bands/rows. A positioned row may contain one child, so no engine/schema change is required.
- `PrintTemplates.vue` already pauses server preview during a canvas gesture, commits cloned definitions through `updateDraftDefinition()`, and debounces recompilation.
- `pageRegistry.js` already dynamically imports this page, so adapter code can remain outside the normal POS entry chunk.
- Npm registry evidence on 2026-08-27: all selected packages are MIT; VueUse 14.4 requires Vue `^3.5.0`, satisfied by current Vue `^3.5.34`; the versions named above were the current releases inspected for this plan.

## Execution Preflight

Execute in the ordinary checkout, never an isolated worktree. Before Task 1, verify the current branch/HEAD/status, inspect any changes since the fixed point above, then create or switch to `codex/print-template-builder-interaction-adapters` without resetting or cleaning user files. The only expected starting change at this fixed point is this untracked plan. If tracked source has moved, reconcile the plan's source anchors against that diff before editing; do not force the repository back to `38f5c620`.

---

## Expected Product Outcome

| User action | Saved result | Runtime consequence |
|---|---|---|
| Resize a full-width flow block | The same block is wrapped once in a valid positioned row; its id/content survive | Server preview and eventual print use the existing compiler path |
| Add a block beside it | A real schema node fills the computed gap | No editor placeholder or adapter token reaches Save |
| Drag/marquee positioned blocks | Snapped `x`/`y` or dimensions are committed once at gesture end | One preview compile and one Undo step, not a request per frame |
| Reorder bands/nodes | Only the existing sibling array order changes | Existing engine ordering semantics remain unchanged |
| Cancel or click without moving | Nothing changes | No history noise and no preview mutation |
| Undo/Redo | The local whole-definition ref moves within a 30-entry history | Published immutable revisions and server state are untouched |
| Open POS or print an unchanged template | No behavior change | New adapters are confined to the lazy admin builder chunk |

Existing saved templates require no conversion. Existing published revisions, checkout compilation, queue payload envelopes, and spooler artifact protocol remain structurally compatible because this plan adds no schema field and changes no backend/runtime module; the compiled HTML naturally changes when an admin changes a layout.

---

## Task 1: Add bounded local undo/redo around the existing draft ref

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/admin/composables/usePrintTemplates.js`
- Modify: `src/admin/composables/__tests__/usePrintTemplates.spec.js`
- Modify: `src/admin/pages/PrintTemplates.vue`
- Modify: `src/admin/pages/__tests__/printTemplatesPage.spec.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `tests/e2e/specs/admin.print-templates.spec.js`

**Interface:** Consumes the existing whole-object `draftDefinition` ref. Produces `undoDraft()`, `redoDraft()`, `canUndo`, and `canRedo`. It does not add another draft store or alter save/publish payloads.

- [ ] **Step 1: Add a RED source-contract test.**

Add to `printTemplatesPage.spec.js`:

```js
it('keeps bounded draft history without hijacking text-input undo', () => {
    const page = read('../PrintTemplates.vue');
    const pkg = JSON.parse(read('../../../../package.json'));
    const i18n = readCatalog();

    expect(pkg.dependencies['@vueuse/core']).toBe('14.4.0');
    expect(page).toContain("import { useEventListener, useRefHistory } from '@vueuse/core'");
    expect(page).toContain('capacity: 30');
    expect(page).toContain("flush: 'sync'");
    expect(page).toContain('shouldCommit: (oldValue, newValue) => stableStringify(oldValue) !== stableStringify(newValue)');
    expect(page).toContain('pause: pauseHistory');
    expect(page).toContain('resume: resumeHistory');
    expect(page).toContain('@focusin="startFieldHistory"');
    expect(page).toContain('@focusout="finishFieldHistory"');
    expect(page).toContain('watch(workspaceLoadVersion');
    expect(page).toContain('function undoDraft()');
    expect(page).toContain('function redoDraft()');
    expect(page).toContain("['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)");
    expect(page).toContain(':disabled="!canUndo"');
    expect(page).toContain(':disabled="!canRedo"');
    expect(i18n.Undo).toBe('تراجع');
    expect(i18n.Redo).toBe('إعادة');
});
```

- [ ] **Step 2: Run RED.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
```

Expected: failure because VueUse and history controls are absent.

- [ ] **Step 3: Install the exact compatible dependency.**

```powershell
npm install --save-exact @vueuse/core@14.4.0
```

Inspect `package.json` and `package-lock.json`; reject unrelated version changes.

- [ ] **Step 4: Add history around the existing ref.**

In `PrintTemplates.vue`:

```js
const {
    undo,
    redo,
    canUndo,
    canRedo,
    clear: clearHistory,
    pause: pauseHistory,
    resume: resumeHistory
} = useRefHistory(draftDefinition, {
    capacity: 30,
    clone: value => structuredClone(toRaw(value)),
    deep: false,
    flush: 'sync',
    shouldCommit: (oldValue, newValue) => stableStringify(oldValue) !== stableStringify(newValue)
});

function selectableIds() {
    const ids = new Set();
    const visit = nodes => (nodes || []).forEach(node => {
        ids.add(node.id);
        if (node.type === 'row') visit(node.nodes);
    });
    for (const band of draftDefinition.value?.bands || []) { ids.add(band.id); visit(band.nodes); }
    return ids;
}

function repairSelection() {
    const ids = selectableIds();
    selectedNodeIds.value = [...new Set(selectedNodeIds.value.filter(id => ids.has(id)))];
    if (!ids.has(selectedNodeId.value)) selectedNodeId.value = selectedNodeIds.value.at(-1) || draftDefinition.value?.bands?.[0]?.id || '';
    if (selectedNodeId.value && !selectedNodeIds.value.includes(selectedNodeId.value)) selectedNodeIds.value.push(selectedNodeId.value);
}

function finishHistoryChange(action) {
    action();
    repairSelection();
    schedulePreview();
}

function undoDraft() { if (canUndo.value) finishHistoryChange(undo); }
function redoDraft() { if (canRedo.value) finishHistoryChange(redo); }

function onHistoryKey(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undoDraft(); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redoDraft(); }
}

useEventListener(document, 'keydown', onHistoryKey);
```

Keep `draftDefinition` as the only editable source. `shouldCommit` is mandatory because save/activate replace the ref with a fresh but often semantically identical server clone; that replacement must not create a no-op Undo entry.

Do not let `flush: 'sync'` turn every `@input` keystroke into a history entry. The Properties editor has a single component root, so attach `@focusin="startFieldHistory"` and `@focusout="finishFieldHistory"` to the properties-mode `PrintTemplateEditor`. For `INPUT`, `TEXTAREA`, or `SELECT`, record the stable definition at focus-in and call `pauseHistory()`. At focus-out, call `resumeHistory(changed)` where `changed` compares the current stable definition with the focus-in value. One focused field-edit session is therefore one toolbar Undo step; focus/blur without a change adds nothing; native `Ctrl+Z` remains owned by the focused control.

History boundaries must follow a **successful asynchronous workspace load**, not a button click or every assignment to `workspace`. In `usePrintTemplates.js`, import Vue's `readonly`, add `const workspaceLoadVersion = ref(0)`, and make `loadWorkspace()` follow this exact outcome contract: after the response check, return `false` if `controller.signal.aborted` or `workspaceController !== controller`; otherwise call `applyWorkspace(data)`, clear the conflict, increment `workspaceLoadVersion`, and return `true`. Its catch returns `false` after preserving the existing non-abort error behavior. Expose `workspaceLoadVersion: readonly(workspaceLoadVersion)` with the other refs. Do not increment it from `saveRevision()` or `activate()`, because those paths call `applyWorkspace()` with a semantically identical server clone and valid local Undo history must survive them.

Have `reloadAfterSaveConflict()` return `loadWorkspace()` rather than swallowing its result. In `PrintTemplates.vue`, consume `workspaceLoadVersion` and `watch(workspaceLoadVersion, () => clearHistory())`. This covers initial load, confirmed Refresh, save-conflict recovery, and the composable's document-type watcher only after the intended replacement arrives. Gate the explicit `setBaseline()`/`schedulePreview()` calls in `reload()` and `recoverFromSaveConflict()` on that returned `true`; a failed load must not mark the still-local draft clean. A canceled discard prompt never calls the loader; a failed/aborted load never increments the version; therefore neither can poison a later Save/Publish by clearing history late. Call `clearHistory()` explicitly after `selectRevision()` succeeds because that path replaces only the draft ref. There must be no Undo path into a prior document/revision, and no generic `watch(workspace, clearHistory)` that erases history after ordinary Save/Activate.

Add composable tests proving: a successful current load increments exactly once; an HTTP failure and an aborted superseded request do not increment; Save and Activate do not increment. Add a page test proving a failed confirmed refresh leaves the draft dirty and its Undo history intact. The existing workspace/baseline watcher remains responsible only for baseline and selection repair.

Replace the existing pinned assertion in `usePrintTemplates.spec.js` from `await expect(workflow.loadWorkspace()).resolves.toBeUndefined()` to `.resolves.toBe(true)`, then add the `false` failure/abort assertions above. This is an intentional API-contract change; leaving the old expectation would make Task 1's GREEN command impossible.

- [ ] **Step 5: Add controls and natural Arabic.**

Place Undo/Redo beside Restore starting layout:

```vue
<button class="admin-grid-button" type="button" :disabled="!canUndo" aria-keyshortcuts="Control+Z Meta+Z" @click="undoDraft">
    <i class="fa-solid fa-rotate-left text-[10px]" aria-hidden="true"></i><span>{{ $t('Undo') }}</span>
</button>
<button class="admin-grid-button" type="button" :disabled="!canRedo" aria-keyshortcuts="Control+Y Meta+Shift+Z" @click="redoDraft">
    <i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i><span>{{ $t('Redo') }}</span>
</button>
```

Add:

```json
"Undo": "تراجع",
"Redo": "إعادة"
```

- [ ] **Step 6: Extend the browser path.**

Add E2E `undoes and redoes one local template change`: type several characters into one editable text field, blur, click toolbar Undo once, and verify the complete field edit (not one character) is reverted in Properties and the compiled iframe; Redo once restores it. Save, then Undo once and prove it changes only the local draft rather than hitting a no-op server-clone entry or mutating the immutable revision. Finally change document type, wait for its workspace to load, and verify Undo is disabled. Native `Ctrl+Z` inside the input must remain browser-owned.

- [ ] **Step 7: Run focused GREEN and commit.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js src/admin/composables/__tests__/usePrintTemplates.spec.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "undoes and redoes one local template change"
git add package.json package-lock.json src/admin/composables/usePrintTemplates.js src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/PrintTemplates.vue src/admin/pages/__tests__/printTemplatesPage.spec.js src/shared/i18n/ar.json tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): add bounded draft undo history"
```

---

## Task 2: Replace manual canvas pointer machinery with Moveable and Selecto

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/admin/components/PrintTemplatePreview.vue`
- Modify: `src/admin/pages/__tests__/printTemplatesPage.spec.js`
- Modify: `tests/e2e/specs/admin.print-templates.spec.js`

**Interface:** Consumes overlay buttons, `interactiveNodes`, `nodeRects`, `scale`, and current selection. Produces the same `select-node`, `set-selection`, `patch-nodes`, `interaction-start`, and `interaction-end` events. It never consumes iframe nodes.

- [ ] **Step 1: Add RED replacement assertions.**

Before adding the new contract, replace the existing implementation-pinning assertions in `printTemplatesPage.spec.js`. The old tests currently require `resizeHandlePx`, `data-editor-marquee`, `startMarquee`, `startDivider`, and `cancelPointer`; keeping them would make the intended deletion impossible. Replace those assertions with behavior-level adapter contracts: Moveable owns resize/move, Selecto owns marquee selection, the shared divider remains keyboard-operable, and cleanup is provided by component unmount rather than a global `cancelPointer` callback.

```js
it('delegates canvas gestures to Moveable and Selecto without a second pointer engine', () => {
    const preview = read('../../components/PrintTemplatePreview.vue');
    const pkg = JSON.parse(read('../../../../package.json'));

    expect(pkg.dependencies['vue3-moveable']).toBe('0.28.0');
    expect(pkg.dependencies['vue3-selecto']).toBe('1.12.3');
    expect(preview).toContain("import Moveable from 'vue3-moveable'");
    expect(preview).toContain("import { VueSelecto } from 'vue3-selecto'");
    expect(preview).toContain(':snap-grid-width="4"');
    expect(preview).toContain(':snap-grid-height="4"');
    expect(preview).toContain('function samePositionedContainer');
    expect(preview).not.toMatch(/function startPosition|function startMarquee|function startDivider|cancelPointer/);
    expect(preview).not.toContain("window.addEventListener('pointermove'");
});
```

- [ ] **Step 2: Run RED, then install exact versions.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npm install --save-exact vue3-moveable@0.28.0 vue3-selecto@1.12.3
```

- [ ] **Step 3: Mount adapters outside the iframe.**

Keep the scaled `.stage` unchanged, but mount both adapters as direct children of the existing untransformed, `position: relative` `.canvas`, after the stage. Do not mount adapter control boxes inside the scaled stage: that double-scales their geometry and handles. Add `ref="canvasElement"` to the canvas and `ref="overlayElement"` to the stage overlay, then replace the custom marquee surface/rectangle and pointer resize corner with:

```vue
<VueSelecto
    v-if="canvasElement"
    :drag-container="canvasElement"
    :selectable-targets="selectableElements"
    :select-by-click="false"
    :select-from-inside="false"
    :continue-select="false"
    :hit-rate="1"
    @drag-start="startSelecto"
    @select-end="finishSelecto"
/>
<Moveable
    ref="moveable"
    :target="moveableTargets"
    :draggable="canMoveSelection"
    :resizable="canResizeSelection"
    :snappable="true"
    :snap-grid-width="4"
    :snap-grid-height="4"
    :throttle-drag="4"
    :throttle-resize="4"
    :origin="false"
    :rotatable="false"
    :scalable="false"
    :keep-ratio="false"
    :render-directions="['e', 's', 'se']"
    :display-around-controls="true"
    :control-padding="44"
    :use-resize-observer="true"
    :prevent-click-event-on-drag="true"
    @drag-start="startMoveableDrag"
    @drag="moveSingle"
    @drag-end="finishMoveable"
    @drag-group-start="startMoveableDrag"
    @drag-group="moveGroup"
    @drag-group-end="finishMoveable"
    @resize-start="startMoveableResize"
    @resize="resizeSingle"
    @resize-end="finishMoveable"
/>
```

`VueSelecto` does not expose core Selecto's `container`/`portalContainer` as Vue props; do not add them. Its wrapper portal resolves to the unscaled canvas when mounted as the canvas child above. Default Moveable `zoom=1` is correct in this sibling layout, so do not pass `zoom`, `scale`, or `1 / scale`.

Give each overlay button `print-template-preview__node-target`. `selectableElements` and `moveableTargets` must be DOM elements queried only below `overlayElement`, filtered to measured/visible entries. Retain each button's semantics, label, pressed state, click selection, and keyboard handler. Change `.print-template-preview__position-overlay` to `pointer-events: auto` so blank-stage events cannot fall into the iframe; keep node buttons pointer-active. Give Selecto's selection box and Moveable's control box explicit z-index above the stage/row-slot layer with scoped `:deep(...)` rules. `startSelecto()` must reject starts from a node button, Moveable control, divider, header, or footer. With `displayAroundControls`, `controlPadding` is the side length of the separate around-control hit element—not padding added to the visible 14px handle—so use 44. Preserve that 44×44 hit area under coarse-pointer media rather than hiding the controls.

- [ ] **Step 4: Keep geometry in model units and commit once.**

Retain `snap`, `clampedMoves`, `movementStyles`, `resizeColumns`, and keyboard handlers. Replace pointer capture with:

```js
function samePositionedContainer(entries) {
    return entries.length > 0 && entries.every(entry => entry.positioned && entry.containerKey === entries[0].containerKey);
}

function canToggle(entry) {
    const primary = primaryEntry();
    return entry.positioned && primary?.positioned && entry.node.id !== primary.node.id && entry.containerKey === primary.containerKey;
}

function movableEntries(entry) {
    const selected = interactiveNodes.value.filter(candidate => props.selectedIds.includes(candidate.node.id));
    return selected.includes(entry) && samePositionedContainer(selected) ? selected : [entry];
}

function entryForElement(element) {
    const id = element?.dataset?.editorNodeId;
    return interactiveNodes.value.find(entry => entry.node.id === id) || null;
}

function beginGesture(entries, event) {
    emit('interaction-start');
    activeInteraction.value = {
        entries,
        startX: event?.clientX ?? 0,
        startY: event?.clientY ?? 0,
        moves: [],
        styles: {}
    };
}

function movementFromEvent(event) {
    const live = activeInteraction.value;
    if (!live) return { dx: 0, dy: 0 };
    return {
        dx: snap(((event?.clientX ?? live.startX) - live.startX) / scale.value),
        dy: snap(((event?.clientY ?? live.startY) - live.startY) / scale.value)
    };
}

function finishMoveable(event) {
    const result = activeInteraction.value;
    activeInteraction.value = null;
    const inputType = event?.inputEvent?.type;
    const canceled = !event?.inputEvent || inputType === 'pointercancel' || inputType === 'touchcancel';
    const moves = canceled ? [] : (result?.moves || []).filter(move => {
        const original = result.entries.find(entry => entry.node.id === move.id)?.node;
        return original && ['x', 'y', 'widthPx', 'heightPx'].some(key => move[key] !== undefined && move[key] !== original[key]);
    });
    const changed = moves.length > 0;
    if (changed) emit('patch-nodes', moves);
    emit('interaction-end', changed);
}
```

Moveable already normalizes mouse/touch positions on its outer drag/resize event; `moveSingle()`/`moveGroup()` must pass that outer event to `movementFromEvent()`, not the raw `inputEvent` (a native `TouchEvent` has no `clientX/clientY`). They use `clampedMoves()` against schema container dimensions, update overlay-only `activeInteraction.styles`, and store final patches in `activeInteraction.moves`. They must not emit model patches during live events.

An east-edge resize of touching columns reuses `resizeColumns()` so the neighbour shrinks and total span stays fixed. Keep the shared divider button for keyboard resize only; remove its pointer path.

Always clear overlay-only live styles on end, cancel, blur-without-input-event, and component unmount. Gesto listens to mouse/touch cancellation but not browser `pointercancel`, so do not pretend an end-handler string check alone covers that event. While either adapter owns an interaction, register one component-scoped capture listener for `pointercancel`; its only job is to invalidate the active Moveable/Selecto interaction, clear overlay-only styles, and emit `interaction-end(false)`. Remove it on unmount. Both normal end handlers must first verify that their own interaction is still active, so a later library end after this cancellation is ignored rather than emitting twice. This is cancellation plumbing only—do not add another movement engine or global pointer-move listener.

A no-distance gesture, `pointercancel`, `touchcancel`, or missing-input end must emit `interaction-end(false)`, create no draft replacement, create no history entry, and schedule only the normal preview recovery.

Moveable does not reliably remeasure an ancestor transform change by default. Watch the measured `nodeRects`, `scale`, and the selected target elements with `flush: 'post'`; after `nextTick()`, call `moveable.value?.updateRect()`. This is required after iframe load, Fit/75%/100% changes, selection changes, and a preview recompile. Keep `useResizeObserver` enabled for direct target-size changes.

- [ ] **Step 5: Make Selecto deterministic.**

`startSelecto(event)` performs the rejection checks above before emitting `interaction-start`. `finishSelecto(event)` maps `event.selected` elements to entries and restricts them to the first positioned `containerKey`. Keep Selecto's own `continueSelect` false and do not configure `toggleContinueSelect`: click selection is canonical state outside Selecto, so its internal remembered set must never resurrect stale ids. When Shift is held at `selectEnd`, merge the result with current `props.selectedIds` filtered to that same container; without Shift, replace it. Emit exactly one final `set-selection`, then `interaction-end(false)`. Do not use the continuously firing `select` event; otherwise selection and preview-pausing remain noisy. Selecto does not own click selection.

Remove the current early return for positioned entries in `selectFromPreview()`. A plain positioned-node click selects it; Shift/Ctrl/Meta click uses the corrected `canToggle()` above, which now requires the same `containerKey` rather than merely two positioned nodes. The Moveable drag-click suppression prevents a completed drag from becoming an accidental selection click.

- [ ] **Step 6: Remove retired code.**

Delete `marqueeRect`, `marqueeStyle`, `rectFromPoints`, `intersects`, `startMarquee`, `startPosition`, `startDivider`, `resizeStyles`, `cancelPointer`, and manual pointer listener registration. Keep iframe ResizeObserver measurement.

- [ ] **Step 7: Update browser tests.**

Update current marquee, group move, single move, resize, fit zoom, and shared-divider cases. Preserve these assertions:

- 4px model snapping;
- no iframe navigation during live drag;
- same-container multi-selection;
- touching-column total span unchanged;
- equivalent model delta at Fit and 100%;
- keyboard move/divider resize works without Moveable.

Add decisive cases with these grep-stable titles: `marquee-selects only current same-container nodes`, `moves positioned elements equivalently by touch`, `keeps Moveable touch controls at least 44px`, `cancels a canvas gesture without history`, and `keeps physical geometry in RTL`. Together they must prove a positioned node still selects by click, Shift-marquee merges only current same-container selection (never a stale Selecto id), a touch drag has the same snapped model delta as a mouse drag, every `.moveable-around-control[data-direction]` hit box is at least 44×44 CSS px (the visible `.moveable-control` intentionally remains 14px), controls stay aligned after Fit → 100% → Fit, and `pointercancel`, `touchcancel`, plus an end event without `inputEvent` produce no schema replacement/history entry. The cancellation test must inspect the draft/Undo state, not only the absence of an exception. The RTL case sets `document.documentElement.dir = 'rtl'`, performs the same eastward geometry gesture, and asserts saved physical `x` changes exactly as in LTR rather than mirroring; restore the document direction in `finally`.

Do not leave a source-contract test for the retired manual gesture implementation. The focused unit file must be green because its contract now describes the adapter boundary, not because old implementation names were reintroduced as dead compatibility shims.

- [ ] **Step 8: Run focused GREEN and commit.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "moves selected positioned elements|marquee-selects only current same-container nodes|moves positioned elements equivalently by touch|keeps Moveable touch controls at least 44px|resizes touching columns|shows both columns resizing|room to move|cancels a canvas gesture without history|keeps controls aligned|keeps physical geometry in RTL"
git add package.json package-lock.json src/admin/components/PrintTemplatePreview.vue src/admin/pages/__tests__/printTemplatesPage.spec.js tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): adopt native canvas interactions"
```

---

## Task 3: Turn direct flow resize into a real side-by-side row

**Files:**
- Create: `src/admin/utils/printTemplateLayout.js`
- Create: `src/admin/utils/__tests__/printTemplateLayout.spec.js`
- Modify: `src/admin/components/PrintTemplatePreview.vue`
- Modify: `src/admin/pages/PrintTemplates.vue`
- Modify: `src/admin/pages/__tests__/printTemplatesPage.spec.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `tests/e2e/specs/admin.print-templates.spec.js`
- Modify: `backend/tests/unit/printTemplateEngine.test.js` (characterization only)

**Interface:** Consumes a selected direct child of a flow band and a Moveable resize result. Produces one absolute row containing that same node id plus a visible editor-only gap. It never produces an empty schema node or compiler special case.

- [ ] **Step 1: Characterize the unchanged engine.**

```powershell
npx vitest run backend/tests/unit/printTemplateEngine.test.js
```

Confirm positioned rows are accepted and coordinates on flow children are rejected. Add one characterization covering an absolute row whose `visibleWhen` is false/true: false emits no row and consumes zero height; true emits the row and child. Also confirm row-level `marginTop`/`marginBottom` remain valid. Do not modify the engine.

- [ ] **Step 2: Add RED pure-state tests.**

Create tests proving:

- flow `store.name` resized to 244px becomes the sole child of a new absolute row;
- node id/content and all non-layout style fields survive; `visibleWhen`/`hidden` and vertical margins move to the wrapper row so their runtime semantics survive;
- row height is 40–1200px and all geometry is on the 4px grid;
- child stays inside 556px with 8px side margins;
- positioned, nested, QR/logo/image, unsupported, or missing nodes return `null` without mutation;
- an indented flow node (`style.marginInlineStart > 0`) remains unchanged because converting logical start indentation into physical absolute geometry is direction-sensitive and cannot be represented honestly by this shortcut;
- input definition stays byte-for-byte unchanged;
- 1px, negative, NaN, and over-wide dimensions clamp/reject safely.

```powershell
npx vitest run src/admin/utils/__tests__/printTemplateLayout.spec.js
```

Expected: module-not-found RED.

- [ ] **Step 3: Add the minimum pure transformation.**

```js
const GRID = 4;
const ROW_WIDTH = 556;
const ROW_MARGIN = 8;
const MIN_NODE_WIDTH = 16;
const COLUMN_TYPES = new Set(['text', 'field']);

const snap = value => Math.round(value / GRID) * GRID;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function promoteFlowNodeToRow(definition, nodeId, { rowId, widthPx, heightPx }) {
    if (!definition || !rowId || !Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null;
    const next = structuredClone(definition);
    for (const band of next.bands || []) {
        if (band.layout !== 'flow') continue;
        const index = (band.nodes || []).findIndex(node => node.id === nodeId && COLUMN_TYPES.has(node.type));
        if (index < 0) continue;
        const node = band.nodes[index];
        const { style: sourceStyle = {}, visibleWhen, hidden, ...content } = node;
        if (Number(sourceStyle.marginInlineStart || 0) !== 0) return null;
        const { marginTop, marginBottom, ...childStyle } = sourceStyle;
        const rowStyle = {
            ...(marginTop !== undefined ? { marginTop } : {}),
            ...(marginBottom !== undefined ? { marginBottom } : {})
        };
        const rowHeight = clamp(snap(Math.max(40, heightPx + 8)), 40, 1200);
        const childWidth = clamp(snap(widthPx), MIN_NODE_WIDTH, ROW_WIDTH - (ROW_MARGIN * 2));
        band.nodes.splice(index, 1, {
            id: rowId,
            type: 'row',
            layout: 'absolute',
            height: rowHeight,
            style: rowStyle,
            ...(visibleWhen !== undefined ? { visibleWhen } : {}),
            ...(hidden !== undefined ? { hidden } : {}),
            nodes: [{
                ...content,
                style: childStyle,
                x: ROW_MARGIN,
                y: 4,
                widthPx: childWidth,
                heightPx: rowHeight - 8
            }]
        });
        return { definition: next, rowId, nodeId };
    }
    return null;
}
```

The wrapper transfer is not cosmetic. Leaving `visibleWhen` only on the child would render an empty fixed-height row whenever the condition is false. Leaving vertical margins on the clipped positioned child would cut them off. A nonzero `marginInlineStart` is deliberately ineligible: it is logical-direction indentation, while positioned-row `x` is physical-left geometry; silently preserving it would visually shift the child away from its saved box and make slot math lie. QR/logo sizing remains discrete (`node.size`) and is deliberately excluded; changing only its wrapper width would clip the image rather than resize it.

- [ ] **Step 4: Let Moveable resize eligible flow nodes without dragging them.**

Define `canPromoteFlowEntry(entry)` for a visible `text`/`field` that is a direct child of a flow band. `interactiveNodes` currently does not carry parent/depth metadata, so prove direct ownership against the definition rather than assuming every non-positioned entry is eligible:

```js
function canPromoteFlowEntry(entry) {
    if (!entry || entry.positioned || !['text', 'field'].includes(entry.node.type)) return false;
    if (Number(entry.node.style?.marginInlineStart || 0) !== 0) return false;
    return (props.definition?.bands || []).some(band =>
        (band.layout || 'flow') === 'flow' && (band.nodes || []).some(node => node.id === entry.node.id)
    );
}
```

Eligible flow targets receive east/south/southeast resize handles but remain non-draggable. Live frames resize only the overlay. On end:

```js
emit('promote-flow-node', {
    id: entry.node.id,
    widthPx: liveWidth,
    heightPx: liveHeight
});
```

Extend Task 2's `moveableTargets` to include the single selected, measured eligible flow target; keep `selectableElements` positioned-only, set dragging false for this target, and set resizing true. Do not write coordinates onto the flow node.

Record the flow target's rendered model width/height at gesture start. Emit `promote-flow-node` only when the snapped final dimensions differ; clicking a resize handle without moving, or receiving `pointercancel`, must leave the flow definition untouched.

- [ ] **Step 5: Apply once in the page.**

```js
function promotePreviewFlowNode({ id, widthPx, heightPx }) {
    const result = promoteFlowNodeToRow(toRaw(draftDefinition.value), id, {
        rowId: crypto.randomUUID(),
        widthPx,
        heightPx
    });
    if (!result) return;
    updateDraftDefinition(result.definition);
    setPreviewSelection([result.nodeId], result.nodeId);
}
```

Wire `@promote-flow-node="promotePreviewFlowNode"`.

- [ ] **Step 6: Show usable empty space without persisting it.**

Derive gaps only for the selected absolute row (or the absolute row directly containing the selected child), from its children sorted by `x`. Render only gaps at least 16px. For each gap use the measured row rectangle plus model coordinates: `left = rowRect.left + gapStart`, `top = rowRect.top`, `width = gapWidth`, `height = rowRect.height`. Never create slots for every row at once.

Make the hit stack explicit: the full-row wrapper target is z-index 1, the gap slot is z-index 2, positioned child targets are z-index 3, and Selecto/Moveable controls remain above all three. Add distinct classes for wrapper rows and positioned children; do not rely on DOM order. The slot occupies only computed empty geometry, so it can receive a click without hiding an existing child, while the row remains selectable outside the slot.

```vue
<button
    v-for="slot in availableRowSlots"
    :key="slot.key"
    type="button"
    class="print-template-preview__row-slot"
    :style="slot.style"
    :aria-label="$t('Add content to this row')"
    @click="emit('request-row-content', slot.rowId)"
>
    <i class="fa-solid fa-plus" aria-hidden="true"></i>
    <span>{{ $t('Add content') }}</span>
</button>
```

The slot never enters `definition`. Add `ref="structureEditor"` to the conditionally rendered Structure editor and a stable `data-template-library` marker to its palette. Handle `request-row-content` by selecting the row, switching to Structure, awaiting `nextTick()`, then focusing `structureEditor.value?.$el?.querySelector('[data-template-library] button:not(:disabled)')`. Without the await, the old Properties component is still mounted and the focus request is lost. The next palette click already routes through `targetFor()`, `canAddToBand()`, `columnPosition()`, and `addNode()`.

Add:

```json
"Add content": "إضافة محتوى",
"Add content to this row": "إضافة محتوى إلى هذا الصف"
```

- [ ] **Step 7: Add decisive E2E.**

`resizes a flow block into a row and fills the remaining space` must:

1. select flow `store.name`;
2. drag east handle narrower;
3. verify a positioned row and snapped Properties;
4. verify the visible empty slot;
5. select it and add Text;
6. verify the slot click itself emits `request-row-content` (rather than selecting the full-row wrapper), palette focus moved after the click, and both nodes compile in the same row with no validation error;
7. Undo twice back to original flow;
8. Redo twice to completed row;
9. save and verify server acceptance.

- [ ] **Step 8: Run focused GREEN and commit.**

```powershell
npx vitest run src/admin/utils/__tests__/printTemplateLayout.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js backend/tests/unit/printTemplateEngine.test.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "resizes a flow block into a row and fills the remaining space"
git add src/admin/utils/printTemplateLayout.js src/admin/utils/__tests__/printTemplateLayout.spec.js src/admin/components/PrintTemplatePreview.vue src/admin/pages/PrintTemplates.vue src/admin/pages/__tests__/printTemplatesPage.spec.js src/shared/i18n/ar.json tests/e2e/specs/admin.print-templates.spec.js backend/tests/unit/printTemplateEngine.test.js
git commit -m "feat(print-templates): resize flow blocks into columns"
```

---

## Task 4: Replace native structure drag/drop with VueDraggablePlus

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/admin/components/PrintTemplateStructureNodes.vue`
- Modify: `src/admin/components/PrintTemplateEditor.vue`
- Modify: `src/admin/pages/__tests__/printTemplatesPage.spec.js`
- Modify: `tests/e2e/specs/admin.print-templates.spec.js`

**Interface:** Consumes `draft.bands`, each real sibling node array, palette types, and current action callbacks. Produces reordered sibling arrays or one guarded palette insertion. Existing nodes cannot change parent.

- [ ] **Step 1: Add RED replacement assertions and install.**

First rewrite the current source-contract assertions that require native HTML5 drag handlers (`draggable="true"`, `startBandDrag`, `startNodeDrag`, and `startLibraryDrag`). Also narrow the older dependency-rejection assertion from `/GrapesJS|SortableJS|VueDraggable|.../` to reject only GrapesJS and raw CSS editing; VueDraggablePlus is now an intentional dependency. Do not preserve the retired names as comments or inert wrappers just to satisfy stale tests.

```js
it('uses VueDraggablePlus for mouse and touch structure ordering', () => {
    const editor = read('../../components/PrintTemplateEditor.vue');
    const nodes = read('../../components/PrintTemplateStructureNodes.vue');
    const pkg = JSON.parse(read('../../../../package.json'));

    expect(pkg.dependencies['vue-draggable-plus']).toBe('0.6.1');
    expect(editor).toContain("import { VueDraggable } from 'vue-draggable-plus'");
    expect(nodes).toContain("import { VueDraggable } from 'vue-draggable-plus'");
    expect(editor).toContain("pull: 'clone'");
    expect(nodes).toContain("put: ['template-library']");
    expect(nodes).toContain('PrintTemplateStructureNodes');
    expect(editor).toContain('handle=".print-template-editor__band-drag"');
    expect(nodes).toContain('handle=".print-template-editor__node-drag"');
    expect(editor).not.toMatch(/startBandDrag|startNodeDrag|startLibraryDrag|dragPayload|dropTargetId/);
    expect(editor).not.toContain('draggable="true"');
});
```

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npm install --save-exact vue-draggable-plus@0.6.1
```

- [ ] **Step 2: Extract only recursive node-list rendering.**

Create self-recursive `PrintTemplateStructureNodes.vue` with:

```js
const props = defineProps({
    nodes: { type: Array, required: true },
    parentId: { type: String, required: true },
    depth: { type: Number, default: 0 },
    selectedId: { type: String, default: '' },
    nodeLabel: { type: Function, required: true },
    nodeSummary: { type: Function, required: true },
    nodeIcon: { type: Function, required: true }
});

const emit = defineEmits([
    'replace-nodes', 'insert-library-node', 'select-node',
    'move-node', 'duplicate-node', 'delete-node'
]);
```

Render one `VueDraggable` per actual sibling array:

```vue
<VueDraggable
    :model-value="nodes"
    :group="{ name: `template-nodes:${parentId}`, pull: false, put: ['template-library'] }"
    handle=".print-template-editor__node-drag"
    :animation="120"
    :fallback-on-body="true"
    :swap-threshold="0.65"
    :scroll="true"
    :scroll-sensitivity="56"
    :scroll-speed="12"
    @update:model-value="replaceNodes"
>
```

For rows, recurse with `node.nodes`, `node.id`, and `depth + 1`. Vue component events do not bubble through recursive component boundaries, so forward every event explicitly at every recursive call. Use method references (which preserve all emitted arguments), with these exact payloads:

```js
function forwardReplace(parentId, nextNodes) { emit('replace-nodes', parentId, nextNodes); }
function forwardInsert(parentId, index, type) { emit('insert-library-node', parentId, index, type); }
function forwardSelect(nodeId) { emit('select-node', nodeId); }
function forwardMove(nodeId, offset) { emit('move-node', nodeId, offset); }
function forwardDuplicate(nodeId) { emit('duplicate-node', nodeId); }
function forwardDelete(nodeId) { emit('delete-node', nodeId); }
```

Wire the recursive component with `@replace-nodes="forwardReplace"`, `@insert-library-node="forwardInsert"`, `@select-node="forwardSelect"`, `@move-node="forwardMove"`, `@duplicate-node="forwardDuplicate"`, and `@delete-node="forwardDelete"`. Preserve current select buttons, hidden state, menus, Alt+Arrow shortcuts, and accessible labels.

Scoped parent CSS will not style markup moved into the child component, and the current `__select`/`__menu` classes are shared by band and node markup. Split them rather than trying to move one shared scoped rule across the component boundary:

- Parent band markup uses `__band-drag`, `__band-select`, and `__band-menu`; their rules stay in `PrintTemplateEditor.vue`.
- Recursive child markup uses `__node-drag`, `__node-select`, and `__node-menu`; move the node-list rules for `__nodes`, `__node`, hidden/selected/mobile states, and node controls into `PrintTemplateStructureNodes.vue`.
- Split the current combined `__band-row, __node` rule. Do not leave a parent-scoped selector pretending it styles child DOM, and do not use a broad unscoped escape.
- Add the child component's own `button:focus-visible, summary:focus-visible` rule; the parent's focus selector cannot cross the scoped boundary.

The existing drag/menu controls are only 36px tall, so “retain 44px targets” would be false. Upgrade both band and node drag buttons, select buttons, menu summaries, and menu action buttons to a measured minimum 44×44 hit target while preserving the same compact visual grammar. Add a component/browser assertion for the band and nested-node drag/menu bounding boxes plus visible keyboard focus; do not infer accessibility from the row's 46px height.

Prevent a palette token entering state:

```js
function replaceNodes(next) {
    const tokenIndex = next.findIndex(node => node?.__paletteType);
    if (tokenIndex >= 0) {
        emit('insert-library-node', props.parentId, tokenIndex, next[tokenIndex].__paletteType);
        return;
    }
    const before = props.nodes.map(node => node.id).sort();
    const after = next.map(node => node.id).sort();
    if (JSON.stringify(before) === JSON.stringify(after)) emit('replace-nodes', props.parentId, next);
}
```

- [ ] **Step 3: Use clone-only palette and draggable bands.**

Palette:

```vue
<VueDraggable
    :model-value="availableNodeTypes"
    :group="{ name: 'template-library', pull: 'clone', put: false }"
    :sort="false"
    :clone="type => ({ __paletteType: type })"
>
```

Keep click-to-add. Wrap `draft.bands` in a separate band-only `VueDraggable` using `handle=".print-template-editor__band-drag"`; node handles use only `.print-template-editor__node-drag`. Parent handlers resolve `parentId` to a band/row, accept reorders only when before/after id sets match, accept palette insertion only through `canAddToBand()` and `addNode()`, call `sync()` once, and preserve selection. Distinct handles are mandatory because the current shared handle selector lets a nested node gesture be seen by the band Sortable.

Delete native `draggable`, `dragPayload`, `dropTargetId`, drag/drop handlers, and drop-target CSS. Do not delete menu/keyboard Move up/Move down.

- [ ] **Step 4: Update behavior tests.**

Replace synthetic `DragEvent` calls with real mouse drag. Add a touch-context case proving:

- node reorder within one sibling list;
- existing-node cross-parent drag rejected;
- palette Text clone becomes a UUID-backed real node;
- duplicate QR leaves no clone/duplicate in definition;
- Alt+Arrow and menu fallbacks still work.

Add `keeps structure controls touch-safe and focus-visible`: measure band and nested-node drag/select/menu controls at no less than 44×44 CSS px, keyboard-focus the extracted node controls, and assert the child component's visible outline is rendered.

Make the touch proof executable. Create a separate context with `baseURL: test.info().project.use.baseURL`, `storageState: 'playwright/.auth/admin.json'`, `hasTouch: true`, and viewport `{ width: 1200, height: 520 }`; open the builder in that context. The short height creates overflow while width ≥1100 keeps the desktop flex layout in which `.print-templates-page__editor-pane` is the scroll owner. Use a Chrome DevTools Protocol session and `Input.dispatchTouchEvent` (`touchStart`, several `touchMove` frames, `touchEnd`) against the real node handle. Drag far enough toward the editor-pane edge to assert that element's `scrollTop` increases, then assert sibling order changed. The surrounding `.print-templates-page__rail` has `overflow: hidden`, while at widths ≤1099 the page becomes the responsive scroll owner; do not mix either layout with this assertion. In the same proof, drag a nested node and assert its containing band index is unchanged. Close the touch context in `finally`; a desktop `page.mouse` call or synthetic `DragEvent` is not touch evidence.

- [ ] **Step 5: Run focused GREEN and commit.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "reorders sections|orders template structure on touch|keeps structure controls touch-safe and focus-visible|adds a once-only logo|adds a fourth column"
git add package.json package-lock.json src/admin/components/PrintTemplateStructureNodes.vue src/admin/components/PrintTemplateEditor.vue src/admin/pages/__tests__/printTemplatesPage.spec.js tests/e2e/specs/admin.print-templates.spec.js
git commit -m "feat(print-templates): adopt touch-safe structure dragging"
```

---

## Task 5: Close integration and prove the edit-to-print contract

**Files:**
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Add/track: `docs/superpowers/plans/2026-08-27-print-template-builder-interaction-adapters.md`
- Modify: `backend/tests/unit/printDocumentCompiler.test.js` (runtime-contract characterization)
- Verify unchanged: `backend/tests/unit/printDispatchOwnership.test.js`
- Verify unchanged: `pos-spooler-printer/tests/render-document.test.js`
- Modify only when a focused regression proves necessary: Task 1–4 files

- [ ] **Step 1: Map authority.**

Add client nodes:

- `adm-print-template-builder` → `src/admin/pages/PrintTemplates.vue`
- `adm-print-template-editor` → `src/admin/components/PrintTemplateEditor.vue`
- `adm-print-template-preview` → `src/admin/components/PrintTemplatePreview.vue`
- `api-admin-print-templates` → `backend/routes/admin/printTemplates.js`

No print-template admin API node exists today, and the route uses anonymous callbacks rather than named handler symbols. Add the API node explicitly, anchored to the current route signatures `POST /print-templates/:docType/preview`, `POST /print-templates/:docType/revisions`, and `POST /print-templates/:docType/activate`. Add one flow from `actor-admin` through builder/editor/preview to `api-admin-print-templates` and `prn-template-engine`. State that adapters edit schema only, compilation remains authoritative, and publishing activates an immutable revision globally. Anchor current component/composable symbols and route signatures, not stale line numbers or invented handler names.

Open `backend/routes/admin/printTemplates.js` while editing the map and verify those signatures still exist.

```powershell
npm run architecture
```

- [ ] **Step 2: Run leftover scan.**

```powershell
rg -n 'startPosition|startMarquee|startDivider|cancelPointer|marqueeRect|marqueeStyle|rectFromPoints|intersects|resizeStyles|window\.addEventListener\(.pointermove|dragPayload|dropTargetId|drop-target|startBandDrag|startNodeDrag|startLibraryDrag|draggable="true"|print-template-editor__drag\b' src/admin/components/PrintTemplateEditor.vue src/admin/components/PrintTemplatePreview.vue src/admin/components/PrintTemplateStructureNodes.vue
rg -n "vue3-moveable|vue3-selecto|vue-draggable-plus|@vueuse/core" package.json package-lock.json src/admin
```

Expected: first scan empty; second shows exact dependencies and lazy admin imports. Keyboard geometry helpers remain because adapters do not replace accessible keyboard behavior.

- [ ] **Step 3: Run concerned tests once.**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/utils/__tests__/printTemplateLayout.spec.js backend/tests/unit/printTemplateEngine.test.js
npx vitest run backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printDispatchOwnership.test.js
node pos-spooler-printer/tests/render-document.test.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js
npm run build:admin
npm run architecture:check
```

Inspect Vite output: adapter code must remain in the lazy print-template/admin chunk. Inspect `npm audit --omit=dev --json`; stop only for a new high/critical path involving one of the four new packages, and report unrelated existing findings without scope expansion.

Before GREEN, add one runtime-contract characterization to `printDocumentCompiler.test.js`: make `resolveActiveTemplate` return a valid custom receipt definition containing the representative positioned row produced by Task 3, run the real compiler (do not mock `compileTemplate`), and assert `data.compiled_document_v1` carries the custom revision plus the row/child geometry in its HTML. The existing `printDispatchOwnership` test then proves the compiled artifact is placed in the queued payload, and `render-document.test.js` proves the spooler accepts the unchanged `compiled_document_v1` shape. No physical print or spooler source change is required for this schema-preserving editor feature.

- [ ] **Step 4: Execute the end-to-end outcome simulation against the branch.**

| Scenario | Required result |
|---|---|
| Resize full-width receipt `store.name` | One valid absolute row; original id/content preserved; editor-only gap visible |
| Add content into gap | Real guarded node inserted; no placeholder/token remains |
| Existing receipt item columns | Shared span preserved, no overlap, `qty/name/netAmount/note` retained |
| Kitchen item row | Quantity/name/note still compile and print |
| Marquee in one row | Same-container ids selected; group drag is one history step |
| Marquee across containers | Limited to first container; no mixed-coordinate group |
| Fit vs 100% zoom | Equivalent gesture yields same 4px model delta |
| RTL admin UI | Handles usable; physical X and print layout do not mirror |
| Invalid draft | Last good iframe stays; validation appears; no stale target crash |
| Undo/redo | Gesture/reorder is one step; reload/type/revision boundaries clear history |
| Text input Ctrl+Z | Browser owns input undo |
| Touch structure reorder | Auto-scroll works; menus/Alt+Arrow remain |
| Save/Accept & Publish | Same lifecycle; no test-print ceremony |
| Runtime print | `compiled_document_v1` envelope/protocol unchanged; edited HTML is consumed; spooler source untouched |

- [ ] **Step 5: Attack the implementation.**

Verify all seventeen:

1. No Moveable/Selecto/Sortable state is saved.
2. No live gesture sends preview HTTP traffic.
3. Pointer cancel changes neither schema nor history.
4. Deleted selection is repaired before Moveable retargets.
5. Rejected palette clone leaves no object, DOM ghost, or history entry.
6. Duplicate QR uses the same existing guard.
7. Undo after save edits only local draft, never an immutable revision.
8. Undo after Receipt/Kitchen switch is disabled.
9. Server validation remains the final Save gate.
10. Backend/spooler import none of the new dependencies.
11. A false promoted-node condition emits no blank wrapper row, and vertical margins are not clipped.
12. QR/logo nodes cannot enter the flow-promotion path until their discrete sizing semantics are deliberately designed.
13. Nested structure actions reach the parent once, and a node drag cannot reorder its band.
14. Failed, canceled, and superseded workspace loads neither clear history nor mark a dirty draft clean.
15. Every visible Moveable direction exposes a measured 44×44 around-control hit target on touch layouts.
16. A row gap click reaches `request-row-content` above the wrapper target and never persists the editor-only slot.
17. A flow node with logical start indentation is not offered the physical-coordinate promotion shortcut.

Any failure is fixed in the task that introduced it and gets the smallest focused regression test. Do not bury tracked Task 1–4 corrections in the documentation commit: create a scoped corrective commit for each proven defect cluster, rerun only its focused test, then rerun this step's final concerned commands.

- [ ] **Step 6: Commit integration evidence.**

```powershell
git add docs/architecture.json docs/architecture.html docs/superpowers/plans/2026-08-27-print-template-builder-interaction-adapters.md backend/tests/unit/printDocumentCompiler.test.js
git commit -m "test(print-templates): close adapter integration evidence"
git status --short
git log -10 --oneline
```

Expected: clean worktree and five planned task commits, plus only any explicitly justified corrective commits created by Step 5.

## Plan Attack Result

This plan was mentally executed from palette/structure input through draft mutation, debounced server preview, server validation, immutable revision save, publish, compiled artifact creation, and spooler consumption.

Rejected alternatives:

- Mutating iframe HTML: preview and saved/spooler output diverge.
- Writing width directly on a flow node: server returns `TEMPLATE_POSITION_INVALID`.
- Persisting a drop placeholder: contaminates schema and invents a new engine concept.
- Emitting schema every pointer frame: preview abort/recompile churn destroys targets and floods history.
- Cross-container Moveable groups: mixed coordinate systems clamp incorrectly.
- Replacing compiler/schema: unnecessary; current engine already renders this row.
- Adding Reka/Splitpanes: unrelated redesign with no geometry payoff.
- Deleting keyboard/menu fallback: mouse improvement at the cost of touch/accessibility.

Final owner flow: select a printed element → drag a visible resize handle → builder creates a real row → choose the visible empty slot → add the next block → adjust, undo, save, and publish. The same schema still produces the server artifact consumed by the spooler.

## Official References

- Vue3 Moveable features/API: https://github.com/daybrush/moveable/tree/master/packages/vue3-moveable
- Moveable targets, events, snapping, zoom: https://daybrush.com/moveable/release/latest/doc/Moveable.html
- Vue3 Selecto mouse/touch selection: https://github.com/daybrush/selecto/tree/master/packages/vue3-selecto
- VueDraggablePlus clone groups, handles, touch: https://vue-draggable-plus.pages.dev/en/
- VueUse ref history: https://vueuse.org/core/userefhistory/

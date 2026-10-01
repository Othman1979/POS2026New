# Print Template Builder Pair Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Clarify the builder's Receipt/Kitchen controls and move exactly two positioned elements together without changing printed template data.

**Architecture:** PrintTemplates.vue owns the temporary primary/companion selection and performs one atomic draft update. PrintTemplatePreview.vue owns eligibility, pointer/keyboard movement, and container-bound geometry. No backend, schema, database, compiler, or spooler work is involved.

**Tech Stack:** Vue 3 Composition API, scoped CSS, Playwright, Vitest, Vite.

## Global Constraints

- Keep the existing desktop-only direct-positioning breakpoint at 1100px.
- Two elements maximum; selection is editor state only and never serialized.
- Pair members must share the same absolute band or absolute row.
- Snap movement to 4px and clamp both elements inside their shared container.
- Resize only the primary element.
- Preserve RTL, 44px controls, existing teal selection states, and current single-node editing.
- Add no dependencies, endpoints, persistent groups, marquee selection, or arbitrary multi-select.

---

## Files

- Modify: src/admin/pages/PrintTemplates.vue — command controls, selection owner, reset points, atomic move patch.
- Modify: src/admin/components/PrintTemplatePreview.vue — dynamic title, eligible pair selection, movement geometry, feedback.
- Modify: src/shared/i18n.js — Arabic labels.
- Modify: src/admin/pages/__tests__/printTemplatesPage.spec.js — source contracts.
- Modify: tests/e2e/specs/admin.print-templates.spec.js — browser workflow and responsive proof.

## Task 1: Make document choice explicit and preview title truthful

**Files:**
- Modify: src/admin/pages/PrintTemplates.vue
- Modify: src/admin/components/PrintTemplatePreview.vue
- Modify: src/shared/i18n.js
- Test: src/admin/pages/__tests__/printTemplatesPage.spec.js
- Test: tests/e2e/specs/admin.print-templates.spec.js

**Produces:** A labelled Document type group separate from Fixture, and a preview title derived from artifact.docType.

- [ ] **Step 1: Write the failing tests**

Append this Vitest test:

    it('keeps document choice separate from fixture selection and names the rendered document', () => {
        const page = read('../PrintTemplates.vue');
        const preview = read('../../components/PrintTemplatePreview.vue');
        const i18n = read('../../../shared/i18n.js');

        expect(page).toContain('print-templates-page__document-control');
        expect(page).toContain("$t('Document type')");
        expect(page).toContain('print-templates-page__fixture');
        expect(preview).toContain("artifact?.docType === 'kitchen' ? 'Kitchen preview' : 'Receipt preview'");
        expect(i18n).toContain("'Document type': 'نوع المستند'");
    });

Add this browser test:

    test('keeps document choice clear and names the kitchen server preview', async ({ page }) => {
      await page.goto('/admin/print-templates');
      const workspace = page.locator('.print-templates-page');
      await expect(workspace.getByRole('group', { name: 'Document type' })).toBeVisible();
      await expect(workspace.getByLabel('Fixture')).toBeVisible();
      await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
      await expect(workspace.getByRole('heading', { name: 'Kitchen preview' })).toBeVisible();
      await expect(workspace.locator('iframe[title="Screen layout preview"]').contentFrame().getByText('KITCHEN TICKET', { exact: true })).toBeVisible();
    });

- [ ] **Step 2: Prove the tests are red**

Run:

    npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
    npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "keeps document choice clear"

Expected: missing document-control class/group and missing Kitchen preview heading.

- [ ] **Step 3: Add the minimum implementation**

Replace the bare document nav in PrintTemplates.vue with:

    <div class="print-templates-page__document-control" role="group" :aria-label="$t('Document type')">
        <span>{{ $t('Document type') }}</span>
        <nav class="admin-grid-segmented" :aria-label="$t('Print templates')">
            <button type="button" :class="{ 'is-active': docType === 'receipt' }" @click="changeDocType('receipt')">{{ $t('Receipt') }}</button>
            <button type="button" :class="{ 'is-active': docType === 'kitchen' }" @click="changeDocType('kitchen')">{{ $t('Kitchen') }}</button>
        </nav>
    </div>

Add scoped page CSS:

    .print-templates-page__document-control { display:flex; min-width:170px; flex-direction:column; gap:4px; color:#52525b; font-size:10px; font-weight:750; }
    .print-templates-page__document-control .admin-grid-segmented { width:100%; grid-auto-columns:minmax(0,1fr); }
    .print-templates-page__document-control .admin-grid-segmented button { min-width:0; }
    @media (max-width:767px) { .print-templates-page__document-control { grid-column:1 / -1; width:100%; } }

Replace the preview title with:

    <h3>{{ $t(artifact?.docType === 'kitchen' ? 'Kitchen preview' : 'Receipt preview') }}</h3>

Add translations:

    'Document type': 'نوع المستند',
    'Kitchen preview': 'معاينة تذكرة المطبخ',

- [ ] **Step 4: Prove green**

Run the two commands from Step 2. Expected: both pass.

- [ ] **Step 5: Commit**

    git add src/admin/pages/PrintTemplates.vue src/admin/components/PrintTemplatePreview.vue src/shared/i18n.js src/admin/pages/__tests__/printTemplatesPage.spec.js tests/e2e/specs/admin.print-templates.spec.js
    git commit -m "fix(print-templates): clarify document controls"

## Task 2: Move one temporary pair atomically

**Files:**
- Modify: src/admin/pages/PrintTemplates.vue
- Modify: src/admin/components/PrintTemplatePreview.vue
- Modify: src/shared/i18n.js
- Test: src/admin/pages/__tests__/printTemplatesPage.spec.js
- Test: tests/e2e/specs/admin.print-templates.spec.js

**Consumes:** Positioned template nodes contain x, y, widthPx, heightPx; the preview already emits move-node.
**Produces:** selectedIds, toggle-node, clear-selection, and move-nodes(Array<move>) events.

- [ ] **Step 1: Write the failing tests**

Append this source-contract test:

    it('bounds temporary pair movement to two positioned siblings and one draft update', () => {
        const page = read('../PrintTemplates.vue');
        const preview = read('../../components/PrintTemplatePreview.vue');

        expect(page).toContain('const selectedNodeIds = ref([])');
        expect(page).toContain('@move-nodes="movePreviewNodes"');
        expect(page).toContain('function movePreviewNodes(moves)');
        expect(preview).toContain("selectedIds: { type: Array, default: () => [] }");
        expect(preview).toContain("emit('toggle-node', entry.node.id)");
        expect(preview).toContain("emit('move-nodes', moves)");
        expect(preview).toContain('containerKey');
        expect(preview).toContain('Math.max(...entries.map(entry => -entry.node.x))');
        expect(preview).toContain('Math.min(...entries.map(entry => entry.width - entry.node.x - entry.node.widthPx))');
        expect(preview).toContain('aria-keyshortcuts="Shift+Enter ArrowLeft ArrowRight ArrowUp ArrowDown"');
    });

Add this browser test:

    test('moves exactly two positioned sibling elements together without preview reloads', async ({ page }) => {
      await page.goto('/admin/print-templates');
      const workspace = page.locator('.print-templates-page');
      await workspace.locator('.print-template-editor__select').filter({ hasText: 'store.name' }).click();
      await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
      await workspace.getByRole('button', { name: 'Place next item beside this' }).click();
      await workspace.getByRole('button', { name: 'Preview', exact: true }).click();

      const first = workspace.getByRole('button', { name: 'Position store.name', exact: true });
      const second = workspace.getByRole('button', { name: 'Position store.address', exact: true });
      await first.click();
      await second.click({ modifiers: ['Shift'] });
      await expect(workspace.getByText('2 selected', { exact: true })).toBeVisible();
      await workspace.getByRole('button', { name: 'Edit store.phone', exact: true }).click({ modifiers: ['Shift'] });
      await expect(workspace.getByText('2 selected', { exact: true })).toHaveCount(0);
      await first.click();
      await second.click({ modifiers: ['Shift'] });

      const firstBefore = await first.boundingBox();
      const secondBefore = await second.boundingBox();
      let reloads = 0;
      page.on('framenavigated', frame => { if (frame.parentFrame()) reloads += 1; });
      await page.mouse.move(firstBefore.x + firstBefore.width / 2, firstBefore.y + firstBefore.height / 2);
      await page.mouse.down();
      await page.mouse.move(firstBefore.x + firstBefore.width / 2 + 16, firstBefore.y + firstBefore.height / 2 + 8, { steps: 3 });
      await page.mouse.up();
      expect(reloads).toBe(0);
      await expect.poll(async () => (await first.boundingBox()).x).toBeGreaterThan(firstBefore.x + 4);
      await expect.poll(async () => (await second.boundingBox()).x).toBeGreaterThan(secondBefore.x + 4);

      await first.focus();
      const keyboardFirst = await first.boundingBox();
      const keyboardSecond = await second.boundingBox();
      await first.press('Shift+ArrowRight');
      await expect.poll(async () => (await first.boundingBox()).x).toBeGreaterThan(keyboardFirst.x + 8);
      await expect.poll(async () => (await second.boundingBox()).x).toBeGreaterThan(keyboardSecond.x + 8);

      const secondWidth = (await second.boundingBox()).width;
      await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
      const width = workspace.getByLabel('Width', { exact: true });
      await width.fill(String(Number(await width.inputValue()) - 20));
      await width.press('Enter');
      await workspace.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect.poll(async () => (await second.boundingBox()).width).toBeCloseTo(secondWidth, 0);

      await workspace.getByRole('button', { name: 'Clear pair selection' }).click();
      await expect(workspace.getByText('2 selected', { exact: true })).toHaveCount(0);
      await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
      await expect(workspace.getByText('2 selected', { exact: true })).toHaveCount(0);
    });

- [ ] **Step 2: Prove RED**

Run:

    npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
    npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "moves exactly two positioned"

Expected: no pair selection state or 2 selected status exists.

- [ ] **Step 3: Implement page ownership**

In PrintTemplates.vue, add:

    const selectedNodeIds = ref([]);

    function selectNode(id) {
        selectedNodeId.value = id;
        selectedNodeIds.value = id ? [id] : [];
        activePane.value = 'properties';
    }
    function clearPairSelection() {
        selectedNodeIds.value = selectedNodeId.value ? [selectedNodeId.value] : [];
    }
    function togglePreviewNode(id) {
        if (!selectedNodeId.value || selectedNodeId.value === id) return clearPairSelection();
        selectedNodeIds.value = selectedNodeIds.value.includes(id) ? [selectedNodeId.value] : [selectedNodeId.value, id];
    }
    function movePreviewNodes(moves) {
        const positions = new Map(moves.map(move => [move.id, move]));
        const next = structuredClone(toRaw(draftDefinition.value));
        const update = nodes => (nodes || []).reduce((count, node) => {
            const move = positions.get(node.id);
            if (move) { Object.assign(node, move); count += 1; }
            return count + (node.type === 'row' ? update(node.nodes) : 0);
        }, 0);
        const updated = next?.bands?.reduce((count, band) => count + update(band.nodes), 0) || 0;
        if (updated === positions.size) updateDraftDefinition(next);
    }

Pass :selected-ids="selectedNodeIds" to PrintTemplatePreview, bind @select-node to selectNode, and bind @toggle-node, @clear-selection, and @move-nodes to the functions above. Bind both editor update:selected-id listeners to selectNode.

Call clearPairSelection after a successful document switch, after restoreStartingLayout, after chooseRevision, and from the workspace watch callback.

- [ ] **Step 4: Implement preview eligibility and geometry**

Extend preview props and emits:

    selectedIds: { type: Array, default: () => [] }

    const emit = defineEmits(['select-node', 'toggle-node', 'clear-selection', 'move-node', 'move-nodes', 'interaction-start', 'interaction-end']);

During interactive-node traversal, add containerKey:

    if (node.type === 'row') {
        visit(node.nodes, node.layout === 'absolute' ? { width: 556, height: node.height, containerKey: 'row:' + node.id } : null);
    }

    for (const band of props.definition?.bands || []) {
        visit(band.nodes, band.layout === 'absolute' ? { width: 576, height: band.height, containerKey: 'band:' + band.id } : null);
    }

Use these helpers:

    function pairEntries(entry) {
        const selected = interactiveNodes.value.filter(candidate => props.selectedIds.includes(candidate.node.id));
        return selected.length === 2 && selected.every(candidate => candidate.positioned && candidate.containerKey === entry.containerKey) ? selected : [entry];
    }
    function clampedMoves(entries, dx, dy) {
        const lowerX = Math.max(...entries.map(entry => -entry.node.x));
        const upperX = Math.min(...entries.map(entry => entry.width - entry.node.x - entry.node.widthPx));
        const lowerY = Math.max(...entries.map(entry => -entry.node.y));
        const upperY = Math.min(...entries.map(entry => entry.height - entry.node.y - entry.node.heightPx));
        const nextX = Math.min(upperX, Math.max(lowerX, dx));
        const nextY = Math.min(upperY, Math.max(lowerY, dy));
        return entries.map(entry => ({ id: entry.node.id, x: entry.node.x + nextX, y: entry.node.y + nextY }));
    }

For a non-resize drag and arrow movement, call pairEntries(entry), then clampedMoves. Emit move-nodes for two moves, retaining move-node for one move and retaining the existing single-node resize branch. Render temporary overlay styles for every moved id, not just the dragged id.

On Shift/Ctrl/Command click or Shift+Enter, emit toggle-node only when the candidate and primary are positioned in the same container; otherwise emit select-node. Plain click selects one element.

Update the overlay button:

    :class="{ 'is-selected': selectedIds.includes(entry.node.id), 'is-primary': selectedId === entry.node.id, 'is-positioned': entry.positioned }"
    :aria-pressed="selectedIds.includes(entry.node.id)"
    aria-keyshortcuts="Shift+Enter ArrowLeft ArrowRight ArrowUp ArrowDown"

Add an inline header status only when selectedIds.length is two:

    <span v-if="selectedIds.length === 2" class="print-template-preview__selection-status" role="status">
        {{ $t('2 selected') }}
        <button type="button" :aria-label="$t('Clear pair selection')" @click="emit('clear-selection')">×</button>
    </span>

Style the primary outline solid teal, companion outline teal plus a light teal wash, and hide the direct-selection status below 1100px. Do not add heavy cards or decorative animation.

Add translations:

    '2 selected': 'عنصران محددان',
    'Clear pair selection': 'إلغاء تحديد العنصرين',

- [ ] **Step 5: Prove GREEN**

Run:

    npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
    npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "moves exactly two positioned"

Expected: both pass, no iframe navigation occurs while dragging, and both selected overlay boxes move in the same direction.

- [ ] **Step 6: Commit**

    git add src/admin/pages/PrintTemplates.vue src/admin/components/PrintTemplatePreview.vue src/shared/i18n.js src/admin/pages/__tests__/printTemplatesPage.spec.js tests/e2e/specs/admin.print-templates.spec.js
    git commit -m "feat(print-templates): move positioned element pairs"

## Task 3: Verify responsive behavior and complete regressions

**Files:**
- Modify only if this task identifies a scoped defect in a Task 1 or Task 2 file.

- [ ] **Step 1: Add phone geometry proof**

In the existing narrow-phone browser test, add:

    const documentControl = workspace.getByRole('group', { name: 'Document type' });
    await expect(documentControl).toBeVisible();
    for (const button of await documentControl.getByRole('button').all()) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

- [ ] **Step 2: Run phone proof**

Run:

    npx playwright test tests/e2e/specs/admin.print-templates.spec.js --grep "narrow phone"

Expected: document controls remain touch-sized and the document has no horizontal overflow.

- [ ] **Step 3: Run complete regression and build verification**

Run:

    npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/integration/printTemplates.test.js src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js
    npx playwright test tests/e2e/specs/admin.print-templates.spec.js
    npm run build
    git diff --check

Expected: all tests pass, Vite exits 0, and diff check has no output.

- [ ] **Step 4: Capture and inspect desktop, tablet, and phone screenshots**

Use authenticated admin screenshots at 1440x900, 768x900, and 390x844. Confirm that document controls are separated from fixture selection, the Kitchen title is truthful, no breakpoint overflows, and pair status appears only where direct positioning works.

- [ ] **Step 5: Commit verification-only test edits**

    git add tests/e2e/specs/admin.print-templates.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js
    git commit -m "test(print-templates): cover pair selection controls"

## Plan self-review

- Task 1 covers every document-control and preview-title requirement.
- Task 2 covers two-only temporary selection, compatible containers, atomic pointer/keyboard movement, shared clamping, single resize, clearing, accessibility, and no schema changes.
- Task 3 covers phone controls, all builder regressions, build output, and visual inspection.
- Function and event names are consistent across tasks: selectedNodeIds, selectNode, togglePreviewNode, movePreviewNodes, selectedIds, toggle-node, move-nodes.
- No task adds persistent grouping or backend work.

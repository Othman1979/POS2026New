import { test, expect } from '@playwright/test';
import pool from '../../../backend/config/db.js';

async function boundingBoxes(page, ids) {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [
    id,
    await page.locator(`[data-editor-node-id="${id}"]`).boundingBox()
  ])));
}

async function marqueeOver(page, ids) {
  await page.locator(`[data-editor-node-id="${ids[0]}"]`).scrollIntoViewIfNeeded();
  const boxes = Object.values(await boundingBoxes(page, ids));
  const stage = await page.locator('.print-template-preview__stage').boundingBox();
  const left = Math.max(stage.x + 2, Math.min(...boxes.map(box => box.x)) - 12);
  const top = Math.max(stage.y + 2, Math.min(...boxes.map(box => box.y)) - 12);
  const right = Math.max(...boxes.map(box => box.x + box.width)) + 12;
  const bottom = Math.max(...boxes.map(box => box.y + box.height)) + 12;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 4 });
  await page.mouse.up();
}

async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await page.mouse.up();
}

// Since 24acfb14 the built-in receipt item row uses proportional (flow)
// columns so long names wrap. Tests of the free-positioning tools promote it
// with the editor's own "Position columns freely" control first, which keeps
// the proportional widths (11.5 / 64.75 / 23.75 % of the 556px row, snapped to
// the 4px grid) and lays the columns out edge to edge in a 40px row:
// qty 0+64, name 64+360, total 424+132. Promoting leaves the row
// wrapper selected (it then sits above its columns and takes their clicks)
// with Properties open, so the helper returns the editor to a neutral state:
// nothing selected and the canvas showing. On the narrow layout the canvas
// lives in the Preview pane; on desktop it sits beside Structure. Tests that
// go on to edit the row itself pass { keepRowSelected: true }.
async function positionItemColumns(page, { keepRowSelected = false } = {}) {
  const workspace = page.locator('.print-templates-page');
  await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
  await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'receipt-item-row' }).click();
  await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
  await workspace.getByRole('button', { name: 'Position columns freely' }).click();
  await expect(workspace.getByLabel('Row height')).toHaveValue('40');
  if (keepRowSelected) {
    await expect(page.locator('[data-editor-node-id="receipt-item-name"]')).toBeVisible();
    return;
  }

  const previewPane = workspace.getByRole('button', { name: 'Preview', exact: true });
  await (await previewPane.isVisible() ? previewPane : workspace.getByRole('button', { name: 'Structure', exact: true })).click();
  const itemName = page.locator('[data-editor-node-id="receipt-item-name"]');
  await expect(itemName).toBeVisible();

  // A single selection has no clear button; an empty marquee on the canvas is
  // the editor's own way to select nothing. Start it on bare overlay.
  const overlay = page.locator('.print-template-preview__position-overlay');
  await overlay.scrollIntoViewIfNeeded();
  const start = await overlay.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let y = box.top + 4; y < Math.min(box.bottom, window.innerHeight) - 12; y += 4) {
      for (const x of [box.left + 4, box.right - 12]) {
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
    }
    return null;
  });
  expect(start).not.toBeNull();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('.print-template-preview__node-target.is-selected')).toHaveCount(0);
  await expect(itemName).toBeVisible();
}

test.describe('Print template lifecycle workspace', () => {

  test.afterEach(async () => {
    // These scenarios save drafts to verify the real publish path. The E2E
    // server owns a freshly seeded scratch database, so reset just the
    // receipt template afterwards instead of leaking one test's geometry into
    // the next one.
    const [templates] = await pool.query("SELECT id FROM print_templates WHERE document_type = 'receipt' LIMIT 1");
    const templateId = templates[0]?.id;
    if (!templateId) return;
    await pool.query('UPDATE print_templates SET active_revision_id = NULL, draft_revision_id = NULL WHERE id = ?', [templateId]);
    await pool.query('DELETE FROM print_template_revision_tests WHERE revision_id IN (SELECT id FROM print_template_revisions WHERE template_id = ?)', [templateId]);
    await pool.query('DELETE FROM print_template_revisions WHERE template_id = ?', [templateId]);
  });

  test('lets an admin inspect both server-rendered document types without browser printing', async ({ page }) => {
    await page.goto('/admin/print-templates');

    const workspace = page.locator('.print-templates-page');
    await expect(workspace.getByRole('heading', { name: 'Print Templates' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Receipt', exact: true })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Kitchen', exact: true })).toBeVisible();

    const fixture = workspace.locator('select').first();
    await expect(fixture).toBeVisible();
    const initialFixture = await fixture.inputValue();
    const alternatives = await fixture.locator('option').evaluateAll((options, current) =>
      options.map(option => option.value).filter(value => value && value !== current), initialFixture
    );
    if (alternatives[0]) await fixture.selectOption(alternatives[0]);
    await workspace.getByRole('button', { name: 'Refresh preview' }).click();

    const iframe = workspace.locator('iframe[title="Screen layout preview"]');
    await expect(iframe).toBeVisible();
    await expect(workspace.getByText('TEMPLATE PREVIEW — NOT A SALE', { exact: true })).toBeVisible();
    await expect(iframe.contentFrame().getByText('TEMPLATE PREVIEW — NOT A SALE', { exact: true })).toHaveCount(0);
    await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(await iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    await expect(iframe).toHaveAttribute('srcdoc', /default-src 'none'/);

    await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
    await expect(workspace.getByRole('button', { name: 'Kitchen', exact: true })).toHaveClass(/is-active/);
    await expect(fixture).toBeVisible();
    await expect(iframe).toBeVisible();
    // Normal tickets intentionally fall through to the store heading. Named
    // variants are reserved for subscription, follow-up, cancellation, etc.
    await expect(iframe.contentFrame().getByText('TEMPLATE CAFE', { exact: true })).toBeVisible();
    await expect(iframe.contentFrame().getByText('*** NO ONION · EXTRA CHEESE ***', { exact: true })).toBeVisible();
    await expect(iframe.contentFrame().getByText('-- ALSO ON ORDER --', { exact: true })).toBeVisible();
  });

  test('keeps document choice clear and names the kitchen server preview', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await expect(workspace.getByRole('group', { name: 'Document type' })).toBeVisible();
    await expect(workspace.getByLabel('Fixture')).toBeVisible();
    await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
    await expect(workspace.getByRole('heading', { name: 'Kitchen preview' })).toBeVisible();
    await expect(workspace.locator('iframe[title="Screen layout preview"]').contentFrame().getByText('TEMPLATE CAFE', { exact: true })).toBeVisible();
  });

  test('undoes and redoes one local template change', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');

    await workspace.getByRole('button', { name: 'Text', exact: true }).click();
    const editedNodeId = await workspace.locator('.print-template-editor__selection small').textContent();
    const english = workspace.getByLabel('English text');
    await expect(english).toHaveValue('Text');
    await english.fill('Undo alpha');
    await english.fill('Undo bravo');
    await english.blur();

    await workspace.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(english).toHaveValue('Text');
    await workspace.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(english).toHaveValue('Undo bravo');
    await expect(workspace.locator('iframe[title="Screen layout preview"]').contentFrame().getByText('Undo bravo', { exact: true }).first()).toBeVisible();

    await workspace.getByRole('button', { name: 'Save Revision' }).click();
    await workspace.getByRole('button', { name: 'Undo', exact: true }).click();
    // Save refreshes the workspace and intentionally repairs the selection to
    // the header. Re-select the edited block before checking the history.
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await workspace.locator(`[data-template-node-id="${editedNodeId}"] .print-template-editor__node-select`).click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await expect(workspace.getByLabel('English text')).toHaveValue('Text');
    // Return to the saved revision before changing document type so the
    // deliberate dirty-draft discard confirmation cannot block that switch.
    await workspace.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(workspace.getByLabel('English text')).toHaveValue('Undo bravo');

    await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
    await expect(workspace.getByRole('button', { name: 'Kitchen', exact: true })).toHaveClass(/is-active/);
    await expect(workspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await workspace.getByRole('button', { name: 'Receipt', exact: true }).click();
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await workspace.getByRole('button', { name: 'Text', exact: true }).click();
    const nativeUndo = workspace.getByLabel('English text');
    await nativeUndo.fill('Browser owned undo');
    await nativeUndo.press('Control+Z');
    await expect(nativeUndo).not.toHaveValue('Browser owned undo');
  });

  test('redirects a cashier away from the admin-only workspace', async ({ browser }) => {
    const cashier = await browser.newContext({ storageState: 'playwright/.auth/cashier.json' });
    const page = await cashier.newPage();
    await page.goto('/admin/print-templates');
    await page.waitForURL(/\/pos(?:\/|$)/);
    await cashier.close();
  });

  test('uses one built-in layout and lets an admin hide optional printed elements', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'payment.amountTendered' }).click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    const hidden = workspace.getByLabel('Always hide this element');
    const iframe = workspace.locator('iframe[title="Screen layout preview"]');
    await hidden.check();
    await expect(iframe.contentFrame().getByText('Tendered', { exact: true })).toHaveCount(0);
    await hidden.uncheck();
    await expect(iframe.contentFrame().getByText('Tendered', { exact: true })).toBeVisible();
  });

  test('rejects deliberately hiding receipt item notes', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const items = workspace.locator('.print-template-editor__band').filter({ has: page.locator('.print-template-editor__band-row small:text-is("items")') });
    const note = items.locator('.print-template-editor__node').filter({ has: page.locator('small:text-is("note")') });

    await note.locator('.print-template-editor__node-select').click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByLabel('Always hide this element').check();

    await expect(workspace.locator('.print-template-validation')).toContainText(/note cannot be hidden/i);
  });

  test('edits a named heading used by a kitchen workflow', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'meta.ticketTypeLabel' }).click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();

    await expect(workspace.getByLabel('Normal kitchen ticket English')).toHaveValue('');
    await expect(workspace.getByLabel('Void kitchen ticket English')).toHaveValue('');
    await workspace.getByLabel('Void kitchen ticket English').fill('GRILL VOID');
    await workspace.getByLabel('Fixture').selectOption('kitchen-void');

    const iframe = workspace.locator('iframe[title="Screen layout preview"]');
    await expect(iframe.contentFrame().getByText('GRILL VOID')).toBeVisible();
    await expect(workspace.getByLabel('Fixture').locator('option')).toHaveCount(2);
  });

  test('positions a top-level element on both axes and restores the built-in shape', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');

    await workspace.getByRole('button', { name: 'Edit store.name', exact: true }).click();
    await workspace.getByRole('button', { name: 'Enable X & Y positioning' }).click();
    await expect(workspace.getByLabel('X', { exact: true })).toBeVisible();
    await expect(workspace.getByLabel('Y', { exact: true })).toBeVisible();
    await expect(workspace.getByLabel('Width', { exact: true })).toHaveValue('272');
    await workspace.getByLabel('X', { exact: true }).fill('80');
    await workspace.getByLabel('X', { exact: true }).press('Enter');
    await expect(workspace.getByText('Custom layout', { exact: true })).toBeVisible();

    await workspace.getByRole('button', { name: 'Restore starting layout' }).click();
  });

  test('tightens adjacent flow elements into independently adjustable columns', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await expect(workspace.getByRole('button', { name: 'Edit store.name', exact: true })).toBeVisible();

    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'store.name' }).click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByRole('button', { name: 'Place next item beside this' }).click();

    // A flow band is 560px wide; the editor splits it on the 4px grid.
    // Assert the resulting half rather than the retired 576px-paper value.
    await expect(workspace.getByLabel('Width', { exact: true })).toHaveValue('268');
    // The printable content starts after its 8px inner margin.
    await expect(workspace.getByLabel('X', { exact: true })).toHaveValue('8');
    await expect(workspace.getByRole('button', { name: 'Position store.name', exact: true })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Position store.address', exact: true })).toBeVisible();
    await expect(workspace.getByText('Custom layout', { exact: true })).toBeVisible();
  });

  test('resizes a flow block into a row and fills the remaining space', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await workspace.locator('[data-template-node-id="store-name"] .print-template-editor__node-select').click();

    const flowTarget = workspace.getByRole('button', { name: 'Edit store.name', exact: true });
    await flowTarget.scrollIntoViewIfNeeded();
    const before = await flowTarget.boundingBox();
    const eastHandle = workspace.locator('.moveable-around-control[data-direction="e"]');
    await expect(eastHandle).toBeVisible();
    await dragBy(page, eastHandle, -120, 0);

    const positionedTarget = workspace.getByRole('button', { name: 'Position store.name', exact: true });
    await expect(positionedTarget).toBeVisible();
    await expect.poll(async () => (await positionedTarget.boundingBox()).width).toBeLessThan(before.width - 80);
    const slot = workspace.getByRole('button', { name: 'Add content to this row' });
    await expect(slot).toBeVisible();
    await slot.click();
    await expect(workspace.locator('[data-template-library] button:focus')).toHaveCount(1);
    await workspace.getByRole('button', { name: 'Text', exact: true }).click();
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    const row = workspace.locator('[data-template-node-id="store-name"]').locator('xpath=../..');
    await expect(row.locator(':scope > .print-template-structure-nodes > .print-template-editor__node')).toHaveCount(2);
    await workspace.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row.locator(':scope > .print-template-structure-nodes > .print-template-editor__node')).toHaveCount(1);
    await workspace.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(workspace.getByRole('button', { name: 'Edit store.name', exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(row.locator(':scope > .print-template-structure-nodes > .print-template-editor__node')).toHaveCount(1);
    await workspace.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(row.locator(':scope > .print-template-structure-nodes > .print-template-editor__node')).toHaveCount(2);
    await workspace.getByRole('button', { name: 'Save Revision' }).click();
    await expect(workspace.locator('.print-template-validation')).toHaveCount(0);
  });

  test('keeps flow resize on the selected axis', async ({ browser }, testInfo) => {
    async function resizeWithVerticalDrift(dy) {
      const context = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        storageState: 'playwright/.auth/admin.json',
        viewport: { width: 1280, height: 900 },
      });
      try {
        const resizePage = await context.newPage();
        await resizePage.goto('/admin/print-templates');
        const workspace = resizePage.locator('.print-templates-page');
        await workspace.locator('[data-template-node-id="store-name"] .print-template-editor__node-select').click();
        const target = workspace.getByRole('button', { name: 'Edit store.name', exact: true });
        await target.scrollIntoViewIfNeeded();
        await dragBy(resizePage, workspace.locator('.moveable-around-control[data-direction="e"]'), -120, dy);
        await expect(workspace.getByRole('button', { name: 'Position store.name', exact: true })).toBeVisible();
        await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
        return {
          width: Number(await workspace.getByLabel('Width', { exact: true }).inputValue()),
          height: Number(await workspace.getByLabel('Height', { exact: true }).inputValue()),
        };
      } finally {
        await context.close();
      }
    }

    const horizontal = await resizeWithVerticalDrift(0);
    const drifted = await resizeWithVerticalDrift(8);
    expect(drifted).toEqual(horizontal);
  });

  test('moves selected positioned elements together without preview reloads', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'store.name' }).click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByRole('button', { name: 'Place next item beside this' }).click();

    const first = workspace.getByRole('button', { name: 'Position store.name', exact: true });
    const second = workspace.getByRole('button', { name: 'Position store.address', exact: true });
    const width = workspace.getByLabel('Width', { exact: true });
    await width.fill('200');
    await width.press('Enter');
    await second.click();
    await width.fill('200');
    await width.press('Enter');
    await first.click();
    await second.click({ modifiers: ['Shift'] });
    const selectionStatus = workspace.locator('.print-template-preview__selection-status');
    await expect(selectionStatus).toContainText('2 selected');
    await workspace.getByRole('button', { name: 'Edit store.phone', exact: true }).click({ modifiers: ['Shift'] });
    await expect(selectionStatus).toHaveCount(0);
    await first.click();
    await second.click({ modifiers: ['Shift'] });

    const firstBefore = await first.boundingBox();
    const secondBefore = await second.boundingBox();
    let reloads = 0;
    page.on('framenavigated', frame => { if (frame.parentFrame()) reloads += 1; });
    await page.mouse.move(firstBefore.x + firstBefore.width / 2, firstBefore.y + firstBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstBefore.x + firstBefore.width / 2 + 16, firstBefore.y + firstBefore.height / 2 + 8);
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
    await width.fill(String(Number(await width.inputValue()) - 20));
    await width.press('Enter');
    await expect.poll(async () => Math.round((await second.boundingBox()).width)).toBe(Math.round(secondWidth));

    await workspace.getByRole('button', { name: 'Clear selection' }).click();
    await expect(selectionStatus).toHaveCount(0);
    await workspace.getByRole('button', { name: 'Kitchen', exact: true }).click();
    await expect(selectionStatus).toHaveCount(0);
  });

  test('marquee-selects only current same-container nodes', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const workspace = page.locator('.print-templates-page');
    const ids = ['receipt-item-qty', 'receipt-item-name', 'receipt-item-total'];

    await workspace.getByRole('button', { name: '100%', exact: true }).click();
    await page.waitForTimeout(100);
    await marqueeOver(page, ids);
    await expect(workspace.locator('.print-template-preview__selection-status')).toContainText('3 selected');

    const before = await boundingBoxes(page, ids);
    const beforeStage = await workspace.locator('.print-template-preview__stage').boundingBox();
    await page.locator('[data-editor-node-id="receipt-item-total"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => {
      const after = await boundingBoxes(page, ids);
      const afterStage = await workspace.locator('.print-template-preview__stage').boundingBox();
      return ids.map(id => Math.round((after[id].y - afterStage.y) - (before[id].y - beforeStage.y)));
    }).toEqual([4, 4, 4]);
  });

  test('resizes touching columns from their shared divider', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const divider = page.locator('[data-divider="receipt-item-qty|receipt-item-name"]');
    const qty = page.locator('[data-editor-node-id="receipt-item-qty"]');
    const name = page.locator('[data-editor-node-id="receipt-item-name"]');
    await expect(divider).toBeVisible();

    const beforeQty = await qty.boundingBox();
    const beforeName = await name.boundingBox();
    await divider.focus();
    await divider.press('ArrowRight');
    await expect.poll(async () => {
      const afterQty = await qty.boundingBox();
      const afterName = await name.boundingBox();
      return {
        qtyGrew: afterQty.width > beforeQty.width,
        nameShrank: afterName.width < beforeName.width,
        span: Math.round(afterQty.width + afterName.width) === Math.round(beforeQty.width + beforeName.width)
      };
    }).toEqual({ qtyGrew: true, nameShrank: true, span: true });
  });

  test('splitting a column leaves the pair exactly adjacent', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const workspace = page.locator('.print-templates-page');
    const divider = page.locator('[data-divider="receipt-item-qty|receipt-item-name"]');

    await divider.focus();
    // Promotion gives qty 64 / name 360 / total 132. One 4px step makes qty 68
    // and name 356, the widest column and the one the new field splits. 356 is
    // not a multiple of 8, so its half (178) is off the 4px grid and one side
    // must snap. The fixed split (ba784b52) keeps 176 and gives the new column
    // the exact remainder: name 68..244, new 244..424, total 424..556, three
    // touching pairs. The pre-ba784b52 logic gave the new column 176 at x=244
    // but left name at 356-176=180 (68..248): a 4px overlap with the new column
    // and a 4px gap before total, so only the qty|name divider would render.
    await divider.press('ArrowRight');
    await page.locator('[data-editor-node-id="receipt-item-name"]').click();
    await expect(workspace.getByLabel('Width', { exact: true })).toHaveValue('356');
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'receipt-item-row' }).click();
    await workspace.getByRole('button', { name: 'Field', exact: true }).click();

    // Dividers are rendered only when neighbours touch exactly. A four-column
    // row needs three handles, including both sides of the new column.
    await expect(page.locator('[data-divider*="receipt-item-"]')).toHaveCount(3);
  });

  test('adds a once-only logo to a compatible band when the items band is selected', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const band = id => workspace.locator('.print-template-editor__band').filter({ has: page.locator(`.print-template-editor__band-row small:text-is("${id}")`) });

    await band('items').locator('.print-template-editor__band-select').click();
    await workspace.locator('[data-node-type="store_logo"]').click();
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();

    await expect(band('header')).toContainText('Store logo');
    await expect(band('items')).not.toContainText('Store logo');
  });

  test('restores coordinates when positioning is switched off and back on', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const ids = ['receipt-item-qty', 'receipt-item-name', 'receipt-item-total'];

    await positionItemColumns(page, { keepRowSelected: true });
    await workspace.getByLabel('Row height').fill('120');
    await workspace.getByLabel('Row height').press('Enter');
    const before = await boundingBoxes(page, ids);
    await workspace.getByRole('button', { name: 'Use proportional columns' }).click();
    await workspace.getByRole('button', { name: 'Position columns freely' }).click();

    await expect(workspace.getByLabel('Row height')).toHaveValue('120');
    await expect.poll(async () => boundingBoxes(page, ids)).toEqual(before);
  });

  test('restores a positioned section height with its child coordinates', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const header = workspace.locator('.print-template-editor__band').filter({ has: page.locator('.print-template-editor__band-row small:text-is("header")') });

    await header.locator('.print-template-editor__band-select').click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByRole('button', { name: 'Enable visual positioning' }).click();
    await workspace.getByLabel('Section height').fill('400');
    await workspace.getByLabel('Section height').press('Enter');
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.locator('[data-editor-node-id="store-name"]').click();
    await workspace.getByLabel('Y', { exact: true }).fill('360');
    await workspace.getByLabel('Y', { exact: true }).press('Enter');
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await header.locator('.print-template-editor__band-select').click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByRole('button', { name: 'Use flow layout' }).click();
    await workspace.getByRole('button', { name: 'Enable visual positioning' }).click();

    await expect(workspace.getByLabel('Section height')).toHaveValue('400');
    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.locator('[data-editor-node-id="store-name"]').click();
    await expect(workspace.getByLabel('Y', { exact: true })).toHaveValue('360');
  });

  test('uses side-by-side-sized boxes after enabling positioning', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');

    await workspace.locator('.print-template-editor__band').filter({ hasText: 'Totals' }).locator('.print-template-editor__band-select').click();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await workspace.getByRole('button', { name: 'Enable visual positioning' }).click();
    await page.locator('[data-editor-node-id="subtotal"]').click();

    await expect(workspace.getByLabel('Width', { exact: true })).toHaveValue('272');
  });

  test('shows both columns resizing while the divider is dragged', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const divider = page.locator('[data-divider="receipt-item-qty|receipt-item-name"]');
    const qty = page.locator('[data-editor-node-id="receipt-item-qty"]');
    const before = await qty.boundingBox();
    await divider.focus();
    await divider.press('ArrowRight');
    await expect.poll(async () => (await qty.boundingBox()).width).toBeGreaterThan(before.width + 3);
  });

  test('lets an admin delete a required field and shows what the server rejects', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const subtotal = workspace.locator('.print-template-editor__node').filter({ hasText: 'summary.subtotal' });

    await expect(page.locator('.print-template-preview__paper')).toBeVisible();
    await subtotal.getByLabel('Content block actions').click();
    await subtotal.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('.print-template-validation')).toContainText(/subtotal/i);
    await expect(page.locator('.print-template-preview__paper')).toBeVisible();
  });

  test('a positioned element has room to move on both axes', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const total = page.locator('[data-editor-node-id="receipt-item-total"]');
    await expect(total).toBeVisible();
    // Measure against the paper: focusing a control may scroll the viewport.
    const paper = page.locator('.print-template-preview__paper');
    const onPaper = async () => {
      const [box, origin] = await Promise.all([total.boundingBox(), paper.boundingBox()]);
      return { x: box.x - origin.x, y: box.y - origin.y };
    };
    const before = await onPaper();

    await total.focus();
    await total.press('ArrowLeft');
    await total.press('ArrowDown');

    await expect.poll(async () => (await onPaper()).x).toBeLessThan(before.x);
    await expect.poll(async () => (await onPaper()).y).toBeGreaterThan(before.y);
  });


  test('keeps Moveable touch controls at least 44px', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const total = page.locator('[data-editor-node-id="receipt-item-total"]');
    await total.click();
    const controls = page.locator('.moveable-around-control[data-direction]');
    await expect(controls.first()).toBeVisible();
    const sizes = await controls.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.className, width: rect.width, height: rect.height };
    }));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter(size => size.width < 44 || size.height < 44)).toEqual([]);
  });

  test('keeps controls aligned through the preview zoom cycle', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    const workspace = page.locator('.print-templates-page');
    const target = page.locator('[data-editor-node-id="receipt-item-total"]');
    await target.click();
    const east = workspace.locator('.moveable-around-control[data-direction="e"]');

    async function alignmentError() {
      const targetBox = await target.boundingBox();
      const handleBox = await east.boundingBox();
      const targetRight = targetBox.x + targetBox.width;
      return {
        x: Math.min(Math.abs(handleBox.x - targetRight), Math.abs((handleBox.x + handleBox.width) - targetRight)),
        y: Math.abs((handleBox.y + (handleBox.height / 2)) - (targetBox.y + (targetBox.height / 2))),
      };
    }

    for (const zoom of ['100%', 'Fit']) {
      await workspace.getByRole('button', { name: zoom, exact: true }).click();
      await expect.poll(async () => {
        const error = await alignmentError();
        return Math.max(error.x, error.y);
      }).toBeLessThan(2);
    }
  });

  test('cancels a canvas gesture without history', async ({ page, browser }, testInfo) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const total = page.locator('[data-editor-node-id="receipt-item-total"]');
    await expect(workspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await total.click();
    const before = await total.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2 + 8);
    await workspace.locator('.print-template-preview__canvas').evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
    await page.mouse.up();
    await expect(workspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    const after = await total.boundingBox();
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.y)).toBe(Math.round(before.y));

    const touchContext = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: 'playwright/.auth/admin.json',
      hasTouch: true,
      viewport: { width: 1280, height: 900 },
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto('/admin/print-templates');
      const touchWorkspace = touchPage.locator('.print-templates-page');
      const itemName = touchPage.locator('[data-editor-node-id="receipt-item-name"]');
      await itemName.tap();
      const touchBefore = await itemName.boundingBox();
      const session = await touchContext.newCDPSession(touchPage);
      const start = { x: touchBefore.x + touchBefore.width / 2, y: touchBefore.y + touchBefore.height / 2 };
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + 20, y: start.y + 8 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await expect(touchWorkspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      const touchAfter = await itemName.boundingBox();
      expect(Math.round(touchAfter.x)).toBe(Math.round(touchBefore.x));
      expect(Math.round(touchAfter.y)).toBe(Math.round(touchBefore.y));
    } finally {
      await touchContext.close();
    }
  });

  test('moves positioned elements equivalently by touch', async ({ page, browser }, testInfo) => {
    await page.goto('/admin/print-templates');
    const mouseWorkspace = page.locator('.print-templates-page');
    await positionItemColumns(page);
    const mouseTarget = page.locator('[data-editor-node-id="receipt-item-name"]');
    await mouseTarget.click();
    const mouseStart = {
      x: Number(await mouseWorkspace.getByLabel('X', { exact: true }).inputValue()),
      y: Number(await mouseWorkspace.getByLabel('Y', { exact: true }).inputValue()),
    };
    const mouseScale = (await mouseWorkspace.locator('.print-template-preview__stage').boundingBox()).width / 576;
    await dragBy(page, mouseTarget, 16 * mouseScale, 8 * mouseScale);
    const mouseDelta = {
      x: Number(await mouseWorkspace.getByLabel('X', { exact: true }).inputValue()) - mouseStart.x,
      y: Number(await mouseWorkspace.getByLabel('Y', { exact: true }).inputValue()) - mouseStart.y,
    };

    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: 'playwright/.auth/admin.json',
      hasTouch: true,
      viewport: { width: 1280, height: 900 }
    });
    try {
      const touchPage = await context.newPage();
      await touchPage.goto('/admin/print-templates');
      await positionItemColumns(touchPage);
      const itemName = touchPage.locator('[data-editor-node-id="receipt-item-name"]');
      await expect(itemName).toBeVisible();
      await itemName.tap();
      const before = await itemName.boundingBox();
      const touchStart = {
        x: Number(await touchPage.getByLabel('X', { exact: true }).inputValue()),
        y: Number(await touchPage.getByLabel('Y', { exact: true }).inputValue()),
      };
      const touchScale = (await touchPage.locator('.print-template-preview__stage').boundingBox()).width / 576;
      const session = await context.newCDPSession(touchPage);
      const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (16 * touchScale), y: start.y + (8 * touchScale) }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => Number(await touchPage.getByLabel('X', { exact: true }).inputValue())).toBeGreaterThan(touchStart.x);
      const touchDelta = {
        x: Number(await touchPage.getByLabel('X', { exact: true }).inputValue()) - touchStart.x,
        y: Number(await touchPage.getByLabel('Y', { exact: true }).inputValue()) - touchStart.y,
      };
      expect(touchDelta).toEqual(mouseDelta);
    } finally {
      await context.close();
    }
  });

  test('keeps physical geometry in RTL', async ({ page }) => {
    await page.goto('/admin/print-templates');
    await positionItemColumns(page);
    try {
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      const itemName = page.locator('[data-editor-node-id="receipt-item-name"]');
      await itemName.focus();
      const before = await itemName.boundingBox();
      await itemName.press('ArrowRight');
      await expect.poll(async () => (await itemName.boundingBox()).x).toBeGreaterThan(before.x);
    } finally {
      await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    }
  });

  test('adds a fourth column to the item row', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');

    await workspace.locator('.print-template-editor__node-select').filter({ hasText: 'receipt-item-row' }).click();
    await workspace.getByRole('button', { name: 'Field', exact: true }).click();
    await workspace.getByLabel('Field').selectOption('unitPrice');

    const paper = workspace.locator('iframe[title="Screen layout preview"]').contentFrame();
    await expect(paper.locator('[data-node="receipt-item-row"]').first().locator('[data-node]')).toHaveCount(4);
    await workspace.getByRole('button', { name: 'Save Revision' }).click();
    await expect(page.locator('.print-template-validation')).toHaveCount(0);
  });

  test('reorders sections with the visible drag handle', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const bands = workspace.locator('.print-template-editor__band');
    const ids = bands.locator('.print-template-editor__band-select small');
    await expect(bands.first()).toBeVisible();
    const before = await ids.allTextContents();

    const sourceBand = bands.nth(0);
    const targetBand = bands.nth(1);
    const handleBox = await sourceBand.locator('.print-template-editor__band-drag').boundingBox();
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 20, { steps: 5 });
    await expect(sourceBand).toHaveClass(/sortable-chosen/);
    const targetBox = await targetBand.locator('.print-template-editor__band-row').boundingBox();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 30 });
    await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).toEqual([before[1], before[0]]);
    await page.mouse.up();

    await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).toEqual([before[1], before[0]]);
  });

  test('keeps structure controls touch-sized and keyboard reorderable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const controls = workspace.locator([
      '.print-template-editor__add',
      '.print-template-editor__band-drag',
      '.print-template-editor__band-select',
      '.print-template-editor__band-menu summary',
      '.print-template-editor__node-drag',
      '.print-template-editor__node-select',
      '.print-template-editor__node-menu summary',
    ].join(','));
    await expect(controls.first()).toBeVisible();
    const sizes = await controls.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.className, width: rect.width, height: rect.height };
    }));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter(size => size.width < 44 || size.height < 44)).toEqual([]);

    const bands = workspace.locator('.print-template-editor__band');
    const ids = bands.locator('.print-template-editor__band-select small');
    const before = await ids.allTextContents();
    const secondHandle = bands.nth(1).locator('.print-template-editor__band-drag');
    await secondHandle.focus();
    await expect(secondHandle).toBeFocused();
    const focusStyle = await secondHandle.evaluate(element => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(focusStyle.style).not.toBe('none');
    expect(focusStyle.width).toBeGreaterThanOrEqual(2);
    await secondHandle.press('Alt+ArrowUp');
    await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).toEqual([before[1], before[0]]);

    const nestedList = workspace.locator('[data-template-node-id="receipt-item-row"] > .print-template-structure-nodes');
    const nestedNodes = nestedList.locator(':scope > .print-template-editor__node');
    const nestedIds = nestedNodes.locator(':scope > .print-template-editor__node-select small');
    const nestedBefore = await nestedIds.allTextContents();
    const nestedHandle = nestedNodes.nth(1).locator(':scope > .print-template-editor__node-drag');
    await nestedHandle.scrollIntoViewIfNeeded();
    await nestedHandle.focus();
    const nestedFocusStyle = await nestedHandle.evaluate(element => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(nestedFocusStyle.style).not.toBe('none');
    expect(nestedFocusStyle.width).toBeGreaterThanOrEqual(2);
    await nestedNodes.nth(1).getByLabel('Content block actions').click();
    await nestedNodes.nth(1).getByRole('button', { name: 'Move up', exact: true }).click();
    await expect.poll(async () => (await nestedIds.allTextContents()).slice(0, 2)).toEqual([nestedBefore[1], nestedBefore[0]]);
  });

  test('reorders structure blocks by touch', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: 'playwright/.auth/admin.json',
      hasTouch: true,
      viewport: { width: 1280, height: 1800 },
    });
    try {
      const touchPage = await context.newPage();
      await touchPage.goto('/admin/print-templates');
      const list = touchPage.locator('.print-template-editor__band').first().locator(':scope > .print-template-structure-nodes');
      const nodes = list.locator('.print-template-editor__node');
      const ids = nodes.locator('.print-template-editor__node-select small');
      await expect(nodes.nth(1)).toBeVisible();
      const before = await ids.allTextContents();
      const source = await nodes.nth(1).locator('.print-template-editor__node-drag').boundingBox();
      const target = await nodes.nth(0).locator('.print-template-editor__node-drag').boundingBox();
      const session = await context.newCDPSession(touchPage);
      const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await touchPage.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y - 20 }] });
      await expect(nodes.nth(1)).toHaveClass(/sortable-chosen/);
      await touchPage.waitForTimeout(100);
      for (let step = 1; step <= 6; step += 1) {
        const progress = step / 6;
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
          x: start.x + ((target.x + target.width / 2) - start.x) * progress,
          y: (start.y - 20) + ((target.y + target.height / 2) - (start.y - 20)) * progress,
        }] });
        await touchPage.waitForTimeout(30);
      }
      await touchPage.waitForTimeout(100);
      await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).toEqual([before[1], before[0]]);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).toEqual([before[1], before[0]]);

      const nestedList = touchPage.locator('[data-template-node-id="receipt-item-row"] > .print-template-structure-nodes');
      const nestedNodes = nestedList.locator(':scope > .print-template-editor__node');
      const nestedIds = nestedNodes.locator(':scope > .print-template-editor__node-select small');
      const nestedBefore = await nestedIds.allTextContents();
      const nestedSource = nestedNodes.nth(1);
      await nestedSource.scrollIntoViewIfNeeded();
      const bandIndexBefore = await nestedSource.evaluate(element => [...document.querySelectorAll('.print-template-editor__band')].indexOf(element.closest('.print-template-editor__band')));
      const nestedSourceBox = await nestedSource.locator(':scope > .print-template-editor__node-drag').boundingBox();
      const nestedTargetBox = await nestedNodes.nth(0).locator(':scope > .print-template-editor__node-drag').boundingBox();
      const nestedStart = { x: nestedSourceBox.x + nestedSourceBox.width / 2, y: nestedSourceBox.y + nestedSourceBox.height / 2 };
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [nestedStart] });
      await touchPage.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nestedStart.x, y: nestedStart.y - 20 }] });
      await expect(nestedSource).toHaveClass(/sortable-chosen/);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nestedTargetBox.x + nestedTargetBox.width / 2, y: nestedTargetBox.y + nestedTargetBox.height / 2 }] });
      await touchPage.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await nestedIds.allTextContents()).slice(0, 2)).toEqual([nestedBefore[1], nestedBefore[0]]);
      const bandIndexAfter = await nestedNodes.first().evaluate(element => [...document.querySelectorAll('.print-template-editor__band')].indexOf(element.closest('.print-template-editor__band')));
      expect(bandIndexAfter).toBe(bandIndexBefore);
    } finally {
      await context.close();
    }
  });

  test('rejects existing-node cross-parent structure drops', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.goto('/admin/print-templates');
    const source = page.locator('[data-template-node-id="receipt-item-name"]');
    const sourceHandle = source.locator(':scope > .print-template-editor__node-drag');
    const targetList = page.locator('[data-template-node-id="receipt-item-row"]').locator('xpath=..');
    const parentBefore = await source.evaluate(element => element.parentElement?.parentElement?.dataset.templateNodeId || '');
    await sourceHandle.scrollIntoViewIfNeeded();
    const sourceBox = await sourceHandle.boundingBox();
    const targetBox = await targetList.boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2 + 20, { steps: 4 });
    await expect.poll(() => page.locator('[data-template-node-id="receipt-item-name"].sortable-chosen').count()).toBeGreaterThan(0);
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 10, { steps: 20 });
    await page.mouse.up();
    await expect(source).toBeVisible();
    const parentAfter = await source.evaluate(element => element.parentElement?.parentElement?.dataset.templateNodeId || '');
    expect(parentAfter).toBe(parentBefore);
  });

  test('auto-scrolls the structure pane during touch reordering', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: 'playwright/.auth/admin.json',
      hasTouch: true,
      viewport: { width: 1200, height: 520 },
    });
    try {
      const touchPage = await context.newPage();
      await touchPage.goto('/admin/print-templates');
      const pane = touchPage.locator('.print-templates-page__editor-pane');
      const list = touchPage.locator('.print-template-editor__band').first().locator(':scope > .print-template-structure-nodes');
      const nodes = list.locator(':scope > .print-template-editor__node');
      const ids = nodes.locator(':scope > .print-template-editor__node-select small');
      const beforeIds = await ids.allTextContents();
      const handle = nodes.first().locator(':scope > .print-template-editor__node-drag');
      await handle.scrollIntoViewIfNeeded();
      const paneBox = await pane.boundingBox();
      const handleBox = await handle.boundingBox();
      const beforeScroll = await pane.evaluate(element => element.scrollTop);
      expect(await pane.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);

      const session = await context.newCDPSession(touchPage);
      const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
      const edgeY = Math.min(510, paneBox.y + paneBox.height - 4);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await touchPage.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: Math.min(edgeY, start.y + 30) }] });
      await expect.poll(() => touchPage.locator('.sortable-chosen').count()).toBeGreaterThan(0);
      for (let step = 0; step < 15; step += 1) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: edgeY }] });
        await touchPage.waitForTimeout(100);
      }
      await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeScroll);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await ids.allTextContents()).slice(0, 2)).not.toEqual(beforeIds.slice(0, 2));
    } finally {
      await context.close();
    }
  });

  test('inserts a palette block at the dropped structure position', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const targetList = workspace.locator('.print-template-editor__band').first().locator(':scope > .print-template-structure-nodes');
    const nodes = targetList.locator('.print-template-editor__node');
    await expect(nodes.first()).toBeVisible();
    const before = await nodes.count();
    const beforeIds = new Set(await nodes.evaluateAll(elements => elements.map(element => element.dataset.templateNodeId)));
    const source = workspace.locator('[data-node-type="text"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await targetList.boundingBox();

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2 + 20, { steps: 4 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 8, { steps: 20 });
    // The placeholder grows the list by one row, so the original bottom edge
    // now sits in the dead band at the foot of the second-to-last block (the
    // list uses a 0.65 swap threshold). Settle over the middle of the block
    // that is now last, as a person aiming for the end would.
    const lastNode = targetList.locator(':scope > .print-template-editor__node').last();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.waitForTimeout(200);
      const lastBox = await lastNode.boundingBox();
      await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2 + attempt, { steps: 4 });
    }
    await page.mouse.up();

    await workspace.getByRole('button', { name: 'Structure', exact: true }).click();
    await expect(nodes).toHaveCount(before + 1);
    const added = await nodes.evaluateAll((elements, knownIds) => elements
      .map((element, index) => ({ id: element.dataset.templateNodeId, index, label: element.querySelector('.print-template-editor__node-select')?.textContent }))
      .filter(entry => !knownIds.includes(entry.id)), [...beforeIds]);
    expect(added).toHaveLength(1);
    expect(added[0].label).toContain('Text');
    expect(added[0].index).toBeGreaterThanOrEqual(before - 1);
  });

  test('does not duplicate the unique JoFotara QR block', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const qrBlocks = workspace.locator('[data-template-node-id="jofotara-qr"]');
    await expect(qrBlocks).toHaveCount(1);
    await expect(workspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await qrBlocks.first().getByLabel('Content block actions').click();
    await qrBlocks.first().getByRole('button', { name: 'Duplicate', exact: true }).click();

    await expect(qrBlocks).toHaveCount(1);
    await expect(workspace.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('reorders sections by drag and keeps the fitted server preview inside its canvas', async ({ page }) => {
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    const bands = workspace.locator('.print-template-editor__band');
    await expect(bands.first()).toBeVisible();
    expect(await bands.count()).toBeGreaterThan(1);

    const firstBandNodes = bands.first().locator(':scope > .print-template-structure-nodes > .print-template-editor__node');
    const nodeCount = await firstBandNodes.count();
    await workspace.locator('[data-node-type="text"]').click();
    await workspace.locator('.print-templates-page__panes button.is-structure').click();
    await expect(firstBandNodes).toHaveCount(nodeCount + 1);
    await positionItemColumns(page);

    const nameColumn = workspace.getByRole('button', { name: 'Position name', exact: true });
    await expect(nameColumn).toBeVisible();
    expect(await nameColumn.evaluate(element => getComputedStyle(element).borderTopColor)).toBe('rgba(0, 0, 0, 0)');
    const iframe = workspace.locator('iframe[title="Screen layout preview"]');
    let previewReloads = 0;
    const countPreviewReload = frame => { if (frame.parentFrame()) previewReloads += 1; };
    page.on('framenavigated', countPreviewReload);
    await nameColumn.scrollIntoViewIfNeeded();
    const columnBefore = await nameColumn.boundingBox();
    await page.mouse.move(columnBefore.x + columnBefore.width / 2, columnBefore.y + columnBefore.height / 2);
    await page.mouse.down();
    // A real drag must keep the preview mounted. A click opens Properties
    // after pointerup, but switching panes on pointerdown hides the canvas.
    await expect(workspace.locator('.print-templates-page__panes button.is-properties')).not.toHaveClass(/is-active/);
    await page.mouse.move(columnBefore.x + columnBefore.width / 2 + 20, columnBefore.y + columnBefore.height / 2, { steps: 4 });
    await page.waitForTimeout(500);
    expect(previewReloads).toBe(0);
    await page.mouse.up();
    await workspace.getByRole('button', { name: 'Properties', exact: true }).click();
    await expect(iframe).toBeVisible();
    const firstMovedColumn = await nameColumn.boundingBox();
    await page.mouse.move(firstMovedColumn.x + firstMovedColumn.width / 2, firstMovedColumn.y + firstMovedColumn.height / 2);
    const xBeforeSecondDrag = Number(await workspace.getByLabel('X', { exact: true }).inputValue());
    await page.mouse.down();
    await page.mouse.move(firstMovedColumn.x + firstMovedColumn.width / 2 + 16, firstMovedColumn.y + firstMovedColumn.height / 2, { steps: 2 });
    await page.mouse.up();
    page.off('framenavigated', countPreviewReload);
    await expect.poll(async () => Number(await workspace.getByLabel('X', { exact: true }).inputValue())).toBeGreaterThan(xBeforeSecondDrag);
    await expect.poll(async () => (await nameColumn.boundingBox())?.x).toBeGreaterThan(columnBefore.x + 8);
    const rightX = Number(await workspace.getByLabel('X', { exact: true }).inputValue());
    const rightColumn = await nameColumn.boundingBox();
    await page.mouse.move(rightColumn.x + rightColumn.width / 2, rightColumn.y + rightColumn.height / 2);
    await page.mouse.down();
    await page.mouse.move(rightColumn.x + rightColumn.width / 2 - 20, rightColumn.y + rightColumn.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await workspace.getByLabel('X', { exact: true }).inputValue())).toBeLessThan(rightX);
    await expect.poll(async () => (await nameColumn.boundingBox())?.x).toBeLessThan(rightColumn.x - 8);
    const leftColumn = await nameColumn.boundingBox();
    await page.mouse.move(leftColumn.x + leftColumn.width / 2, leftColumn.y + leftColumn.height / 2);
    await page.mouse.down();
    await page.mouse.move(leftColumn.x + leftColumn.width / 2 + 500, leftColumn.y + leftColumn.height / 2, { steps: 8 });
    await page.mouse.up();
    const edgeX = Number(await workspace.getByLabel('X', { exact: true }).inputValue());
    expect(edgeX).toBeGreaterThan(rightX);
    await expect.poll(async () => (await nameColumn.boundingBox())?.x).toBeGreaterThan(leftColumn.x + 8);
    // Drive further beyond the same edge. The model width is the printable
    // inner width, not the 576px paper width, so prove the clamp by behaviour.
    const edgeColumn = await nameColumn.boundingBox();
    await page.mouse.move(edgeColumn.x + edgeColumn.width / 2, edgeColumn.y + edgeColumn.height / 2);
    await page.mouse.down();
    await page.mouse.move(edgeColumn.x + edgeColumn.width / 2 + 500, edgeColumn.y + edgeColumn.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Number(await workspace.getByLabel('X', { exact: true }).inputValue())).toBe(edgeX);
    await page.mouse.move(edgeColumn.x + edgeColumn.width / 2, edgeColumn.y + edgeColumn.height / 2);
    await page.mouse.down();
    await page.mouse.move(edgeColumn.x + edgeColumn.width / 2 - 48, edgeColumn.y + edgeColumn.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await workspace.getByLabel('X', { exact: true }).inputValue())).toBeLessThan(edgeX);
    // The model updates before the overlay remeasures; grabbing a stale box
    // lands on the east resize handle instead of the column body.
    await expect.poll(async () => (await nameColumn.boundingBox())?.x).toBeLessThan(edgeColumn.x - 8);
    const beforeMoveColumn = await nameColumn.boundingBox();
    const widthBeforeMove = Number(await workspace.getByLabel('Width', { exact: true }).inputValue());
    const xBeforeMove = Number(await workspace.getByLabel('X', { exact: true }).inputValue());
    await page.mouse.move(beforeMoveColumn.x + beforeMoveColumn.width / 2, beforeMoveColumn.y + beforeMoveColumn.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeMoveColumn.x + beforeMoveColumn.width / 2 + 16, beforeMoveColumn.y + beforeMoveColumn.height / 2, { steps: 2 });
    await page.mouse.up();
    await expect(workspace.getByLabel('Width', { exact: true })).toHaveValue(String(widthBeforeMove));
    await expect.poll(async () => Number(await workspace.getByLabel('X', { exact: true }).inputValue())).toBeGreaterThan(xBeforeMove);
    const movedColumn = await nameColumn.boundingBox();
    const widthBeforeResize = Number(await workspace.getByLabel('Width', { exact: true }).inputValue());
    const modelScale = movedColumn.width / Number(await workspace.getByLabel('Width', { exact: true }).inputValue());
    const eastResize = workspace.locator('.moveable-around-control[data-direction="e"]');
    await dragBy(page, eastResize, 20 * modelScale, 0);
    await expect.poll(async () => Number(await workspace.getByLabel('Width', { exact: true }).inputValue())).toBeGreaterThan(widthBeforeResize);
    await expect.poll(async () => (await nameColumn.boundingBox())?.width).toBeGreaterThan(movedColumn.width + 8);
    await workspace.locator('.print-templates-page__panes button.is-structure').click();
    await nameColumn.focus();
    await nameColumn.press('Enter');
    await expect(workspace.locator('.print-templates-page__panes button.is-properties')).toHaveClass(/is-active/);
    await workspace.locator('.print-templates-page__panes button.is-structure').click();

    await workspace.getByRole('button', { name: 'Edit store.name', exact: true }).click();
    await expect(workspace.locator('.print-templates-page__panes button.is-properties')).toHaveClass(/is-active/);
    await expect(workspace.locator('.print-template-editor__selection small')).toHaveText('store-name');
    await workspace.locator('.print-templates-page__panes button.is-structure').click();

    const previewViewport = workspace.locator('.print-template-preview__viewport');
    expect(await previewViewport.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const frame = iframe.contentFrame();
    expect(await frame.locator('html').evaluate(element => element.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });

  test('accepts a saved receipt revision without a paper-confirmation gate and retains stale local edits', async ({ page, browser }) => {
    const staleContext = await browser.newContext({ storageState: 'playwright/.auth/admin.json' });
    const stalePage = await staleContext.newPage();
    await Promise.all([page.goto('/admin/print-templates'), stalePage.goto('/admin/print-templates')]);
    const workspace = page.locator('.print-templates-page');
    const staleWorkspace = stalePage.locator('.print-templates-page');
    await expect(workspace.getByRole('button', { name: 'Text', exact: true })).toBeVisible();
    await expect(staleWorkspace.getByRole('button', { name: 'Text', exact: true })).toBeVisible();

    await workspace.getByRole('button', { name: 'Text', exact: true }).click();
    await workspace.getByLabel('English text').fill('Front header');
    await workspace.getByLabel('Arabic text').fill('عنوان أمامي');
    await expect(workspace.locator('iframe[title="Screen layout preview"]')).toBeVisible();

    await staleWorkspace.getByRole('button', { name: 'Text', exact: true }).click();
    await staleWorkspace.getByLabel('English text').fill('Stale local header');

    await workspace.getByRole('button', { name: 'Save Revision' }).click();
    await workspace.getByRole('button', { name: 'Publish', exact: true }).click();
    const publish = workspace.getByRole('button', { name: 'Accept & Publish', exact: true });
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(workspace.getByText('A published revision is active for this document type.')).toBeVisible();

    await staleWorkspace.getByRole('button', { name: 'Save Revision' }).click();
    await expect(staleWorkspace.getByText('Another admin saved a newer revision. Your local edits are still here.')).toBeVisible();
    await expect(staleWorkspace.getByLabel('English text')).toHaveValue('Stale local header');
    await staleContext.close();
  });

  test('keeps every editor pane reachable on a narrow phone without browser receipt printing and keeps report jobs artifact-free', async ({ page }) => {
    const [printer] = await pool.query(
      "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Template E2E Report', 'receipt', 'windows', 'Template E2E Report', 1)"
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/print-templates');
    const workspace = page.locator('.print-templates-page');
    for (const pane of ['Structure', 'Preview', 'Properties', 'Publish']) {
      await workspace.getByRole('button', { name: pane, exact: true }).click();
      await expect(workspace).toHaveClass(new RegExp(`is-${pane.toLowerCase()}`));
    }
    await positionItemColumns(page);
    await workspace.getByRole('button', { name: 'Preview', exact: true }).click();
    await workspace.getByRole('button', { name: 'Position name', exact: true }).click();
    await expect(workspace).toHaveClass(/is-properties/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const report = await page.request.post('/api/print/print', {
      data: {
        print_type: 'daily_summary_report', receipt_printer_id: printer.insertId, report_id: 'template-builder-scope-e2e',
        period: { start_date: '2026-07-26', end_date: '2026-07-26', business_day_start_hour: 6 },
        summary: {}, comparison: {}, payments: [], order_types: [], hourly_sales: [], cash_status: {}
      }
    });
    expect(report.ok()).toBe(true);
    const [reportJobs] = await pool.query(
      "SELECT payload FROM print_queue WHERE print_type = 'daily_summary_report' ORDER BY id DESC LIMIT 1"
    );
    const payload = JSON.parse(reportJobs[0].payload);
    expect(payload.data.compiled_document_v1).toBeUndefined();
    expect(payload.data.template_test).toBeUndefined();
  });
});

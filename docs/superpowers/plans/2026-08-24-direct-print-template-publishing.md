# Direct Print Template Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace printer-by-printer template certification with one `Accept & Publish` action that activates a saved revision for every matching printer.

**Architecture:** Keep revision saving, validation, optimistic locking, auditing, compiler fallback, routing checks, history, and built-in rollback. Remove printer-test proof from the two places where it currently changes product behavior: activation and runtime resolution. Delete the unused test-print ceremony from the admin composable/page, but retain the existing API endpoints and database history as dormant compatibility surface.

**Tech Stack:** Vue 3 Composition API, Express 5, MySQL/MariaDB, Vitest, Supertest.

## Global Constraints

- Work on the normal feature branch `codex/fix-print-template-active-provenance`; do not create or use a worktree.
- Do not push, merge, deploy, migrate a database, rebuild installers, or change Hostinger.
- Use focused RED/GREEN tests only; do not run the complete repository suite.
- Do not change spooler delivery, printer routing, compiled artifact rendering, template schema, or print queue idempotency.
- Keep the existing `Save Revision` action. Unsaved editor state must never be published.
- Custom publishing is one click with no printer selector, test print, paper confirmation, reason prompt, or confirmation modal.
- Keep built-in rollback's explicit reason and confirmation flow. This covers `revisionId === null` only. The Rollback selector can also hold a saved custom revision, and that path publishes in one click like any other custom publish — see Task 2 Step 6.
- Keep the legacy test-print/confirm-test HTTP endpoints and `print_template_revision_tests` table untouched but behaviorally irrelevant to activation and runtime resolution.
- This approved decision supersedes the printer-coverage activation requirements in `docs/superpowers/plans/2026-07-25-receipt-template-builder.md`; do not restore those historical gates while executing this plan.
- No new dependency, abstraction, configuration flag, or migration.

## Evidence and attack conclusions

- `backend/services/printTemplateManager.js:274-311` currently computes `is_confirmed` and silently substitutes the built-in template when the active revision lacks proof for the current printer. Removing only the UI would therefore leave normal orders broken.
- `backend/services/printTemplateManager.js:444-468` independently blocks activation when zero printers exist or any active endpoint lacks proof. Both enforcement points must change together.
- `src/admin/composables/usePrintTemplates.js:68-73,277-321` repeats the same coverage rule and adds two dialogs before activation. A button-only UI requires deleting those client gates, not hiding the panel with CSS.
- `src/admin/composables/usePrintTemplates.js:72` also filters rollback candidates by printer proof. Leaving it unchanged would make a successfully published revision disappear from rollback choices.
- Printer validity remains independent: `resolveActiveTemplate` must still reject a missing, inactive, wrong-role, or endpoint-less printer before queuing.
- Compiler failure remains independent: a malformed or over-limit active definition still records diagnostics and falls back to the built-in template.
- The retained activation `reason` field is populated with the fixed audit value `Published from the print template admin.`. This avoids changing the route contract and keeps audit rows intelligible without showing another prompt. The wording deliberately names the page rather than the editor button, because `PrintTemplates.vue:232` `rollback()` also reaches `activate(<number>)` when the Rollback selector holds a saved revision, and an audit row must not claim an entry point the actor did not use.

## Out of scope, deliberately

`getTemplateWorkspace` keeps its printer-coverage machinery: the correlated `NOT EXISTS` query at `backend/services/printTemplateManager.js:137-161`, the `coverageByRevision` fold at `:177-192`, the `printerCoverage` field on every revision at `:195`, and the `printers` list at `:162-168, 210`. After Task 2 nothing reads any of it — the composable stops exposing `printers`, and the page stops rendering coverage — so the server runs a join across every active printer × up to 52 revisions on each workspace load to produce data that is thrown away. Three unit tests (`backend/tests/unit/printTemplateManager.test.js:146, 164, 181`) pin that shape in place.

It stays because this plan's contract is "activation and runtime resolution only", and removing it means rewriting those three tests plus the workspace response shape — a separate, independently reviewable change. Do not delete it while executing this plan; raise it afterwards as the follow-up it is.

## File map

- Modify `backend/services/printTemplateManager.js`: remove proof-dependent activation/runtime decisions while retaining routing, transactions, audit, and fallback.
- Modify `backend/tests/unit/printTemplateManager.test.js`: pin proof-free runtime resolution and retained compiler fallback.
- Modify `backend/tests/integration/printTemplates.test.js`: pin direct activation, zero-printer support, new-printer runtime use, stale-lock rejection, and built-in rollback.
- Modify `src/admin/composables/usePrintTemplates.js`: delete test-print state/polling and expose direct custom publishing plus unrestricted revision rollback candidates.
- Modify `src/admin/composables/__tests__/usePrintTemplates.spec.js`: pin a single activation request and absence of prompts.
- Modify `src/admin/pages/PrintTemplates.vue`: replace paper verification and coverage panels with the one publish action.
- Modify `src/admin/pages/__tests__/printTemplatesPage.spec.js`: pin the simplified source surface and absence of the removed workflow.
- Modify `src/shared/i18n/ar.json`: add natural Arabic copy for the new publish state/action and remove now-unused page copy.

---

### Task 1: Make activation global to the document type

**Files:**
- Modify: `backend/tests/unit/printTemplateManager.test.js`
- Modify: `backend/tests/integration/printTemplates.test.js`
- Modify: `backend/services/printTemplateManager.js`

**Interfaces:**
- Consumes: `resolveActiveTemplate(executor, docType, { printerId, storeInfo })` and `activateTemplateRevision(executor, input)`.
- Produces: an active saved revision that resolves for every valid matching printer without consulting `print_template_revision_tests`.

- [ ] **Step 1: Write the failing runtime-resolution test**

Replace the manager test named `uses a confirmed custom revision only for its current printer endpoint` with this proof-free contract, and delete the obsolete `falls back to builtin with a named warning for an untested printer` test:

```js
it('uses the globally active custom revision for a valid matching printer without test proof', async () => {
    const custom = getBuiltinTemplate('receipt');
    custom.bands[0].nodes[0].label.en = 'Custom Store';
    const db = trackedExecutor([[[{
        printer_id: 3, printer_role: 'receipt', printer_is_active: 1,
        active_endpoint_key: 'receipt:windows:primary:counter', active_revision_id: 11,
        revision_id: 11, revision_no: 4, definition_json: JSON.stringify(custom)
    }]]]);

    const result = await manager.resolveActiveTemplate(db, 'receipt', {
        printerId: 3,
        storeInfo: { receipt_config: '{}' }
    });

    expect(result).toMatchObject({ kind: 'custom', id: 11, revisionNo: 4, templateRevisionId: 11 });
    expect(result.definition.bands[0].nodes[0].label.en).toBe('Custom Store');
    expect(db.calls[0].sql).not.toContain('print_template_revision_tests');
});
```

In `records custom compiler diagnostics without mutating the saved definition`, remove the unused `is_confirmed: 1` fixture field. Keep the assertions proving that compiler failure records diagnostics and returns the built-in fallback.

- [ ] **Step 2: Write the failing real-database activation test**

Replace `requires an acknowledged current spooler test on every active endpoint before activation and permits built-in rollback` with:

```js
it('publishes without printer proof and applies the active revision to a printer added later', async () => {
    const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
    const revisionId = saved.body.template.draft.id;

    const activated = await request(app)
        .post('/api/admin/print-templates/receipt/activate')
        .set('Cookie', adminCookie)
        .send({
            revisionId,
            expectedLockVersion: 1,
            reason: 'Published from the print template admin.'
        });

    expect(activated.statusCode).toBe(200);
    expect(activated.body).toMatchObject({ success: true, template: { active: { id: revisionId } } });
    const [[proof]] = await pool.query(
        'SELECT COUNT(*) AS count FROM print_template_revision_tests WHERE revision_id = ?',
        [revisionId]
    );
    expect(Number(proof.count)).toBe(0);

    const [printer] = await pool.query(
        "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Later Receipt', 'receipt', 'windows', 'Later Receipt', 1)"
    );
    const { resolveActiveTemplate } = require('../../services/printTemplateManager');
    const resolved = await resolveActiveTemplate(pool, 'receipt', { printerId: printer.insertId });
    expect(resolved).toMatchObject({ kind: 'custom', id: revisionId, templateRevisionId: revisionId });

    const restored = await request(app)
        .post('/api/admin/print-templates/receipt/activate')
        .set('Cookie', adminCookie)
        .send({ revisionId: null, expectedLockVersion: 2, reason: 'rollback' });
    expect(restored.statusCode).toBe(200);
    expect(restored.body).toMatchObject({ success: true, template: { active: { kind: 'builtin' } } });
});
```

Delete the now-contradictory integration tests `serves built-in to a newly added endpoint...` and `blocks custom activation when no matching active printer exists`. Replace the routing half of the former test with this focused invariant:

```js
it('still rejects a wrong-role printer before queue insertion', async () => {
    const [printer] = await pool.query(
        "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Wrong Role Receipt', 'receipt', 'windows', 'Wrong Role Receipt', 1)"
    );
    const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
    const revisionId = saved.body.template.draft.id;
    const [[endpoint]] = await pool.query('SELECT active_endpoint_key FROM printers WHERE id = ?', [printer.insertId]);
    await pool.query("UPDATE printers SET role = 'kitchen' WHERE id = ?", [printer.insertId]);

    const { enqueuePrintJobs } = require('../../services/printDispatch');
    const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
    await expect(enqueuePrintJobs(pool, [{
        printer_id: printer.insertId,
        printer_name: 'Wrong Role Receipt',
        print_type: 'receipt',
        data: {}
    }], { templateTest: {
        docType: 'receipt',
        revisionId,
        printerId: printer.insertId,
        printerEndpointKey: endpoint.active_endpoint_key,
        fixtureKey: 'receipt-basic'
    } })).rejects.toMatchObject({ statusCode: 409, code: 'PRINT_PRINTER_UNAVAILABLE' });
    const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
    expect(Number(after.count)).toBe(Number(before.count));
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js
```

Expected: FAIL because the resolver query still contains `print_template_revision_tests`, direct activation without printers returns `409`, and a later printer resolves to the built-in template.

- [ ] **Step 4: Remove proof from runtime resolution**

In `resolveActiveTemplate`, reduce the query projection to printer validity plus the active revision:

```js
const [rows] = await executor.query(
    `SELECT p.id AS printer_id, p.role AS printer_role, p.is_active AS printer_is_active, p.active_endpoint_key,
            t.active_revision_id, r.id AS revision_id, r.revision_no, r.definition_json
       FROM printers p
       JOIN print_templates t ON t.document_type = ?
  LEFT JOIN print_template_revisions r ON r.id = t.active_revision_id
      WHERE p.id = ?
      LIMIT 1`,
    [docType, printerId]
);
```

Keep the existing printer availability guard exactly. Replace the confirmation-dependent fallback:

```js
if (!row.active_revision_id) return builtinResolution(docType, options.storeInfo);
if (!row.revision_id) return builtinResolution(docType, options.storeInfo, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
```

The second line covers `active_revision_id` pointing at a row the `LEFT JOIN` could not produce. Do not label it `PRINT_TEMPLATE_COMPILE_FAILED`: nothing compiled, and that code already means something else eight lines below. Nothing consumes `resolution.warning` today — `printDocumentCompiler.js:171` reads only `definition`, `templateRevisionId`, `kind`, and `fallback` — so this is a truthfulness fix in a diagnostic field, not a contract change.

Do not change the override path, definition normalization, diagnostics update, or compiler fallback closure.

- [ ] **Step 5: Remove proof from activation**

Inside `activateTemplateRevision`, delete the query for matching active printers and the coverage query. Keep the locked revision ownership check:

```js
if (revisionId !== null) {
    const [revisionRows] = await executor.query(
        'SELECT id FROM print_template_revisions WHERE id = ? AND template_id = ? FOR UPDATE',
        [revisionId, template.id]
    );
    if (!revisionRows[0]) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'Template revision was not found', 404);
}
```

Keep the existing atomic `UPDATE print_templates`. Change the audit value so it no longer claims printer tests occurred:

```js
newValue: { documentType: docType, revisionId, reason },
```

Do not change lock-version validation, transaction boundaries, rollback, or audit event names.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js
```

Expected: both files PASS. The integration test must use the real test database and prove zero confirmation rows.

- [ ] **Step 7: Commit Task 1**

```powershell
git add backend/services/printTemplateManager.js backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js
git commit -m "fix(print-templates): publish revisions without printer proof"
```

---

### Task 2: Reduce Publish to one acceptance action

**Files:**
- Modify: `src/admin/composables/__tests__/usePrintTemplates.spec.js`
- Modify: `src/admin/pages/__tests__/printTemplatesPage.spec.js`
- Modify: `src/admin/composables/usePrintTemplates.js`
- Modify: `src/admin/pages/PrintTemplates.vue`
- Modify: `src/shared/i18n/ar.json`

**Interfaces:**
- Consumes: `POST api/admin/print-templates/:docType/activate` with `{ revisionId, expectedLockVersion, reason }`.
- Produces: `canPublishSelected`, `activate(revisionId)`, and one visible `Accept & Publish` action for saved custom revisions.

- [ ] **Step 1: Write the failing composable behavior test**

Add this test to `usePrintTemplates.spec.js`:

```js
it('publishes a saved revision in one request without printer proof or dialogs', async () => {
    const definition = {
        schemaVersion: 1,
        docType: 'receipt',
        paper: { widthPx: 576 },
        bands: [{ id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [] }]
    };
    const prompt = vi.fn();
    const confirm = vi.fn();
    vi.stubGlobal('window', { showAdminPrompt: prompt, showAdminConfirm: confirm });
    fetchJsonResponse.mockImplementation(async (resource, options) => {
        if (resource.endsWith('/receipt')) return {
            response: { ok: true, status: 200 },
            data: {
                success: true,
                template: {
                    active: { kind: 'builtin', definition },
                    draft: { kind: 'custom', id: 17, definition },
                    revisions: [{ id: 17, definition, isActive: false }],
                    lockVersion: 3
                },
                builtin: { kind: 'builtin', definition },
                fixtures: [{ key: 'receipt-basic', label: 'Receipt' }]
            }
        };
        if (resource.endsWith('/activate')) {
            return {
                response: { ok: true, status: 200 },
                data: {
                    success: true,
                    template: {
                        active: { kind: 'custom', id: 17, definition },
                        draft: { kind: 'custom', id: 17, definition },
                        revisions: [{ id: 17, definition, isActive: true }],
                        lockVersion: 4
                    }
                }
            };
        }
        throw new Error(`Unexpected request ${resource}`);
    });

    const { usePrintTemplates } = await import('../usePrintTemplates.js');
    const workflow = usePrintTemplates();
    await workflow.loadWorkspace();
    expect(workflow.canPublishSelected.value).toBe(true);

    await workflow.activate(17);

    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(workflow.error.value).toBe('');
    // Assert the request body OUT HERE, never inside the mock. activate() wraps the
    // whole fetch in try/catch, so an expect() that throws inside the mocked
    // fetchJsonResponse is swallowed into error.value and the test still passes -
    // proven by mutation: revisionId 99999 / lockVersion 12345 / a wrong reason all
    // went green when the assertion lived in the mock.
    const activations = fetchJsonResponse.mock.calls.filter(([resource]) => resource.includes('/activate'));
    expect(activations).toHaveLength(1);
    expect(JSON.parse(activations[0][1].body)).toEqual({
        revisionId: 17,
        expectedLockVersion: 3,
        reason: 'Published from the print template admin.'
    });
    expect(fetchJsonResponse.mock.calls.some(([resource]) => resource.includes('/test-print') || resource.includes('/confirm-test'))).toBe(false);
});
```

Add `vi.unstubAllGlobals();` to the existing `afterEach` block so a failed assertion cannot leak the window stub. Remove the obsolete polling test and rewrite `preserves local edits after a save conflict and only permits test print...` to assert only save-conflict preservation; remove its `canTestPrint` assertions and printer coverage fixture.

Then fix the third test in the same file, `loads the exact selected saved revision or built-in definition into the local editor`. It asserts `expect(workflow.canTestPrint.value).toBe(false);` at `src/admin/composables/__tests__/usePrintTemplates.spec.js:204`, which throws `TypeError: Cannot read properties of undefined (reading 'value')` once Step 4 deletes `canTestPrint`. Replace that one line with the equivalent publish-side invariant, which is what the test is really about — selecting the built-in leaves nothing publishable:

```js
    expect(workflow.canPublishSelected.value).toBe(false);
```

- [ ] **Step 2: Rewrite the page contract test**

Replace `keeps publishing actions gated by saved paper proof and provides conflict recovery` with:

```js
it('publishes a saved revision with one action and no printer-test ceremony', () => {
    const page = read('../PrintTemplates.vue');
    const composable = read('../../composables/usePrintTemplates.js');
    const i18n = readCatalog();

    expect(page).toContain('Save Revision');
    expect(page).toContain('Accept & Publish');
    expect(page).toContain(':disabled="acting || isDirty || !canPublishSelected"');
    expect(page).toContain('@click="activate(selectedRevision.id)"');
    expect(page).not.toMatch(/Paper verification|Test Print|Confirm Paper|Required printer coverage|selectedPrinterId|testJob/);
    expect(composable).toContain('const canPublishSelected');
    expect(composable).toContain("reason = 'Published from the print template admin.'");
    expect(composable).not.toMatch(/canConfirmPaper|canTestPrint|sendTestPrint|confirmPaper|startPolling|refreshTestJob|\/test-print|\/confirm-test/);
    expect(i18n['Accept & Publish']).toBe('اعتماد ونشر');
    expect(i18n['Save this revision before publishing it.']).toBe('احفظ هذه المراجعة قبل نشرها.');
});
```

Update the lifecycle source test `uses the server lifecycle endpoints with cancellation and bounded queue polling` so it asserts only preview, revision saving, activation, abort handling, and the `300` ms preview debounce. Its removal list is exactly these six lines — `printTemplatesPage.spec.js:168-174` — and it is exhaustive; each one names something Step 4 deletes:

```js
    expect(composable).toContain('/test-print');
    expect(composable).toContain('/confirm-test');
    expect(composable).toContain('2000');
    expect(composable).toContain('60000');
    expect(composable).toContain('document.visibilityState');
    expect(composable).toContain('pollDeadlineAt: Date.now() + POLL_DURATION_MS');
```

Rename that test to `uses the server lifecycle endpoints with cancellation`, since nothing polls any more.

Finally, fix `preserves the truthful 576px preview and adapts the designer into focused panes below desktop width` in the same file. It asserts the deleted job-status binding at `printTemplatesPage.spec.js:188-189`:

```js
    expect(page).toContain("$t(jobStatusLabel(testJob.status))");
    expect(page).not.toContain('$t(testJob.status');
```

Delete both lines. The first fails as soon as Step 6 removes `jobStatusLabel`; the second only existed to stop that binding regressing to a raw status string, and has nothing left to guard.

- [ ] **Step 3: Run the frontend tests and verify RED**

Run:

```powershell
npx vitest run src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js
```

Expected: FAIL because `canPublishSelected` and `Accept & Publish` do not exist, the old paper workflow remains, and custom activation still opens two dialogs.

- [ ] **Step 4: Delete test-print state and polling from the composable**

In `usePrintTemplates.js`:

- Delete `terminalJobStates`, `POLL_INTERVAL_MS`, and `POLL_DURATION_MS`.
- Delete `printers`, `selectedPrinterId`, `testJob`, `pollTimer`, `canConfirmPaper`, and `canTestPrint`.
- Delete `stopPolling`, `refreshTestJob`, `startPolling`, `sendTestPrint`, `confirmPaper`, `onVisibilityChange`, and the visibility event registration/removal.
- Delete the module-level `sameDefinition` helper at `usePrintTemplates.js:31-33`. `canTestPrint` is its only caller, so it becomes dead the moment that computed goes. Keep `stableStringify`, which `preview()` still uses for its staleness signature.
- Remove assignments that reset `testJob`, stop polling, or choose a printer from `applyWorkspace`, `updateDraftDefinition`, `saveRevision`, `selectRevision`, and the `docType` watcher.
- Keep fixture selection because it drives the on-screen server preview.

Replace coverage-based computed values with:

```js
const canPublishSelected = computed(() => Boolean(selectedRevision.value && !selectedRevision.value.isActive));
const rollbackCandidates = computed(() => workspace.value.revisions.filter(revision => !revision.isActive));
```

Return `canPublishSelected` and remove every deleted value/function from the composable's returned object. The returned object becomes exactly:

```js
    return {
        docType, workspace, draftDefinition, catalog, builtinDefinition, fixtures, selectedFixture, selectedRevisionId, selectedRevision,
        previewArtifact, previewWarnings, loading, previewing, acting, error, saveConflict, isBuiltinSelection, canPublishSelected, rollbackCandidates,
        loadWorkspace, updateDraftDefinition, preview, schedulePreview, pausePreview, saveRevision, reloadAfterSaveConflict, copyDraftJson, activate, selectRevision
    };
```

- [ ] **Step 5: Make custom activation one click while preserving built-in rollback prompts**

Replace `activate` with this behavior:

```js
async function activate(revisionId) {
    const revision = revisionId === null
        ? null
        : workspace.value.revisions.find(item => Number(item.id) === Number(revisionId));
    if (acting.value || (revisionId !== null && (!revision || revision.isActive))) return;

    let reason = 'Published from the print template admin.';
    if (revisionId === null) {
        reason = String(await window.showAdminPrompt?.(
            t('Enter a reason for restoring the built-in template.'),
            '', '', t('Restore built-in')
        ) || '').trim();
        if (!reason) return;
        const confirmed = await window.showAdminConfirm?.(t('Restore the built-in template now?'));
        if (!confirmed) return;
    }

    acting.value = true;
    error.value = '';
    try {
        const { response, data } = await fetchJsonResponse(
            `api/admin/print-templates/${docType.value}/activate`,
            requestOptions(undefined, 'POST', {
                revisionId,
                expectedLockVersion: workspace.value.lockVersion,
                reason
            })
        );
        if (!response.ok || !data?.success) throw errorFor(response, data, 'Unable to update the active template.');
        applyWorkspace(data);
        selectedRevisionId.value = revisionId;
        schedulePreview();
    } catch (activationError) {
        error.value = activationError.status === 409
            ? 'This template changed in another admin session; reload before continuing.'
            : activationError.message;
    } finally {
        acting.value = false;
    }
}
```

- [ ] **Step 6: Replace the Publish pane ceremony**

In `PrintTemplates.vue`:

- Remove the complete `Paper verification` panel.
- Remove the printer coverage block from `Selected revision`.
- Replace its activation button with:

```vue
<p v-if="isDirty" class="print-templates-page__muted">{{ $t('Save this revision before publishing it.') }}</p>
<p v-else-if="selectedRevision.isActive" class="print-templates-page__muted">{{ $t('This revision is already published.') }}</p>
<button
    class="admin-grid-button admin-grid-button--primary print-templates-page__action"
    type="button"
    :disabled="acting || isDirty || !canPublishSelected"
    @click="activate(selectedRevision.id)"
>
    {{ $t('Accept & Publish') }}
</button>
```

- Change the active custom copy from `A confirmed revision is active for this document type.` to `A published revision is active for this document type.`.
- Replace the destructuring at `PrintTemplates.vue:150-154` with exactly this. Adding `canPublishSelected` matters as much as removing the old names: the page test greps for the literal `:disabled` string, so an omitted binding would still pass the test while `!undefined` disables the Publish button forever.

```js
const {
    docType, workspace, draftDefinition, catalog, builtinDefinition, fixtures, selectedFixture, selectedRevisionId, selectedRevision,
    previewArtifact, previewWarnings, loading, previewing, acting, error, saveConflict, isBuiltinSelection, canPublishSelected, rollbackCandidates,
    loadWorkspace, updateDraftDefinition, preview, schedulePreview, pausePreview, saveRevision, reloadAfterSaveConflict, copyDraftJson, activate, selectRevision
} = usePrintTemplates();
```

- Delete `jobStatusLabel` and `jobClass`.
- Keep `isDirty` (`PrintTemplates.vue:161`) exactly as it is. It is page-local, not part of the composable, and it is the only thing standing between an unsaved draft and the live template — `canPublishSelected` and `activate()` deliberately do not re-check it.
- Keep revision history, custom revision selection, and the built-in/custom rollback selector. Note that `rollback()` at `PrintTemplates.vue:232` reaches `activate(<number>)` whenever the selector holds a saved revision, so that path also publishes in one click. That is intended under this plan's one-click rule, and it is why the fixed audit reason names the page rather than the editor button.

- [ ] **Step 7: Update Arabic copy and remove dead page strings**

Add these entries to `src/shared/i18n/ar.json`:

```json
"A published revision is active for this document type.": "توجد مراجعة منشورة ونشطة لهذا النوع من المستندات.",
"Accept & Publish": "اعتماد ونشر",
"Save this revision before publishing it.": "احفظ هذه المراجعة قبل نشرها.",
"This revision is already published.": "هذه المراجعة منشورة بالفعل."
```

After the Vue/composable edits, use `rg` to confirm and remove only zero-reference strings that belonged exclusively to the deleted page ceremony. Verified as zero-reference once Steps 4-6 land — remove each one only after `rg` proves it:

`Paper verification`, `Send to a printer`, `Select a printer`, `Test Print`, `Save this exact draft before sending a test print.`, `Confirm Paper`, `I inspected this physical paper test and it is correct. Confirm it for this printer?`, `Inspect the built-in paper output. Built-in remains available for rollback and does not need confirmation.`, `Required printer coverage`, `Needs paper test`, `No active matching printers are configured.`, `Activate template` (its only use was the deleted activation prompt title), `Activate this confirmed template now?`, `Enter a reason for activating this template.`, and `A confirmed revision is active for this document type.` (replaced by the published wording above).

Keep `Activate revision` — the rollback selector still renders it. Keep `Tested`, which the shared status vocabulary uses elsewhere; confirm with `rg` before deciding. Do not remove fixture/preview translations because preview still uses fixtures. `src/shared/__tests__/i18nCatalog.spec.js` does not fail on orphaned keys, so nothing here is caught automatically — the `rg` check is the only guard.

- [ ] **Step 8: Run the frontend tests and verify GREEN**

Run:

```powershell
npx vitest run src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js
```

Expected: both files PASS.

- [ ] **Step 9: Run the complete focused regression gate**

Run:

```powershell
npx vitest run backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/__tests__/printTemplatesPage.spec.js
rg -n "PRINT_TEMPLATE_PRINTER_UNTESTED|PRINT_TEMPLATE_PRINTER_COVERAGE_REQUIRED|canConfirmPaper|canTestPrint|canActivateSelected|sendTestPrint|confirmPaper|sameDefinition|jobStatusLabel|jobClass|Paper verification|Required printer coverage" backend/services/printTemplateManager.js src/admin
rg -n "canPublishSelected" src/admin/pages/PrintTemplates.vue
git diff --check
```

Expected: all four test files PASS; the first `rg` prints no matches; the second prints **two** lines — the destructuring and the `:disabled` binding. One line there means the binding was added to the template but never destructured, which no test can catch and which leaves the Publish button permanently disabled. `git diff --check` exits successfully. Do not run the full suite.

- [ ] **Step 10: Commit Task 2**

```powershell
git add src/admin/composables/usePrintTemplates.js src/admin/composables/__tests__/usePrintTemplates.spec.js src/admin/pages/PrintTemplates.vue src/admin/pages/__tests__/printTemplatesPage.spec.js src/shared/i18n/ar.json
git commit -m "feat(print-templates): publish with one acceptance action"
```

## Completion review

Before reporting completion, inspect `git diff` from the first implementation commit through Task 2 and answer these attacks from source and focused test evidence:

1. Can a published revision still fall back merely because a printer lacks a confirmation row? It must not.
2. Can a template publish when the venue has no printer configured yet? It must.
3. Can an invalid, inactive, wrong-role, or endpoint-less printer receive a job? It must not.
4. Can unsaved local edits be published? They must not; `Save Revision` remains mandatory.
5. Does custom publishing open any prompt/modal or call a test-print endpoint? It must not.
6. Does built-in rollback still require a reason and confirmation? It must.
7. Can any inactive saved custom revision be selected as a rollback target without old paper proof? It must.
8. Do audit rows still identify the old revision, new revision, document type, actor, IP, and a truthful fixed reason? They must. Check both entry points: the `Accept & Publish` button and `rollback()` with a saved revision selected reach the same `activate(<number>)` and write the same reason, so the wording has to be true of both.
9. Did any endpoint, table, migration, spooler file, renderer, or queue-delivery behavior change? None may.
10. Does the Publish button actually enable? Mount or manually exercise it once — every assertion in `printTemplatesPage.spec.js` is a source scrape, so a `canPublishSelected` that reaches the template but not the destructuring passes every test and ships a dead button.
11. Can the new composable test fail? Temporarily change the expected `revisionId` in `publishes a saved revision in one request without printer proof or dialogs` to a wrong number and confirm it goes RED, then change it back. An assertion that ends up inside the mocked `fetchJsonResponse` is swallowed by `activate()`'s catch and proves nothing.

Report the branch, the two implementation commit hashes, exact focused test counts, and any remaining untracked files. Do not merge, push, or deploy.

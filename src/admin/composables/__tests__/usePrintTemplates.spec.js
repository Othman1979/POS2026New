import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJsonResponse = vi.fn();
vi.mock('@/shared/http.js', () => ({ fetchJsonResponse }));
vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), onBeforeUnmount: () => {} }));

beforeEach(() => {
    vi.useFakeTimers();
    fetchJsonResponse.mockReset();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('usePrintTemplates', () => {
    it('keeps the previous artifact and reports the reason when a draft fails validation', async () => {
        const definition = { schemaVersion: 1, docType: 'receipt', paper: { widthPx: 576 }, bands: [] };
        fetchJsonResponse
            .mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: { success: true, template: { active: { kind: 'builtin', definition }, draft: { kind: 'builtin', definition }, revisions: [], lockVersion: 0 }, fixtures: [{ key: 'receipt-basic', label: 'Receipt' }] } })
            .mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: { success: true, artifact: { html: 'good' }, warnings: [] } })
            .mockResolvedValueOnce({ response: { ok: false, status: 422 }, data: { success: false, message: 'Receipt primary row requires note' } });
        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const templates = usePrintTemplates();
        await templates.loadWorkspace();
        await templates.preview();
        const good = templates.previewArtifact.value;
        await templates.preview();
        expect(templates.previewArtifact.value).toBe(good);
        expect(templates.validationError.value).toBe('Receipt primary row requires note');
        expect(templates.error.value).toBe('');
    });

    it('owns an editable clone after loading a reactive workspace', async () => {
        const definition = {
            schemaVersion: 1,
            docType: 'receipt',
            paper: { widthPx: 576 },
            bands: [{ id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [{ id: 'text', type: 'text', text: { en: 'Before', ar: '', mode: 'auto' }, style: {} }] }]
        };
        fetchJsonResponse.mockResolvedValue({
            response: { ok: true, status: 200 },
            data: {
                success: true,
                template: { active: { kind: 'builtin', definition }, draft: { kind: 'builtin', id: null, definition }, revisions: [], lockVersion: 0 },
                printers: [], fixtures: [{ key: 'receipt-basic', label: 'Receipt' }]
            }
        });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();

        await expect(workflow.loadWorkspace()).resolves.toBe(true);
        workflow.draftDefinition.value.bands[0].nodes[0].text.en = 'Edited';
        expect(() => workflow.updateDraftDefinition(workflow.draftDefinition.value)).not.toThrow();
        expect(workflow.draftDefinition.value.bands[0].nodes[0].text.en).toBe('Edited');
        expect(workflow.workspace.value.draft.definition.bands[0].nodes[0].text.en).toBe('Before');
        expect(workflow.selectedRevisionId.value).toBeNull();
        await workflow.preview();
        const previewCall = fetchJsonResponse.mock.calls.filter(([resource]) => resource.includes('/preview')).at(-1);
        expect(JSON.parse(previewCall[1].body).definition.bands[0].nodes[0].text.en).toBe('Edited');
    });

    it('advances the workspace generation only when the current workspace load succeeds', async () => {
        const definition = { schemaVersion: 1, docType: 'receipt', paper: { widthPx: 576 }, bands: [] };
        const workspaceData = {
            success: true,
            template: { active: { kind: 'builtin', definition }, draft: { kind: 'builtin', definition }, revisions: [], lockVersion: 0 },
            fixtures: [{ key: 'receipt-basic', label: 'Receipt' }]
        };
        let resolveFirst;
        fetchJsonResponse
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
            .mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: workspaceData })
            .mockResolvedValueOnce({ response: { ok: false, status: 503 }, data: { success: false, message: 'Offline' } });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();

        const staleLoad = workflow.loadWorkspace();
        await expect(workflow.loadWorkspace()).resolves.toBe(true);
        expect(workflow.workspaceLoadVersion.value).toBe(1);

        resolveFirst({ response: { ok: true, status: 200 }, data: workspaceData });
        await expect(staleLoad).resolves.toBe(false);
        expect(workflow.workspaceLoadVersion.value).toBe(1);

        await expect(workflow.loadWorkspace()).resolves.toBe(false);
        expect(workflow.workspaceLoadVersion.value).toBe(1);
    });

    it('keeps the workspace generation stable when saving a revision', async () => {
        const definition = { schemaVersion: 1, docType: 'receipt', paper: { widthPx: 576 }, bands: [] };
        const saved = structuredClone(definition);
        const initial = {
            success: true,
            template: { active: { kind: 'builtin', definition }, draft: { kind: 'builtin', definition }, revisions: [], lockVersion: 1 },
            fixtures: [{ key: 'receipt-basic', label: 'Receipt' }]
        };
        const afterSave = {
            success: true,
            template: { active: { kind: 'builtin', definition }, draft: { kind: 'custom', id: 17, definition: saved }, revisions: [{ id: 17, definition: saved }], lockVersion: 2 }
        };
        fetchJsonResponse.mockImplementation((resource) => Promise.resolve(
            resource.endsWith('/receipt')
                ? { response: { ok: true, status: 200 }, data: initial }
                : { response: { ok: true, status: 200 }, data: afterSave }
        ));

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();
        await workflow.loadWorkspace();
        const loadGeneration = workflow.workspaceLoadVersion.value;

        await expect(workflow.saveRevision()).resolves.toBe(true);
        expect(workflow.workspaceLoadVersion.value).toBe(loadGeneration);
    });

    it('debounces local preview, aborts the previous request, and never keeps stale artifact HTML', async () => {
        const definition = {
            schemaVersion: 1,
            docType: 'receipt',
            paper: { widthPx: 576 },
            bands: [{ id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [{ id: 'text', type: 'text', text: { en: 'Before', ar: '', mode: 'auto' }, style: {} }] }]
        };
        let firstPreviewOptions;
        fetchJsonResponse.mockImplementation((resource, options) => {
            if (!resource.includes('/preview')) {
                return Promise.resolve({
                    response: { ok: true, status: 200 },
                    data: { success: true, template: { active: { kind: 'builtin', definition }, draft: { kind: 'builtin', id: null, definition }, revisions: [], lockVersion: 0 }, printers: [], fixtures: [{ key: 'receipt-basic', label: 'Receipt' }] }
                });
            }
            if (!firstPreviewOptions) {
                firstPreviewOptions = options;
                return new Promise(() => {});
            }
            return Promise.resolve({ response: { ok: true, status: 200 }, data: { success: true, artifact: { html: 'fresh' }, warnings: [] } });
        });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();
        await workflow.loadWorkspace();
        const firstEdit = JSON.parse(JSON.stringify(workflow.draftDefinition.value));
        firstEdit.bands[0].nodes[0].text.en = 'First';
        workflow.updateDraftDefinition(firstEdit);
        await vi.advanceTimersByTimeAsync(300);
        expect(firstPreviewOptions).toBeTruthy();

        const secondEdit = JSON.parse(JSON.stringify(firstEdit));
        secondEdit.bands[0].nodes[0].text.en = 'Second';
        workflow.updateDraftDefinition(secondEdit);
        expect(firstPreviewOptions.signal.aborted).toBe(true);
        expect(workflow.previewArtifact.value).toBeNull();
        await vi.advanceTimersByTimeAsync(300);

        expect(workflow.previewArtifact.value).toMatchObject({ html: 'fresh' });
        const previews = fetchJsonResponse.mock.calls.filter(([resource]) => resource.includes('/preview'));
        expect(JSON.parse(previews.at(-1)[1].body).definition.bands[0].nodes[0].text.en).toBe('Second');
    });

    it('preserves local edits after a save conflict', async () => {
        const definition = {
            schemaVersion: 1,
            docType: 'receipt',
            paper: { widthPx: 576 },
            bands: [{ id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [{ id: 'text', type: 'text', text: { en: 'Before', ar: '', mode: 'auto' }, style: {} }] }]
        };
        const revision = { id: 17, revisionNo: 1, definition };
        fetchJsonResponse.mockImplementation((resource) => {
            if (resource.endsWith('/receipt')) return Promise.resolve({
                response: { ok: true, status: 200 },
                data: { success: true, template: { active: { kind: 'builtin', definition }, draft: { kind: 'custom', id: 17, definition }, revisions: [revision], lockVersion: 3 }, fixtures: [{ key: 'receipt-basic', label: 'Receipt' }] }
            });
            if (resource.endsWith('/revisions')) return Promise.resolve({ response: { ok: false, status: 409 }, data: { success: false, message: 'This template changed in another admin session' } });
            throw new Error(`Unexpected request ${resource}`);
        });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();
        await workflow.loadWorkspace();

        const edited = JSON.parse(JSON.stringify(workflow.draftDefinition.value));
        edited.bands[0].nodes[0].text.en = 'Local edit';
        workflow.updateDraftDefinition(edited);
        await workflow.saveRevision();

        expect(workflow.saveConflict.value).toBe(true);
        expect(workflow.draftDefinition.value.bands[0].nodes[0].text.en).toBe('Local edit');
        const saveCall = fetchJsonResponse.mock.calls.find(([resource]) => resource.endsWith('/revisions'));
        expect(JSON.parse(saveCall[1].body)).toEqual({ definition: edited, expectedLockVersion: 3 });
    });

    it('loads the exact selected saved revision or built-in definition into the local editor', async () => {
        const builtin = {
            schemaVersion: 1, docType: 'receipt', paper: { widthPx: 576 },
            bands: [{ id: 'builtin', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [{ id: 'builtin-text', type: 'text', text: { en: 'Built-in', ar: '', mode: 'auto' }, style: {} }] }]
        };
        const saved = structuredClone(builtin);
        saved.bands[0].id = 'saved';
        saved.bands[0].nodes[0].text.en = 'Saved revision';
        fetchJsonResponse.mockResolvedValue({
            response: { ok: true, status: 200 },
            data: {
                success: true,
                template: { active: { kind: 'custom', id: 17, definition: saved }, draft: { kind: 'custom', id: 17, definition: saved }, revisions: [{ id: 17, definition: saved }], lockVersion: 2 },
                builtin: { kind: 'builtin', definition: builtin }, printers: [], fixtures: [{ key: 'receipt-basic', label: 'Receipt' }]
            }
        });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();
        await workflow.loadWorkspace();
        const localEdit = JSON.parse(JSON.stringify(workflow.draftDefinition.value));
        localEdit.bands[0].nodes[0].text.en = 'Unsaved local edit';
        workflow.updateDraftDefinition(localEdit);

        workflow.selectRevision(null);
        expect(workflow.selectedRevisionId.value).toBeNull();
        expect(workflow.draftDefinition.value.bands[0].nodes[0].text.en).toBe('Built-in');
        expect(workflow.canPublishSelected.value).toBe(false);

        workflow.selectRevision(17);
        expect(workflow.draftDefinition.value.bands[0].nodes[0].text.en).toBe('Saved revision');
        expect(workflow.workspace.value.revisions[0].definition.bands[0].nodes[0].text.en).toBe('Saved revision');
    });

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
        fetchJsonResponse.mockImplementation(async (resource) => {
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
            if (resource.endsWith('/activate')) return {
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
            throw new Error(`Unexpected request ${resource}`);
        });

        const { usePrintTemplates } = await import('../usePrintTemplates.js');
        const workflow = usePrintTemplates();
        await workflow.loadWorkspace();
        expect(workflow.canPublishSelected.value).toBe(true);
        const loadGeneration = workflow.workspaceLoadVersion.value;

        await workflow.activate(17);

        expect(prompt).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(workflow.error.value).toBe('');
        const activations = fetchJsonResponse.mock.calls.filter(([resource]) => resource.includes('/activate'));
        expect(activations).toHaveLength(1);
        expect(JSON.parse(activations[0][1].body)).toEqual({
            revisionId: 17,
            expectedLockVersion: 3,
            reason: 'Published from the print template admin.'
        });
        expect(fetchJsonResponse.mock.calls.some(([resource]) => resource.includes('/test-print') || resource.includes('/confirm-test'))).toBe(false);
        expect(workflow.workspaceLoadVersion.value).toBe(loadGeneration);
    });
});

import { computed, onBeforeUnmount, readonly, ref, toRaw, watch } from 'vue';
import { fetchJsonResponse } from '@/shared/http.js';
import { t } from '@/shared/i18n.js';

const PREVIEW_DELAY_MS = 300;
const initialWorkspace = () => ({ active: null, draft: null, revisions: [], lockVersion: 0 });

function requestOptions(signal, method = 'GET', body) {
    return {
        method,
        signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    };
}

function errorFor(response, data, fallback) {
    const error = new Error(data?.message || fallback);
    error.status = response.status;
    return error;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function usePrintTemplates() {
    const docType = ref('receipt');
    const workspace = ref(initialWorkspace());
    const draftDefinition = ref(null);
    const catalog = ref(null);
    const builtinDefinition = ref(null);
    const fixtures = ref([]);
    const selectedFixture = ref('');
    const selectedRevisionId = ref(null);
    const previewArtifact = ref(null);
    const previewWarnings = ref([]);
    const loading = ref(true);
    const previewing = ref(false);
    const acting = ref(false);
    const error = ref('');
    const validationError = ref('');
    const saveConflict = ref(false);
    const workspaceLoadVersion = ref(0);

    let workspaceController = null;
    let previewController = null;
    let previewTimer = null;

    const selectedRevision = computed(() => workspace.value.revisions.find(item => Number(item.id) === Number(selectedRevisionId.value)) || null);
    const selectedDefinition = computed(() => draftDefinition.value);
    const isBuiltinSelection = computed(() => !selectedRevision.value);
    const canPublishSelected = computed(() => Boolean(selectedRevision.value && !selectedRevision.value.isActive));
    const rollbackCandidates = computed(() => workspace.value.revisions.filter(revision => !revision.isActive));

    function stopPreviewTimer() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = null;
    }

    function invalidatePreview() {
        stopPreviewTimer();
        previewController?.abort();
        previewController = null;
        previewing.value = false;
        previewArtifact.value = null;
        previewWarnings.value = [];
    }

    function pausePreview() {
        stopPreviewTimer();
        previewController?.abort();
        previewController = null;
        previewing.value = false;
    }

    function applyWorkspace(data) {
        workspace.value = data.template || initialWorkspace();
        draftDefinition.value = workspace.value.draft?.definition ? structuredClone(toRaw(workspace.value.draft.definition)) : null;
        if (data.catalog) catalog.value = data.catalog;
        if (data.builtin?.definition) builtinDefinition.value = structuredClone(toRaw(data.builtin.definition));
        if (data.fixtures) fixtures.value = data.fixtures;
        if (!selectedFixture.value || !fixtures.value.some(item => item.key === selectedFixture.value)) {
            selectedFixture.value = fixtures.value[0]?.key || '';
        }
        const draftId = workspace.value.draft?.kind === 'custom' ? workspace.value.draft.id : null;
        if (!workspace.value.revisions.some(item => Number(item.id) === Number(selectedRevisionId.value))) {
            selectedRevisionId.value = draftId;
        }
    }

    function updateDraftDefinition(definition) {
        draftDefinition.value = structuredClone(toRaw(definition));
        saveConflict.value = false;
        schedulePreview();
    }

    async function loadWorkspace({ preserveError = false } = {}) {
        workspaceController?.abort();
        const controller = new AbortController();
        workspaceController = controller;
        loading.value = true;
        if (!preserveError) error.value = '';
        try {
            const { response, data } = await fetchJsonResponse(`api/admin/print-templates/${docType.value}`, requestOptions(controller.signal));
            if (!response.ok || !data?.success) throw errorFor(response, data, 'Unable to load print templates.');
            if (controller.signal.aborted || workspaceController !== controller) return false;
            applyWorkspace(data);
            saveConflict.value = false;
            workspaceLoadVersion.value += 1;
            return true;
        } catch (loadError) {
            if (loadError.name !== 'AbortError') error.value = loadError.message;
            return false;
        } finally {
            if (!controller.signal.aborted) loading.value = false;
        }
    }

    async function preview() {
        stopPreviewTimer();
        previewController?.abort();
        if (loading.value || !selectedDefinition.value || !selectedFixture.value) return;
        const controller = new AbortController();
        previewController = controller;
        previewing.value = true;
        error.value = '';
        const signature = stableStringify(selectedDefinition.value);
        const fixtureKey = selectedFixture.value;
        const previewDocType = docType.value;
        try {
            const { response, data } = await fetchJsonResponse(
                `api/admin/print-templates/${previewDocType}/preview`,
                requestOptions(controller.signal, 'POST', { definition: selectedDefinition.value, fixtureKey })
            );
            if (!response.ok || !data?.success) throw errorFor(response, data, 'Unable to prepare the screen preview.');
            if (controller.signal.aborted || previewController !== controller ||
                previewDocType !== docType.value || fixtureKey !== selectedFixture.value || signature !== stableStringify(selectedDefinition.value)) return;
            previewArtifact.value = data.artifact || null;
            previewWarnings.value = data.warnings || [];
            validationError.value = '';
        } catch (previewError) {
            if (previewError.name !== 'AbortError' && !controller.signal.aborted && previewController === controller) {
                if (previewError.status === 422) {
                    validationError.value = previewError.message;
                    return;
                }
                previewArtifact.value = null;
                previewWarnings.value = [];
                error.value = previewError.message;
            }
        } finally {
            if (previewController === controller) previewing.value = false;
        }
    }

    function schedulePreview() {
        pausePreview();
        if (loading.value || !selectedDefinition.value || !selectedFixture.value) return;
        previewTimer = setTimeout(() => {
            previewTimer = null;
            void preview();
        }, PREVIEW_DELAY_MS);
    }

    async function saveRevision() {
        if (!draftDefinition.value || acting.value) return false;
        acting.value = true;
        error.value = '';
        saveConflict.value = false;
        try {
            const definition = structuredClone(toRaw(draftDefinition.value));
            const { response, data } = await fetchJsonResponse(
                `api/admin/print-templates/${docType.value}/revisions`,
                requestOptions(undefined, 'POST', { definition, expectedLockVersion: workspace.value.lockVersion })
            );
            if (!response.ok || !data?.success) throw errorFor(response, data, 'Unable to save this template revision.');
            applyWorkspace(data);
            selectedRevisionId.value = workspace.value.draft?.kind === 'custom' ? workspace.value.draft.id : null;
            schedulePreview();
            return true;
        } catch (saveError) {
            saveConflict.value = saveError.status === 409;
            error.value = saveError.message;
            return false;
        } finally { acting.value = false; }
    }

    async function reloadAfterSaveConflict() {
        saveConflict.value = false;
        return loadWorkspace();
    }

    async function copyDraftJson() {
        if (!draftDefinition.value || !navigator.clipboard?.writeText) {
            error.value = 'Clipboard access is unavailable.';
            return false;
        }
        try {
            await navigator.clipboard.writeText(JSON.stringify(toRaw(draftDefinition.value), null, 2));
            return true;
        } catch {
            error.value = 'Clipboard access is unavailable.';
            return false;
        }
    }

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
                requestOptions(undefined, 'POST', { revisionId, expectedLockVersion: workspace.value.lockVersion, reason })
            );
            if (!response.ok || !data?.success) throw errorFor(response, data, 'Unable to update the active template.');
            applyWorkspace(data);
            selectedRevisionId.value = revisionId;
            schedulePreview();
        } catch (activationError) { error.value = activationError.status === 409 ? 'This template changed in another admin session; reload before continuing.' : activationError.message; }
        finally { acting.value = false; }
    }

    function selectRevision(id) {
        const selectedId = id === null ? null : Number(id);
        const definition = selectedId === null
            ? builtinDefinition.value
            : workspace.value.revisions.find(item => Number(item.id) === selectedId)?.definition;
        if (!definition) return false;
        selectedRevisionId.value = selectedId;
        draftDefinition.value = structuredClone(toRaw(definition));
        schedulePreview();
        return true;
    }

    watch(docType, async () => {
        loading.value = true;
        invalidatePreview();
        selectedRevisionId.value = null;
        await loadWorkspace();
        schedulePreview();
    });
    watch(selectedFixture, () => { invalidatePreview(); schedulePreview(); });
    watch(selectedRevisionId, () => schedulePreview());

    onBeforeUnmount(() => {
        workspaceController?.abort();
        invalidatePreview();
    });

    return {
        docType, workspace, draftDefinition, catalog, builtinDefinition, fixtures, selectedFixture, selectedRevisionId, selectedRevision, workspaceLoadVersion: readonly(workspaceLoadVersion),
        previewArtifact, previewWarnings, validationError, loading, previewing, acting, error, saveConflict, isBuiltinSelection, canPublishSelected, rollbackCandidates,
        loadWorkspace, updateDraftDefinition, preview, schedulePreview, pausePreview, saveRevision, reloadAfterSaveConflict, copyDraftJson, activate, selectRevision
    };
}

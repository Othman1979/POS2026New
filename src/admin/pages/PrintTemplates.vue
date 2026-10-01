<template>
    <div class="admin-data-page print-templates-page flex min-h-0 flex-col" :class="`is-${activePane}`">
        <header class="admin-grid-page-bar shrink-0">
            <div class="admin-grid-page-context">
                <h2>{{ $t('Print Templates') }}</h2>
                <span class="admin-grid-record-count">{{ $t('Spooler-only receipt and kitchen layouts') }}</span>
            </div>
            <div class="admin-grid-page-actions">
                <button class="admin-grid-icon-button" type="button" :aria-label="$t('Refresh')" :disabled="loading" @click="reload()">
                    <i :class="['fa-solid fa-rotate-right text-[10px]', loading && 'fa-spin']" aria-hidden="true"></i>
                </button>
            </div>
        </header>

        <section class="admin-grid-command-bar shrink-0">
            <div class="admin-grid-command-row print-templates-page__command-row">
                <div class="print-templates-page__document-control" role="group" :aria-label="$t('Document type')">
                    <nav class="admin-grid-segmented" :aria-label="$t('Print templates')">
                        <button type="button" :class="{ 'is-active': docType === 'receipt' }" @click="changeDocType('receipt')">{{ $t('Receipt') }}</button>
                        <button type="button" :class="{ 'is-active': docType === 'kitchen' }" @click="changeDocType('kitchen')">{{ $t('Kitchen') }}</button>
                    </nav>
                </div>
                <label class="print-templates-page__fixture">
                    <span>{{ $t('Fixture') }}</span>
                    <select v-model="selectedFixture" class="admin-grid-select" :disabled="loading || !fixtures.length">
                        <option v-for="fixture in fixtures" :key="fixture.key" :value="fixture.key">{{ fixture.label }}</option>
                    </select>
                </label>
                <div class="print-templates-page__layout-state"><span>{{ $t('Draft layout') }}</span><strong>{{ $t(isDirty ? 'Custom layout' : (isBuiltinSelection ? 'Built-in' : templateLabel(selectedRevision))) }}</strong></div>
                <button class="admin-grid-button" type="button" :disabled="!canRestore" @click="restoreStartingLayout">
                    <i class="fa-solid fa-rotate-left text-[10px]" aria-hidden="true"></i><span>{{ $t('Restore starting layout') }}</span>
                </button>
                <button class="admin-grid-button" type="button" :disabled="!canUndo" aria-keyshortcuts="Control+Z Meta+Z" @click="undoDraft">
                    <i class="fa-solid fa-rotate-left text-[10px]" aria-hidden="true"></i><span>{{ $t('Undo') }}</span>
                </button>
                <button class="admin-grid-button" type="button" :disabled="!canRedo" aria-keyshortcuts="Control+Y Meta+Shift+Z" @click="redoDraft">
                    <i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i><span>{{ $t('Redo') }}</span>
                </button>
                <button class="admin-grid-button" type="button" :disabled="previewing || loading" @click="preview">
                    <i :class="['fa-solid fa-eye text-[10px]', previewing && 'fa-spin']" aria-hidden="true"></i><span>{{ $t('Refresh preview') }}</span>
                </button>
                <button class="admin-grid-button admin-grid-button--primary" type="button" :disabled="loading || acting || !isDirty" @click="saveRevision">
                    <i class="fa-solid fa-floppy-disk text-[10px]" aria-hidden="true"></i><span>{{ $t('Save Revision') }}</span>
                </button>
            </div>
        </section>

        <p v-if="error" class="print-templates-page__error" role="alert">{{ error }}</p>
        <p v-if="validationError" class="print-template-validation" role="status">{{ validationError }}</p>
        <section v-if="saveConflict" class="print-templates-page__conflict" role="alert">
            <p>{{ $t('Another admin saved a newer revision. Your local edits are still here.') }}</p>
            <div>
                <button class="admin-grid-button" type="button" :disabled="acting" @click="recoverFromSaveConflict">{{ $t('Reload workspace') }}</button>
                <button class="admin-grid-button" type="button" :disabled="acting" @click="copyLocalJson">{{ $t('Copy JSON') }}</button>
            </div>
        </section>

        <div v-if="loading" class="print-templates-page__loading">{{ $t('Loading…') }}</div>
        <section v-else class="print-templates-page__workspace">
            <aside class="print-templates-page__rail" :aria-label="$t('Template designer')">
                <nav class="print-templates-page__panes" :aria-label="$t('Print template sections')">
                    <button v-for="pane in panes" :key="pane.key" type="button" :class="[{ 'is-active': activePane === pane.key }, `is-${pane.key}`]" @click="activePane = pane.key">
                        <i :class="pane.icon" aria-hidden="true"></i><span>{{ $t(pane.label) }}</span>
                    </button>
                </nav>

                <section v-if="(activePane === 'structure' || activePane === 'preview') && draftDefinition" class="print-templates-page__editor-pane" :aria-label="$t('Structure')">
                    <PrintTemplateEditor ref="structureEditor" mode="structure" :definition="draftDefinition" :catalog="catalog" :selected-id="selectedNodeId"
                        @update:selected-id="selectNode" @update:definition="updateDraftDefinition" @request-properties="activePane = 'properties'" />
                </section>

                <section v-else-if="activePane === 'properties' && draftDefinition && catalog" class="print-templates-page__editor-pane" :aria-label="$t('Properties')">
                    <PrintTemplateEditor mode="properties" :definition="draftDefinition" :catalog="catalog" :active-definition="workspace.active?.definition"
                        :builtin-definition="builtinDefinition" :selected-id="selectedNodeId" @update:selected-id="selectNode" @update:definition="updateDraftDefinition" @focusin="startFieldHistory" @focusout="finishFieldHistory" />
                </section>

                <div v-else-if="activePane === 'publish'" class="print-templates-page__publish" :aria-label="$t('Publish')">
                <section class="print-templates-page__panel">
                    <div class="print-templates-page__panel-heading">
                        <div><span class="print-templates-page__section-label">{{ $t('Active template') }}</span><h3>{{ templateLabel(workspace.active) }}</h3></div>
                        <span class="admin-grid-status" :class="workspace.active?.kind === 'custom' ? 'is-success' : 'is-warning'">{{ $t(workspace.active?.kind === 'custom' ? 'Custom' : 'Built-in') }}</span>
                    </div>
                    <p class="print-templates-page__muted">{{ workspace.active?.kind === 'custom' ? $t('A published revision is active for this document type.') : $t('The safe built-in template is active.') }}</p>
                </section>

                <section v-if="selectedRevision" class="print-templates-page__panel">
                    <div class="print-templates-page__panel-heading"><div><span class="print-templates-page__section-label">{{ $t('Selected revision') }}</span><h3>{{ templateLabel(selectedRevision) }}</h3></div><span v-if="selectedRevision.isDraft" class="print-templates-page__tag">{{ $t('Draft') }}</span></div>
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
                </section>

                <section class="print-templates-page__panel print-templates-page__history-panel">
                    <div class="print-templates-page__panel-heading"><div><span class="print-templates-page__section-label">{{ $t('Revision history') }}</span><h3>{{ $t('Saved templates') }}</h3></div></div>
                    <button type="button" class="print-templates-page__revision" :class="{ 'is-selected': selectedRevisionId === null }" @click="chooseRevision(null)"><span>{{ $t('Built-in') }}</span><small data-no-i18n>{{ workspace.active?.templateRevisionId }}</small></button>
                    <button v-for="revision in workspace.revisions" :key="revision.id" type="button" class="print-templates-page__revision" :class="{ 'is-selected': Number(selectedRevisionId) === Number(revision.id) }" @click="chooseRevision(revision.id)">
                        <span>{{ templateLabel(revision) }}</span><small>{{ revision.createdByName || $t('System') }} · <span data-no-i18n>{{ dateTime(revision.createdAt) }}</span></small>
                        <span class="print-templates-page__revision-state">{{ $t(revision.isActive ? 'Active' : revision.isDraft ? 'Draft' : 'Saved') }}</span>
                    </button>
                    <p v-if="!workspace.revisions.length" class="print-templates-page__muted">{{ $t('No custom revisions have been saved yet.') }}</p>
                </section>

                <section class="print-templates-page__panel print-templates-page__rollback">
                    <div><span class="print-templates-page__section-label">{{ $t('Rollback') }}</span><h3>{{ $t('Built-in fallback') }}</h3></div>
                    <p class="print-templates-page__muted">{{ $t('Restore the built-in template without deleting revision history.') }}</p>
                    <label class="print-templates-page__field"><span>{{ $t('Rollback target') }}</span><select v-model="rollbackRevisionId" class="admin-grid-select"><option value="builtin">{{ $t('Built-in fallback') }}</option><option v-for="revision in rollbackCandidates" :key="revision.id" :value="String(revision.id)">{{ templateLabel(revision) }}</option></select></label>
                    <button class="admin-grid-button" type="button" :disabled="acting || (rollbackRevisionId === 'builtin' && workspace.active?.kind === 'builtin')" @click="rollback">{{ rollbackRevisionId === 'builtin' ? $t('Restore built-in') : $t('Activate revision') }}</button>
                </section>
                </div>
            </aside>

            <main class="print-templates-page__preview" :class="{ 'is-mobile-active': activePane === 'preview' }">
                <PrintTemplatePreview :artifact="previewArtifact" :warnings="previewWarnings" :definition="draftDefinition" :selected-id="selectedNodeId" :selected-ids="selectedNodeIds"
                    @select-node="selectPreviewNode" @toggle-node="togglePreviewNode" @set-selection="setPreviewSelection" @clear-selection="clearPairSelection" @patch-nodes="patchPreviewNodes" @promote-flow-node="promotePreviewFlowNode" @request-row-content="requestRowContent" @interaction-start="startPreviewInteraction" @interaction-end="finishPreviewInteraction" />
            </main>
        </section>
    </div>
</template>

<script setup>
import { formatBusinessDateTimeShort } from '@/utils/businessDate.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { useEventListener, useRefHistory } from '@vueuse/core';
import { onBeforeRouteLeave } from 'vue-router';
import PrintTemplateEditor from '@/admin/components/PrintTemplateEditor.vue';
import PrintTemplatePreview from '@/admin/components/PrintTemplatePreview.vue';
import { usePrintTemplates } from '@/admin/composables/usePrintTemplates.js';
import { promoteFlowNodeToRow } from '@/admin/utils/printTemplateLayout.js';
import { t } from '@/shared/i18n.js';

const activePane = ref('structure');
const panes = [
    { key: 'structure', label: 'Structure', icon: 'fa-solid fa-layer-group' },
    { key: 'properties', label: 'Properties', icon: 'fa-solid fa-sliders' },
    { key: 'preview', label: 'Preview', icon: 'fa-solid fa-eye' },
    { key: 'publish', label: 'Publish', icon: 'fa-solid fa-print' }
];
const selectedNodeId = ref('');
const selectedNodeIds = ref([]);
const baselineDefinition = ref('');
const restorePointDefinition = ref(null);
const rollbackRevisionId = ref('builtin');
const previewInteraction = ref(false);
const structureEditor = ref(null);
const {
    docType, workspace, draftDefinition, catalog, builtinDefinition, fixtures, selectedFixture, selectedRevisionId, selectedRevision, workspaceLoadVersion,
    previewArtifact, previewWarnings, validationError, loading, previewing, acting, error, saveConflict, isBuiltinSelection, canPublishSelected, rollbackCandidates,
    loadWorkspace, updateDraftDefinition, preview, schedulePreview, pausePreview, saveRevision, reloadAfterSaveConflict, copyDraftJson, activate, selectRevision
} = usePrintTemplates();

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const isDirty = computed(() => Boolean(draftDefinition.value && baselineDefinition.value && stableStringify(draftDefinition.value) !== baselineDefinition.value));
const canRestore = computed(() => Boolean(restorePointDefinition.value && draftDefinition.value && stableStringify(draftDefinition.value) !== stableStringify(restorePointDefinition.value)));
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
let fieldHistoryDefinition = '';
let fieldHistoryActive = false;
function setBaseline() { baselineDefinition.value = draftDefinition.value ? stableStringify(draftDefinition.value) : ''; restorePointDefinition.value = draftDefinition.value ? structuredClone(toRaw(draftDefinition.value)) : null; }
function clearPairSelection() { selectedNodeIds.value = selectedNodeId.value ? [selectedNodeId.value] : []; }
function selectNode(id) { selectedNodeId.value = id || ''; clearPairSelection(); }
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
function fieldControl(event) { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName); }
function startFieldHistory(event) {
    if (!fieldControl(event) || fieldHistoryActive) return;
    fieldHistoryActive = true;
    fieldHistoryDefinition = stableStringify(draftDefinition.value);
    pauseHistory();
}
function finishFieldHistory(event) {
    if (!fieldControl(event) || !fieldHistoryActive) return;
    const changed = stableStringify(draftDefinition.value) !== fieldHistoryDefinition;
    fieldHistoryActive = false;
    fieldHistoryDefinition = '';
    resumeHistory(changed);
}
function onHistoryKey(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || fieldControl(event)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undoDraft(); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redoDraft(); }
}
useEventListener(document, 'keydown', onHistoryKey);
async function restoreStartingLayout() {
    if (!canRestore.value) return;
    const confirmed = await window.showAdminConfirm?.(t('Restore the layout to its starting shape? Current local changes will be discarded.'), t('Restore starting layout'));
    if (!confirmed) return;
    updateDraftDefinition(structuredClone(toRaw(restorePointDefinition.value)));
    selectNode(restorePointDefinition.value?.bands?.[0]?.id || '');
}
function beforeUnload(event) { if (!isDirty.value) return; event.preventDefault(); event.returnValue = ''; }
async function discardLocalDraft() { return !isDirty.value || Boolean(await window.showAdminConfirm?.(t('Discard unsaved template edits?'))); }

function templateLabel(template) {
    if (!template || template.kind === 'builtin' || !template.id) return 'Built-in';
    return `Revision ${template.revisionNo || template.id}`;
}
function dateTime(value) { return formatBusinessDateTimeShort(value) || '—'; }
async function changeDocType(nextDocType) { if (nextDocType !== docType.value && await discardLocalDraft()) { clearPairSelection(); docType.value = nextDocType; } }
async function reload(force = false) { if (!force && !await discardLocalDraft()) return; if (await loadWorkspace()) { setBaseline(); schedulePreview(); } }
async function recoverFromSaveConflict() { if (await reloadAfterSaveConflict()) { setBaseline(); schedulePreview(); } }
async function copyLocalJson() { if (await copyDraftJson()) window.showAdminToast?.(t('Copied local JSON.'), 'success'); }
async function chooseRevision(revisionId) {
    if (!await discardLocalDraft()) return;
    if (selectRevision(revisionId)) {
        setBaseline();
        clearHistory();
        selectNode(draftDefinition.value?.bands?.[0]?.id || '');
    }
}
async function activateAfterDiscard(revisionId) {
    if (await discardLocalDraft()) await activate(revisionId);
}
function patchPreviewNodes(moves) {
    if (!Array.isArray(moves) || !moves.length || new Set(moves.map(move => move.id)).size !== moves.length) return;
    const positions = new Map(moves.map(({ id, ...position }) => [id, position]));
    const next = structuredClone(toRaw(draftDefinition.value));
    const update = nodes => (nodes || []).reduce((count, node) => {
        const position = positions.get(node.id);
        if (position) { Object.assign(node, position); count += 1; }
        return count + (node.type === 'row' ? update(node.nodes) : 0);
    }, 0);
    const updated = (next?.bands || []).reduce((count, band) => count + update(band.nodes), 0);
    if (updated === positions.size) updateDraftDefinition(next);
}
function promotePreviewFlowNode({ id, widthPx, heightPx }) {
    const result = promoteFlowNodeToRow(toRaw(draftDefinition.value), id, {
        rowId: crypto.randomUUID(), widthPx, heightPx
    });
    if (!result) return;
    updateDraftDefinition(result.definition);
    setPreviewSelection([result.nodeId], result.nodeId);
}
async function requestRowContent(rowId) {
    selectNode(rowId);
    activePane.value = 'structure';
    await nextTick();
    structureEditor.value?.$el?.querySelector('[data-template-library] button:not(:disabled)')?.focus();
}
function togglePreviewNode(id) {
    const next = selectedNodeIds.value.filter(item => item !== id);
    if (next.length === selectedNodeIds.value.length) next.push(id);
    selectedNodeIds.value = next;
    selectedNodeId.value = next.at(-1) || '';
}
function setPreviewSelection(ids, primaryId = ids.at(-1) || '') {
    selectedNodeIds.value = [...new Set(ids.filter(Boolean))];
    selectedNodeId.value = selectedNodeIds.value.includes(primaryId) ? primaryId : selectedNodeIds.value.at(-1) || '';
}
function selectPreviewNode(id) { selectNode(id); if (!previewInteraction.value) activePane.value = 'properties'; }
function startPreviewInteraction() { previewInteraction.value = true; pausePreview(); }
function finishPreviewInteraction(changed) {
    if (!changed) { previewInteraction.value = false; schedulePreview(); return; }
    // The synthetic click after a completed drag must not switch a narrow
    // layout away from its preview before the pointer interaction is visible.
    window.setTimeout(() => { previewInteraction.value = false; }, 0);
}
function rollback() { return activateAfterDiscard(rollbackRevisionId.value === 'builtin' ? null : Number(rollbackRevisionId.value)); }
watch(workspace, () => { setBaseline(); selectNode(draftDefinition.value?.bands?.[0]?.id || ''); });
watch(workspaceLoadVersion, () => clearHistory());
onBeforeRouteLeave(() => !isDirty.value || window.confirm(t('Discard unsaved template edits?')));
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); reload(); });
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<style scoped>
.print-templates-page { height: 100%; gap: 10px; padding-bottom: 14px; overflow: hidden; }
.print-templates-page__command-row { flex-wrap: wrap; }
.print-templates-page .admin-grid-button, .print-templates-page .admin-grid-icon-button, .print-templates-page .admin-grid-segmented { min-height: 44px; height: 44px; }
.print-templates-page__document-control { display: inline-flex; }.print-templates-page__document-control .admin-grid-segmented { grid-template-columns: repeat(2, minmax(68px, 1fr)); grid-auto-columns: unset; }.print-templates-page__document-control .admin-grid-segmented button { min-width: 0; }
.print-templates-page__fixture, .print-templates-page__field { display: flex; align-items: center; gap: 7px; color: #52525b; font-size: 11px; font-weight: 750; }
.print-templates-page__layout-state { min-height: 44px; display: flex; flex-direction: column; justify-content: center; border-inline-start: 1px solid #d4d4d8; padding-inline-start: 12px; line-height: 1.25; }.print-templates-page__layout-state span { color: #71717a; font-size: 9px; font-weight: 750; }.print-templates-page__layout-state strong { color: #24405e; font-size: 11px; }
.print-templates-page__fixture .admin-grid-select { min-width: 180px; }
.print-templates-page__error { margin: 0; border: 1px solid #f1a4ad; border-radius: 7px; background: #fff1f2; color: #a11232; padding: 10px 12px; font-size: 12px; }
.print-template-validation { margin: 0; border: 1px solid #f1c168; border-radius: 7px; background: #fff8e7; color: #744a00; padding: 10px 12px; font-size: 12px; }
.print-templates-page__conflict { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid #f1c168; border-radius: 7px; background: #fff8e7; color: #744a00; padding: 10px 12px; font-size: 12px; }
.print-templates-page__conflict p { margin: 0; }.print-templates-page__conflict div { display: flex; flex-wrap: wrap; gap: 6px; }
.print-templates-page__loading { min-height: 320px; display: grid; place-items: center; border: 1px solid #d4d4d8; border-radius: 9px; background: #fff; color: #71717a; font-size: 12px; }
.print-templates-page__workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(320px, 390px) minmax(0, 1fr); gap: 10px; overflow: hidden; }
.print-templates-page__rail, .print-templates-page__preview { min-width: 0; min-height: 0; border: 1px solid #d4d4d8; border-radius: 9px; background: #fff; overflow: hidden; }
.print-templates-page__rail { display: flex; flex-direction: column; }
.print-templates-page__panes { flex: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid #d4d4d8; background: #f4f4f5; }
.print-templates-page__panes button { min-width: 0; min-height: 46px; display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-inline-end: 1px solid #d4d4d8; background: transparent; color: #62626b; padding: 7px; font-size: 11px; font-weight: 750; }.print-templates-page__panes button:last-child { border-inline-end: 0; }.print-templates-page__panes button.is-active { background: #fff; color: #24405e; box-shadow: inset 0 -2px #24405e; }.print-templates-page__panes button.is-preview { display: none; }
.print-templates-page__editor-pane, .print-templates-page__publish { min-height: 0; flex: 1; overflow-y: auto; scrollbar-gutter: stable; }
.print-templates-page__publish { display: flex; flex-direction: column; gap: 10px; padding: 10px; background: #fafafa; }
.print-templates-page__preview { display: block; }
.print-templates-page__panel { display: flex; flex-direction: column; gap: 10px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fff; padding: 13px; }
.print-templates-page__panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.print-templates-page__panel h3 { margin: 2px 0 0; color: #18181b; font-size: 13px; font-weight: 800; line-height: 1.35; }
.print-templates-page__section-label { color: #62626b; font-size: 10px; font-weight: 750; }
:global(html[dir="rtl"]) .print-templates-page__section-label { letter-spacing: 0; }
.print-templates-page__muted { margin: 0; color: #62626b; font-size: 11px; line-height: 1.5; }
.print-templates-page__field { align-items: stretch; flex-direction: column; }.print-templates-page__field .admin-grid-select { min-height: 42px; }
.print-templates-page__action { min-height: 44px; width: 100%; }
.print-templates-page__tag { border-radius: 5px; background: #dce4ee; color: #1d3450; padding: 3px 6px; font-size: 10px; font-weight: 750; }
.print-templates-page__rollback { margin-top: auto; }
.print-templates-page__revision { position: relative; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; border: 1px solid #e4e4e7; border-radius: 7px; background: #fff; color: #34343a; padding: 9px 10px; text-align: start; transition: border-color 150ms ease, background 150ms ease; }.print-templates-page__revision:hover { border-color: #a1a1aa; background: #fafafa; }.print-templates-page__revision.is-selected { border-color: #24405e; background: #dce4ee; color: #1d3450; }.print-templates-page__revision > span:first-child { font-size: 12px; font-weight: 750; }.print-templates-page__revision small { overflow: hidden; color: #62626b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.print-templates-page__revision-state { grid-column: 2; grid-row: 1 / 3; color: inherit; font-size: 10px; font-weight: 750; }
.print-templates-page__revision:focus-visible, .print-templates-page__panes button:focus-visible { outline: 2px solid rgb(36 64 94 / 36%); outline-offset: -2px; }
@media (max-width: 1099px) {
    .print-templates-page { height: auto; min-height: 100%; overflow-y: auto; }
    .print-templates-page__workspace { display: block; overflow: visible; }
    .print-templates-page__rail { min-height: 560px; }.print-templates-page__panes { grid-template-columns: repeat(4, minmax(0, 1fr)); }.print-templates-page__panes button.is-preview { display: flex; }
    .print-templates-page__preview { display: none; min-height: 600px; }.print-templates-page.is-preview .print-templates-page__rail { min-height: 0; }.print-templates-page.is-preview .print-templates-page__editor-pane, .print-templates-page.is-preview .print-templates-page__publish { display: none; }.print-templates-page.is-preview .print-templates-page__preview { display: block; margin-top: 10px; }
}
@media (max-width: 767px) {
    .print-templates-page .admin-grid-page-bar { align-items: flex-start; flex-direction: row; }.print-templates-page .admin-grid-page-context { align-items: flex-start; flex-direction: column; gap: 3px; }.print-templates-page .admin-grid-page-actions { display: flex; width: auto; }.print-templates-page .admin-grid-page-actions > .admin-grid-icon-button { width: 44px; }
    .print-templates-page__command-row { display: grid; grid-template-columns: 1fr 1fr; }.print-templates-page__document-control, .print-templates-page__fixture { grid-column: 1 / -1; }.print-templates-page__document-control, .print-templates-page__fixture { width: 100%; align-items: stretch; flex-direction: column; }.print-templates-page__fixture { flex-direction: column; }.print-templates-page__fixture .admin-grid-select { width: 100%; min-width: 0; }.print-templates-page__layout-state { min-height: 40px; border-inline-start: 0; padding-inline-start: 0; }
    .print-templates-page__panes button { min-height: 50px; flex-direction: column; gap: 3px; font-size: 10px; }.print-templates-page__rail { min-height: calc(100dvh - 260px); }.print-templates-page__publish { padding: 8px; }
}
@media (max-width: 420px) { .print-templates-page__panes button { padding-inline: 3px; }.print-templates-page__panel { padding: 11px; } }
@media (prefers-reduced-motion: reduce) { .print-templates-page__revision { transition: none; } }
</style>

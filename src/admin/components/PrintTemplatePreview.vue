<template>
    <section class="print-template-preview" :aria-label="$t('Print template preview')">
        <header class="print-template-preview__header">
            <div>
                <div class="print-template-preview__title"><h3>{{ $t(artifact?.docType === 'kitchen' ? 'Kitchen preview' : 'Receipt preview') }}</h3><span v-if="hasPreviewNotice">TEMPLATE PREVIEW — NOT A SALE</span></div>
                <p>{{ $t('This is the current draft rendered by the same engine as the spooler.') }}</p>
            </div>
            <div class="print-template-preview__tools" role="group" :aria-label="$t('Preview zoom')">
                <button v-for="option in zoomOptions" :key="option.value" type="button" :class="{ 'is-active': zoomMode === option.value }" @click="zoomMode = option.value">{{ $t(option.label) }}</button>
            </div>
            <span v-if="selectedIds.length > 1" class="print-template-preview__selection-status" role="status">{{ $t(`${selectedIds.length} selected`) }}<button type="button" :aria-label="$t('Clear selection')" @click="emit('clear-selection')">×</button></span>
        </header>

        <div ref="viewport" class="print-template-preview__viewport" :class="{ 'is-empty': !previewDocument }">
        <div v-if="previewDocument" ref="canvasElement" class="print-template-preview__canvas" :style="canvasStyle" @pointercancel.capture="cancelCanvasInteraction">
                <div ref="stageElement" class="print-template-preview__stage" :style="stageStyle">
                    <iframe ref="previewFrame" class="print-template-preview__paper" sandbox="allow-same-origin" scrolling="no"
                        :srcdoc="previewDocument" :title="$t('Screen layout preview')" :style="paperStyle" @load="onPreviewLoad"></iframe>
                    <div v-if="interactiveNodes.length" ref="overlayElement" class="print-template-preview__position-overlay" :aria-label="$t('Editable content')" @mousedown.capture="startSelectoFromCanvas" @touchstart.capture="startSelectoFromCanvas">
                        <button v-for="handle in columnDividers" :key="handle.key" type="button" class="print-template-preview__divider" :data-divider="handle.key" :style="dividerStyle(handle)" :aria-label="`${$t('Resize columns')} ${nodeName(handle.left.node)} ${nodeName(handle.right.node)}`" aria-keyshortcuts="ArrowLeft ArrowRight" @keydown="moveDividerWithKeyboard($event, handle)"></button>
                        <button v-for="slot in availableRowSlots" :key="slot.key" type="button" class="print-template-preview__row-slot" :style="slot.style" :aria-label="$t('Add content to this row')" @click.stop="emit('request-row-content', slot.rowId)"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>{{ $t('Add content') }}</span></button>
                        <button v-for="entry in interactiveNodes" :key="entry.node.id" type="button" :data-editor-node-id="entry.node.id" :style="overlayStyle(entry)"
                            class="print-template-preview__node-target" :class="{ 'is-selected': selectedIds.includes(entry.node.id), 'is-primary': selectedId === entry.node.id, 'is-positioned': entry.positioned, 'is-row-wrapper': entry.node.type === 'row' }" :aria-label="`${$t(entry.positioned ? 'Position' : 'Edit')} ${nodeName(entry.node)}`"
                            :aria-pressed="selectedIds.includes(entry.node.id)" aria-keyshortcuts="Shift+Enter ArrowLeft ArrowRight ArrowUp ArrowDown"
                            @click="selectFromPreview($event, entry)" @mousedown="startMoveableFromTarget($event, entry)" @touchstart="startMoveableFromTarget($event, entry)" @keydown="moveWithKeyboard($event, entry)">
                            <span class="print-template-preview__node-label">{{ nodeName(entry.node) }}</span>
                        </button>
                    </div>
                    <VueSelecto
                        v-if="selectoReady"
                        ref="selecto"
                        :drag-container="overlayElement"
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
                        :target="moveableTarget"
                        :container="stageElement"
                        :draggable="canMoveSelection"
                        :drag-area="true"
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
                        :control-padding="45 / scale"
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
                </div>
            </div>
            <div v-else class="print-template-preview__empty">
                <i class="fa-regular fa-file-lines" aria-hidden="true"></i>
                <strong>{{ $t('Preview unavailable') }}</strong>
                <p>{{ $t('Choose sample data or refresh the preview to render the document.') }}</p>
            </div>
        </div>

        <footer class="print-template-preview__footer">
            <span><i class="fa-solid fa-circle-info" aria-hidden="true"></i>{{ $t('Screen layout preview — paper output may differ') }}</span>
            <span data-no-i18n>576px · {{ Math.round(scale * 100) }}%</span>
        </footer>
        <ul v-if="warnings.length" class="print-template-preview__warnings">
            <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
        </ul>
    </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Moveable from 'vue3-moveable';
import { VueSelecto } from 'vue3-selecto';

const PAPER_WIDTH = 576;
const MIN_COLUMN_PX = 16;
const FIT_CONTROL_GUTTER = 45;
const props = defineProps({
    artifact: { type: Object, default: null }, warnings: { type: Array, default: () => [] },
    definition: { type: Object, default: null }, selectedId: { type: String, default: '' }, selectedIds: { type: Array, default: () => [] }
});
const emit = defineEmits(['select-node', 'toggle-node', 'set-selection', 'clear-selection', 'patch-nodes', 'promote-flow-node', 'request-row-content', 'interaction-start', 'interaction-end']);
const viewport = ref(null);
const canvasElement = ref(null);
const stageElement = ref(null);
const overlayElement = ref(null);
const selectoReady = ref(false);
const selecto = ref(null);
const previewFrame = ref(null);
const moveable = ref(null);
const viewportWidth = ref(PAPER_WIDTH + 32);
const previewHeight = ref(640);
const nodeRects = ref({});
const activeInteraction = ref(null);
const zoomMode = ref('fit');
const zoomOptions = [{ value: 'fit', label: 'Fit' }, { value: '0.75', label: '75%' }, { value: '1', label: '100%' }];
let viewportObserver;
let documentObserver;

const hasPreviewNotice = computed(() => props.artifact?.html?.includes('data-template-preview-notice="true"') === true);
const printableArtifactHtml = computed(() => {
    const html = props.artifact?.html || '';
    const start = html.indexOf('<main'); const end = html.lastIndexOf('</main>');
    return start >= 0 && end >= start ? html.slice(start, end + 7) : html;
});
const previewDocument = computed(() => {
    if (!props.artifact?.html) return '';
    const css = typeof props.artifact.css === 'string' ? props.artifact.css : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;min-width:${PAPER_WIDTH}px;overflow:hidden;background:#fff}${css}</style></head><body>${printableArtifactHtml.value}</body></html>`;
});
const fitScale = computed(() => Math.min(1, Math.max(.35, (viewportWidth.value - 32 - FIT_CONTROL_GUTTER) / PAPER_WIDTH)));
const scale = computed(() => zoomMode.value === 'fit' ? fitScale.value : Number(zoomMode.value));
const canvasStyle = computed(() => ({ width: `${PAPER_WIDTH * scale.value}px`, height: `${previewHeight.value * scale.value}px` }));
const stageStyle = computed(() => ({
    width: `${PAPER_WIDTH}px`,
    height: `${previewHeight.value}px`,
    transform: `scale(${scale.value})`,
    '--template-control-size': `${45 / scale.value}px`,
    '--template-handle-size': `${14 / scale.value}px`
}));
const paperStyle = computed(() => ({ width: `${PAPER_WIDTH}px`, height: `${previewHeight.value}px` }));
const interactiveNodes = computed(() => {
    const entries = [];
    const visit = (nodes, container = null, parentRow = null) => (nodes || []).forEach(node => {
        if (node.hidden === true) return;
        entries.push({ node, positioned: Boolean(container), width: container?.width, height: container?.height, containerKey: container?.key, parentRow });
        if (node.type === 'row') visit(node.nodes, node.layout === 'absolute' ? { width: 556, height: node.height, key: `row:${node.id}` } : null, node);
    });
    for (const band of props.definition?.bands || []) visit(band.nodes, band.layout === 'absolute' ? { width: 576, height: band.height, key: `band:${band.id}` } : null);
    return entries;
});
const targetElements = computed(() => {
    void nodeRects.value;
    return [...(overlayElement.value?.querySelectorAll('.print-template-preview__node-target') || [])]
        .filter(element => element.getClientRects().length > 0);
});
const selectableElements = computed(() => targetElements.value.filter(element => {
    const entry = interactiveNodes.value.find(item => item.node.id === element.dataset.editorNodeId);
    return entry?.positioned;
}));
const moveableEntries = computed(() => interactiveNodes.value.filter(entry => props.selectedIds.includes(entry.node.id) && entry.positioned));
function canPromoteFlowEntry(entry) {
    if (!entry || entry.positioned || !['text', 'field'].includes(entry.node.type) || Number(entry.node.style?.marginInlineStart || 0) !== 0) return false;
    return (props.definition?.bands || []).some(band => (band.layout || 'flow') === 'flow' && (band.nodes || []).some(node => node.id === entry.node.id));
}
const flowResizeEntry = computed(() => props.selectedIds.length === 1 ? interactiveNodes.value.find(entry => entry.node.id === props.selectedId && canPromoteFlowEntry(entry)) : null);
const moveableTargets = computed(() => {
    const ids = new Set(moveableEntries.value.map(entry => entry.node.id));
    if (flowResizeEntry.value) ids.add(flowResizeEntry.value.node.id);
    return targetElements.value.filter(element => ids.has(element.dataset.editorNodeId));
});
const moveableTarget = computed(() => moveableTargets.value.length === 1 ? moveableTargets.value[0] : moveableTargets.value);
const canMoveSelection = computed(() => samePositionedContainer(moveableEntries.value));
const canResizeSelection = computed(() => moveableEntries.value.length === 1 || Boolean(flowResizeEntry.value));
const availableRowSlots = computed(() => {
    const selected = interactiveNodes.value.find(entry => entry.node.id === props.selectedId);
    const row = selected?.node?.type === 'row' && selected.node.layout === 'absolute' ? selected.node : selected?.parentRow;
    if (!row?.id || row.layout !== 'absolute') return [];
    const rowRect = nodeRects.value[row.id];
    if (!rowRect) return [];
    const children = [...(row.nodes || [])].sort((left, right) => left.x - right.x);
    const slots = [];
    let cursor = 0;
    for (const child of children) {
        if (child.x - cursor >= 16) slots.push({ key: `${row.id}:${cursor}`, rowId: row.id, style: { left: `${rowRect.left + cursor}px`, top: `${rowRect.top}px`, width: `${child.x - cursor}px`, height: `${rowRect.height}px` } });
        cursor = Math.max(cursor, child.x + child.widthPx);
    }
    if (556 - cursor >= 16) slots.push({ key: `${row.id}:${cursor}`, rowId: row.id, style: { left: `${rowRect.left + cursor}px`, top: `${rowRect.top}px`, width: `${556 - cursor}px`, height: `${rowRect.height}px` } });
    return slots;
});
const columnDividers = computed(() => {
    const groups = new Map();
    for (const entry of interactiveNodes.value) if (entry.positioned) (groups.get(entry.containerKey) || groups.set(entry.containerKey, []).get(entry.containerKey)).push(entry);
    return [...groups.values()].flatMap(entries => [...entries].sort((a, b) => a.node.x - b.node.x).slice(1).flatMap((right, index) => {
        const left = [...entries].sort((a, b) => a.node.x - b.node.x)[index];
        return left.node.x + left.node.widthPx === right.node.x ? [{ key: `${left.node.id}|${right.node.id}`, left, right }] : [];
    }));
});

function nodeName(node) { return node.type === 'field' ? node.path : node.type === 'text' ? node.text?.en || node.text?.ar || 'Text' : node.type.replace('_', ' '); }
function measurePreview() {
    const doc = previewFrame.value?.contentDocument;
    if (!doc) return;
    const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, 420);
    previewHeight.value = Math.min(10000, Math.ceil(height));
    const rootRect = doc.documentElement.getBoundingClientRect();
    const measured = {};
    for (const element of doc.querySelectorAll('[data-node]')) {
        if (measured[element.dataset.node]) continue;
        const rect = element.getBoundingClientRect();
        measured[element.dataset.node] = { left: rect.left - rootRect.left, top: rect.top - rootRect.top, width: rect.width, height: rect.height };
    }
    nodeRects.value = measured;
}
function onPreviewLoad() {
    documentObserver?.disconnect();
    measurePreview();
    const body = previewFrame.value?.contentDocument?.body;
    if (body) { documentObserver = new ResizeObserver(measurePreview); documentObserver.observe(body); }
    nextTick(() => { selectoReady.value = Boolean(canvasElement.value && overlayElement.value); });
}
function overlayStyle({ node }) {
    const live = activeInteraction.value;
    if (live?.styles?.[node.id]) return live.styles[node.id];
    const rect = nodeRects.value[node.id];
    return rect ? { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` } : { display: 'none' };
}
function dividerStyle(handle) { const right = nodeRects.value[handle.right.node.id]; return right ? { left: `${right.left - 4}px`, top: `${right.top}px`, width: '8px', height: `${right.height}px` } : { display: 'none' }; }
function snap(value) { return Math.round(value / 4) * 4; }
function primaryEntry() { return interactiveNodes.value.find(entry => entry.node.id === props.selectedId); }
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
function clampedMoves(entries, dx, dy) {
    const minimumX = Math.max(...entries.map(entry => -entry.node.x));
    const maximumX = Math.min(...entries.map(entry => entry.width - entry.node.x - entry.node.widthPx));
    const minimumY = Math.max(...entries.map(entry => -entry.node.y));
    const maximumY = Math.min(...entries.map(entry => entry.height - entry.node.y - entry.node.heightPx));
    const offsetX = Math.min(maximumX, Math.max(minimumX, dx));
    const offsetY = Math.min(maximumY, Math.max(minimumY, dy));
    return entries.map(entry => ({ id: entry.node.id, x: entry.node.x + offsetX, y: entry.node.y + offsetY }));
}
function movementStyles(entries, moves) {
    const moveById = new Map(moves.map(move => [move.id, move]));
    return Object.fromEntries(entries.map(entry => {
        const rect = nodeRects.value[entry.node.id]; const move = moveById.get(entry.node.id);
        return [entry.node.id, rect && move ? {
            left: `${rect.left + (move.x ?? entry.node.x) - entry.node.x}px`,
            top: `${rect.top + (move.y ?? entry.node.y) - entry.node.y}px`,
            width: `${rect.width + (move.widthPx ?? entry.node.widthPx) - entry.node.widthPx}px`,
            height: `${rect.height + (move.heightPx ?? entry.node.heightPx) - entry.node.heightPx}px`
        } : overlayStyle(entry)];
    }));
}
function resizeColumns(handle, dx) {
    const { left, right } = handle;
    const offset = Math.max(MIN_COLUMN_PX - left.node.widthPx, Math.min(right.node.widthPx - MIN_COLUMN_PX, snap(dx)));
    return [
        { id: left.node.id, widthPx: left.node.widthPx + offset },
        { id: right.node.id, x: right.node.x + offset, widthPx: right.node.widthPx - offset }
    ];
}
function moveDividerWithKeyboard(event, handle) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 16 : 4;
    const patches = resizeColumns(handle, event.key === 'ArrowLeft' ? -step : step);
    if (patches.some((patch, index) => patch.widthPx !== [handle.left, handle.right][index].node.widthPx)) emit('patch-nodes', patches);
}
function selectFromPreview(event, entry) {
    if ((event.shiftKey || event.ctrlKey || event.metaKey) && canToggle(entry)) emit('toggle-node', entry.node.id);
    else emit('select-node', entry.node.id);
}
function beginGesture(entries, event, mode = 'move') {
    emit('interaction-start');
    activeInteraction.value = {
        entries,
        mode,
        startX: event?.clientX ?? 0,
        startY: event?.clientY ?? 0,
        moves: [],
        styles: {},
        direction: event?.direction || []
    };
}
function movementFromEvent(event) {
    const live = activeInteraction.value;
    if (!live) return { dx: 0, dy: 0 };
    const inputEvent = event?.inputEvent;
    const point = inputEvent?.touches?.[0] || inputEvent?.changedTouches?.[0] || inputEvent;
    if (Number.isFinite(point?.clientX) && Number.isFinite(point?.clientY)) {
        return {
            dx: snap((point.clientX - live.startX) / scale.value),
            dy: snap((point.clientY - live.startY) / scale.value)
        };
    }
    if (Array.isArray(event?.dist) && event.dist.length === 2) {
        return { dx: snap(event.dist[0] / scale.value), dy: snap(event.dist[1] / scale.value) };
    }
    return {
        dx: snap(((event?.clientX ?? live.startX) - live.startX) / scale.value),
        dy: snap(((event?.clientY ?? live.startY) - live.startY) / scale.value)
    };
}
function startMoveableDrag(event) {
    if (activeInteraction.value?.mode === 'move') return;
    const entries = moveableTargets.value.map(entryForElement).filter(Boolean);
    if (!samePositionedContainer(entries)) return event.stop?.();
    beginGesture(entries, event);
}
function startMoveableFromTarget(event, entry) {
    if (!entry.positioned || event.shiftKey || event.ctrlKey || event.metaKey || !props.selectedIds.includes(entry.node.id)) return;
    const instance = moveable.value;
    instance?.dragStart?.(event, instance.getDragElement?.());
}
function moveSingle(event) {
    const live = activeInteraction.value;
    if (!live || live.mode !== 'move') return;
    const { dx, dy } = movementFromEvent(event);
    const moves = clampedMoves(live.entries, dx, dy);
    live.moves = moves;
    live.styles = movementStyles(live.entries, moves);
}
function moveGroup(event) { moveSingle(event?.events?.[0] || event); }
function startMoveableResize(event) {
    const entry = entryForElement(event.target) || moveableEntries.value[0] || flowResizeEntry.value;
    if (!entry) return event.stop?.();
    beginGesture([entry], event, canPromoteFlowEntry(entry) ? 'promote' : 'resize');
    const rect = nodeRects.value[entry.node.id];
    activeInteraction.value.flowWidth = rect?.width || 0;
    activeInteraction.value.flowHeight = rect?.height || 0;
}
function resizeSingle(event) {
    const live = activeInteraction.value;
    const entry = live?.entries?.[0];
    if (!live || !['resize', 'promote'].includes(live.mode) || !entry) return;
    const { dx, dy } = movementFromEvent(event);
    const east = Array.isArray(live.direction) && live.direction[0] === 1;
    const south = Array.isArray(live.direction) && live.direction[1] === 1;
    if (live.mode === 'promote') {
        const widthPx = Math.max(16, snap(live.flowWidth + (east ? dx : 0)));
        const heightPx = Math.max(32, snap(live.flowHeight + (south ? dy : 0)));
        live.moves = [{ id: entry.node.id, widthPx, heightPx }];
        live.styles = { [entry.node.id]: { ...overlayStyle(entry), width: `${widthPx}px`, height: `${heightPx}px` } };
        return;
    }
    const divider = columnDividers.value.find(handle => handle.left.node.id === entry.node.id);
    const moves = east && divider
        ? resizeColumns(divider, dx)
        : [{
            id: entry.node.id,
            ...(east ? { widthPx: Math.min(entry.width - entry.node.x, Math.max(4, entry.node.widthPx + dx)) } : {}),
            ...(south ? { heightPx: Math.min(entry.height - entry.node.y, Math.max(4, entry.node.heightPx + dy)) } : {})
        }];
    live.moves = moves;
    live.styles = east && divider ? movementStyles([divider.left, divider.right], moves) : movementStyles([entry], moves);
}
function finishMoveable(event) {
    const result = activeInteraction.value;
    if (!result || !['move', 'resize', 'promote'].includes(result.mode)) return;
    const inputType = event?.inputEvent?.type;
    const canceled = !event?.inputEvent || inputType === 'pointercancel' || inputType === 'touchcancel';
    let pendingMoves = result.moves || [];
    const lastMoveEvent = event?.lastEvent?.events?.[0] || event?.lastEvent;
    if (!pendingMoves.length && lastMoveEvent && result.mode === 'move') {
        const { dx, dy } = movementFromEvent(lastMoveEvent);
        pendingMoves = clampedMoves(result.entries, dx, dy);
    }
    activeInteraction.value = null;
    if (result.mode === 'promote') {
        const change = !canceled && pendingMoves[0] && (pendingMoves[0].widthPx !== result.flowWidth || pendingMoves[0].heightPx !== result.flowHeight);
        if (change) emit('promote-flow-node', pendingMoves[0]);
        emit('interaction-end', change);
        return;
    }
    const moves = canceled ? [] : pendingMoves.filter(move => {
        const original = result.entries.find(entry => entry.node.id === move.id)?.node;
        return original && ['x', 'y', 'widthPx', 'heightPx'].some(key => move[key] !== undefined && move[key] !== original[key]);
    });
    const changed = moves.length > 0;
    if (changed) emit('patch-nodes', moves);
    emit('interaction-end', changed);
}
function selectionStartIsExcluded(target) {
    return target?.closest?.('.print-template-preview__node-target, .moveable-control-box, .print-template-preview__divider, .print-template-preview__row-slot, .print-template-preview__header, .print-template-preview__footer');
}
function startSelectoFromCanvas(event) {
    if (selectionStartIsExcluded(event.target)) return;
    selecto.value?.triggerDragStart?.(event);
}
function startSelecto(event) {
    const target = event?.inputEvent?.target;
    if (selectionStartIsExcluded(target)) return event.stop?.();
    beginGesture([], event, 'select');
}
function finishSelecto(event) {
    if (activeInteraction.value?.mode !== 'select') return;
    activeInteraction.value = null;
    const entries = (event.selected || []).map(entryForElement).filter(entry => entry?.positioned);
    const containerKey = entries[0]?.containerKey;
    const picked = containerKey ? entries.filter(entry => entry.containerKey === containerKey).map(entry => entry.node.id) : [];
    const heldShift = Boolean(event?.inputEvent?.shiftKey);
    const current = heldShift && containerKey
        ? props.selectedIds.filter(id => interactiveNodes.value.some(entry => entry.node.id === id && entry.positioned && entry.containerKey === containerKey))
        : [];
    const ids = [...new Set([...current, ...picked])];
    emit('set-selection', ids, ids.at(-1) || '');
    emit('interaction-end', false);
}
function cancelCanvasInteraction() {
    if (!activeInteraction.value) return;
    activeInteraction.value = null;
    emit('interaction-end', false);
}
function moveWithKeyboard(event, entry) {
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (canToggle(entry)) emit('toggle-node', entry.node.id); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); emit('select-node', entry.node.id); return; }
    if (!entry.positioned) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); if (!props.selectedIds.includes(entry.node.id)) emit('select-node', entry.node.id);
    const step = event.shiftKey ? 16 : 4;
    const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y';
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
    const moves = clampedMoves(movableEntries(entry), axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    emit('patch-nodes', moves);
}
watch(previewDocument, () => {
    cancelCanvasInteraction();
    selectoReady.value = false;
    previewHeight.value = 640;
    nodeRects.value = {};
    nextTick(() => {
        selectoReady.value = Boolean(canvasElement.value && overlayElement.value);
        measurePreview();
    });
}, { immediate: true });
watch([canvasElement, overlayElement], ([canvas, overlay]) => { selectoReady.value = Boolean(canvas && overlay); }, { flush: 'post' });
watch([nodeRects, scale, moveableTarget], async () => {
    await nextTick();
    moveable.value?.forceUpdate?.();
    moveable.value?.updateRect?.();
}, { flush: 'post' });
onMounted(() => {
    viewportObserver = new ResizeObserver(entries => { viewportWidth.value = entries[0]?.contentRect.width || PAPER_WIDTH + 32; });
    if (viewport.value) viewportObserver.observe(viewport.value);
});
onBeforeUnmount(() => { cancelCanvasInteraction(); viewportObserver?.disconnect(); documentObserver?.disconnect(); });
</script>

<style scoped>
.print-template-preview { min-width: 0; height: 100%; display: flex; flex-direction: column; background: #fff; }
.print-template-preview__header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #e4e4e7; padding: 10px 14px; }
.print-template-preview__title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }.print-template-preview__title > span { border: 1px solid #a1a1aa; border-radius: 4px; color: #52525b; padding: 2px 5px; font-size: 9px; font-weight: 800; letter-spacing: .02em; }
.print-template-preview__header h3 { margin: 0; color: #18181b; font-size: 14px; font-weight: 800; }.print-template-preview__header p { margin: 3px 0 0; color: #62626b; font-size: 11px; line-height: 1.4; }
.print-template-preview__tools { flex: none; display: inline-flex; border: 1px solid #d4d4d8; border-radius: 7px; overflow: hidden; background: #f4f4f5; }.print-template-preview__tools button { min-width: 48px; min-height: 38px; border: 0; border-inline-end: 1px solid #d4d4d8; background: transparent; color: #52525b; padding: 6px 9px; font-size: 10px; font-weight: 750; }.print-template-preview__tools button:last-child { border-inline-end: 0; }.print-template-preview__tools button.is-active { background: #fff; color: #24405e; box-shadow: inset 0 -2px #24405e; }
.print-template-preview__selection-status { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #8fa6c4; border-radius: 999px; background: #dce4ee; color: #1d3450; padding: 3px 5px 3px 8px; font-size: 10px; font-weight: 800; white-space: nowrap; }.print-template-preview__selection-status button { width: 18px; height: 18px; border: 0; border-radius: 50%; background: transparent; color: inherit; font-size: 16px; line-height: 1; }.print-template-preview__selection-status button:hover { background: rgb(29 52 80 / 12%); }
.print-template-preview__viewport { min-height: 0; flex: 1; overflow: auto; padding: 16px; background: #e3e6ea; scrollbar-gutter: stable; }.print-template-preview__viewport.is-empty { display: grid; place-items: center; }
.print-template-preview__canvas { position: relative; margin-inline: auto; }
.print-template-preview__stage { position: absolute; top: 0; left: 50%; transform-origin: top center; translate: -50% 0; }
.print-template-preview__paper { position: relative; z-index: 0; display: block; border: 0; background: #fff; box-shadow: 0 2px 6px rgb(24 24 27 / 18%); pointer-events: none; }
.print-template-preview__position-overlay { position: absolute; z-index: 1; inset: 0; background: rgb(0 0 0 / 0.001); pointer-events: auto; }.print-template-preview__position-overlay button { position: absolute; z-index: 2; box-sizing: border-box; border: 1px solid transparent; border-radius: 2px; background: transparent; cursor: pointer; pointer-events: auto; }.print-template-preview__position-overlay button.is-row-wrapper { z-index: 1; }.print-template-preview__position-overlay button.is-positioned { z-index: 3; cursor: move; }.print-template-preview__divider { z-index: 4!important; cursor: col-resize!important; }.print-template-preview__divider:hover { background:rgb(36 64 94 / 40%)!important; }.print-template-preview__position-overlay button:hover, .print-template-preview__position-overlay button.is-selected { border-color: rgb(36 64 94 / 88%); background: rgb(36 64 94 / 7%); }.print-template-preview__position-overlay button.is-selected { z-index: 5; }.print-template-preview__position-overlay button:focus-visible { outline: 2px solid #24405e; outline-offset: 2px; }.print-template-preview__node-label { position: absolute; inset-block-start: -20px; inset-inline-start: -1px; max-width: 180px; overflow: hidden; border-radius: 4px 4px 0 0; background: #24405e; color: #fff; padding: 2px 5px; font: 700 9px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; opacity: 0; }.print-template-preview__position-overlay button:hover .print-template-preview__node-label, .print-template-preview__position-overlay button.is-selected .print-template-preview__node-label { opacity: 1; }
.print-template-preview__row-slot { z-index: 2!important; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px dashed rgb(36 64 94 / 45%)!important; background: rgb(220 228 238 / 55%)!important; color: #24405e; font-size: 10px; font-weight: 750; }
.print-template-preview__canvas :deep(.selecto-selection) { z-index: 8!important; }.print-template-preview__canvas :deep(.moveable-control-box) { z-index: 9!important; pointer-events: none; }.print-template-preview__canvas :deep(.moveable-control), .print-template-preview__canvas :deep(.moveable-around-control[data-direction]) { pointer-events: auto; }.print-template-preview__canvas :deep(.moveable-around-control[data-direction]) { box-sizing: border-box; width: var(--template-control-size); height: var(--template-control-size); }.print-template-preview__canvas :deep(.moveable-control) { width: var(--template-handle-size); height: var(--template-handle-size); }
.print-template-preview__empty { max-width: 34ch; display: grid; place-items: center; gap: 7px; color: #62626b; text-align: center; }.print-template-preview__empty i { font-size: 28px; color: #6c737b; }.print-template-preview__empty strong { color: #27272a; font-size: 13px; }.print-template-preview__empty p { margin: 0; font-size: 12px; line-height: 1.5; }
.print-template-preview__footer { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid #e4e4e7; padding: 7px 14px; color: #62626b; font-size: 10px; }.print-template-preview__footer span { display: flex; align-items: center; gap: 6px; }.print-template-preview__footer i { color: #24405e; }
.print-template-preview__warnings { margin: 0; border-top: 1px solid #f1c168; background: #fff8e7; color: #7a4c00; padding: 9px 14px 9px 32px; font-size: 11px; line-height: 1.45; }
.print-template-preview button:focus-visible { outline: 2px solid rgb(36 64 94 / 40%); outline-offset: -2px; }
@media (max-width: 1099px) { .print-template-preview { min-height: 560px; }.print-template-preview__position-overlay button.is-positioned { cursor: pointer; }.print-template-preview__tools button { min-height: 44px; }.print-template-preview__header { align-items: flex-start; flex-direction: column; }.print-template-preview__tools { width: 100%; }.print-template-preview__tools button { flex: 1; }.print-template-preview__selection-status { display: none; } }
@media (max-width: 520px) { .print-template-preview { min-height: calc(100dvh - 230px); }.print-template-preview__viewport { padding: 10px; }.print-template-preview__header { padding: 10px 12px; }.print-template-preview__header p { max-width: 34ch; }.print-template-preview__footer { align-items: flex-start; flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { .print-template-preview__node-label { transition: none; } }
</style>

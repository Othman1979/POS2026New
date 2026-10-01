<template>
    <VueDraggable
        :model-value="nodes"
        :group="{ name: `template-nodes:${parentId}`, pull: false, put: ['template-library'] }"
        handle=".print-template-editor__node-drag"
        :animation="120"
        :custom-update="finishNodeDrag"
        :force-fallback="true"
        :fallback-on-body="true"
        :swap-threshold="0.65"
        :scroll="true"
        :scroll-sensitivity="56"
        :scroll-speed="12"
        class="print-template-structure-nodes"
        @add="insertDroppedNode"
    >
        <article v-for="(node, index) in nodes" :key="node.id" class="print-template-editor__node" :class="{ 'is-selected': selectedId === node.id, 'is-hidden': node.hidden }" :style="{ '--depth': depth }" :data-template-node-id="node.id" role="treeitem" :aria-selected="selectedId === node.id">
            <button class="print-template-editor__node-drag" type="button" :aria-label="$t('Drag content block')" @keydown.alt.up.prevent="emit('move-node', node.id, -1)" @keydown.alt.down.prevent="emit('move-node', node.id, 1)"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></button>
            <button class="print-template-editor__node-select" type="button" @click="emit('select-node', node.id)"><i :class="nodeIcon(node.type)" aria-hidden="true"></i><span>{{ $t(nodeLabel(node.type)) }}</span><small data-no-i18n>{{ nodeSummary(node) }}</small></button>
            <details class="print-template-editor__node-menu"><summary :aria-label="$t('Content block actions')"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary><div><button type="button" :disabled="index === 0" @click="emit('move-node', node.id, -1)">{{ $t('Move up') }}</button><button type="button" :disabled="index === nodes.length - 1" @click="emit('move-node', node.id, 1)">{{ $t('Move down') }}</button><button type="button" @click="emit('duplicate-node', node.id)">{{ $t('Duplicate') }}</button><button type="button" @click="emit('delete-node', node.id)">{{ $t('Delete') }}</button></div></details>
            <PrintTemplateStructureNodes v-if="node.type === 'row'" :nodes="node.nodes" :parent-id="node.id" :depth="depth + 1" :selected-id="selectedId" :node-label="nodeLabel" :node-summary="nodeSummary" :node-icon="nodeIcon" @replace-nodes="forwardReplace" @insert-library-node="forwardInsert" @select-node="forwardSelect" @move-node="forwardMove" @duplicate-node="forwardDuplicate" @delete-node="forwardDelete" />
        </article>
    </VueDraggable>
</template>

<script setup>
import { VueDraggable } from 'vue-draggable-plus';

const props = defineProps({
    nodes: { type: Array, required: true }, parentId: { type: String, required: true }, depth: { type: Number, default: 0 }, selectedId: { type: String, default: '' },
    nodeLabel: { type: Function, required: true }, nodeSummary: { type: Function, required: true }, nodeIcon: { type: Function, required: true }
});
const emit = defineEmits(['replace-nodes', 'insert-library-node', 'select-node', 'move-node', 'duplicate-node', 'delete-node']);
function insertDroppedNode(event) {
    const type = event.item?.dataset?.nodeType;
    const index = event.newDraggableIndex ?? event.newIndex;
    if (type && Number.isInteger(index)) emit('insert-library-node', props.parentId, index, type);
}
function finishNodeDrag(event) {
    if (event.from !== event.to) return;
    const from = event.oldDraggableIndex ?? event.oldIndex;
    const to = event.newDraggableIndex ?? event.newIndex;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
    const next = [...props.nodes];
    const [node] = next.splice(from, 1);
    next.splice(to, 0, node);
    emit('replace-nodes', props.parentId, next);
}
function forwardReplace(parentId, nextNodes) { emit('replace-nodes', parentId, nextNodes); }
function forwardInsert(parentId, index, type) { emit('insert-library-node', parentId, index, type); }
function forwardSelect(nodeId) { emit('select-node', nodeId); }
function forwardMove(nodeId, offset) { emit('move-node', nodeId, offset); }
function forwardDuplicate(nodeId) { emit('duplicate-node', nodeId); }
function forwardDelete(nodeId) { emit('delete-node', nodeId); }
</script>

<style scoped>
.print-template-structure-nodes { display: grid; gap: 2px; }.print-template-editor__node { display: grid; grid-template-columns: 45px minmax(0, 1fr) 45px; min-height: 45px; align-items: stretch; padding-inline-start: calc(var(--depth) * 12px); border: 1px solid #e4e4e7; border-radius: 5px; }.print-template-editor__node > .print-template-structure-nodes { grid-column: 1 / -1; }.print-template-editor__node.is-selected { border-color: #24405e; background: #dce4ee; }.print-template-editor__node.is-hidden .print-template-editor__node-select { opacity: .5; }.print-template-editor__node.is-hidden .print-template-editor__node-select span { text-decoration: line-through; }.print-template-editor__node-drag, .print-template-editor__node-select, .print-template-editor__node-menu summary, .print-template-editor__node-menu button { min-width: 45px; min-height: 45px; border: 0; background: transparent; }.print-template-editor__node-select { min-width: 0; display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 5px; align-content: center; text-align: start; }.print-template-editor__node-select small { grid-column: 2; overflow: hidden; color: #71717a; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.print-template-editor__node-menu { position: relative; }.print-template-editor__node-menu summary { display: grid; place-items: center; list-style: none; }.print-template-editor__node-menu summary::-webkit-details-marker { display: none; }.print-template-editor__node-menu div { position: absolute; z-index: 2; inset-inline-end: 0; display: none; min-width: 110px; background: #fff; border: 1px solid #d4d4d8; }.print-template-editor__node-menu[open] div { display: grid; }.print-template-editor__node-menu button { text-align: start; }.print-template-editor__node-drag { cursor: grab; }.print-template-editor__node button:focus-visible, .print-template-editor__node summary:focus-visible { outline: 2px solid #24405e; outline-offset: -2px; }
</style>

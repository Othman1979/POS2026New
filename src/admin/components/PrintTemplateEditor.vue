<template>
    <section class="print-template-editor" :class="`is-${mode}`" :aria-label="$t(mode === 'properties' ? 'Properties' : 'Template structure')">
        <template v-if="mode === 'structure'">
            <header class="print-template-editor__header">
                <div>
                    <h3>{{ $t('Arrange the printed content') }}</h3>
                    <p>{{ $t('Drag blocks into a section, or tap to add. Use each item menu for keyboard and touch reordering.') }}</p>
                </div>
                <span class="print-template-editor__status"><span aria-hidden="true"></span>{{ $t('Draft') }}</span>
            </header>

            <div class="print-template-editor__library" data-template-library role="group" :aria-label="$t('Add content')">
                <p>{{ $t('Content blocks') }}</p>
                <VueDraggable :model-value="availableNodeTypes" :group="{ name: 'template-library', pull: 'clone', put: false }" :sort="false" :clone="type => ({ __paletteType: type })" :force-fallback="true">
                    <button v-for="type in availableNodeTypes" :key="type" class="print-template-editor__add" type="button" :data-node-type="type"
                        :disabled="!canOfferType(type)" @click="addNodeFromPalette(type)">
                        <i :class="nodeIcon(type)" aria-hidden="true"></i><span>{{ $t(nodeLabel(type)) }}</span><i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                </VueDraggable>
            </div>

            <VueDraggable
                :model-value="draft.bands"
                :group="{ name: 'template-bands', pull: false, put: false }"
                handle=".print-template-editor__band-drag"
                :animation="120"
                :custom-update="finishBandDrag"
                class="print-template-editor__tree"
                role="tree"
                :aria-label="$t('Template structure')"
            >
                <article v-for="(band, bandIndex) in draft.bands" :key="band.id" class="print-template-editor__band"
                    :class="{ 'is-selected': currentSelectedId === band.id }"
                    role="treeitem" :aria-selected="currentSelectedId === band.id">
                    <div class="print-template-editor__band-row">
                        <button class="print-template-editor__band-drag" type="button" :aria-label="$t('Drag section')"
                            @keydown.alt.up.prevent="moveBand(bandIndex, -1)" @keydown.alt.down.prevent="moveBand(bandIndex, 1)">
                            <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                        </button>
                        <button class="print-template-editor__band-select" type="button" @click="selectBand(band)">
                            <span class="print-template-editor__kind">{{ $t(band.kind === 'repeat' ? 'Repeating section' : 'Section') }}</span>
                            <strong>{{ $t(bandLabel(band)) }}</strong>
                            <small data-no-i18n>{{ band.id }}</small>
                        </button>
                        <span v-if="band.layout === 'absolute'" class="print-template-editor__layout-tag">{{ $t('Positioned') }}</span>
                        <details class="print-template-editor__band-menu">
                            <summary :aria-label="$t('Section actions')"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary>
                            <div>
                                <button type="button" :disabled="bandIndex === 0" @click="moveBand(bandIndex, -1)"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i>{{ $t('Move up') }}</button>
                                <button type="button" :disabled="bandIndex === draft.bands.length - 1" @click="moveBand(bandIndex, 1)"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i>{{ $t('Move down') }}</button>
                                <button type="button" @click="duplicateBand(bandIndex)"><i class="fa-regular fa-copy" aria-hidden="true"></i>{{ $t('Duplicate') }}</button>
                                <button type="button" class="is-danger" @click="deleteBand(bandIndex)"><i class="fa-regular fa-trash-can" aria-hidden="true"></i>{{ $t('Delete') }}</button>
                            </div>
                        </details>
                    </div>

                    <PrintTemplateStructureNodes :nodes="band.nodes" :parent-id="band.id" :selected-id="currentSelectedId" :node-label="nodeLabel" :node-summary="nodeSummary" :node-icon="nodeIcon" @replace-nodes="replaceNodes" @insert-library-node="insertLibraryNode" @select-node="selectNodeById" @move-node="moveNodeById" @duplicate-node="duplicateNodeById" @delete-node="deleteNodeById" />
                </article>
            </VueDraggable>
        </template>

        <template v-else>
            <header class="print-template-editor__header">
                <div><h3>{{ $t('Properties') }}</h3><p>{{ $t('Edit only the selected block. The server validates every saved value.') }}</p></div>
            </header>
            <div v-if="!selectedEntry" class="print-template-editor__empty">
                <i class="fa-solid fa-arrow-pointer" aria-hidden="true"></i>
                <strong>{{ $t('Nothing selected') }}</strong>
                <p>{{ $t('Choose a section or content block from Structure, or select a positioned block in the preview.') }}</p>
            </div>
            <form v-else class="print-template-editor__inspector" @submit.prevent>
                <div class="print-template-editor__selection">
                    <i :class="nodeIcon(selectedEntry.node?.type || 'row')" aria-hidden="true"></i>
                    <span><strong>{{ $t(selectedEntry.node ? nodeLabel(selectedEntry.node.type) : bandLabel(selectedEntry.band)) }}</strong><small data-no-i18n>{{ selectedEntry.node?.id || selectedEntry.band.id }}</small></span>
                </div>

                <fieldset v-if="!selectedNode && selectedBand?.kind === 'once'" class="print-template-editor__fieldset">
                    <legend>{{ $t('Layout') }}</legend>
                    <p class="print-template-editor__hint">{{ $t(selectedBand.layout === 'absolute' ? 'Drag blocks directly on the preview. Content is clipped to this fixed section.' : 'Blocks print from top to bottom in the Structure order.') }}</p>
                    <button type="button" class="print-template-editor__layout-button" @click="toggleBandLayout"><i class="fa-solid fa-up-down-left-right" aria-hidden="true"></i>{{ $t(selectedBand.layout === 'absolute' ? 'Use flow layout' : 'Enable visual positioning') }}</button>
                    <label v-if="selectedBand.layout === 'absolute'"><span>{{ $t('Section height') }}</span><input :value="selectedBand.height" min="40" max="1200" step="4" type="number" inputmode="numeric" @change="setBandHeight($event.target.value)"></label>
                </fieldset>
                <fieldset v-if="canEnableSelectedPositioning" class="print-template-editor__fieldset">
                    <legend>{{ $t('Position') }}</legend>
                    <p class="print-template-editor__hint">{{ $t('This section currently follows the vertical content order. Enable positioning to move this element left, right, up, or down.') }}</p>
                    <button type="button" class="print-template-editor__layout-button" @click="toggleBandLayout"><i class="fa-solid fa-up-down-left-right" aria-hidden="true"></i>{{ $t('Enable X & Y positioning') }}</button>
                </fieldset>
                <fieldset v-if="adjacentPlacement" class="print-template-editor__fieldset">
                    <legend>{{ $t('Columns') }}</legend>
                    <p class="print-template-editor__hint">{{ $t('Tighten this element and its adjacent content into one row. Each column can then be resized and positioned independently.') }}</p>
                    <button type="button" class="print-template-editor__layout-button" @click="placeAdjacentItemBeside"><i class="fa-solid fa-table-columns" aria-hidden="true"></i>{{ $t(adjacentPlacement.direction === 'next' ? 'Place next item beside this' : 'Place previous item beside this') }}</button>
                </fieldset>
                <fieldset v-if="selectedNode?.type === 'row'" class="print-template-editor__fieldset">
                    <legend>{{ $t('Columns') }}</legend>
                    <p class="print-template-editor__hint">{{ $t(selectedNode.layout === 'absolute' ? 'Drag each column left, right, up, or down directly on the preview.' : 'Turn on free column positioning to arrange this row like a report designer.') }}</p>
                    <button type="button" class="print-template-editor__layout-button" @click="toggleRowLayout"><i class="fa-solid fa-table-columns" aria-hidden="true"></i>{{ $t(selectedNode.layout === 'absolute' ? 'Use proportional columns' : 'Position columns freely') }}</button>
                    <label v-if="selectedNode.layout === 'absolute'"><span>{{ $t('Row height') }}</span><input :value="selectedNode.height" min="40" max="1200" step="4" type="number" inputmode="numeric" @change="setRowHeight($event.target.value)"></label>
                </fieldset>
                <template v-if="selectedNode?.type === 'text'">
                    <label><span>{{ $t('English text') }}</span><input v-model="selectedNode.text.en" type="text" maxlength="500" @input="sync"></label>
                    <label><span>{{ $t('Arabic text') }}</span><input v-model="selectedNode.text.ar" type="text" dir="rtl" maxlength="500" @input="sync"></label>
                    <label><span>{{ $t('Display mode') }}</span><select v-model="selectedNode.text.mode" @change="sync"><option value="auto">{{ $t('Auto') }}</option><option value="both">{{ $t('Both') }}</option></select></label>
                </template>
                <template v-if="selectedNode?.type === 'field'">
                    <label><span>{{ $t('Field') }}</span><select v-model="selectedNode.path" @change="sync"><option v-for="field in catalogFields" :key="field.path" :value="field.path">{{ $t(fieldLabel(field.path)) }} · {{ field.path }}</option></select></label>
                    <template v-if="selectedNode.path !== 'meta.ticketTypeLabel'">
                        <label><span>{{ $t('English label') }}</span><input v-model="selectedNode.label.en" type="text" maxlength="500" @input="sync"></label>
                        <label><span>{{ $t('Arabic label') }}</span><input v-model="selectedNode.label.ar" type="text" dir="rtl" maxlength="500" @input="sync"></label>
                        <label><span>{{ $t('Label mode') }}</span><select v-model="selectedNode.label.mode" @change="sync"><option value="auto">{{ $t('Auto') }}</option><option value="both">{{ $t('Both') }}</option></select></label>
                    </template>
                    <label><span>{{ $t('Label layout') }}</span><select :value="styleValue('labelLayout')" @change="setStyle('labelLayout', $event.target.value)"><option value="">{{ $t('Default') }}</option><option v-for="value in styleTokens.labelLayout || []" :key="value" :value="value">{{ $t(value) }}</option></select></label>
                    <label><span>{{ $t('Value format') }}</span><select :value="selectedNode.format || ''" @change="setFieldFormat($event.target.value)"><option value="">{{ $t('Plain') }}</option><option v-for="value in FIELD_FORMATS" :key="value" :value="value">{{ $t(value) }}</option></select></label>
                </template>
                <fieldset v-if="selectedNode?.type === 'field' && selectedNode.path === 'meta.ticketTypeLabel'" class="print-template-editor__fieldset">
                    <legend>{{ $t('Ticket headings') }}</legend>
                    <template v-for="type in KITCHEN_HEADING_TYPES" :key="type">
                        <p class="print-template-editor__variant-title">{{ $t(headingTypeLabel(type)) }}</p>
                        <label><span>{{ $t('English text') }}</span><input :aria-label="$t(`${headingTypeLabel(type)} English`)" :value="headingVariant(type).en" type="text" maxlength="500" @input="setHeadingVariant(type, 'en', $event.target.value)"></label>
                        <label><span>{{ $t('Arabic text') }}</span><input :aria-label="$t(`${headingTypeLabel(type)} Arabic`)" :value="headingVariant(type).ar" type="text" dir="rtl" maxlength="500" @input="setHeadingVariant(type, 'ar', $event.target.value)"></label>
                        <label><span>{{ $t('Display mode') }}</span><select :aria-label="$t(`${headingTypeLabel(type)} display mode`)" :value="headingVariant(type).mode" @change="setHeadingVariant(type, 'mode', $event.target.value)"><option value="auto">{{ $t('Auto') }}</option><option value="both">{{ $t('Both') }}</option></select></label>
                    </template>
                </fieldset>
                <fieldset v-if="selectedNode?.type === 'field'" class="print-template-editor__fieldset">
                    <legend>{{ $t('Label and value') }}</legend>
                    <template v-for="part in FIELD_PARTS" :key="part">
                        <label v-for="key in INLINE_STYLE_KEYS" :key="`${part}-${key}`"><span>{{ $t(`${part === 'labelStyle' ? 'Label' : 'Value'} ${inlineStyleLabel(key)}`) }}</span><select :value="inlineStyleValue(part, key)" @change="setInlineStyle(part, key, $event.target.value)"><option value="">{{ $t('Inherit') }}</option><option v-for="value in styleTokens[key] || []" :key="value" :value="value">{{ $t(String(value)) }}</option></select></label>
                    </template>
                </fieldset>
                <template v-if="selectedNode?.type === 'divider'"><label><span>{{ $t('Divider style') }}</span><select v-model="selectedNode.variant" @change="sync"><option v-for="variant in DIVIDER_VARIANTS" :key="variant" :value="variant">{{ $t(variant) }}</option></select></label></template>
                <template v-if="selectedNode?.type === 'spacer'"><label><span>{{ $t('Space') }}</span><select :value="selectedNode.size" @change="setNodeNumber('size', $event.target.value)"><option v-for="size in SPACER_SIZES" :key="size" :value="size">{{ size }}px</option></select></label></template>
                <template v-if="selectedNode?.type === 'jofotara_qr'">
                    <label><span>{{ $t('QR size') }}</span><select :value="selectedNode.size <= 160 ? 556 : selectedNode.size" @change="setNodeNumber('size', $event.target.value)"><option v-for="size in QR_SIZES" :key="size" :value="size">{{ size === 556 ? $t('Full printable width') : size + 'px' }}</option></select></label>
                    <p class="print-template-editor__hint">{{ $t('Printed centered below the receipt, with a clear white border.') }}</p>
                </template>
                <template v-if="selectedNode?.type === 'store_logo'"><p class="print-template-editor__hint">{{ $t('Uses the Store Brand Icon from Settings.') }} <a href="/admin/settings">{{ $t('Settings') }}</a></p><label><span>{{ $t('Logo size') }}</span><select :value="selectedNode.size" @change="setNodeNumber('size', $event.target.value)"><option v-for="size in [64, 96, 128]" :key="size" :value="size">{{ size }}px</option></select></label></template>
                <fieldset v-if="canPositionSelected" class="print-template-editor__fieldset print-template-editor__position-grid"><legend>{{ $t('Position') }}</legend>
                    <label v-for="key in POSITION_KEYS" :key="key"><span>{{ $t(positionLabel(key)) }}</span><input :value="selectedNode[key]" min="0" step="4" type="number" inputmode="numeric" @change="setPosition(key, $event.target.value)"></label>
                </fieldset>
                <fieldset v-if="supportsStyle" class="print-template-editor__fieldset"><legend>{{ $t('Style') }}</legend>
                    <label v-for="key in STYLE_KEYS" :key="key"><span>{{ $t(styleLabel(key)) }}</span><select :value="styleValue(key)" @change="setStyle(key, $event.target.value)"><option value="">{{ $t('Default') }}</option><option v-for="value in styleTokens[key] || []" :key="value" :value="value">{{ $t(String(value)) }}</option></select></label>
                </fieldset>
                <fieldset v-if="selectedNode" class="print-template-editor__fieldset"><legend>{{ $t('Visibility') }}</legend>
                    <label class="print-template-editor__check"><input type="checkbox" :checked="Boolean(selectedNode.hidden)" @change="toggleHidden($event.target.checked)"><span>{{ $t('Always hide this element') }}</span></label>
                    <label class="print-template-editor__check"><input type="checkbox" :checked="Boolean(selectedNode.visibleWhen)" @change="toggleVisibility($event.target.checked)"><span>{{ $t('Show only when') }}</span></label>
                    <template v-if="selectedNode.visibleWhen">
                        <label><span>{{ $t('Field') }}</span><select v-model="selectedNode.visibleWhen.path" @change="resetVisibilityValue"><option v-for="field in catalogFields" :key="field.path" :value="field.path">{{ $t(fieldLabel(field.path)) }} · {{ field.path }}</option></select></label>
                        <label><span>{{ $t('Condition') }}</span><select v-model="selectedNode.visibleWhen.op" @change="resetVisibilityValue"><option v-for="operator in conditionOperators" :key="operator" :value="operator">{{ operator }}</option></select></label>
                        <label v-if="!['truthy', 'falsy'].includes(selectedNode.visibleWhen.op)"><span>{{ $t('Value') }}</span><input v-if="conditionField?.type === 'text'" v-model="selectedNode.visibleWhen.value" type="text" maxlength="500" @input="sync"><input v-else-if="['number', 'money'].includes(conditionField?.type)" v-model.number="selectedNode.visibleWhen.value" type="number" step="any" @input="sync"><select v-else v-model="selectedNode.visibleWhen.value" @change="sync"><option :value="true">{{ $t('True') }}</option><option :value="false">{{ $t('False') }}</option></select></label>
                    </template>
                </fieldset>
                <div class="print-template-editor__reset"><button type="button" @click="resetDraft(activeDefinition, 'active')">{{ $t('Reset draft to active') }}</button><button type="button" @click="resetDraft(builtinDefinition, 'built-in')">{{ $t('Reset draft to built-in') }}</button></div>
            </form>
        </template>
    </section>
</template>

<script setup>
import { computed, ref, toRaw, watch } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import PrintTemplateStructureNodes from '@/admin/components/PrintTemplateStructureNodes.vue';
import { t } from '@/shared/i18n.js';

const NODE_TYPES = ['text', 'field', 'row', 'divider', 'spacer', 'jofotara_qr', 'store_logo'];
const STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'align', 'direction', 'width', 'marginTop', 'marginBottom', 'marginInlineStart', 'padding', 'treatment', 'textTransform', 'letterSpacing', 'lineHeight', 'opacity'];
const INLINE_STYLE_KEYS = ['fontWeight', 'textTransform', 'letterSpacing'];
const FIELD_PARTS = ['labelStyle', 'valueStyle'];
const FIELD_FORMATS = ['brackets', 'modifier', 'list'];
const KITCHEN_HEADING_TYPES = ['normal', 'void', 'follow_up', 'cancel'];
const DIVIDER_VARIANTS = ['dashed', 'solid'];
const SPACER_SIZES = [4, 8, 12, 16, 24];
const QR_SIZES = [384, 448, 512, 556];
const POSITION_KEYS = ['x', 'y', 'widthPx', 'heightPx'];
const COLUMN_NODE_TYPES = new Set(['text', 'field', 'jofotara_qr', 'store_logo']);
const props = defineProps({
    definition: { type: Object, required: true }, catalog: { type: Object, required: true },
    activeDefinition: { type: Object, default: null }, builtinDefinition: { type: Object, default: null },
    selectedId: { type: String, default: '' }, mode: { type: String, default: 'structure' }
});
const emit = defineEmits(['update:definition', 'update:selected-id', 'request-properties']);
const draft = ref({ bands: [] });
const localSelectedId = ref('');
const positionMemory = new Map();
const heightMemory = new Map();
const styleTokens = computed(() => props.catalog?.styleTokens || {});
const currentSelectedId = computed(() => props.selectedId || localSelectedId.value);
const availableNodeTypes = computed(() => NODE_TYPES.filter(type => draft.value.docType === 'receipt' || type !== 'jofotara_qr'));
const selectedEntry = computed(() => findEntry(currentSelectedId.value));
const selectedNode = computed(() => selectedEntry.value?.node || null);
const selectedBand = computed(() => selectedEntry.value?.band || null);
const targetBand = computed(() => draft.value.bands.find(band => band.id === currentSelectedId.value) || selectedEntry.value?.band || draft.value.bands[0] || null);
const hasQr = computed(() => draft.value.bands.some(band => entriesForBand(band).some(entry => entry.node.type === 'jofotara_qr')));
const catalogFields = computed(() => fieldsForBand(selectedBand.value));
const conditionField = computed(() => catalogFields.value.find(field => field.path === selectedNode.value?.visibleWhen?.path) || null);
const conditionOperators = computed(() => {
    const type = conditionField.value?.type;
    return (props.catalog?.conditionOperations || []).filter(operator => !['gt', 'gte', 'lt', 'lte'].includes(operator) || ['number', 'money'].includes(type));
});
const supportsStyle = computed(() => Boolean(selectedNode.value?.style) && selectedNode.value?.type !== 'jofotara_qr');
const positionedContainer = computed(() => {
    if (!selectedNode.value) return null;
    if (selectedEntry.value?.depth === 0 && selectedBand.value?.layout === 'absolute') return { width: 576, height: selectedBand.value.height };
    if (selectedEntry.value?.parentNode?.type === 'row' && selectedEntry.value.parentNode.layout === 'absolute') return { width: 556, height: selectedEntry.value.parentNode.height };
    return null;
});
const canPositionSelected = computed(() => Boolean(positionedContainer.value));
const canEnableSelectedPositioning = computed(() => Boolean(selectedNode.value && selectedEntry.value?.depth === 0 && selectedBand.value?.kind === 'once' && selectedBand.value.layout !== 'absolute'));
const adjacentPlacement = computed(() => {
    const entry = selectedEntry.value;
    if (!entry?.node || entry.depth !== 0 || entry.band.layout === 'absolute' || !COLUMN_NODE_TYPES.has(entry.node.type)) return null;
    const next = entry.siblings[entry.index + 1];
    if (COLUMN_NODE_TYPES.has(next?.type)) return { direction: 'next', node: next };
    const previous = entry.siblings[entry.index - 1];
    return COLUMN_NODE_TYPES.has(previous?.type) ? { direction: 'previous', node: previous } : null;
});

watch(() => props.definition, definition => {
    if (JSON.stringify(toRaw(definition)) === JSON.stringify(toRaw(draft.value))) return;
    positionMemory.clear();
    heightMemory.clear();
    draft.value = structuredClone(toRaw(props.definition));
    if (!findEntry(currentSelectedId.value)) selectBand(draft.value.bands[0] || { id: '' });
}, { immediate: true });

function id() { return crypto.randomUUID(); }
function bilingual(en = '', ar = '') { return { en, ar, mode: 'auto' }; }
function nodeLabel(type) { return ({ text: 'Text', field: 'Field', row: 'Row', divider: 'Divider', spacer: 'Spacer', jofotara_qr: 'JoFotara QR', store_logo: 'Store logo' })[type] || type; }
function bandLabel(band) { return ({ header: 'Header', meta: 'Order details', items: 'Items', rows: 'Items', summary: 'Totals', payment: 'Payment', footer: 'Footer' })[band?.id] || (band?.kind === 'repeat' ? 'Items' : 'Section'); }
function fieldLabel(path) { const value = String(path || '').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2'); return value.charAt(0).toUpperCase() + value.slice(1); }
function positionLabel(key) { return ({ x: 'X', y: 'Y', widthPx: 'Width', heightPx: 'Height' })[key]; }
function nodeIcon(type) { return ({ text: 'fa-solid fa-font', field: 'fa-solid fa-list', row: 'fa-solid fa-table-columns', divider: 'fa-solid fa-minus', spacer: 'fa-solid fa-arrows-up-down', jofotara_qr: 'fa-solid fa-qrcode', store_logo: 'fa-solid fa-image' })[type] || 'fa-solid fa-layer-group'; }
function nodeSummary(node) { return node.type === 'field' ? node.path : node.type === 'text' ? node.text.en || node.text.ar || 'Text' : node.id; }
function styleLabel(key) { return ({ fontFamily: 'Font family', fontSize: 'Font size', fontWeight: 'Font weight', fontStyle: 'Font style', align: 'Alignment', direction: 'Direction', width: 'Width', marginTop: 'Top margin', marginBottom: 'Bottom margin', marginInlineStart: 'Start indent', padding: 'Padding', treatment: 'Thermal treatment', textTransform: 'Text case', letterSpacing: 'Letter spacing', lineHeight: 'Line height', opacity: 'Opacity' })[key]; }
function inlineStyleLabel(key) { return ({ fontWeight: 'weight', textTransform: 'case', letterSpacing: 'tracking' })[key]; }
function headingTypeLabel(type) { return ({ normal: 'Normal kitchen ticket', void: 'Void kitchen ticket', follow_up: 'Follow-up kitchen ticket', cancel: 'Order cancellation ticket' })[type]; }
function fieldsForBand(band) { const scope = band?.kind === 'repeat' ? band.source : 'document'; return (props.catalog?.fields || []).filter(field => field.scope === scope); }
function entriesForBand(band) { const entries = []; const visit = (nodes, depth = 0, parentId = band.id, parentNode = null) => nodes.forEach((node, index) => { entries.push({ node, siblings: nodes, index, depth, band, parentId, parentNode }); if (node.type === 'row') visit(node.nodes, depth + 1, node.id, node); }); visit(band.nodes); return entries; }
function findEntry(selectedId) { for (const band of draft.value.bands) { if (band.id === selectedId) return { band }; const entry = entriesForBand(band).find(item => item.node.id === selectedId); if (entry) return entry; } return null; }
function sync() { emit('update:definition', structuredClone(toRaw(draft.value))); }
function selectBand(band) { localSelectedId.value = band.id; emit('update:selected-id', band.id); }
function selectNode(node) { localSelectedId.value = node.id; emit('update:selected-id', node.id); }
function move(list, index, offset) { const next = index + offset; if (next < 0 || next >= list.length) return; [list[index], list[next]] = [list[next], list[index]]; sync(); }
function moveBand(index, offset) { move(draft.value.bands, index, offset); }
function moveNode(entry, offset) { move(entry.siblings, entry.index, offset); }
function entryById(nodeId) { for (const band of draft.value.bands) { const entry = entriesForBand(band).find(item => item.node.id === nodeId); if (entry) return entry; } return null; }
function bandForNodeId(nodeId) { return entryById(nodeId)?.band || null; }
function selectNodeById(nodeId) { const entry = entryById(nodeId); if (entry) selectNode(entry.node, entry.band); }
function moveNodeById(nodeId, offset) { const entry = entryById(nodeId); if (entry) moveNode(entry, offset); }
function duplicateNodeById(nodeId) { const entry = entryById(nodeId); if (entry) duplicateNode(entry); }
function deleteNodeById(nodeId) { const entry = entryById(nodeId); if (entry) deleteNode(entry); }
function sameIds(left, right) { return JSON.stringify(left.map(item => item?.id).sort()) === JSON.stringify(right.map(item => item?.id).sort()); }
function finishBandDrag(event) {
    if (event.from !== event.to) return;
    const from = event.oldDraggableIndex ?? event.oldIndex;
    const to = event.newDraggableIndex ?? event.newIndex;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
    const next = [...draft.value.bands];
    const [band] = next.splice(from, 1);
    next.splice(to, 0, band);
    draft.value.bands = next;
    sync();
}
function replaceNodes(parentId, nextNodes) {
    const band = draft.value.bands.find(item => item.id === parentId);
    const container = band || entryById(parentId)?.node;
    if (!container || (container.type && container.type !== 'row')) return;
    if (!sameIds(container.nodes || [], nextNodes || [])) return;
    container.nodes = structuredClone(toRaw(nextNodes));
    sync();
}
function insertLibraryNode(parentId, index, type) {
    const band = draft.value.bands.find(item => item.id === parentId);
    const container = band || entryById(parentId)?.node;
    const owner = band || bandForNodeId(parentId);
    if (container && owner) addNode(type, { container, band: owner }, index);
}
function isOnlyBandNode(entry) { return entry.depth === 0 && entry.siblings.length <= 1; }
function cloneNode(node) { const copy = structuredClone(toRaw(node)); const renew = item => { item.id = id(); item.nodes?.forEach(renew); }; renew(copy); return copy; }
function duplicateBand(index) { const band = draft.value.bands[index]; const copy = structuredClone(toRaw(band)); copy.id = id(); copy.nodes = copy.nodes.map(cloneNode); draft.value.bands.splice(index + 1, 0, copy); selectBand(copy); sync(); }
function duplicateNode(entry) { if (entry.node.type === 'jofotara_qr' && hasQr.value) return; const copy = cloneNode(entry.node); entry.siblings.splice(entry.index + 1, 0, copy); selectNode(copy); sync(); }
function deleteBand(index) { const band = draft.value.bands[index]; draft.value.bands.splice(index, 1); selectBand(draft.value.bands[Math.max(0, index - 1)] || { id: '' }); sync(); }
function deleteNode(entry) { if (isOnlyBandNode(entry)) return; entry.siblings.splice(entry.index, 1); selectBand(entry.band); sync(); }
function canAddToBand(type, band) { if (!band) return false; if (type === 'jofotara_qr') return draft.value.docType === 'receipt' && band.kind === 'once' && !hasQr.value; if (type === 'store_logo') return band.kind === 'once'; if (type === 'field') return fieldsForBand(band).length > 0; return true; }
function canOfferType(type) { return draft.value.bands.some(band => canAddToBand(type, band)); }
function makeNode(type, band) {
    const fields = fieldsForBand(band);
    return {
        text: { id: id(), type: 'text', text: bilingual('Text'), style: {} },
        field: { id: id(), type: 'field', path: fields[0]?.path || '', label: bilingual(), style: {} },
        row: { id: id(), type: 'row', nodes: [], style: {} }, divider: { id: id(), type: 'divider', variant: 'dashed', style: {} },
        spacer: { id: id(), type: 'spacer', size: 8 }, jofotara_qr: { id: id(), type: 'jofotara_qr', size: 556, style: {} }, store_logo: { id: id(), type: 'store_logo', size: 64, style: {} }
    }[type];
}
function targetFor(entry = selectedEntry.value) {
    return entry?.node?.type === 'row'
        ? { container: entry.node, band: entry.band }
        : { container: entry?.band || targetBand.value, band: entry?.band || targetBand.value };
}
function columnPosition(row) {
    const ordered = [...row.nodes].filter(node => Number.isInteger(node.x) && Number.isInteger(node.widthPx)).sort((a, b) => a.x - b.x);
    for (let index = 0; index <= ordered.length; index += 1) {
        const start = index ? ordered[index - 1].x + ordered[index - 1].widthPx : 0;
        const end = ordered[index]?.x ?? 556;
        if (end - start >= 16) return { x: start, y: 0, widthPx: end - start, heightPx: Math.max(4, row.height - 4) };
    }
    const widest = ordered.reduce((best, node) => !best || node.widthPx > best.widthPx ? node : best, null);
    if (!widest || widest.widthPx < 32) return null;
    // Split into a snapped left side and its exact remainder. Rounding both
    // sides independently leaves a 4px overlap for widths such as 356px,
    // which also removes the divider needed to repair the row.
    const keep = Math.floor((widest.widthPx / 2) / 4) * 4;
    const widthPx = widest.widthPx - keep;
    const x = widest.x + keep;
    widest.widthPx = keep;
    return { x, y: widest.y, widthPx, heightPx: widest.heightPx };
}
function addNode(type, target = targetFor(), index = target?.container?.nodes?.length) {
    const { container, band } = target || {};
    if (!container || !band || !canAddToBand(type, band)) return;
    const node = makeNode(type, band);
    if (container.layout === 'absolute') {
        const position = container.type === 'row' ? columnPosition(container) : defaultPosition(container, node);
        if (!position) { window.showAdminToast?.(t('No room remains in this row. Resize or remove a column first.'), 'error'); return; }
        Object.assign(node, position);
    }
    container.nodes.splice(index, 0, node); selectNode(node); sync(); emit('request-properties');
}
function addNodeFromPalette(type) {
    const target = targetFor();
    if (canAddToBand(type, target.band)) return addNode(type, target);
    // Validate and insert into the same compatible band. A library item must
    // not be admitted by a once-only band then spliced into the selected repeat band.
    const band = draft.value.bands.find(item => canAddToBand(type, item));
    if (band) addNode(type, { container: band, band });
}
function nodeBox(node) { const square = ['jofotara_qr', 'store_logo'].includes(node.type) ? node.size : null; if (square) return { widthPx: square, heightPx: square }; return { widthPx: ['divider', 'spacer', 'row'].includes(node.type) ? 560 : 272, heightPx: node.type === 'row' ? node.height || 40 : 32 }; }
function defaultPosition(band, node) { const box = nodeBox(node); return { x: box.widthPx === 560 ? 8 : Math.floor((576 - box.widthPx) / 8) * 4, y: Math.min(Math.max(8, band.height - box.heightPx), band.nodes.reduce((sum, item) => sum + nodeBox(item).heightPx + 8, 8)), ...box }; }
function dropPositions(nodes) {
    nodes.forEach(node => {
        if (POSITION_KEYS.every(key => Number.isInteger(node[key]))) positionMemory.set(node.id, Object.fromEntries(POSITION_KEYS.map(key => [key, node[key]])));
        POSITION_KEYS.forEach(key => delete node[key]);
    });
}
function restorePositions(container, node, fallback) {
    return positionMemory.get(node.id) || fallback || (container.type === 'row' ? columnPosition(container) : defaultPosition(container, node));
}
function toggleBandLayout() {
    const band = selectedBand.value;
    if (!band || band.kind !== 'once') return;
    if (band.layout === 'absolute') {
        dropPositions(band.nodes); heightMemory.set(`band:${band.id}`, band.height); band.layout = 'flow'; delete band.height;
    } else {
        const requiredHeight = band.nodes.reduce((sum, node) => sum + nodeBox(node).heightPx + 8, 8);
        band.layout = 'absolute'; band.height = heightMemory.get(`band:${band.id}`) || Math.max(40, Math.min(1200, Math.ceil(requiredHeight / 4) * 4));
        let y = 8;
        band.nodes.forEach(node => {
            const box = nodeBox(node);
            const fallback = { x: box.widthPx === 560 ? 8 : Math.floor((576 - box.widthPx) / 8) * 4, y: Math.min(Math.max(0, band.height - box.heightPx), y), ...box };
            Object.assign(node, restorePositions(band, node, fallback));
            y += box.heightPx + 8;
        });
    }
    sync();
}
function setBandHeight(value) { if (!selectedBand.value) return; selectedBand.value.height = Number(value); sync(); }
function placeAdjacentItemBeside() {
    const entry = selectedEntry.value; const placement = adjacentPlacement.value;
    if (!entry?.node || !placement) return;
    const start = placement.direction === 'next' ? entry.index : entry.index - 1;
    const pair = entry.siblings.slice(start, start + 2);
    const rowHeight = Math.max(40, Math.ceil((Math.max(...pair.map(node => nodeBox(node).heightPx)) + 4) / 4) * 4);
    const firstWidth = Math.floor((540 / 2) / 4) * 4;
    const row = { id: id(), type: 'row', layout: 'absolute', height: rowHeight, style: {}, nodes: pair.map((node, index) => {
        const copy = structuredClone(toRaw(node));
        return {
            ...copy, x: index === 0 ? 8 : 8 + firstWidth, y: 4,
            widthPx: index === 0 ? firstWidth : 540 - firstWidth, heightPx: rowHeight - 8
        };
    }) };
    entry.siblings.splice(start, 2, row); selectNode(entry.node); sync();
}
function toggleRowLayout() {
    const row = selectedNode.value;
    if (row?.type !== 'row') return;
    if (row.layout === 'absolute') {
        dropPositions(row.nodes); heightMemory.set(`row:${row.id}`, row.height); row.layout = 'flow'; delete row.height;
    } else {
        row.layout = 'absolute'; row.height = heightMemory.get(`row:${row.id}`) || 40;
        const proportional = promotedColumnFallbacks(row.nodes, Math.max(4, row.height - 4), positionMemory);
        // Remembered (or proportional) columns first, so a column added meanwhile
        // is placed around them instead of on top of a later restored one.
        const unplaced = [];
        row.nodes.forEach((node, index) => {
            const known = positionMemory.get(node.id) || proportional?.[index];
            if (known) Object.assign(node, known); else unplaced.push(node);
        });
        unplaced.forEach(node => Object.assign(node, restorePositions(row, node)));
    }
    sync();
}
function setRowHeight(value) { if (selectedNode.value?.type !== 'row') return; selectedNode.value.height = Number(value); sync(); }
function setPosition(key, value) { if (!canPositionSelected.value) return; selectedNode.value[key] = Number(value); sync(); }
function styleValue(key) { return selectedNode.value?.style?.[key] ?? ''; }
function numericStyle(key, value) { return ['width', 'marginTop', 'marginBottom', 'marginInlineStart', 'padding', 'letterSpacing', 'lineHeight', 'opacity'].includes(key) ? Number(value) : value; }
function setStyle(key, value) { if (!selectedNode.value?.style) return; if (value === '') delete selectedNode.value.style[key]; else selectedNode.value.style[key] = numericStyle(key, value); sync(); }
function inlineStyleValue(part, key) { return selectedNode.value?.[part]?.[key] ?? ''; }
function setInlineStyle(part, key, value) { if (selectedNode.value?.type !== 'field') return; if (value === '') { if (selectedNode.value[part]) { delete selectedNode.value[part][key]; if (!Object.keys(selectedNode.value[part]).length) delete selectedNode.value[part]; } } else { selectedNode.value[part] ||= {}; selectedNode.value[part][key] = numericStyle(key, value); } sync(); }
function setFieldFormat(value) { if (selectedNode.value?.type !== 'field') return; if (value) selectedNode.value.format = value; else delete selectedNode.value.format; sync(); }
function builtinHeadingVariants() { for (const band of props.builtinDefinition?.bands || []) { const heading = entriesForBand(band).find(entry => entry.node.path === 'meta.ticketTypeLabel')?.node; if (heading) return heading.variants || {}; } return {}; }
function headingVariant(type) { return selectedNode.value?.variants?.[type] || builtinHeadingVariants()[type] || bilingual(); }
function setHeadingVariant(type, key, value) {
  if (selectedNode.value?.path !== 'meta.ticketTypeLabel') return;
  const variants = selectedNode.value.variants ||= {};
  variants[type] ||= structuredClone(headingVariant(type));
  variants[type][key] = value;
  if (!variants[type].en.trim() && !variants[type].ar.trim()) delete variants[type];
  sync();
}
function setNodeNumber(key, value) { if (!selectedNode.value) return; selectedNode.value[key] = Number(value); sync(); }
function toggleVisibility(enabled) { if (!selectedNode.value) return; if (!enabled) selectedNode.value.visibleWhen = null; else { const field = catalogFields.value[0]; if (!field) return; selectedNode.value.visibleWhen = { path: field.path, op: ['number', 'money'].includes(field.type) ? 'gt' : field.type === 'boolean' ? 'eq' : 'truthy', value: ['number', 'money'].includes(field.type) ? 0 : field.type === 'boolean' ? true : null }; } sync(); }
function toggleHidden(hidden) { if (!selectedNode.value) return; if (hidden) selectedNode.value.hidden = true; else delete selectedNode.value.hidden; sync(); }
function resetVisibilityValue() { const field = conditionField.value; if (!selectedNode.value?.visibleWhen || !field) return; const op = selectedNode.value.visibleWhen.op; selectedNode.value.visibleWhen.value = ['truthy', 'falsy'].includes(op) ? null : ['number', 'money'].includes(field.type) ? 0 : field.type === 'boolean' ? true : ''; sync(); }
async function resetDraft(definition, target) { if (!definition) return; const confirmed = await window.showAdminConfirm?.(t(target === 'active' ? 'Reset this local draft to the active template?' : 'Reset this local draft to the built-in template?'), t('Reset draft')); if (!confirmed) return; positionMemory.clear(); heightMemory.clear(); draft.value = structuredClone(toRaw(definition)); selectBand(draft.value.bands[0] || { id: '' }); sync(); }
</script>

<script>
// Promote a flow row's proportional columns to free positions without losing
// their widths: lay them out left to right at their percentage widths, snapped
// to the editor's 4px grid, with the last column absorbing only the rounding.
// Only a row whose every column has a width and whose widths add up to 100%
// (the built-in rows) qualifies; anything else returns null and keeps the
// editor's usual column placement.
export function proportionalColumns(nodes, heightPx, rowWidth = 556, step = 4) {
    const percents = nodes.map(node => Number(node?.style?.width));
    if (!nodes.length || percents.some(value => !(value > 0))) return null;
    if (Math.abs(percents.reduce((sum, value) => sum + value, 0) - 100) > 0.5) return null;
    let x = 0;
    return nodes.map((node, index) => {
        const last = index === nodes.length - 1;
        const wanted = Math.round((rowWidth * percents[index] / 100) / step) * step;
        const widthPx = last ? rowWidth - x : Math.min(Math.max(16, wanted), rowWidth - x - 16 * (nodes.length - 1 - index));
        const position = { x, y: 0, widthPx, heightPx };
        x += widthPx;
        return position;
    });
}

// Proportional positions apply only to a row none of whose children has a
// remembered position; otherwise remembered columns come back and the rest are
// placed around them by the editor's column fallback.
export function promotedColumnFallbacks(nodes, heightPx, memory) {
    if (nodes.some(node => memory?.has(node.id))) return null;
    return proportionalColumns(nodes, heightPx);
}
</script>

<style scoped>
.print-template-editor { min-width: 0; color: #18181b; }
.print-template-editor__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid #e4e4e7; }
.print-template-editor__header h3 { margin: 0; font-size: 15px; font-weight: 800; line-height: 1.35; }
.print-template-editor__header p { margin: 4px 0 0; color: #62626b; font-size: 12px; line-height: 1.5; }
.print-template-editor__status { display: inline-flex; align-items: center; gap: 6px; flex: none; color: #24405e; font-size: 11px; font-weight: 750; }
.print-template-editor__status > span { width: 7px; height: 7px; border-radius: 50%; background: #3a5c85; }
.print-template-editor__library { padding: 14px 16px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.print-template-editor__library > p { margin: 0 0 8px; color: #52525b; font-size: 11px; font-weight: 750; }
.print-template-editor__library > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.print-template-editor__add { min-width: 0; min-height: 45px; display: grid; grid-template-columns: 18px minmax(0, 1fr) 12px; align-items: center; gap: 7px; border: 1px solid #d4d4d8; border-radius: 7px; background: #fff; color: #27272a; padding: 7px 9px; font-size: 11px; font-weight: 750; text-align: start; cursor: grab; transition: border-color 140ms ease, background 140ms ease; }
.print-template-editor__add:hover { border-color: #8fa6c4; background: #eef2f7; }.print-template-editor__add:disabled { cursor: not-allowed; opacity: .42; }.print-template-editor__add > i:last-child { color: #24405e; font-size: 9px; }
.print-template-editor__tree { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.print-template-editor__band { border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; transition: border-color 140ms ease, background 140ms ease; }
.print-template-editor__band.is-selected { border-color: #8fa6c4; }
.print-template-editor__band-row { min-width: 0; min-height: 52px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 44px; align-items: stretch; gap: 4px; padding: 4px; background: #f4f4f5; border-radius: 7px 7px 0 0; }
.print-template-editor__band-drag, .print-template-editor__band-select, .print-template-editor__band-menu summary, .print-template-editor__band-menu button { min-width: 45px; min-height: 45px; border: 0; background: transparent; }
.print-template-editor__band-drag { border-radius: 6px; color: #74747e; cursor: grab; }.print-template-editor__band-drag:hover { color: #24405e; background: #eef2f7; }.print-template-editor__band-drag:active { cursor: grabbing; }
.print-template-editor__band-select { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 2px 7px; color: #27272a; padding: 5px 3px; text-align: start; }
.print-template-editor__band-select > i { grid-row: 1 / 3; width: 16px; color: #71717a; text-align: center; }.print-template-editor__band-select strong, .print-template-editor__band-select > span:not(.print-template-editor__kind) { overflow: hidden; font-size: 12px; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }.print-template-editor__band-select small { overflow: hidden; color: #71717a; font: 500 10px/1.25 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: start; }
.print-template-editor__kind { color: #71717a; font-size: 9px; font-weight: 700; }.print-template-editor__kind + strong { grid-column: 1 / -1; }
.print-template-editor__layout-tag { border-radius: 5px; background: #dce4ee; color: #1d3450; padding: 3px 6px; font-size: 9px; font-weight: 750; }
.print-template-editor__locked { flex: none; color: #71717a; font-size: 10px; }
.print-template-editor__band-menu { position: relative; }
.print-template-editor__band-menu summary { display: grid; place-items: center; border-radius: 6px; color: #71717a; cursor: pointer; list-style: none; }.print-template-editor__band-menu summary::-webkit-details-marker { display: none; }.print-template-editor__band-menu summary:hover { background: #e4e4e7; color: #18181b; }
.print-template-editor__band-menu > div { position: absolute; z-index: 30; inset-inline-end: 0; top: calc(100% + 4px); width: 150px; display: flex; flex-direction: column; gap: 2px; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; padding: 5px; box-shadow: 0 4px 8px rgb(24 24 27 / 14%); }
.print-template-editor__band-menu button { display: flex; align-items: center; gap: 8px; border-radius: 5px; color: #27272a; padding: 7px 9px; font-size: 11px; font-weight: 700; text-align: start; }.print-template-editor__band-menu button:hover { background: #f4f4f5; }.print-template-editor__band-menu button.is-danger { color: #be123c; }.print-template-editor__band-menu button:disabled { opacity: .35; }
.print-template-editor__empty { min-height: 220px; display: grid; place-items: center; align-content: center; gap: 7px; padding: 24px; color: #71717a; text-align: center; }.print-template-editor__empty i { font-size: 22px; }.print-template-editor__empty strong { color: #27272a; font-size: 13px; }.print-template-editor__empty p { max-width: 30ch; margin: 0; font-size: 12px; line-height: 1.5; }
.print-template-editor__inspector { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 18px; }
.print-template-editor__selection { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 9px; margin: 0; border-bottom: 1px solid #e4e4e7; padding-bottom: 12px; }.print-template-editor__selection > i { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 7px; background: #dce4ee; color: #24405e; }.print-template-editor__selection > span { min-width: 0; display: flex; flex-direction: column; }.print-template-editor__selection strong { font-size: 12px; }.print-template-editor__selection small { overflow: hidden; color: #71717a; font: 500 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: start; }
.print-template-editor__inspector > label, .print-template-editor__fieldset > label { display: flex; flex-direction: column; gap: 5px; color: #52525b; font-size: 11px; font-weight: 750; }
.print-template-editor input:not([type="checkbox"]), .print-template-editor select { width: 100%; min-height: 42px; border: 1px solid #d4d4d8; border-radius: 7px; background: #fff; color: #18181b; padding: 8px 10px; font-size: 12px; outline: none; }.print-template-editor input:focus, .print-template-editor select:focus { border-color: #24405e; box-shadow: 0 0 0 2px rgb(36 64 94 / 15%); }.print-template-editor input:disabled, .print-template-editor select:disabled { background: #f4f4f5; color: #71717a; }
.print-template-editor__fieldset { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; border: 0; border-top: 1px solid #e4e4e7; padding: 14px 0 0; }.print-template-editor__fieldset legend { grid-column: 1 / -1; margin-bottom: 8px; color: #27272a; font-size: 12px; font-weight: 800; }.print-template-editor__fieldset > .print-template-editor__hint, .print-template-editor__fieldset > .print-template-editor__layout-button, .print-template-editor__fieldset > .print-template-editor__check { grid-column: 1 / -1; }
.print-template-editor__hint { margin: 0; color: #62626b; font-size: 11px; line-height: 1.5; }.print-template-editor__hint a { color: #24405e; font-weight: 750; }
.print-template-editor__variant-title { grid-column: 1 / -1; margin: 4px 0 0; color: #24405e; font-size: 11px; font-weight: 800; }
.print-template-editor__layout-button { min-height: 42px; display: flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid #24405e; border-radius: 7px; background: #fff; color: #24405e; padding: 8px 10px; font-size: 11px; font-weight: 800; }.print-template-editor__layout-button:hover { background: #eef2f7; }
.print-template-editor__check { min-height: 42px; flex-direction: row !important; align-items: center; }.print-template-editor__check input { width: 17px; height: 17px; accent-color: #24405e; }
.print-template-editor__reset { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; border-top: 1px solid #e4e4e7; padding-top: 14px; }.print-template-editor__reset button { min-height: 42px; border: 1px solid #d4d4d8; border-radius: 7px; background: #fff; color: #52525b; padding: 7px; font-size: 10px; font-weight: 750; }.print-template-editor__reset button:hover { background: #f4f4f5; }
.print-template-editor button:focus-visible, .print-template-editor summary:focus-visible { outline: 2px solid rgb(36 64 94 / 40%); outline-offset: 2px; }
@media (max-width: 520px) { .print-template-editor__header { flex-direction: column; }.print-template-editor__library > div { grid-template-columns: 1fr; }.print-template-editor__fieldset { grid-template-columns: 1fr; }.print-template-editor__reset { grid-template-columns: 1fr; }.print-template-editor__add, .print-template-editor__band-row { min-height: 46px; } }
@media (hover: none) { .print-template-editor__band-drag { cursor: default; }.print-template-editor__add { cursor: pointer; } }
@media (prefers-reduced-motion: reduce) { .print-template-editor__add, .print-template-editor__band { transition: none; } }
</style>

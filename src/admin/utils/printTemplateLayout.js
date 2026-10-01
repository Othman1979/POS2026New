const GRID = 4;
const ROW_WIDTH = 556;
const ROW_MARGIN = 8;
const MIN_NODE_WIDTH = 16;
const COLUMN_TYPES = new Set(['text', 'field']);

const snap = value => Math.round(value / GRID) * GRID;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function promoteFlowNodeToRow(definition, nodeId, { rowId, widthPx, heightPx } = {}) {
    if (!definition || !nodeId || !rowId || !Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null;

    const next = structuredClone(definition);
    for (const band of next.bands || []) {
        if ((band.layout || 'flow') !== 'flow') continue;
        const index = (band.nodes || []).findIndex(node => node.id === nodeId && COLUMN_TYPES.has(node.type));
        if (index < 0) continue;

        const node = band.nodes[index];
        const { style: sourceStyle = {}, visibleWhen, hidden, ...content } = node;
        if (Number(sourceStyle.marginInlineStart || 0) !== 0) return null;

        const { marginTop, marginBottom, ...childStyle } = sourceStyle;
        const rowHeight = clamp(snap(Math.max(40, heightPx + 8)), 40, 1200);
        const childWidth = clamp(snap(widthPx), MIN_NODE_WIDTH, ROW_WIDTH - (ROW_MARGIN * 2));
        const rowStyle = {
            ...(marginTop !== undefined ? { marginTop } : {}),
            ...(marginBottom !== undefined ? { marginBottom } : {})
        };

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

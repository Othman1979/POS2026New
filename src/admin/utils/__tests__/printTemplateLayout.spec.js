import { describe, expect, it } from 'vitest';
import { promoteFlowNodeToRow } from '../printTemplateLayout.js';

function definition(node = {}) {
    return {
        bands: [{ id: 'header', layout: 'flow', nodes: [{
            id: 'store-name', type: 'field', path: 'store.name',
            label: { en: 'Store', ar: 'المتجر', mode: 'auto' },
            style: { fontWeight: 700, marginTop: 8, marginBottom: 4 },
            visibleWhen: { path: 'store.name', op: 'truthy', value: null },
            ...node
        }] }]
    };
}

describe('promoteFlowNodeToRow', () => {
    it('turns an eligible direct flow field into one snapped absolute row without mutating input', () => {
        const input = definition();
        const before = JSON.stringify(input);
        const result = promoteFlowNodeToRow(input, 'store-name', { rowId: 'row-1', widthPx: 244, heightPx: 31 });
        expect(JSON.stringify(input)).toBe(before);
        expect(result?.definition.bands[0].nodes).toEqual([expect.objectContaining({
            id: 'row-1', type: 'row', layout: 'absolute', height: 40,
            style: { marginTop: 8, marginBottom: 4 }, visibleWhen: input.bands[0].nodes[0].visibleWhen
        })]);
        expect(result?.definition.bands[0].nodes[0].nodes[0]).toEqual(expect.objectContaining({
            id: 'store-name', path: 'store.name', x: 8, y: 4, widthPx: 244, heightPx: 32,
            style: { fontWeight: 700 }
        }));
    });

    it('clamps unsafe dimensions on the grid and rejects ineligible flow nodes without mutation', () => {
        const input = definition();
        const result = promoteFlowNodeToRow(input, 'store-name', { rowId: 'row-1', widthPx: 9999, heightPx: 9999 });
        expect(result?.definition.bands[0].nodes[0]).toEqual(expect.objectContaining({ height: 1200 }));
        expect(result?.definition.bands[0].nodes[0].nodes[0]).toEqual(expect.objectContaining({ widthPx: 540, heightPx: 1192 }));
        expect(promoteFlowNodeToRow(definition({ style: { marginInlineStart: 4 } }), 'store-name', { rowId: 'row-1', widthPx: 20, heightPx: 20 })).toBeNull();
        expect(promoteFlowNodeToRow(definition({ type: 'jofotara_qr' }), 'store-name', { rowId: 'row-1', widthPx: 20, heightPx: 20 })).toBeNull();
        expect(promoteFlowNodeToRow(definition(), 'store-name', { rowId: 'row-1', widthPx: NaN, heightPx: 20 })).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';
import { promotedColumnFallbacks, proportionalColumns } from '../PrintTemplateEditor.vue';

const col = width => ({ style: width === undefined ? {} : { width } });

describe('proportionalColumns (Position columns freely)', () => {
    it('keeps the built-in receipt item row proportions on the 556px row', () => {
        const layout = proportionalColumns([col(11.5), col(64.75), col(23.75)], 36);
        expect(layout).toEqual([
            { x: 0, y: 0, widthPx: 64, heightPx: 36 },
            { x: 64, y: 0, widthPx: 360, heightPx: 36 },
            { x: 424, y: 0, widthPx: 132, heightPx: 36 }
        ]);
    });

    it('snaps to the 4px grid and lets the last column absorb the rounding', () => {
        const layout = proportionalColumns([col(33.3), col(33.3), col(33.4)], 36);
        expect(layout.map(item => item.widthPx)).toEqual([184, 184, 188]);
        expect(layout.every(item => item.x % 4 === 0)).toBe(true);
        const last = layout.at(-1);
        expect(last.x + last.widthPx).toBe(556);
    });

    it('keeps the usual placement when a column has no width (for example a Field just added)', () => {
        // A built-in row already sums to 100%, so a widthless column would get nothing.
        expect(proportionalColumns([col(11.5), col(64.75), col(23.75), col()], 36)).toBeNull();
    });

    it('returns null when no child width is known so the editor falls back to halving', () => {
        expect(proportionalColumns([col(), col()], 36)).toBeNull();
        expect(proportionalColumns([], 36)).toBeNull();
    });

    it('keeps the usual placement when the widths do not add up to 100%', () => {
        // Over 100% after Duplicate, or under after a column was deleted.
        expect(proportionalColumns([col(11.5), col(64.75), col(23.75), col(64.75)], 36)).toBeNull();
        expect(proportionalColumns([col(64.75), col(23.75)], 36)).toBeNull();
    });
});

describe('promotedColumnFallbacks', () => {
    const node = (id, width) => ({ id, style: width === undefined ? {} : { width } });

    it('uses proportional positions when no child is remembered', () => {
        const nodes = [node('a', 50), node('b', 50)];
        expect(promotedColumnFallbacks(nodes, 36, new Map())).toEqual(proportionalColumns(nodes, 36));
    });

    it('skips proportional positions when any child has a remembered position', () => {
        const nodes = [node('a', 11.5), node('b', 64.75), node('c', 23.75), node('new')];
        const memory = new Map([['a', { x: 0 }], ['b', { x: 64 }], ['c', { x: 424 }]]);
        expect(promotedColumnFallbacks(nodes, 36, memory)).toBeNull();
    });
});

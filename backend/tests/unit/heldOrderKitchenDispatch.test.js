import { describe, expect, it, vi } from 'vitest';
const {
    dispatchHeldOrderKitchen,
    assignStableHeldLineIds,
    buildPreparationSignature,
    computePositiveKitchenDelta,
    buildKitchenSnapshot,
    buildCancellationBatchId
} = require('../../services/HeldOrderKitchenDispatch');

describe('HeldOrderKitchenDispatch', () => {
    const heldOrder = {
        id: 42,
        kitchen_fired: 0,
        reference_name: 'Takeaway Sam',
        created_at: new Date('2026-07-15T09:30:00.000Z')
    };
    const items = [{ id: 1, name: 'Tea', qty: 1 }];

    it('uses stable print identity and marks fired after durable dispatch', async () => {
        const db = { query: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
        const printKitchenOrder = vi.fn().mockResolvedValue(2);

        const count = await dispatchHeldOrderKitchen({
            db, io: {}, heldOrder, items, printKitchenOrder
        });

        expect(count).toBe(2);
        expect(printKitchenOrder).toHaveBeenCalledWith({}, expect.objectContaining({
            print_batch_id: 'held-42',
            order_id: 42,
            items
        }));
        expect(db.query).toHaveBeenCalledWith(
            'UPDATE held_orders SET kitchen_fired = 1 WHERE id = ? AND kitchen_fired = 0',
            [42]
        );
    });

    it('does not mark fired when no printer route matches', async () => {
        const db = { query: vi.fn() };
        await expect(dispatchHeldOrderKitchen({
            db,
            io: {},
            heldOrder,
            items,
            printKitchenOrder: vi.fn().mockResolvedValue(0)
        })).rejects.toMatchObject({ statusCode: 422 });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('does not mark fired when print dispatch fails', async () => {
        const db = { query: vi.fn() };
        await expect(dispatchHeldOrderKitchen({
            db,
            io: {},
            heldOrder,
            items,
            printKitchenOrder: vi.fn().mockRejectedValue(new Error('queue failed'))
        })).rejects.toThrow('queue failed');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('keeps the complete print payload stable when a failed dispatch is retried later', async () => {
        vi.useFakeTimers();
        try {
            const payloads = [];
            const printKitchenOrder = vi.fn(async (_io, payload) => {
                payloads.push(payload);
                return 1;
            });
            const db = { query: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };

            vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
            await dispatchHeldOrderKitchen({ db, io: {}, heldOrder, items, printKitchenOrder });
            vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));
            await dispatchHeldOrderKitchen({ db, io: {}, heldOrder, items, printKitchenOrder });

            expect(payloads[0]).toEqual(payloads[1]);
            expect(payloads[0].date).toBe('2026-07-15T09:30:00.000Z');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects a ticket already marked fired before printing', async () => {
        const printKitchenOrder = vi.fn();
        await expect(dispatchHeldOrderKitchen({
            db: { query: vi.fn() },
            io: {},
            heldOrder: { ...heldOrder, kitchen_fired: 1 },
            items,
            printKitchenOrder
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(printKitchenOrder).not.toHaveBeenCalled();
    });

    it('assigns server line ids that survive client reordering and rejects changed signatures', () => {
        const initial = assignStableHeldLineIds([
            { product_id: 10, name: 'Burger', qty: 3, note: 'No onion' },
            { product_id: 10, name: 'Burger', qty: 1, note: 'Extra cheese' }
        ], { heldId: 42, mode: 'initial' });

        expect(initial.items.map(item => item.held_line_id)).toEqual([
            'held-42-line-1', 'held-42-line-2'
        ]);
        expect(initial.items.every(item => item.preparation_signature)).toBe(true);

        const reordered = assignStableHeldLineIds([
            { ...initial.items[1], qty: 2 },
            { ...initial.items[0], qty: 4 }
        ], { heldId: 42, previousItems: initial.items, mode: 'update' });
        expect(reordered.items.map(item => item.held_line_id)).toEqual([
            'held-42-line-2', 'held-42-line-1'
        ]);
        expect(() => assignStableHeldLineIds([
            { ...initial.items[0], name: 'Different product' }
        ], { heldId: 42, previousItems: initial.items, protectedLineIds: new Set(['held-42-line-1']), mode: 'update' }))
            .toThrowError(expect.objectContaining({ publicCode: 'HELD_KITCHEN_SENT_LINE_CONFLICT' }));
    });

    it('keeps preparation identity stable across claim-time tax and availability metadata', () => {
        const heldLine = {
            product_id: 10,
            name: 'Burger',
            qty: 1,
            note: 'No onion',
            tax_rate: 16,
            jofotara_tax_category: 'S',
            is_available: 1,
            can_sell: 1
        };
        const claimedLine = {
            ...heldLine,
            tax_rate: 0,
            tax_amount: 0.42,
            jofotara_tax_category: 'O',
            tax_context_version: 'claim-v2',
            is_available: 1,
            can_sell: 1
        };

        expect(buildPreparationSignature(claimedLine)).toBe(buildPreparationSignature(heldLine));
    });

    it('computes only positive quantity deltas in canonical line order', () => {
        const baseline = [
            { held_line_id: 'held-42-line-1', qty: 3, preparation_signature: 'a', name: 'Burger' },
            { held_line_id: 'held-42-line-2', qty: 1, preparation_signature: 'b', name: 'Tea' }
        ];
        const current = [
            { held_line_id: 'held-42-line-2', qty: 1, preparation_signature: 'b', name: 'Tea' },
            { held_line_id: 'held-42-line-1', qty: 5, preparation_signature: 'a', name: 'Burger' },
            { held_line_id: 'held-42-line-3', qty: 2, preparation_signature: 'c', name: 'Cake' }
        ];
        const delta = computePositiveKitchenDelta({ baseline, current });
        expect(delta.map(item => [item.held_line_id, item.qty])).toEqual([
            ['held-42-line-1', 2], ['held-42-line-3', 2]
        ]);
    });

    it('builds a snapshot without customer or payment authority and stable cancel identity', () => {
        const snapshot = buildKitchenSnapshot({
            heldId: 42,
            createdAt: '2026-07-15T09:30:00.000Z',
            sequence: 1,
            batchId: 'held-42',
            lines: [{ held_line_id: 'held-42-line-1', qty: 1, name: 'Tea', preparation_signature: 'sig' }],
            routes: [{ printer_id: 7 }]
        });
        expect(snapshot).toMatchObject({ schema_version: 1, held_id: 42, sequence: 1, baseline_unknown: false });
        expect(snapshot).not.toHaveProperty('customer_phone');
        expect(snapshot).not.toHaveProperty('payment_method');
        const cancellationBatchId = buildCancellationBatchId(42, '11111111-1111-4111-8111-111111111111', snapshot);
        expect(cancellationBatchId).toMatch(/^held-42-cancel-[a-f0-9]{64}$/);
        expect(cancellationBatchId).toBe(buildCancellationBatchId(42, '11111111-1111-4111-8111-111111111111', snapshot));
        expect(cancellationBatchId).not.toBe(buildCancellationBatchId(42, '22222222-2222-4222-8222-222222222222', snapshot));
    });
});

const { appendAuditEvent, appendAuditEvents, appendDiscountAuditEvents } = require('../../services/auditEvents');

describe('transaction audit batches', () => {
    const events = [
        { eventType: 'split_check_created', entityType: 'held_order', entityId: 21, newValue: { parent_invoice_id: 8 } },
        { eventType: 'split_check_opened', entityType: 'order', entityId: 8, oldValue: 'already serialized' }
    ];

    it('keeps every event and actor field while reading policy once', async () => {
        const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]).mockResolvedValueOnce([[{ disabled: 0 }]]);
        await appendAuditEvents({ query }, events, { userId: 4, managerId: 5, ipAddress: '127.0.0.1' });
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.map(([, params]) => params)).toEqual([
            [4, 5],
            [[['split_check_created', 4, 5, 'held_order', 21, null, '{"parent_invoice_id":8}', '127.0.0.1'],
            ['split_check_opened', 4, 5, 'order', 8, 'already serialized', null, '127.0.0.1']]]
        ]);
    });

    it('honors the existing actor or manager policy and rechecks for the next batch', async () => {
        const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
            .mockResolvedValueOnce([[{ disabled: 1 }]])
            .mockResolvedValueOnce([[{ disabled: 0 }]]);
        await appendAuditEvents({ query }, events, { managerId: 5 });
        expect(query).toHaveBeenCalledTimes(1);
        await appendAuditEvents({ query }, events, { managerId: 5 });
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[0][1]).toEqual([0, 5]);
        expect(query.mock.calls[1][1]).toEqual([0, 5]);
    });

    it('does no work for an empty batch and preserves actorless events', async () => {
        const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
        await appendAuditEvents({ query }, [], { userId: 4 });
        expect(query).not.toHaveBeenCalled();
        await appendAuditEvents({ query }, events, {});
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls.every(([sql]) => sql.includes('INSERT INTO audit_events'))).toBe(true);
    });

    it('propagates a write failure to the transaction owner and stops subsequent events', async () => {
        const failure = new Error('Database connection lost');
        const query = vi.fn().mockResolvedValueOnce([[{ disabled: 0 }]]).mockRejectedValueOnce(failure);
        await expect(appendAuditEvents({ query }, events, { userId: 4 })).rejects.toBe(failure);
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('retains the single-event database return value and serialization contract', async () => {
        const result = [{ insertId: 37, affectedRows: 1 }, []];
        const query = vi.fn().mockResolvedValueOnce([[{ disabled: 0 }]]).mockResolvedValueOnce(result);
        expect(await appendAuditEvent({ query }, { ...events[0], userId: 4 })).toBe(result);
        expect(query.mock.calls[1][1]).toEqual(['split_check_created', 4, null, 'held_order', 21, null, '{"parent_invoice_id":8}', null]);
    });

    it('reads xyz policy once for one order discount and every changed line', async () => {
        const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]).mockResolvedValueOnce([[{ disabled: 0 }]]);
        const currentItems = Array.from({ length: 4 }, (_, index) => ({
            product_id: index + 1,
            name: `Item ${index + 1}`,
            qty: 1,
            price: 10,
            discountType: 'percent',
            discountValue: 10,
        }));

        await appendDiscountAuditEvents({ query }, {
            userId: 4,
            managerId: 5,
            invoiceId: 91,
            ipAddress: '127.0.0.1',
            currentOrder: { type: 'fixed', value: 2, subtotal: 40 },
            currentItems,
        });

        expect(query.mock.calls.filter(([sql]) => sql.includes('SELECT COALESCE(MAX(xyz)'))).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_events'))).toHaveLength(1);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[1][1][0].map(row => row.slice(0, 5))).toEqual([
            ['order_discount_changed', 4, 5, 'order', 91],
            ['line_discount_changed', 4, 5, 'order', 91],
            ['line_discount_changed', 4, 5, 'order', 91],
            ['line_discount_changed', 4, 5, 'order', 91],
            ['line_discount_changed', 4, 5, 'order', 91],
        ]);
    });

    it('bounds writes by row count and serialized bytes without losing order', async () => {
        const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
        const input = Array.from({ length: 101 }, (_, entityId) => ({ ...events[0], entityId }));
        await appendAuditEvents({ query }, input, {});
        expect(query.mock.calls.map(([, params]) => params[0].length)).toEqual([50, 50, 1]);
        expect(query.mock.calls.flatMap(([, params]) => params[0].map(row => row[4])))
            .toEqual(input.map(event => event.entityId));
        query.mockClear();
        await appendAuditEvents({ query }, [0, 1, 2].map(entityId => ({
            ...events[0], entityId, newValue: 'x'.repeat(150_000),
        })), {});
        expect(query.mock.calls.map(([, params]) => params[0].length)).toEqual([1, 1, 1]);
    });

    it('does not read policy when no discount changed and suppresses the whole discount batch for xyz', async () => {
        const unchanged = vi.fn();
        await appendDiscountAuditEvents({ query: unchanged }, {
            userId: 4,
            invoiceId: 92,
            previousOrder: { subtotal: 10 },
            currentOrder: { subtotal: 10 },
            previousItems: [],
            currentItems: [{ product_id: 1, qty: 1, price: 10 }],
        });
        expect(unchanged).not.toHaveBeenCalled();

        const disabled = vi.fn().mockResolvedValueOnce([[{ disabled: 1 }]]);
        await appendDiscountAuditEvents({ query: disabled }, {
            userId: 4,
            managerId: 5,
            invoiceId: 93,
            currentOrder: { type: 'percent', value: 10, subtotal: 10 },
            currentItems: [{ product_id: 1, qty: 1, price: 10, discountType: 'fixed', discountValue: 1 }],
        });
        expect(disabled).toHaveBeenCalledTimes(1);
        expect(disabled.mock.calls[0][1]).toEqual([4, 5]);
    });
});

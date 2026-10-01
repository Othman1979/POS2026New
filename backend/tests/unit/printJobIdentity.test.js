const {
    buildPrintJobRecord,
    hashPrintPayload,
    stableStringify
} = require('../../services/printJobIdentity');

describe('print job identity', () => {
    it('hashes the same Arabic payload deterministically regardless of key order', () => {
        const first = {
            print_type: 'receipt',
            printer_name: 'Receipt',
            data: {
                customer_name: 'احمد',
                total: 12,
                items: [{ name: 'منسف', qty: 1 }]
            }
        };
        const second = {
            data: {
                items: [{ qty: 1, name: 'منسف' }],
                total: 12,
                customer_name: 'احمد'
            },
            printer_name: 'Receipt',
            print_type: 'receipt'
        };

        expect(stableStringify(first)).toBe(stableStringify(second));
        expect(hashPrintPayload(first)).toBe(hashPrintPayload(second));
    });

    it('changes the payload hash when item quantity changes', () => {
        const one = hashPrintPayload({
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: { print_batch_id: 'batch-1', items: [{ name: 'Burger', qty: 1 }] }
        });
        const two = hashPrintPayload({
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: { print_batch_id: 'batch-1', items: [{ name: 'Burger', qty: 2 }] }
        });

        expect(one).not.toBe(two);
    });

    it('hashes the exact JSON payload that will be persisted', () => {
        const payload = {
            printer_id: 42,
            print_type: 'receipt',
            data: { invoice_id: 7001, omitted_before_storage: undefined }
        };

        const record = buildPrintJobRecord(payload);
        const persistedPayload = JSON.parse(JSON.stringify(payload));

        expect(record.payload).toEqual(persistedPayload);
        expect(record.payloadHash).toBe(hashPrintPayload(persistedPayload));
    });

    it('requires a kitchen print batch id so later fires for the same table do not collapse', () => {
        expect(() => buildPrintJobRecord({
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: { table_number: '4', items: [] }
        })).toThrow('Kitchen print job missing print_batch_id');

        const first = buildPrintJobRecord({
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: { print_batch_id: 'batch-1', table_number: '4', items: [] }
        });
        const second = buildPrintJobRecord({
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: { print_batch_id: 'batch-2', table_number: '4', items: [] }
        });

        expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
        expect(first.idempotencyKey).toMatch(/^kitchen:batch-1:Kitchen:/);
    });

    it('uses the database printer id instead of a mutable printer name', () => {
        const record = buildPrintJobRecord({
            printer_id: 42,
            printer_name: 'Kitchen renamed later',
            print_type: 'kitchen',
            data: { print_batch_id: 'batch-printer-id', items: [] }
        });

        expect(record.printerId).toBe('42');
        expect(record.idempotencyKey).toContain('kitchen:batch-printer-id:42:');
    });

    it('keeps a kitchen duplicate key stable across compiled template revisions while retaining payload integrity', () => {
        const base = {
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: {
                print_batch_id: 'batch-template-stable',
                items: [{ name: 'Burger', qty: 1 }]
            }
        };
        const first = buildPrintJobRecord({
            ...base,
            data: {
                ...base.data,
                compiled_document_v1: { templateRevisionId: 'kitchen-v1', html: '<p>Burger</p>' }
            }
        });
        const second = buildPrintJobRecord({
            ...base,
            data: {
                ...base.data,
                compiled_document_v1: { templateRevisionId: 'kitchen-v2', html: '<p>BURGER</p>' }
            }
        });

        expect(first.payloadHash).not.toBe(second.payloadHash);
        expect(first.idempotencyKey).toBe(second.idempotencyKey);
    });

    it('changes the kitchen duplicate key when semantic kitchen data changes', () => {
        const base = {
            print_type: 'kitchen',
            printer_name: 'Kitchen',
            data: {
                print_batch_id: 'batch-template-semantic',
                compiled_document_v1: { templateRevisionId: 'kitchen-v1', html: '<p>Burger</p>' },
                items: [{ name: 'Burger', qty: 1 }]
            }
        };
        const changed = {
            ...base,
            data: { ...base.data, items: [{ name: 'Burger', qty: 2 }] }
        };

        expect(buildPrintJobRecord(base).idempotencyKey)
            .not.toBe(buildPrintJobRecord(changed).idempotencyKey);
    });

    it('creates a distinct idempotency key for audited reprints', () => {
        const original = buildPrintJobRecord({
            print_type: 'receipt',
            printer_name: 'Receipt',
            data: { invoice_id: 7001, items: [] }
        });
        const reprint = buildPrintJobRecord({
            print_type: 'receipt',
            printer_name: 'Receipt',
            reprint_of_queue_id: 44,
            data: { invoice_id: 7001, reprint_sequence: 1, items: [] }
        });

        expect(original.idempotencyKey).not.toBe(reprint.idempotencyKey);
        expect(reprint.idempotencyKey).toContain('reprint:44:Receipt:1:');
    });

    it('does not collapse repeated receipt print requests before audited reprint flow exists', () => {
        const payload = {
            print_type: 'receipt',
            printer_name: 'Receipt',
            data: { invoice_id: 7001, items: [{ name: 'Tea', qty: 1 }] }
        };

        const first = buildPrintJobRecord(payload);
        const second = buildPrintJobRecord(payload);

        expect(first.payloadHash).toBe(second.payloadHash);
        expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    });

    it('uses stable explicit receipt request IDs without mutable payload hashes', () => {
        const primary = buildPrintJobRecord({
            print_type: 'receipt', printer_id: 7, print_request_id: 'checkout-receipt:55:primary',
            data: { invoice_id: 55, invoice_number: 1001, qr_text: 'old' }
        });
        const replay = buildPrintJobRecord({
            print_type: 'receipt', printer_id: 7, print_request_id: 'checkout-receipt:55:primary',
            data: { invoice_id: 55, invoice_number: 1001, qr_text: 'new' }
        });
        const duplicate = buildPrintJobRecord({
            print_type: 'receipt', printer_id: 7, print_request_id: 'checkout-receipt:55:duplicate',
            data: { invoice_id: 55, invoice_number: 1001, qr_text: 'new' }
        });
        expect(primary.idempotencyKey).toBe(replay.idempotencyKey);
        expect(primary.idempotencyKey).not.toBe(duplicate.idempotencyKey);
    });

    it('creates correct report idempotency keys for the new daily report types', () => {
        const reportTypes = ['daily_summary_report', 'daily_sales_report', 'daily_refunds_report'];
        for (const type of reportTypes) {
            const payload = {
                print_type: type,
                printer_name: 'Receipt',
                print_request_id: 'req-123',
                data: {
                    report_id: 'rep-abc',
                    copy_label: 'copy'
                }
            };
            const record = buildPrintJobRecord(payload);
            expect(record.idempotencyKey).toBe(`report:${type}:rep-abc:Receipt:copy:req-123`);
        }
    });

    it('keeps held kitchen operation identity stable when printer metadata changes', () => {
        const base = {
            printer_id: 7,
            printer_name: 'Grill A',
            printer_type: 'windows',
            network_ip: '10.0.0.7',
            network_port: '9100',
            status_capability: 'write_only',
            print_type: 'kitchen',
            data: {
                print_batch_id: 'held-42-2-delta',
                date: '2026-07-15T09:30:00.000Z',
                printer_label: 'Grill A',
                follow_up: true,
                follow_up_sequence: 2,
                items: [{ held_line_id: 'held-42-line-2', name: 'Tea', qty: 2 }]
            }
        };
        const changed = {
            ...base,
            printer_name: 'Renamed Grill',
            network_ip: '10.0.0.8',
            data: { ...base.data, printer_label: 'Renamed Grill' }
        };
        expect(buildPrintJobRecord(changed).idempotencyKey).toBe(buildPrintJobRecord(base).idempotencyKey);
    });
});

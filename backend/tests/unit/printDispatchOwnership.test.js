describe('print dispatch ownership', () => {
    afterEach(() => vi.restoreAllMocks());

    function useBuiltinKitchenTemplate() {
        const manager = require('../../services/printTemplateManager');
        const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');
        vi.spyOn(manager, 'resolveActiveTemplate').mockResolvedValue({
            kind: 'builtin', definition: getBuiltinTemplate('kitchen'), templateRevisionId: 'builtin:kitchen-v1'
        });
    }

    // The enqueue seam is allowed to read before it writes - the kitchen path loads the
    // store name for the ticket heading. Locate the durable write by its statement
    // instead of assuming it is the first call, so a new read cannot fail these tests
    // for the wrong reason.
    function insertCalls(executor) {
        return executor.query.mock.calls.filter(([sql]) => /INSERT INTO print_queue/i.test(sql));
    }

    function persistedPayload(executor) {
        const calls = insertCalls(executor);
        expect(calls).toHaveLength(1);
        return { args: calls[0][1], payload: JSON.parse(calls[0][1][0]) };
    }

    it('enqueues through the supplied transaction executor', async () => {
        useBuiltinKitchenTemplate();
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 44 }]) };
        const { enqueuePrintJobs } = require('../../services/printDispatch');
        const queued = await enqueuePrintJobs(executor, [{
            printer_id: 10, printer_name: 'Kitchen', print_type: 'kitchen',
            data: { print_batch_id: 'subscription-1', items: [] }
        }]);
        // Every statement rides the supplied executor - never the module-level pool -
        // and the job is written exactly once.
        expect(executor.query).toHaveBeenCalled();
        expect(insertCalls(executor)).toHaveLength(1);
        expect(queued).toEqual([expect.objectContaining({ id: 44 })]);
    });

    it('persists the trusted kitchen artifact prepared at the durable enqueue seam', async () => {
        useBuiltinKitchenTemplate();
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 45 }]) };
        const { enqueuePrintJobs } = require('../../services/printDispatch');

        await enqueuePrintJobs(executor, [{
            printer_id: 10,
            printer_name: 'Kitchen',
            print_type: 'kitchen',
            compiled_document_v1: { forged: true },
            data: {
                print_batch_id: 'subscription-2',
                order_type_name: 'Subscription Meal',
                items: [{ name: 'Burger', qty: 1 }],
                compiled_document_v1: { forged: true },
                subscription_redemption: { reference: 'SUB-2', is_void: false }
            }
        }]);

        const { args, payload } = persistedPayload(executor);
        expect(payload.compiled_document_v1).toBeUndefined();
        expect(payload.data.compiled_document_v1).toMatchObject({
            docType: 'kitchen',
            templateRevisionId: 'builtin:kitchen-v1'
        });
        expect(args[2]).toBe(require('../../services/printJobIdentity').hashPrintPayload(payload));
    });

    it('compiles each fresh kitchen payload exactly once at enqueue', async () => {
        useBuiltinKitchenTemplate();
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 46 }]) };
        const templateEngine = require('../../services/printTemplateEngine');
        const compileSpy = vi.spyOn(templateEngine, 'compileTemplate');
        const { enqueuePrintJobs } = require('../../services/printDispatch');

        await enqueuePrintJobs(executor, [{
            printer_id: 10,
            printer_name: 'Kitchen',
            print_type: 'kitchen',
            data: { print_batch_id: 'fresh-once', items: [{ name: 'Burger', qty: 1 }] }
        }]);

        expect(compileSpy).toHaveBeenCalledTimes(1);
    });

    it('uses a server-only revision override and never persists a payload-supplied override', async () => {
        useBuiltinKitchenTemplate();
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 47 }]) };
        const { enqueuePrintJobs } = require('../../services/printDispatch');

        await enqueuePrintJobs(executor, [{
            printer_id: 10, printer_name: 'Kitchen', print_type: 'kitchen', revisionOverrideId: 999,
            data: { print_batch_id: 'override-private', items: [], revisionOverrideId: 999 }
        }], { revisionOverrideId: 'builtin' });

        const { payload: persisted } = persistedPayload(executor);
        expect(persisted.revisionOverrideId).toBeUndefined();
        expect(persisted.data.revisionOverrideId).toBeUndefined();
        expect(persisted.data.compiled_document_v1.templateRevisionId).toBe('builtin:kitchen-v1');
    });

    it('strips a forged receipt test marker from a guest check before persistence', async () => {
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 48 }]) };
        const { enqueuePrintJobs } = require('../../services/printDispatch');

        await enqueuePrintJobs(executor, [{
            printer_id: 10, printer_name: 'Receipt', print_type: 'receipt',
            data: {
                provisional: true, invoice_id: 'GUEST CHECK',
                template_test: { docType: 'receipt', revisionId: 1, printerId: 10, fixtureKey: 'receipt-basic' }
            }
        }]);

        const { payload: persisted } = persistedPayload(executor);
        expect(persisted.data.template_test).toBeUndefined();
        expect(persisted.data.compiled_document_v1).toBeUndefined();
    });

    describe('receipt printer selection', () => {
        const printers = [
            { id: 10, name: 'Front', assigned_ips: '10.0.0.1' },
            { id: 20, name: 'Patio', assigned_ips: null }
        ];

        it('uses the terminal-selected printer and ignores legacy IP mappings', () => {
            const { selectReceiptPrinter } = require('../../services/printDispatch');
            expect(selectReceiptPrinter(printers, { printerId: 20 })).toEqual(printers[1]);
        });

        it('auto-selects only when exactly one active receipt printer exists', () => {
            const { selectReceiptPrinter } = require('../../services/printDispatch');
            expect(selectReceiptPrinter([printers[0]])).toEqual(printers[0]);
        });

        it('fails clearly instead of silently routing an ambiguous receipt', () => {
            const { selectReceiptPrinter } = require('../../services/printDispatch');
            expect(() => selectReceiptPrinter(printers)).toThrow('Select a receipt printer for this terminal.');
            try {
                selectReceiptPrinter(printers);
            } catch (err) {
                expect(err.statusCode).toBe(409);
            }
        });
    });
});

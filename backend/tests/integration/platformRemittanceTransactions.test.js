const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const service = require('../../services/PlatformRemittanceService');
const { refundPaidOrder } = require('../../services/RefundService');

describe('PlatformRemittanceService transactional writes', () => {
    let invoiceSequence = 9200;

    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function createPlatformOrder(total, orderTypeId = SEED.orderType.id) {
        const invoiceNumber = invoiceSequence++;
        const [result] = await pool.query(`
            INSERT INTO orders
                (invoice_number,user_id,order_type_id,subtotal,tax,total,payment_method,
                 invoice_issued_at,created_at,cash_amount,card_amount,amount_tendered,change_due)
            VALUES (?,?,?, ?,0,?,'platform','2026-08-01 10:00:00','2026-08-01 10:00:00',0,0,0,0)
        `, [invoiceNumber, SEED.adminUser.id, orderTypeId, total, total]);
        await pool.query(
            `INSERT INTO order_items (invoice_id,product_id,item_name,quantity,price_at_sale,tax_rate,tax_amount)
             VALUES (?,?,?,1,?,0,0)`,
            [result.insertId, SEED.product1.id, 'Platform Test Item', total]
        );
        return Number(result.insertId);
    }

    async function receivable(invoiceId) {
        const rows = await service.listReceivables(pool, SEED.orderType.id);
        const row = rows.find(entry => entry.invoice_id === invoiceId);
        if (!row) throw new Error(`Missing receivable ${invoiceId}`);
        return row;
    }

    async function invoke(method, input) {
        const conn = await pool.getConnection();
        try {
            return await service[method](conn, input);
        } finally {
            conn.release();
        }
    }

    it('records partial allocations and typed adjustments, then returns an exact idempotent retry', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const input = {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '5.00' }],
            adjustments: [{ direction: 'deduction', category: 'commission', amount: '1.00', note: null }],
            netReceived: '4.00',
            settledOn: '2026-08-02',
            reference: 'BANK-1',
            idempotencyKey: 'integration-remittance-1'
        };
        const recorded = await invoke('recordPlatformRemittance', input);
        expect(recorded).toMatchObject({
            kind: 'settlement',
            invoice_allocations: 5,
            deductions: 1,
            computed_net: 4,
            net_received: 4,
            unreconciled_difference: 0
        });
        expect(recorded.allocations).toEqual([{ invoice_id: invoiceId, allocated_amount: 5 }]);
        expect(recorded.adjustments).toEqual([{ direction: 'deduction', category: 'commission', amount: 1, note: null }]);
        expect((await receivable(invoiceId)).open_amount).toBe(5);
        const [[documents]] = await pool.query('SELECT COUNT(*) AS count FROM jofotara_documents WHERE order_invoice_id=?', [invoiceId]);
        expect(Number(documents.count)).toBe(0);

        const retry = await invoke('recordPlatformRemittance', input);
        expect(retry.id).toBe(recorded.id);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM platform_remittances');
        expect(Number(count.count)).toBe(1);

        await expect(invoke('recordPlatformRemittance', { ...input, netReceived: '5.00' }))
            .rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_IDEMPOTENCY_CONFLICT' });
    });

    it('accepts a partial provider credit only when a positive allocation keeps the batch payable', async () => {
        const creditedInvoice = await createPlatformOrder(10);
        const positiveInvoice = await createPlatformOrder(5);
        const [prior] = await pool.query(`
            INSERT INTO platform_remittances
                (order_type_id,provider_name_at_entry,settled_on,net_received,recorded_by,idempotency_key)
            VALUES (?, 'Dine In', '2026-08-01', 10, ?, 'integration-credit-source')
        `, [SEED.orderType.id, SEED.adminUser.id]);
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id,invoice_id,allocated_amount) VALUES (?,?,10)',
            [prior.insertId, creditedInvoice]
        );
        await pool.query(
            `INSERT INTO refunds (kind,invoice_id,scope,amount_refunded,refund_method,user_id,reason)
             VALUES ('refund',?,'order',7,'platform',?,'later provider refund')`,
            [creditedInvoice, SEED.adminUser.id]
        );
        const credit = await receivable(creditedInvoice);
        const positive = await receivable(positiveInvoice);
        const recorded = await invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [
                { invoiceId: creditedInvoice, balanceToken: credit.balance_token, allocationAmount: '-3.00' },
                { invoiceId: positiveInvoice, balanceToken: positive.balance_token, allocationAmount: '5.00' }
            ],
            adjustments: [],
            netReceived: '2.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-credit-1'
        });
        expect(recorded.invoice_allocations).toBe(2);
        expect(recorded.provider_credits_applied).toBe(3);
        expect(recorded.computed_net).toBe(2);
    });

    it('allows a zero payout only when a positive allocation is fully offset by a typed adjustment', async () => {
        const invoiceId = await createPlatformOrder(5);
        const open = await receivable(invoiceId);
        const recorded = await invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '5.00' }],
            adjustments: [{ direction: 'deduction', category: 'commission', amount: '5.00' }],
            netReceived: '0.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-zero-payout'
        });
        expect(recorded).toMatchObject({ net_received: 0, computed_net: 0, unreconciled_difference: 0 });
    });

    it('rejects a one-cent mismatch and leaves no header, children, or audit row', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '5.00' }],
            adjustments: [{ direction: 'deduction', category: 'commission', amount: '1.00' }],
            netReceived: '4.01',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-mismatch-1'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_EQUATION_MISMATCH' });
        const [[headers]] = await pool.query('SELECT COUNT(*) AS count FROM platform_remittances');
        const [[lines]] = await pool.query('SELECT COUNT(*) AS count FROM platform_remittance_lines');
        const [[adjustments]] = await pool.query('SELECT COUNT(*) AS count FROM platform_remittance_adjustments');
        const [[audits]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='platform_remittance_recorded'");
        expect(Number(headers.count)).toBe(0);
        expect(Number(lines.count)).toBe(0);
        expect(Number(adjustments.count)).toBe(0);
        expect(Number(audits.count)).toBe(0);
    });

    it('reverses once, restores the live balance, and returns the same reversal on retry', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const settlement = await invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '10.00' }],
            adjustments: [],
            netReceived: '10.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-reversal-source'
        });
        expect((await service.listReceivables(pool, SEED.orderType.id)).find(row => row.invoice_id === invoiceId)).toBeUndefined();

        const reversal = await invoke('reversePlatformRemittance', {
            actorId: SEED.adminUser.id,
            remittanceId: settlement.id,
            reason: 'Bank check was voided',
            idempotencyKey: 'integration-reversal-1'
        });
        expect(reversal).toMatchObject({ kind: 'reversal', reverses_remittance_id: settlement.id });
        expect(await service.getRemittance(pool, settlement.id)).toMatchObject({ reversal_id: reversal.id });
        expect((await receivable(invoiceId)).open_amount).toBe(10);
        expect((await invoke('reversePlatformRemittance', {
            actorId: SEED.adminUser.id,
            remittanceId: settlement.id,
            reason: 'Bank check was voided',
            idempotencyKey: 'integration-reversal-1'
        })).id).toBe(reversal.id);

        await expect(invoke('reversePlatformRemittance', {
            actorId: SEED.adminUser.id,
            remittanceId: settlement.id,
            reason: 'Second reason',
            idempotencyKey: 'integration-reversal-2'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_ALREADY_REVERSED' });
    });

    it('reverses positive and provider-credit allocations with their exact original signs', async () => {
        const creditedInvoice = await createPlatformOrder(10);
        const positiveInvoice = await createPlatformOrder(5);
        const [prior] = await pool.query(`
            INSERT INTO platform_remittances
                (order_type_id,provider_name_at_entry,settled_on,net_received,recorded_by,idempotency_key)
            VALUES (?, 'Dine In', '2026-08-01', 10, ?, 'integration-credit-reversal-source')
        `, [SEED.orderType.id, SEED.adminUser.id]);
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id,invoice_id,allocated_amount) VALUES (?,?,10)',
            [prior.insertId, creditedInvoice]
        );
        await pool.query(
            `INSERT INTO refunds (kind,invoice_id,scope,amount_refunded,refund_method,user_id,reason)
             VALUES ('refund',?,'order',7,'platform',?,'provider credit before reversal')`,
            [creditedInvoice, SEED.adminUser.id]
        );

        const creditBefore = await receivable(creditedInvoice);
        const positiveBefore = await receivable(positiveInvoice);
        expect(creditBefore.open_amount).toBe(-7);
        expect(positiveBefore.open_amount).toBe(5);

        const settlement = await invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [
                { invoiceId: creditedInvoice, balanceToken: creditBefore.balance_token, allocationAmount: '-3.00' },
                { invoiceId: positiveInvoice, balanceToken: positiveBefore.balance_token, allocationAmount: '5.00' }
            ],
            adjustments: [],
            netReceived: '2.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-credit-reversal-settlement'
        });
        await invoke('reversePlatformRemittance', {
            actorId: SEED.adminUser.id,
            remittanceId: settlement.id,
            reason: 'Provider statement was voided',
            idempotencyKey: 'integration-credit-reversal'
        });

        expect((await receivable(creditedInvoice)).open_amount).toBe(-7);
        expect((await receivable(positiveInvoice)).open_amount).toBe(5);
        expect(await service.getRangeTotals(pool, {
            startDate: '2026-08-02',
            endDate: '2099-12-31'
        })).toMatchObject({
            positive_allocations: 0,
            provider_credits_applied: 0,
            invoice_allocations: 0,
            net_received: 0,
            settlement_count: 1,
            reversal_count: 1
        });
    });

    it('rejects stale tokens, wrong signs, over-allocation, and negative computed net', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId: 999999, balanceToken: 'c'.repeat(64), allocationAmount: '1.00' }],
            adjustments: [],
            netReceived: '1.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-missing-invoice'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_INVALID_INVOICE' });
        const crossProviderInvoice = await createPlatformOrder(5, 2);
        const crossProvider = (await service.listReceivables(pool, 2)).find(row => row.invoice_id === crossProviderInvoice);
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId: crossProviderInvoice, balanceToken: crossProvider.balance_token, allocationAmount: '5.00' }],
            adjustments: [],
            netReceived: '5.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-cross-provider'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_CROSS_PROVIDER' });
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '11.00' }],
            adjustments: [],
            netReceived: '11.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-over-allocation'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_ALLOCATION_BOUNDS' });
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '-1.00' }],
            adjustments: [],
            netReceived: '0.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-wrong-sign'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_ALLOCATION_BOUNDS' });
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: 'b'.repeat(64), allocationAmount: '5.00' }],
            adjustments: [],
            netReceived: '5.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-stale-token'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_STALE_BALANCE' });
        await expect(invoke('recordPlatformRemittance', {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '1.00' }],
            adjustments: [{ direction: 'deduction', category: 'commission', amount: '2.00' }],
            netReceived: '0.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-negative-net'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_NEGATIVE_NET' });
    });

    it('serializes concurrent identical and conflicting attempts without over-allocation', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const base = {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '10.00' }],
            adjustments: [],
            netReceived: '10.00',
            settledOn: '2026-08-02'
        };
        const [sameA, sameB] = await Promise.allSettled([
            invoke('recordPlatformRemittance', { ...base, idempotencyKey: 'integration-race-same' }),
            invoke('recordPlatformRemittance', { ...base, idempotencyKey: 'integration-race-same' })
        ]);
        expect([sameA, sameB].filter(result => result.status === 'fulfilled')).toHaveLength(2);
        expect(sameA.value.id).toBe(sameB.value.id);

        const freshInvoiceId = await createPlatformOrder(10);
        const fresh = await receivable(freshInvoiceId);
        const [differentA, differentB] = await Promise.allSettled([
            invoke('recordPlatformRemittance', { ...base, invoiceAllocations: [{ invoiceId: freshInvoiceId, balanceToken: fresh.balance_token, allocationAmount: '10.00' }], idempotencyKey: 'integration-race-a' }),
            invoke('recordPlatformRemittance', { ...base, invoiceAllocations: [{ invoiceId: freshInvoiceId, balanceToken: fresh.balance_token, allocationAmount: '10.00' }], idempotencyKey: 'integration-race-b' })
        ]);
        expect([differentA, differentB].filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect([differentA, differentB].find(result => result.status === 'rejected').reason.publicCode)
            .toMatch(/PLATFORM_REMITTANCE_(ALLOCATION_BOUNDS|INVALID_INVOICE|STALE_BALANCE)/);
        const [[lineTotal]] = await pool.query('SELECT SUM(allocated_amount) AS total FROM platform_remittance_lines WHERE invoice_id=?', [freshInvoiceId]);
        expect(Number(lineTotal.total)).toBe(10);
    });

    it('serializes a real platform refund against reconciliation with the shared order-first lock', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const recordInput = {
            actorId: SEED.adminUser.id,
            orderTypeId: SEED.orderType.id,
            invoiceAllocations: [{ invoiceId, balanceToken: open.balance_token, allocationAmount: '10.00' }],
            adjustments: [],
            netReceived: '10.00',
            settledOn: '2026-08-02',
            idempotencyKey: 'integration-refund-race'
        };
        const refundTask = (async () => {
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const result = await refundPaidOrder(conn, {
                    invoiceId,
                    refundMethod: 'platform',
                    reason: 'concurrent provider refund',
                    actorId: SEED.adminUser.id
                });
                await conn.commit();
                return result;
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            } finally {
                conn.release();
            }
        })();
        const [refundResult, reconciliationResult] = await Promise.allSettled([
            refundTask,
            invoke('recordPlatformRemittance', recordInput)
        ]);
        expect(refundResult.status).toBe('fulfilled');
        if (reconciliationResult.status === 'rejected') {
            expect(reconciliationResult.reason.publicCode).toMatch(/PLATFORM_REMITTANCE_(ALLOCATION_BOUNDS|INVALID_INVOICE|STALE_BALANCE)/);
        }
        const [[allocated]] = await pool.query('SELECT COALESCE(SUM(allocated_amount),0) AS amount FROM platform_remittance_lines WHERE invoice_id=?', [invoiceId]);
        expect(Number(allocated.amount)).toBeLessThanOrEqual(10);
        const live = (await service.listReceivables(pool, SEED.orderType.id)).find(row => row.invoice_id === invoiceId);
        expect(live ? live.open_amount : 0).toBeLessThanOrEqual(0);
    });
});

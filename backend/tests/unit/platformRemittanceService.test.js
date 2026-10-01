const crypto = require('crypto');

const service = require('../../services/PlatformRemittanceService');

function balanceToken(orderTypeId, invoiceId, openCents) {
    return crypto.createHash('sha256')
        .update(`${orderTypeId}:${invoiceId}:${openCents}`)
        .digest('hex');
}

describe('PlatformRemittanceService reads', () => {
    it('derives live positive, zero, and provider-credit balances from refunds and signed allocations', async () => {
        const executor = {
            async query(sql) {
                expect(sql).toContain('FROM orders o');
                expect(sql).toContain('refunds');
                expect(sql).toContain('platform_remittance_lines');
                return [[
                    {
                        invoice_id: 101,
                        invoice_number: 'INV-101',
                        order_id: 11,
                        invoice_issued_at: '2026-08-01 10:00:00',
                        order_type_id: 7,
                        invoice_total: '10.00',
                        platform_refunded: '0.00',
                        signed_allocated: '4.00'
                    },
                    {
                        invoice_id: 102,
                        invoice_number: 'INV-102',
                        order_id: 12,
                        invoice_issued_at: '2026-08-01 11:00:00',
                        order_type_id: 7,
                        invoice_total: '10.00',
                        platform_refunded: '6.00',
                        signed_allocated: '5.00'
                    },
                    {
                        invoice_id: 103,
                        invoice_number: 'INV-103',
                        order_id: 13,
                        invoice_issued_at: '2026-08-01 12:00:00',
                        order_type_id: 7,
                        invoice_total: '5.00',
                        platform_refunded: '0.00',
                        signed_allocated: '5.00'
                    }
                ]];
            }
        };

        const rows = await service.listReceivables(executor, 7);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            invoice_id: 101,
            net_platform_sale: 10,
            previous_allocations: 4,
            open_amount: 6,
            balance_token: balanceToken(7, 101, 600)
        });
        expect(rows[1]).toMatchObject({
            invoice_id: 102,
            net_platform_sale: 4,
            previous_allocations: 5,
            open_amount: -1,
            balance_token: balanceToken(7, 102, -100)
        });
    });

    it('keeps allocation, deduction, addition, reversal, and provider-credit totals separate', async () => {
        const executor = {
            async query(sql) {
                if (sql.includes('FROM platform_remittances r')) {
                    return [[
                        { id: 1, kind: 'settlement', net_received: '11.00' },
                        { id: 2, kind: 'reversal', net_received: '11.00' },
                        { id: 3, kind: 'settlement', net_received: '8.00' }
                    ]];
                }
                if (sql.includes('platform_remittance_lines')) {
                    return [[
                        { remittance_id: 1, allocated_amount: '12.00' },
                        { remittance_id: 2, allocated_amount: '12.00' },
                        { remittance_id: 3, allocated_amount: '-2.00' }
                    ]];
                }
                if (sql.includes('platform_remittance_adjustments')) {
                    return [[
                        { remittance_id: 1, direction: 'deduction', category: 'commission', amount: '2.00' },
                        { remittance_id: 1, direction: 'addition', category: 'reimbursement', amount: '1.00' },
                        { remittance_id: 2, direction: 'deduction', category: 'commission', amount: '2.00' },
                        { remittance_id: 2, direction: 'addition', category: 'reimbursement', amount: '1.00' },
                        { remittance_id: 3, direction: 'addition', category: 'incentive', amount: '1.00' },
                        { remittance_id: 3, direction: 'deduction', category: 'correction', amount: '5.00' },
                        { remittance_id: 3, direction: 'addition', category: 'correction', amount: '3.00' }
                    ]];
                }
                throw new Error(`Unexpected query: ${sql}`);
            }
        };

        const totals = await service.getRangeTotals(executor, {
            startDate: '2026-08-01',
            endDate: '2026-08-31'
        });

        expect(totals).toMatchObject({
            positive_allocations: 0,
            provider_credits_applied: 2,
            invoice_allocations: -2,
            deductions: 5,
            additions: 4,
            net_received: 8,
            settlement_count: 2,
            reversal_count: 1,
            computed_net: -3,
            unreconciled_difference: 11,
            deductions_by_category: expect.objectContaining({ correction: 5 }),
            additions_by_category: expect.objectContaining({ correction: 3, incentive: 1 })
        });
        expect(totals.adjustments_by_category).toMatchObject({ commission: 0, reimbursement: 0, incentive: 1 });
    });

    it('rejects authority fields and non-cents values before opening a transaction', async () => {
        const connection = {
            beginTransaction: async () => { throw new Error('must not begin'); }
        };
        await expect(service.recordPlatformRemittance(connection, {
            actorId: 1,
            orderTypeId: 7,
            invoiceAllocations: [],
            adjustments: [],
            netReceived: '1e2',
            settledOn: '2026-08-01',
            idempotencyKey: 'strict-input',
            providerName: 'forged'
        })).rejects.toMatchObject({ publicCode: 'PLATFORM_REMITTANCE_UNKNOWN_FIELD' });
    });

    it('exposes transactional record and reversal operations behind the service boundary', () => {
        expect(typeof service.recordPlatformRemittance).toBe('function');
        expect(typeof service.reversePlatformRemittance).toBe('function');
    });

    it.each([
        ['scientific notation', { netReceived: '1e2' }, 'PLATFORM_REMITTANCE_INVALID_AMOUNT'],
        ['too many decimals', { netReceived: '1.001' }, 'PLATFORM_REMITTANCE_INVALID_AMOUNT'],
        ['numeric too many decimals', { netReceived: 1.001 }, 'PLATFORM_REMITTANCE_INVALID_AMOUNT'],
        ['direction matrix', { adjustments: [{ direction: 'addition', category: 'commission', amount: '1.00' }] }, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT'],
        ['required note', { adjustments: [{ direction: 'deduction', category: 'other', amount: '1.00' }] }, 'PLATFORM_REMITTANCE_INVALID_ADJUSTMENT'],
        ['future date', { settledOn: '2999-01-01' }, 'PLATFORM_REMITTANCE_INVALID_DATE']
    ])('rejects %s before opening a transaction', async (_label, override, publicCode) => {
        const connection = {
            async query() { throw new Error('must not query'); },
            async beginTransaction() { throw new Error('must not begin'); }
        };
        const input = {
            actorId: 1,
            orderTypeId: 7,
            invoiceAllocations: [{ invoiceId: 1, balanceToken: 'a'.repeat(64), allocationAmount: '5.00' }],
            adjustments: [],
            netReceived: '5.00',
            settledOn: '2026-08-01',
            idempotencyKey: `strict-${_label.replace(/\s+/g, '-')}`,
            ...override
        };
        await expect(service.recordPlatformRemittance(connection, input)).rejects.toMatchObject({ publicCode });
    });
});

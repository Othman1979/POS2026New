const { allocateRefundPayment, combineFinancialEvents, buildComparison } = require('../../services/dailyReportBuilder');

describe('dailyReportMath', () => {
    it('puts a Tuesday refund against Tuesday without restating Monday sales', () => {
        expect(combineFinancialEvents(
            { sales_processed: 100, tax: 10, cash: 100, card: 0, orders: 2 },
            { refunds_issued: 20, tax_refunded: 2, refund_cash: 20, refund_card: 0 }
        )).toMatchObject({
            sales_collected: 80,
            net_revenue_pre_tax: 72,
            tax_collected: 8,
            cash_collected: 80,
            total_orders: 2,
            average_ticket: 50,
        });
    });

    it('returns null percent when prior comparison is zero', () => {
        expect(buildComparison({ sales_collected: 10 }, { sales_collected: 0 }).sales_collected)
            .toEqual({ amount: 10, percent: null });
    });

    it('allocates a split refund by the original frozen tender mix and preserves cents', () => {
        expect(allocateRefundPayment(
            { amount_refunded: 10.01, refund_method: 'split' },
            { total: 100, cash_amount: 60, card_amount: 40 }
        )).toEqual({ cash: 6.01, card: 4.00, platform: 0 });
    });

    it('keeps a platform refund out of cash and card while reducing platform sales', () => {
        expect(allocateRefundPayment(
            { amount_refunded: 5.8, refund_method: 'platform' },
            { total: 5.8, cash_amount: 0, card_amount: 0 }
        )).toEqual({ cash: 0, card: 0, platform: 5.8 });
        expect(combineFinancialEvents(
            { sales_processed: 5.8, tax: 0.8, cash: 0, card: 0, platform: 5.8, orders: 1 },
            { refunds_issued: 5.8, tax_refunded: 0.8, refund_cash: 0, refund_card: 0, refund_platform: 5.8 }
        )).toMatchObject({
            sales_collected: 0,
            tax_collected: 0,
            cash_collected: 0,
            card_collected: 0,
            platform_sales: 0,
            refund_platform: 5.8
        });
    });

    it('keeps order and item refund/void event counts available for truthful report labels', () => {
        expect(combineFinancialEvents(
            { sales_processed: 100, tax: 10, cash: 100, card: 0, orders: 1 },
            {
                refunds_issued: 20,
                tax_refunded: 2,
                refund_cash: 20,
                refund_order_count: 1,
                refund_item_count: 2,
                void_order_count: 3,
                void_item_count: 4,
            }
        )).toMatchObject({
            refund_count: 3,
            refund_order_count: 1,
            refund_item_count: 2,
            void_count: 7,
            void_order_count: 3,
            void_item_count: 4,
        });
    });
});

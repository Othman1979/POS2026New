import { describe, expect, it } from 'vitest';
import calculator from '../../services/PosCalculator.js';
import { posTotals } from '../../../src/utils/posTotals.js';

const { calculateExpectedTotals, exemptUnitPrice, stampLineTax } = calculator;

const expectChargedParity = ({ cart, orderDiscount, productMap, taxInclusive = false, taxExempt = false, pricesAlreadyExempt = false }) => {
    const frontend = posTotals(cart, orderDiscount, { taxInclusive, taxExempt, pricesAlreadyExempt });
    const backend = calculateExpectedTotals(
        {
            order_discount_type: orderDiscount.type,
            order_discount_value: orderDiscount.value
        },
        cart,
        productMap,
        taxInclusive,
        { taxExempt, pricesAlreadyExempt }
    );

    expect(frontend.subtotal).toBe(backend.subtotal);
    expect(frontend.tax).toBe(backend.tax);
    expect(frontend.total).toBe(backend.total);
    return { frontend, backend };
};

describe('posTotals charged-field parity with PosCalculator', () => {
    it('matches over a deterministic valid-input grid', () => {
        const prices = [0, 0.01, 1.005, 5, 12.345];
        const quantities = [0.25, 1, 2, 3];
        const lineDiscounts = [
            { type: null, value: 0 },
            { type: 'fixed', value: 0.5 },
            { type: 'percent', value: 10 },
            { type: 'percent', value: 100 }
        ];
        const rates = [0, 5, 16, 100];
        const orderDiscounts = [
            { type: null, value: 0 },
            { type: 'fixed', value: 0.5 },
            { type: 'percent', value: 0.5 },
            { type: 'percent', value: 25 },
            { type: 'percent', value: 100 }
        ];

        for (const price of prices) {
            for (const qty of quantities) {
                for (const lineDiscount of lineDiscounts) {
                    for (const taxRate of rates) {
                        for (const orderDiscount of orderDiscounts) {
                            for (const taxInclusive of [false, true]) {
                                const cart = [{
                                    product_id: 1,
                                    price,
                                    qty,
                                    tax_rate: taxRate,
                                    discountType: lineDiscount.type,
                                    discountValue: lineDiscount.value
                                }];
                                expectChargedParity({
                                    cart,
                                    orderDiscount,
                                    productMap: new Map([[1, { id: 1, tax_rate: taxRate }]]),
                                    taxInclusive
                                });
                            }
                        }
                    }
                }
            }
        }
    });

    it('matches a custom line whose frozen tax rate is the fallback authority', () => {
        expectChargedParity({
            cart: [{
                product_id: null,
                price: '7.500000',
                qty: '2.0000',
                tax_rate: '8.0000',
                discountType: 'fixed',
                discountValue: '0.5000'
            }],
            orderDiscount: { type: 'percent', value: 10 },
            productMap: new Map()
        });
    });

    it('matches seeded mixed multi-line carts', () => {
        let state = 0x5eed1234;
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 0x100000000;
        };
        const pick = (values) => values[Math.floor(random() * values.length)];
        const rates = [0, 5, 8, 16, 100];

        for (let caseIndex = 0; caseIndex < 1000; caseIndex += 1) {
            const productMap = new Map();
            const cart = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => {
                const custom = random() < 0.2;
                const productId = custom ? null : index + 1;
                const taxRate = pick(rates);
                if (!custom) productMap.set(productId, { id: productId, tax_rate: taxRate });
                return {
                    product_id: productId,
                    price: pick([0.01, 1.005, 2.5, 9.99, 12.345, 100]),
                    qty: pick([0.25, 0.5, 1, 2, 3]),
                    tax_rate: taxRate,
                    discountType: pick([null, 'fixed', 'percent']),
                    discountValue: pick([0, 0.01, 0.5, 10, 100])
                };
            });
            const orderDiscountType = pick([null, 'fixed', 'percent']);
            const orderDiscount = {
                type: orderDiscountType,
                value: orderDiscountType === null ? 0 : pick([0, 0.01, 0.5, 25, 100])
            };

            expectChargedParity({
                cart,
                orderDiscount,
                productMap,
                taxInclusive: random() < 0.5
            });
        }
    });

    it('uses NULL catalog tax as zero instead of client fallback tax', () => {
        const { backend } = expectChargedParity({
            cart: [{ product_id: 1, price: 10, qty: 1, tax_rate: null }],
            orderDiscount: { type: null, value: 0 },
            productMap: new Map([[1, { id: 1, tax_rate: null }]])
        });
        expect(backend.tax).toBe(0);
    });

    it('locks the known half-cent discount-display divergence without changing charges', () => {
        const { frontend, backend } = expectChargedParity({
            cart: [{ product_id: 1, price: 5, qty: 3, tax_rate: 16 }],
            orderDiscount: { type: 'percent', value: 0.5 },
            productMap: new Map([[1, { id: 1, tax_rate: 16 }]])
        });

        expect(frontend.discount).toBe(0.08);
        expect(backend.discount).toBe(0.07);
    });

    it('matches parity with modifier surcharge lines', () => {
        const { frontend, backend } = expectChargedParity({
            cart: [{
                product_id: 1,
                price: 7,
                qty: 3,
                tax_rate: 16,
                modifier_surcharge: 2,
                discountType: 'percent',
                discountValue: 10
            }],
            orderDiscount: { type: 'percent', value: 25 },
            productMap: new Map([[1, { id: 1, tax_rate: 16 }]])
        });
        expect(frontend.tax).toBe(backend.tax);
        expect(frontend.total).toBe(backend.total);
    });

    it('matches the exempt inclusive contract and preserves six-decimal source math', () => {
        const cart = [{
            product_id: 1,
            price: 20,
            qty: 1,
            tax_rate: 16
        }];
        const { frontend, backend } = expectChargedParity({
            cart,
            orderDiscount: { type: null, value: 0 },
            productMap: new Map([[1, { id: 1, tax_rate: 16 }]]),
            taxInclusive: true,
            taxExempt: true
        });
        expect(exemptUnitPrice(cart[0], 16, true)).toBe(17.241379);
        expect(frontend).toMatchObject({ subtotal: 17.24, tax: 0, total: 17.24 });
        expect(backend).toMatchObject({ subtotal: 17.24, tax: 0, total: 17.24 });
        expect(stampLineTax(cart[0], 16, 1, true, { taxExempt: true })).toBe(0);
    });

    it('does not divide an already-exempt persisted price a second time', () => {
        const { frontend, backend } = expectChargedParity({
            cart: [{ product_id: 1, price: 17.241379, qty: 1, tax_rate: 16 }],
            orderDiscount: { type: null, value: 0 },
            productMap: new Map([[1, { id: 1, tax_rate: 16 }]]),
            taxInclusive: true,
            taxExempt: true,
            pricesAlreadyExempt: true
        });
        expect(frontend).toMatchObject({ subtotal: 17.24, tax: 0, total: 17.24 });
        expect(backend).toMatchObject({ subtotal: 17.24, tax: 0, total: 17.24 });
    });

    it('keeps the generated Auto-Gratuity amount identical in both calculators', () => {
        const cart = [
            { product_id: 1, price: 20, qty: 1, tax_rate: 16 },
            { product_id: null, price: 1.72, qty: 1, tax_rate: 16, note: 'Auto-Gratuity' }
        ];
        const { frontend, backend } = expectChargedParity({
            cart,
            orderDiscount: { type: null, value: 0 },
            productMap: new Map([[1, { id: 1, price: 20, tax_rate: 16 }]]),
            taxInclusive: true,
            taxExempt: true
        });
        expect(frontend).toMatchObject({ subtotal: 18.96, tax: 0, total: 18.96 });
        expect(backend).toMatchObject({ subtotal: 18.96, tax: 0, total: 18.96 });
    });
});

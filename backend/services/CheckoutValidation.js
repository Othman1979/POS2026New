const { toFiniteNumber, roundMoney } = require('./PosCalculator');
const { validateCashAmount } = require('./CashValidation');

const MONEY_TOLERANCE = 0.02;
const moneyCents = value => Math.round((Number(value) + Number.EPSILON) * 100);
const paymentError = message => Object.assign(new Error(message), { statusCode: 400 });

const hasDiscountsInPayload = (data, cartItems) => {
    const hasOrderDiscount = data.order_discount_type && Number(data.order_discount_value) > 0;
    const hasItemDiscount = cartItems.some(item => item.discountType && Number(item.discountValue) > 0);
    return !!(hasOrderDiscount || hasItemDiscount);
};

const assertNearMoney = (label, submitted, expected) => {
    if (Math.abs(roundMoney(submitted) - roundMoney(expected)) > MONEY_TOLERANCE) {
        throw new Error(`${label} mismatch. Please refresh totals and try again.`);
    }
};

const normalizePaymentMethod = (method) => {
    const normalized = String(method || '').trim();
    if (!['cash', 'card', 'split'].includes(normalized)) {
        throw new Error('Invalid payment method.');
    }
    return normalized;
};

const validatePayments = (data, total) => {
    const paymentMethod = normalizePaymentMethod(data.payment_method);

    if (paymentMethod === 'cash') {
        const cashCheck = validateCashAmount(data.amount_tendered);
        if (!cashCheck.valid) {
            throw new Error(cashCheck.message);
        }
    }

    const amountTendered = toFiniteNumber(data.amount_tendered, 0);
    let cashAmount = toFiniteNumber(data.cash_amount, 0);
    let cardAmount = toFiniteNumber(data.card_amount, 0);
    const changeDue = toFiniteNumber(data.change_due, 0);

    if (cashAmount < 0 || cardAmount < 0 || amountTendered < 0 || changeDue < 0) {
        throw new Error('Payment amounts cannot be negative.');
    }

    if (paymentMethod === 'cash' && amountTendered + MONEY_TOLERANCE < total) {
        throw new Error('Amount tendered is less than the order total.');
    }

    if (paymentMethod === 'cash') {
        cashAmount = total;
        cardAmount = 0;
        assertNearMoney('Change due', changeDue, Math.max(0, amountTendered - total));
    }

    if (paymentMethod === 'card') {
        cardAmount = cardAmount > 0 ? cardAmount : total;
        cashAmount = 0;
        assertNearMoney('Card payment', cardAmount, total);
    }

    if (paymentMethod === 'split') {
        const totalCents = moneyCents(total);
        const cashCents = moneyCents(cashAmount);
        const cardCents = moneyCents(cardAmount);
        const tenderedCents = moneyCents(amountTendered);
        const changeCents = moneyCents(changeDue);
        if (cashCents <= 0 || cardCents <= 0) {
            throw paymentError('Both cash and card amounts are required for split payment.');
        }
        if (cashCents + cardCents !== totalCents) {
            throw paymentError('Split payment mismatch. Please refresh totals and try again.');
        }
        if (tenderedCents - cardCents < cashCents) {
            throw paymentError('Cash tendered is less than the split cash amount.');
        }
        const expectedChangeCents = tenderedCents - totalCents;
        if (changeCents !== expectedChangeCents) {
            throw paymentError('Change due mismatch. Please refresh totals and try again.');
        }
        cashAmount = cashCents / 100;
        cardAmount = cardCents / 100;
    }

    return { paymentMethod, amountTendered, cashAmount, cardAmount, changeDue };
};

module.exports = {
    hasDiscountsInPayload,
    assertNearMoney,
    validatePayments
};

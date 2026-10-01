const crypto = require('crypto');
const { getBusinessCalendarDate } = require('../utils/businessDate');
const {
    JOFOTARA_INVOICE_TYPE_NAMES,
    JOFOTARA_TAX_CATEGORIES,
    isSupportedJofotaraSalesTaxRate,
    resolveJofotaraSaleTaxCategory
} = require('../config/taxRegistration');

const EPSILON = 0.000000001;
const SALES_TAX = 'sales_tax';
const INCOME_TAX = 'income_tax';
const CASH = 'cash';
const RECEIVABLE = 'receivable';
const n = value => Number(value || 0);
const amount6 = value => n(value).toFixed(6);
const qty6 = value => n(value).toFixed(6);
const rate2 = value => n(value).toFixed(2);
const xmlEscape = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const round9 = value => Math.round((n(value) + Number.EPSILON) * 1e9) / 1e9;
const legalItemName = (item, index) => item.note === 'Auto-Gratuity'
    ? 'رسوم خدمة'
    : item.item_name || item.product_name || `Item ${index + 1}`;

function publicError(message, publicCode, statusCode = 422) {
    const error = new Error(message);
    error.publicCode = publicCode;
    error.statusCode = statusCode;
    return error;
}

function assertProfile(profile) {
    if (profile !== SALES_TAX && profile !== INCOME_TAX) {
        throw publicError('The saved tax-registration profile is invalid.', 'JOFOTARA_INVALID_PROFILE');
    }
    return profile;
}

function assertPaymentTerms(paymentTerms = CASH) {
    if (paymentTerms !== CASH && paymentTerms !== RECEIVABLE) {
        throw publicError('The saved invoice payment terms are invalid.', 'JOFOTARA_INVALID_PAYMENT_TERMS');
    }
    return paymentTerms;
}

function invoiceTypeName(profile, paymentTerms) {
    const normalizedProfile = assertProfile(profile);
    return JOFOTARA_INVOICE_TYPE_NAMES[normalizedProfile][assertPaymentTerms(paymentTerms)];
}

function invoiceBuyer(customer, paymentTerms, total) {
    const terms = assertPaymentTerms(paymentTerms);
    const buyer = {
        id: '0',
        name: String(customer?.name || '').trim(),
        phone: String(customer?.phone || '').trim(),
        address: String(customer?.address || '').trim()
    };
    if (terms === RECEIVABLE && !buyer.name) {
        throw publicError('A named buyer is required for receivable invoices.', 'JOFOTARA_RECEIVABLE_BUYER_REQUIRED');
    }
    if (n(total) > 10000 && !buyer.name) {
        throw publicError('A customer name is required for invoices above JOD 10,000.', 'JOFOTARA_CUSTOMER_REQUIRED');
    }
    return buyer;
}

function assertSupportedSalesTaxRates(items) {
    const unsupported = [...new Set((items || []).map(item => n(item.tax_rate)).filter(rate => !isSupportedJofotaraSalesTaxRate(rate)))];
    if (unsupported.length) {
        throw publicError(`Unsupported JoFotara sales-tax rate: ${unsupported.join(', ')}.`, 'JOFOTARA_UNSUPPORTED_RATE');
    }
}

function lineDiscount(item, unitPrice = n(item.price_at_sale)) {
    const qty = n(item.quantity);
    const gross = unitPrice * qty;
    const value = n(item.discount_value);
    if (item.discount_type === 'fixed') return Math.min(gross, value * qty);
    if (item.discount_type === 'percent') return gross * Math.min(100, Math.max(0, value)) / 100;
    return 0;
}

function orderDiscount(order, base) {
    const value = n(order.discount_value);
    if (order.discount_type === 'fixed') return Math.min(base, value);
    if (order.discount_type === 'percent') return base * Math.min(100, Math.max(0, value)) / 100;
    return 0;
}

function allocateOrderDiscount(lines, discount) {
    const base = lines.reduce((sum, line) => sum + line.afterLineDiscountBasis, 0);
    let assigned = 0;
    return lines.map((line, index) => {
        const share = index === lines.length - 1
            ? discount - assigned
            : (base > 0 ? round9(discount * line.afterLineDiscountBasis / base) : 0);
        assigned += share;
        return { ...line, orderDiscount: Math.max(0, share) };
    });
}

function reconcileLastLineExtension(lines, targetExtension, allowGrossIncrease = false, preserveAllowance = false) {
    const calculated = round9(lines.reduce((sum, line) => sum + line.extension, 0));
    const residue = round9(targetExtension - calculated);
    const maximumResidue = preserveAllowance && !allowGrossIncrease ? 0.005 + EPSILON : 0.02;
    if (Math.abs(residue) > maximumResidue) {
        throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }
    if (Math.abs(residue) <= EPSILON) return lines;

    let index = lines.length - 1;
    if (residue < 0 && lines[index].extension + residue < -EPSILON) {
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
            if (lines[candidate].extension + residue >= -EPSILON) {
                index = candidate;
                break;
            }
        }
    }
    const last = lines[index];
    const extension = round9(last.extension + residue);
    if (extension < -EPSILON || (!allowGrossIncrease && !preserveAllowance && extension - last.gross > EPSILON)) {
        throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }
    const gross = preserveAllowance
        ? round9(extension + last.allowance)
        : round9(Math.max(last.gross, extension));
    if (gross < -EPSILON || (!allowGrossIncrease && !preserveAllowance && gross - last.gross > EPSILON)) {
        throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }
    const allowance = preserveAllowance ? last.allowance : round9(gross - extension);
    const unitPrice = gross === last.gross ? last.unitPrice : round9(gross / last.quantity);
    const tax = round9(last.tax);
    lines[index] = {
        ...last,
        unitPrice,
        gross,
        allowance,
        extension,
        tax,
        payable: round9(extension + tax),
        taxRate: last.taxRate,
        taxCategory: last.taxCategory
    };
    return lines;
}

function buildSalesSnapshot({ order, items, customer, seller, paymentTerms = CASH }) {
    if (!order?.invoice_number) throw publicError('Invoice number is required.', 'JOFOTARA_INVALID_INVOICE');
    const parents = (items || []).filter(item => item.parent_item_id == null && n(item.quantity) > 0);
    if (!parents.length) throw publicError('Invoice has no financial lines.', 'JOFOTARA_INVALID_INVOICE');
    assertSupportedSalesTaxRates(parents);

    const inclusive = Number(order.tax_inclusive_at_sale) === 1;
    const taxExempt = Number(order.tax_exempt_at_sale) === 1;
    let lines = parents.map((item, index) => {
        const quantity = n(item.quantity);
        const gross = n(item.price_at_sale) * quantity;
        const modifierTax = item.modifier_tax_amount == null ? 0 : n(item.modifier_tax_amount) * quantity;
        const undiscountedNet = taxExempt
            ? gross
            : inclusive
            ? (n(item.tax_rate) > 0 ? gross / (1 + n(item.tax_rate) / 100) : gross)
            : Math.max(0, gross - modifierTax);
        const basisUnitPrice = taxExempt || !inclusive ? undiscountedNet / quantity : n(item.price_at_sale);
        const ownDiscount = Math.min(taxExempt || !inclusive ? undiscountedNet : gross, lineDiscount(item, basisUnitPrice));
        return {
            id: index + 1,
            itemName: legalItemName(item, index),
            quantity,
            gross,
            undiscountedNet,
            afterLineDiscountBasis: Math.max(0, (inclusive ? gross : undiscountedNet) - ownDiscount),
            lineDiscount: ownDiscount,
            taxRate: n(item.tax_rate),
            storedTax: n(item.tax_amount),
            modifierTaxPerUnit: item.modifier_tax_amount == null ? null : n(item.modifier_tax_amount),
            taxCategory: resolveJofotaraSaleTaxCategory(
                item.jofotara_tax_category,
                n(item.tax_rate),
                { taxExempt, taxRegistrationType: SALES_TAX }
            )
        };
    });
    const baseAfterLineDiscount = lines.reduce((sum, line) => sum + line.afterLineDiscountBasis, 0);
    lines = allocateOrderDiscount(lines, orderDiscount(order, baseAfterLineDiscount));

    const targetPayable = n(order.total);
    const reconcileStoredSplit = order.parent_invoice_id != null && (!inclusive || n(order.tax) > 0);
    let assignedPayable = 0;
    lines = lines.map((line, index) => {
        const discountedBasis = Math.max(0, line.afterLineDiscountBasis - line.orderDiscount);
        let extension;
        let tax;
        if (taxExempt) {
            extension = discountedBasis;
            tax = 0;
        } else if (inclusive) {
            extension = line.taxRate > 0 ? discountedBasis / (1 + line.taxRate / 100) : discountedBasis;
            tax = discountedBasis - extension;
        } else {
            extension = discountedBasis;
            tax = line.storedTax;
        }
        let payable = extension + tax;
        if (!reconcileStoredSplit && index === lines.length - 1 && Math.abs(targetPayable - (assignedPayable + payable)) <= 0.02) {
            const reconciliationDelta = targetPayable - (assignedPayable + payable);
            if (Math.abs(reconciliationDelta) > EPSILON) {
                if (taxExempt) {
                    // A persisted exempt sale can contain sub-cent line precision while
                    // its payable total is currency-rounded. Reconcile that difference
                    // as an allowance, never as negative tax on an exempt document.
                    extension += reconciliationDelta;
                    payable = extension;
                    tax = 0;
                } else if (line.taxCategory === JOFOTARA_TAX_CATEGORIES.STANDARD && line.taxRate > 0) {
                    payable += reconciliationDelta;
                    extension = payable / (1 + line.taxRate / 100);
                    tax = payable - extension;
                } else {
                    extension += reconciliationDelta;
                    payable = extension;
                    tax = 0;
                }
            }
        }
        assignedPayable += payable;
        const undiscountedNet = line.undiscountedNet;
        const legalGross = Math.max(undiscountedNet, extension);
        const effectiveTaxRate = taxExempt || line.taxCategory !== JOFOTARA_TAX_CATEGORIES.STANDARD ? 0 : line.taxRate;
        return {
            id: line.id,
            sourceItemId: parents[index]?.id == null ? null : Number(parents[index].id),
            itemName: line.itemName,
            quantity: round9(line.quantity),
            unitPrice: round9(legalGross / line.quantity),
            gross: round9(legalGross),
            allowance: round9(legalGross - extension),
            extension: round9(extension),
            tax: round9(tax),
            payable: round9(payable),
            taxRate: round9(effectiveTaxRate),
            taxCategory: taxExempt ? JOFOTARA_TAX_CATEGORIES.EXEMPT : line.taxCategory
        };
    });

    if (reconcileStoredSplit) {
        const targetTax = round9(order.tax);
        const calculatedTax = round9(lines.reduce((sum, line) => sum + line.tax, 0));
        if (Math.abs(calculatedTax - targetTax) > EPSILON) {
            throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
        }
        lines = reconcileLastLineExtension(lines, round9(targetPayable - targetTax), true);
    }

    const totals = lines.reduce((out, line) => ({
        taxExclusive: out.taxExclusive + line.gross,
        allowance: out.allowance + line.allowance,
        tax: out.tax + line.tax,
        payable: out.payable + line.payable
    }), { taxExclusive: 0, allowance: 0, tax: 0, payable: 0 });
    Object.keys(totals).forEach(key => { totals[key] = round9(totals[key]); });
    totals.taxInclusive = round9(totals.taxExclusive - totals.allowance + totals.tax);
    if (Math.abs(totals.payable - targetPayable) > 0.005) {
        throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }

    return {
        kind: 'invoice',
        taxRegistrationType: SALES_TAX,
        paymentTerms: assertPaymentTerms(paymentTerms),
        documentNumber: String(order.invoice_number),
        issueDate: getBusinessCalendarDate(order.invoice_issued_at || order.created_at),
        invoiceTypeName: invoiceTypeName(SALES_TAX, paymentTerms),
        note: order.note || '',
        seller: {
            incomeSourceSequence: String(seller.incomeSourceSequence || ''),
            taxNumber: String(seller.taxNumber || ''),
            registeredName: String(seller.registeredName || '')
        },
        customer: {
            ...invoiceBuyer(customer, paymentTerms, targetPayable),
            name: String(customer?.name || '').trim() || 'Cash customer'
        },
        lines,
        totals
    };
}

function buildIncomeSnapshot({ order, items, customer, seller, paymentTerms = CASH }) {
    if (!order?.invoice_number) throw publicError('Invoice number is required.', 'JOFOTARA_INVALID_INVOICE');
    const parents = (items || []).filter(item => item.parent_item_id == null && n(item.quantity) > 0);
    if (!parents.length) throw publicError('Invoice has no financial lines.', 'JOFOTARA_INVALID_INVOICE');

    let lines = parents.map((item, index) => {
        const quantity = n(item.quantity);
        const gross = round9(n(item.price_at_sale) * quantity);
        const ownDiscount = round9(Math.min(gross, lineDiscount(item, n(item.price_at_sale))));
        return {
            id: index + 1,
            sourceItemId: item.id == null ? null : Number(item.id),
            itemName: legalItemName(item, index),
            quantity: round9(quantity),
            unitPrice: round9(n(item.price_at_sale)),
            gross,
            lineDiscount: ownDiscount,
            afterLineDiscountBasis: round9(Math.max(0, gross - ownDiscount))
        };
    });
    const base = round9(lines.reduce((sum, line) => sum + line.afterLineDiscountBasis, 0));
    lines = allocateOrderDiscount(lines, round9(orderDiscount(order, base)));
    lines = lines.map(line => {
        const allowance = round9(line.lineDiscount + line.orderDiscount);
        const extension = round9(Math.max(0, line.gross - allowance));
        return { ...line, allowance, extension, tax: 0, payable: extension, taxRate: 0, taxCategory: 'Z' };
    });

    const targetPayable = round9(order.total);
    lines = reconcileLastLineExtension(lines, targetPayable, order.parent_invoice_id != null, true);
    lines = lines.map(({ lineDiscount: _lineDiscount, afterLineDiscountBasis: _basis, orderDiscount: _orderDiscount, ...line }) => line);
    const totals = lines.reduce((out, line) => ({
        taxExclusive: round9(out.taxExclusive + line.gross),
        allowance: round9(out.allowance + line.allowance),
        tax: 0,
        payable: round9(out.payable + line.payable)
    }), { taxExclusive: 0, allowance: 0, tax: 0, payable: 0 });
    totals.taxInclusive = totals.payable;
    if (Math.abs(totals.payable - targetPayable) > EPSILON) {
        throw publicError('Invoice lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }

    return {
        kind: 'invoice',
        taxRegistrationType: INCOME_TAX,
        paymentTerms: assertPaymentTerms(paymentTerms),
        documentNumber: String(order.invoice_number),
        issueDate: getBusinessCalendarDate(order.invoice_issued_at || order.created_at),
        invoiceTypeName: invoiceTypeName(INCOME_TAX, paymentTerms),
        note: order.note || '',
        seller: {
            incomeSourceSequence: String(seller.incomeSourceSequence || ''),
            taxNumber: String(seller.taxNumber || ''),
            registeredName: String(seller.registeredName || '')
        },
        customer: {
            ...invoiceBuyer(customer, paymentTerms, targetPayable),
            name: String(customer?.name || '').trim() || 'Cash customer'
        },
        lines,
        totals
    };
}

function buildInvoiceSnapshot({ profile, paymentTerms = CASH, ...source }) {
    return assertProfile(profile) === INCOME_TAX
        ? buildIncomeSnapshot({ ...source, paymentTerms })
        : buildSalesSnapshot({ ...source, paymentTerms });
}

function assertSnapshot(snapshot) {
    const sum = key => round9(snapshot.lines.reduce((total, line) => total + n(line[key]), 0));
    if (Math.abs(sum('gross') - snapshot.totals.taxExclusive) > EPSILON ||
        Math.abs(sum('allowance') - snapshot.totals.allowance) > EPSILON ||
        Math.abs(sum('tax') - snapshot.totals.tax) > EPSILON ||
        Math.abs(sum('payable') - snapshot.totals.payable) > EPSILON) {
        throw publicError('Legal snapshot totals are inconsistent.', 'JOFOTARA_TOTAL_MISMATCH');
    }
}

function groupedSalesTaxSubtotals(lines) {
    const groups = new Map();
    for (const line of lines) {
        const key = `${line.taxCategory}:${rate2(line.taxRate)}`;
        const group = groups.get(key) || { category: line.taxCategory, rate: line.taxRate, taxable: 0, tax: 0 };
        group.taxable = round9(group.taxable + line.extension);
        group.tax = round9(group.tax + line.tax);
        groups.set(key, group);
    }
    return [...groups.values()];
}

function renderSalesInvoiceXml(snapshot, { uuid, icv }, { creditNote = false } = {}) {
    assertSnapshot(snapshot);
    const x = xmlEscape;
    const lines = snapshot.lines.map(line => `  <cac:InvoiceLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${qty6(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="JO">${amount6(line.extension)}</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="JO">${amount6(line.tax)}</cbc:TaxAmount><cbc:RoundingAmount currencyID="JO">${amount6(line.payable)}</cbc:RoundingAmount><cac:TaxSubtotal>${creditNote ? `<cbc:TaxableAmount currencyID="JO">${amount6(line.extension)}</cbc:TaxableAmount>` : ''}<cbc:TaxAmount currencyID="JO">${amount6(line.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${line.taxCategory}</cbc:ID><cbc:Percent>${rate2(line.taxRate)}</cbc:Percent><cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
    <cac:Item><cbc:Name>${x(line.itemName)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="JO">${amount6(line.unitPrice)}</cbc:PriceAmount>${creditNote ? '<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>' : ''}<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">${amount6(line.allowance)}</cbc:Amount></cac:AllowanceCharge></cac:Price>
  </cac:InvoiceLine>`).join('\n');
    const reference = creditNote
        ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${x(snapshot.original.documentNumber)}</cbc:ID><cbc:UUID>${x(snapshot.original.uuid)}</cbc:UUID><cbc:DocumentDescription>${amount6(snapshot.original.payable)}</cbc:DocumentDescription></cac:InvoiceDocumentReference></cac:BillingReference>\n`
        : '';
    const paymentInstruction = creditNote ? `<cbc:InstructionNote>${x(snapshot.reason)}</cbc:InstructionNote>` : '';
    const documentTax = creditNote
        ? `<cac:TaxTotal><cbc:TaxAmount currencyID="JO">${amount6(snapshot.totals.tax)}</cbc:TaxAmount>${groupedSalesTaxSubtotals(snapshot.lines).map(group => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="JO">${amount6(group.taxable)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="JO">${amount6(group.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${group.category}</cbc:ID><cbc:Percent>${rate2(group.rate)}</cbc:Percent><cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join('')}</cac:TaxTotal>`
        : `<cac:TaxTotal><cbc:TaxAmount currencyID="JO">${amount6(snapshot.totals.tax)}</cbc:TaxAmount></cac:TaxTotal>`;
    const prepaid = creditNote ? `<cbc:PrepaidAmount currencyID="JO">0.000000</cbc:PrepaidAmount>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID><cbc:ID>${x(snapshot.documentNumber)}</cbc:ID><cbc:UUID>${x(uuid)}</cbc:UUID><cbc:IssueDate>${x(snapshot.issueDate)}</cbc:IssueDate><cbc:InvoiceTypeCode name="${x(snapshot.invoiceTypeName)}">${creditNote ? '381' : '388'}</cbc:InvoiceTypeCode><cbc:Note>${x(snapshot.note)}</cbc:Note><cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>
${reference}  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${x(icv)}</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${x(snapshot.seller.taxNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${x(snapshot.seller.registeredName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="TN">${x(snapshot.customer.id)}</cbc:ID></cac:PartyIdentification><cac:PostalAddress><cbc:PostalZone/><cbc:CountrySubentityCode/><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${x(snapshot.customer.id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${x(snapshot.customer.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party><cac:AccountingContact><cbc:Telephone>${x(snapshot.customer.phone)}</cbc:Telephone></cac:AccountingContact></cac:AccountingCustomerParty>
  <cac:SellerSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${x(snapshot.seller.incomeSourceSequence)}</cbc:ID></cac:PartyIdentification></cac:Party></cac:SellerSupplierParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>${paymentInstruction}</cac:PaymentMeans>
  <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">${amount6(snapshot.totals.allowance)}</cbc:Amount></cac:AllowanceCharge>
  ${documentTax}
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="JO">${amount6(snapshot.totals.taxExclusive)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="JO">${amount6(snapshot.totals.taxInclusive)}</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount currencyID="JO">${amount6(snapshot.totals.allowance)}</cbc:AllowanceTotalAmount>${prepaid}<cbc:PayableAmount currencyID="JO">${amount6(snapshot.totals.payable)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
}

function renderIncomeCustomer(customer) {
    const x = xmlEscape;
    const identification = `<cac:PartyIdentification><cbc:ID schemeID="TN">${x(customer?.id || '0')}</cbc:ID></cac:PartyIdentification>`;
    const taxScheme = `<cac:PartyTaxScheme><cbc:CompanyID>${x(customer?.id || '0')}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`;
    const legalEntity = customer?.name
        ? `<cac:PartyLegalEntity><cbc:RegistrationName>${x(customer.name)}</cbc:RegistrationName></cac:PartyLegalEntity>`
        : '';
    const contact = customer?.phone
        ? `<cac:AccountingContact><cbc:Telephone>${x(customer.phone)}</cbc:Telephone></cac:AccountingContact>`
        : '';
    return `<cac:AccountingCustomerParty><cac:Party>${identification}<cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>${taxScheme}${legalEntity}</cac:Party>${contact}</cac:AccountingCustomerParty>`;
}

function renderIncomeXml(snapshot, { uuid, icv }, { creditNote = false } = {}) {
    assertSnapshot(snapshot);
    if (assertProfile(snapshot.taxRegistrationType) !== INCOME_TAX) {
        throw publicError('Income-tax XML requires an income-tax snapshot.', 'JOFOTARA_INVALID_PROFILE');
    }
    const x = xmlEscape;
    const reference = creditNote
        ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${x(snapshot.original.documentNumber)}</cbc:ID><cbc:UUID>${x(snapshot.original.uuid)}</cbc:UUID><cbc:DocumentDescription>${amount6(snapshot.original.payable)}</cbc:DocumentDescription></cac:InvoiceDocumentReference></cac:BillingReference>\n`
        : '';
    const instruction = creditNote ? `<cbc:InstructionNote>${x(snapshot.reason)}</cbc:InstructionNote>` : '';
    const lines = snapshot.lines.map(line => `  <cac:InvoiceLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${qty6(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="JO">${amount6(line.extension)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${x(line.itemName)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="JO">${amount6(line.unitPrice)}</cbc:PriceAmount><cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">${amount6(line.allowance)}</cbc:Amount></cac:AllowanceCharge></cac:Price>
  </cac:InvoiceLine>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID><cbc:ID>${x(snapshot.documentNumber)}</cbc:ID><cbc:UUID>${x(uuid)}</cbc:UUID><cbc:IssueDate>${x(snapshot.issueDate)}</cbc:IssueDate><cbc:InvoiceTypeCode name="${x(snapshot.invoiceTypeName)}">${creditNote ? '381' : '388'}</cbc:InvoiceTypeCode><cbc:Note>${x(snapshot.note)}</cbc:Note><cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>
${reference}  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${x(icv)}</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${x(snapshot.seller.taxNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${x(snapshot.seller.registeredName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  ${renderIncomeCustomer(snapshot.customer)}
  <cac:SellerSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${x(snapshot.seller.incomeSourceSequence)}</cbc:ID></cac:PartyIdentification></cac:Party></cac:SellerSupplierParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>${instruction}</cac:PaymentMeans>
  <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">${amount6(snapshot.totals.allowance)}</cbc:Amount></cac:AllowanceCharge>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="JO">${amount6(snapshot.totals.taxExclusive)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="JO">${amount6(snapshot.totals.taxInclusive)}</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount currencyID="JO">${amount6(snapshot.totals.allowance)}</cbc:AllowanceTotalAmount><cbc:PayableAmount currencyID="JO">${amount6(snapshot.totals.payable)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
}

function renderInvoiceXml(snapshot, identity) {
    return assertProfile(snapshot?.taxRegistrationType) === INCOME_TAX
        ? renderIncomeXml(snapshot, identity)
        : renderSalesInvoiceXml(snapshot, identity);
}

function buildCreditNoteSnapshot({ profile, refund, refundItems, originalSnapshot, originalDocument, seller }) {
    if (!refund || refund.kind !== 'refund') throw publicError('Saved refund is required.', 'JOFOTARA_INVALID_REFUND');
    const reason = String(refund.reason || '').trim() || 'إرجاع فاتورة';
    if (!originalSnapshot?.documentNumber || !originalSnapshot?.totals || !originalDocument?.document_uuid) {
        throw publicError('Accepted original invoice reference is required.', 'JOFOTARA_ORIGINAL_REQUIRED');
    }
    const frozenProfile = assertProfile(profile || originalSnapshot?.taxRegistrationType || SALES_TAX);
    if (originalSnapshot?.taxRegistrationType && originalSnapshot.taxRegistrationType !== frozenProfile) {
        throw publicError('The return profile does not match the original invoice.', 'JOFOTARA_INVALID_PROFILE');
    }
    if (originalDocument?.tax_registration_type && originalDocument.tax_registration_type !== frozenProfile) {
        throw publicError('The return profile does not match the original document.', 'JOFOTARA_INVALID_PROFILE');
    }
    const originalById = new Map((originalSnapshot?.lines || []).filter(line => line.sourceItemId != null).map(line => [Number(line.sourceItemId), line]));
    const paymentTerms = originalSnapshot?.paymentTerms
        || (originalSnapshot?.invoiceTypeName === JOFOTARA_INVOICE_TYPE_NAMES[frozenProfile].receivable ? RECEIVABLE
            : originalSnapshot?.invoiceTypeName === JOFOTARA_INVOICE_TYPE_NAMES[frozenProfile].cash ? CASH : null);
    if (!paymentTerms) throw publicError('The original invoice payment terms are invalid.', 'JOFOTARA_INVALID_PAYMENT_TERMS');
    const lines = (refundItems || []).filter(item => n(item.quantity) > 0).map(item => {
        const originalLine = originalById.get(Number(item.order_item_id));
        if (!originalLine) throw publicError('Every return line must match the accepted original invoice.', 'JOFOTARA_ORIGINAL_LINE_REQUIRED');
        if (n(item.quantity) + n(item.previously_returned_quantity) - n(originalLine.quantity) > EPSILON) {
            throw publicError('Returned quantity exceeds the original invoice quantity.', 'JOFOTARA_INVALID_REFUND');
        }
        const ratio = n(item.quantity) / n(originalLine.quantity);
        const gross = n(originalLine.unitPrice) * n(item.quantity);
        const extension = n(originalLine.extension) * ratio;
        const taxCategory = originalLine.taxCategory === 'E' ? 'Z' : originalLine.taxCategory;
        if (!['Z', 'O', 'S'].includes(taxCategory)) throw publicError('The accepted original tax category is invalid.', 'JOFOTARA_ORIGINAL_LINE_REQUIRED');
        const tax = frozenProfile === INCOME_TAX || taxCategory !== 'S' ? 0 : n(originalLine.tax) * ratio;
        return {
            id: originalLine.id,
            itemName: originalLine.itemName,
            quantity: round9(item.quantity),
            unitPrice: round9(originalLine.unitPrice),
            gross: round9(gross),
            allowance: round9(Math.max(0, gross - extension)),
            extension: round9(extension),
            tax: round9(tax),
            payable: round9(extension + tax),
            taxRate: taxCategory === 'S' ? round9(originalLine.taxRate) : 0,
            taxCategory
        };
    });
    if (!lines.length) throw publicError('Refund has no financial lines.', 'JOFOTARA_INVALID_REFUND');
    const totals = lines.reduce((out, line) => ({
        taxExclusive: round9(out.taxExclusive + line.gross),
        allowance: round9(out.allowance + line.allowance),
        tax: round9(out.tax + line.tax),
        payable: round9(out.payable + line.payable)
    }), { taxExclusive: 0, allowance: 0, tax: 0, payable: 0 });
    totals.taxInclusive = round9(totals.taxExclusive - totals.allowance + totals.tax);
    if (Math.abs(totals.payable - n(refund.amount_refunded)) > 0.005) {
        throw publicError('Refund lines do not reconcile with the saved total.', 'JOFOTARA_TOTAL_MISMATCH');
    }
    return {
        kind: 'credit_note',
        taxRegistrationType: frozenProfile,
        documentNumber: `R-${originalSnapshot.documentNumber}-${refund.id}`,
        issueDate: getBusinessCalendarDate(refund.created_at),
        invoiceTypeName: JOFOTARA_INVOICE_TYPE_NAMES[frozenProfile][paymentTerms],
        paymentTerms,
        note: originalSnapshot.note || reason,
        reason,
        seller: originalSnapshot.seller || seller,
        customer: frozenProfile === INCOME_TAX && !originalSnapshot.customer?.name
            ? { ...originalSnapshot.customer, name: 'Cash customer' }
            : originalSnapshot.customer,
        original: {
            documentNumber: originalSnapshot.documentNumber,
            uuid: originalDocument.document_uuid,
            payable: originalSnapshot.totals.payable
        },
        lines,
        totals
    };
}

function renderCreditNoteXml(snapshot, identity) {
    if (!snapshot.original?.documentNumber || !snapshot.original?.uuid) {
        throw publicError('Accepted original invoice reference is required.', 'JOFOTARA_ORIGINAL_REQUIRED');
    }
    if (assertProfile(snapshot.taxRegistrationType || SALES_TAX) === INCOME_TAX) {
        return renderIncomeXml(snapshot, identity, { creditNote: true });
    }
    return renderSalesInvoiceXml(snapshot, identity, { creditNote: true });
}

function previewIdentity(invoiceId) {
    const hex = crypto.createHash('sha256').update(`jofotara-preview:${invoiceId}`).digest('hex');
    return { uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`, icv: String(invoiceId) };
}

module.exports = {
    amount6, qty6, rate2, xmlEscape, buildInvoiceSnapshot, buildSalesSnapshot, renderInvoiceXml,
    renderSalesInvoiceXml, buildCreditNoteSnapshot, renderCreditNoteXml, previewIdentity, publicError
};

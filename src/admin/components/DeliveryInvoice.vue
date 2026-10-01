<template>
    <div class="delivery-invoice-overlay w-full max-w-[210mm] mx-auto select-none bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[95vh] text-zinc-100">
        <!-- Action Bar (Not Printed) -->
        <div class="flex items-center justify-between px-5 py-3.5 bg-zinc-950/80 border-b border-zinc-800 print:hidden select-none shrink-0">
            <div class="flex items-center gap-2.5">
                <i class="fa-solid fa-truck text-teal-400 text-sm"></i>
                <h3 class="font-semibold text-sm text-zinc-100">{{ $t('Delivery Invoice') }}</h3>
            </div>
            <div class="flex items-center gap-2.5">
                <button @click="printInvoice" class="h-9 px-3.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 hover:text-white font-medium rounded-lg text-xs flex items-center gap-1.5 transition-colors focus:outline-none">
                    <i class="fa-solid fa-print text-[11px]"></i>
                    <span>{{ $t('Print') }}</span>
                </button>
                <button @click="downloadInvoicePdf" class="h-9 px-3.5 bg-teal-600 hover:bg-teal-700 text-white font-medium rounded-lg text-xs flex items-center gap-1.5 transition-colors focus:outline-none disabled:opacity-60" :disabled="pdfLoading">
                    <i v-if="pdfLoading" class="fa-solid fa-circle-notch fa-spin text-[11px]"></i>
                    <i v-else class="fa-solid fa-file-pdf text-[11px]"></i>
                    <span>{{ pdfLoading ? $t('Generating...') : $t('Download PDF') }}</span>
                </button>
                <div class="h-5 w-px bg-zinc-800 mx-0.5"></div>
                <button @click="$emit('close')" :aria-label="$t('Close')" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:text-white hover:bg-zinc-800 rounded-lg transition-colors focus:outline-none">
                    <i class="fa-solid fa-xmark text-lg"></i>
                </button>
            </div>
        </div>

        <!-- Document Viewer (Scrollable on Screen) -->
        <div class="flex-1 overflow-y-auto p-6 bg-zinc-950/50 print:bg-white premium-scroll flex justify-center">
            <!-- Printable A4 document sheet -->
            <div ref="invoiceRef" class="a4-sheet doc-bg-white doc-text-dark text-[11px] leading-relaxed p-[20mm] flex flex-col justify-between" :dir="isRtl ? 'rtl' : 'ltr'">
                <div>
                    <!-- Header Block -->
                    <div class="flex justify-between items-start mb-10 select-none">
                        <div>
                            <h1 class="text-lg font-extrabold tracking-tight uppercase leading-none doc-text-dark mb-2" data-no-i18n>
                                {{ storeSettings?.store_name || $t('Store Name') }}
                            </h1>
                            <div class="text-[9px] mt-1 space-y-0.5 doc-text-muted" data-no-i18n>
                                <p>{{ storeSettings?.store_address || '' }}</p>
                                <p v-if="storeSettings?.store_phone">{{ $t('Tel:') }} {{ storeSettings.store_phone }}</p>
                                <p v-if="taxNumber">{{ $t('Seller tax number') }}: <span data-no-i18n>{{ taxNumber }}</span></p>
                            </div>
                        </div>
                        <div class="text-right rtl:text-left">
                            <h2 class="text-2xl font-black leading-none mb-1 tracking-widest doc-text-dark uppercase">{{ $t('DELIVERY INVOICE') }}</h2>
                        </div>
                    </div>

                    <!-- Billing & Shipment Editable Details -->
                    <div class="grid grid-cols-12 gap-6 mb-8 text-[10px] doc-text-main">
                        <div class="col-span-4">
                            <h3 class="font-bold mb-2 doc-text-dark text-[10px] select-none uppercase tracking-wider">{{ $t('BILL TO') }}</h3>
                            <div class="space-y-1">
                                <div class="flex items-center gap-1.5">
                                    <span class="doc-text-light select-none">{{ $t('Name:') }}</span>
                                    <div 
                                        contenteditable="true" 
                                        class="editable-field font-semibold px-1 flex-1 doc-text-dark"
                                        :data-placeholder="$t('Add name...')"
                                        @blur="customerName = $event.target.innerText.trim()"
                                        data-no-i18n
                                    >{{ customerName }}</div>
                                </div>
                                <div class="flex items-center gap-1.5">
                                    <span class="doc-text-light select-none">{{ $t('Tel:') }}</span>
                                    <div 
                                        contenteditable="true" 
                                        class="editable-field px-1 flex-1 doc-text-dark"
                                        :data-placeholder="$t('Add telephone...')"
                                        @blur="customerPhone = $event.target.innerText.trim()"
                                        data-no-i18n
                                    >{{ customerPhone }}</div>
                                </div>
                                <div class="flex items-start gap-1.5">
                                    <span class="doc-text-light select-none shrink-0 mt-0.5">{{ $t('Address:') }}</span>
                                    <div 
                                        contenteditable="true" 
                                        class="editable-field px-1 flex-1 doc-text-dark leading-tight"
                                        :data-placeholder="$t('Add billing address...')"
                                        @blur="customerAddress = $event.target.innerText.trim()"
                                        data-no-i18n
                                    >{{ customerAddress }}</div>
                                </div>
                            </div>
                        </div>
                        <div class="col-span-4">
                            <h3 class="font-bold mb-2 doc-text-dark text-[10px] select-none uppercase tracking-wider">{{ $t('SHIP TO') }}</h3>
                            <div class="space-y-1">
                                <div class="flex items-start gap-1.5">
                                    <span class="doc-text-light select-none shrink-0 mt-0.5">{{ $t('Address:') }}</span>
                                    <div 
                                        contenteditable="true" 
                                        class="editable-field px-1 flex-1 doc-text-dark leading-tight"
                                        :data-placeholder="$t('Add shipping address...')"
                                        @blur="shippingAddress = $event.target.innerText.trim()"
                                        data-no-i18n
                                    >{{ shippingAddress }}</div>
                                </div>
                                <div class="flex items-center gap-1.5 select-none pt-0.5 doc-text-muted">
                                    <span>{{ $t('Courier/Fulfillment:') }}</span>
                                    <span class="font-semibold capitalize doc-text-dark" data-no-i18n>{{ $t(order?.order_type_name || 'Delivery') }}</span>
                                </div>
                            </div>
                        </div>
                        <div class="col-span-4 flex justify-end">
                            <table class="w-full max-w-[200px] border-collapse text-[9px] doc-text-muted">
                                <tbody>
                                    <tr>
                                        <td class="font-bold py-0.5 text-left rtl:text-right pr-2 select-none">{{ $t(documentIdentityTitleKey) }}</td>
                                        <td class="text-right rtl:text-left py-0.5 font-mono doc-text-dark" data-no-i18n>{{ documentIdentityLabel }}</td>
                                    </tr>
                                    <tr>
                                        <td class="font-bold py-0.5 text-left rtl:text-right pr-2 select-none">{{ $t('Source Doc') }}</td>
                                        <td class="text-right rtl:text-left py-0.5 font-mono doc-text-dark" data-no-i18n>Order #{{ order?.order_display_no || order?.order_id }}</td>
                                    </tr>
                                    <tr>
                                        <td class="font-bold py-0.5 text-left rtl:text-right pr-2 select-none">{{ $t('Date') }}</td>
                                        <td class="text-right rtl:text-left py-0.5 font-mono doc-text-dark" data-no-i18n>{{ formatDate(order?.created_at) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Legacy Warning Banner -->
                    <div v-if="order?.receipt_display_legacy_reason" class="mb-6 p-2 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[9px] flex items-center gap-1.5 print:hidden">
                        <i class="fa-solid fa-triangle-exclamation text-amber-600"></i>
                        <span class="font-bold">{{ $t('Historical Receipt Format:') }}</span>
                        <span>{{ $t('Created under a historical catalog version. Displaying fallback format.') }}</span>
                    </div>

                    <!-- Items list -->
                    <table class="invoice-table text-[10px] mb-6">
                        <thead>
                            <tr class="select-none">
                                <th class="text-center w-10 font-bold">#</th>
                                <th class="text-left rtl:text-right font-bold">{{ $t('DESCRIPTION') }}</th>
                                <th class="text-right rtl:text-left font-bold w-16">{{ $t('QTY') }}</th>
                                <th class="text-right rtl:text-left font-bold w-24">{{ $t('UNIT PRICE') }}</th>
                                <th class="text-right rtl:text-left font-bold w-28">{{ $t('AMOUNT') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <!-- Presentation rows (v1) -->
                            <template v-if="presentation">
                                <tr v-for="(row, idx) in presentation.rows" :key="row.key" class="doc-row transition-colors">
                                    <!-- Bundle children are descriptive, not financial: indented name, no number/money (mirrors the thermal renderers). -->
                                    <td class="text-center font-medium doc-text-light tabular-nums" data-no-i18n>{{ row.kind === 'bundle_child' ? '' : presentation.rows.slice(0, idx + 1).filter(r => r.kind !== 'bundle_child').length }}</td>
                                    <td>
                                        <div v-if="row.kind === 'bundle_child'" class="ps-4 doc-text-light" data-no-i18n>&bull; {{ row.name }} x{{ row.qty }}</div>
                                        <div v-else class="font-semibold doc-text-dark" data-no-i18n>{{ row.name }}</div>
                                        <div v-if="row.note" class="text-[8px] italic mt-0.5 doc-text-light" :class="row.kind === 'bundle_child' ? 'ps-4' : ''" data-no-i18n>- {{ row.note }}</div>
                                        <div v-if="row.lineDiscountAmount > 0" class="text-[8px] text-yellow-700 font-semibold" data-no-i18n>{{ row.lineDiscountLabel ? `${row.lineDiscountLabel} Off (-${Number(row.lineDiscountAmount).toFixed(2)} JD)` : `-${Number(row.lineDiscountAmount).toFixed(2)} JD` }}</div>
                                    </td>
                                    <td class="text-right rtl:text-left font-semibold tabular-nums" data-no-i18n>{{ row.kind === 'bundle_child' ? '' : row.qty }}</td>
                                    <td class="text-right rtl:text-left font-mono tabular-nums" data-no-i18n>{{ row.kind === 'bundle_child' ? '' : Number(row.unitPrice).toFixed(2) }}</td>
                                    <td class="text-right rtl:text-left font-semibold font-mono tabular-nums" data-no-i18n>{{ row.kind === 'bundle_child' ? '' : Number(row.netAmount).toFixed(2) }}</td>
                                </tr>
                            </template>
                            <!-- Legacy rows -->
                            <template v-else>
                                <tr v-for="(item, idx) in items" :key="item.id" class="doc-row transition-colors">
                                    <td class="text-center font-medium doc-text-light tabular-nums" data-no-i18n>{{ idx + 1 }}</td>
                                    <td>
                                        <div class="font-semibold doc-text-dark" data-no-i18n>{{ item.product_name || $t('Unknown Item') }}</div>
                                        <div v-if="item.note" class="text-[8px] italic mt-0.5 doc-text-light" data-no-i18n>- {{ item.note }}</div>
                                        <div v-if="receiptItemDisplayTotal(item) < (item.quantity * item.price_at_sale)" class="text-[8px] text-yellow-700 font-semibold" data-no-i18n>-{{ Number((item.quantity * item.price_at_sale) - receiptItemDisplayTotal(item)).toFixed(2) }} JD</div>
                                    </td>
                                    <td class="text-right rtl:text-left font-semibold tabular-nums" data-no-i18n>{{ item.quantity }}</td>
                                    <td class="text-right rtl:text-left font-mono tabular-nums" data-no-i18n>{{ Number(item.price_at_sale || 0).toFixed(2) }}</td>
                                    <td class="text-right rtl:text-left font-semibold font-mono tabular-nums" data-no-i18n>{{ receiptItemDisplayTotal(item).toFixed(2) }}</td>
                                </tr>
                            </template>
                        </tbody>
                    </table>

                    <!-- Totals & Delivery Cost (Grid aligned like receipt) -->
                    <div class="flex justify-end mb-6 select-none">
                        <table class="w-64 border-collapse text-[10px] doc-text-main">
                            <!-- Presentation summary (v1) -->
                            <tbody v-if="presentation">
                                <tr v-if="presentation.taxMode !== 'inclusive'">
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Subtotal:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted w-28" data-no-i18n>{{ Number(presentation.summary.subtotal).toFixed(2) }} JD</td>
                                </tr>
                                <tr v-if="presentation.taxMode !== 'inclusive'">
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Tax:') }}</td>
                                    <td v-if="presentation.summary.taxLabel" class="py-1.5 px-3 text-right rtl:text-left italic border-l doc-border-muted">{{ $t(presentation.summary.taxLabel) }}</td>
                                    <td v-else class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" data-no-i18n>{{ Number(presentation.summary.taxAmount).toFixed(2) }} JD</td>
                                </tr>
                                <tr v-if="presentation.summary.orderDiscountAmount > 0">
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ presentation.summary.orderDiscountLabel ? `${$t('Discount')} (${presentation.summary.orderDiscountLabel}):` : $t('Discount:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" data-no-i18n>-{{ Number(presentation.summary.orderDiscountAmount).toFixed(2) }} JD</td>
                                </tr>
                                <tr v-if="presentation.summary.roundingAdjustment !== 0">
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Rounding:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" data-no-i18n>{{ presentation.summary.roundingAdjustment > 0 ? '+' : '' }}{{ Number(presentation.summary.roundingAdjustment).toFixed(2) }} JD</td>
                                </tr>
                                <!-- Shipping/Delivery Cost -->
                                <tr>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Shipping Cost:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" style="padding: 2px 12px;">
                                        <div 
                                            contenteditable="true" 
                                            class="editable-field text-right font-mono font-semibold px-1 min-w-[50px] inline-block doc-text-dark shipping-input-editable"
                                            @blur="handleShippingBlur"
                                            @keydown.enter.prevent="$event.target.blur()"
                                            data-no-i18n
                                        >{{ Number(shippingCost).toFixed(2) }}</div>
                                        <span class="ml-1 doc-text-muted select-none">JD</span>
                                    </td>
                                </tr>
                                <!-- Grand Total Block -->
                                <tr>
                                    <td class="py-2 px-3 text-right rtl:text-left font-bold text-xs uppercase pr-4 select-none">{{ $t('TOTAL:') }}</td>
                                    <td class="py-2 px-3 text-right rtl:text-left font-bold text-xs font-mono border doc-border-muted doc-bg-light" data-no-i18n>{{ grandTotal.toFixed(2) }} JD</td>
                                </tr>
                            </tbody>
                            <!-- Legacy summary -->
                            <tbody v-else>
                                <tr>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Subtotal:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted w-28" data-no-i18n>{{ Number(order?.subtotal || 0).toFixed(2) }} JD</td>
                                </tr>
                                <tr>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Tax:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" data-no-i18n>{{ Number(order?.tax || 0).toFixed(2) }} JD</td>
                                </tr>
                                <tr v-if="Number(order?.discount_value || 0) > 0">
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Discount:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" data-no-i18n>{{ order?.discount_type === 'percent' ? '-' + Number(order?.discount_value) + '%' : '-' + Number(order?.discount_value).toFixed(2) + ' JD' }}</td>
                                </tr>
                                <!-- Shipping/Delivery Cost -->
                                <tr>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-semibold pr-4 select-none">{{ $t('Shipping Cost:') }}</td>
                                    <td class="py-1.5 px-3 text-right rtl:text-left font-mono border-l doc-border-muted" style="padding: 2px 12px;">
                                        <div 
                                            contenteditable="true" 
                                            class="editable-field text-right font-mono font-semibold px-1 min-w-[50px] inline-block doc-text-dark shipping-input-editable"
                                            @blur="handleShippingBlur"
                                            @keydown.enter.prevent="$event.target.blur()"
                                            data-no-i18n
                                        >{{ Number(shippingCost).toFixed(2) }}</div>
                                        <span class="ml-1 doc-text-muted select-none">JD</span>
                                    </td>
                                </tr>
                                <!-- Grand Total Block -->
                                <tr>
                                    <td class="py-2 px-3 text-right rtl:text-left font-bold text-xs uppercase pr-4 select-none">{{ $t('TOTAL:') }}</td>
                                    <td class="py-2 px-3 text-right rtl:text-left font-bold text-xs font-mono border doc-border-muted doc-bg-light" data-no-i18n>{{ grandTotal.toFixed(2) }} JD</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Invoice Notes (Editable) -->
                    <div class="border-l-4 rounded-r p-3 min-h-[50px] mb-6 leading-relaxed shadow-[0_1px_1px_rgba(0,0,0,0.01)] doc-border-muted doc-bg-light">
                        <span class="font-bold text-[9px] uppercase tracking-wider block mb-1 select-none doc-text-muted">{{ $t('Notes') }}</span>
                        <div 
                            contenteditable="true" 
                            class="editable-field text-[10px] outline-none w-full min-h-[20px] doc-text-main"
                            :data-placeholder="$t('Click to add delivery instructions, courier details...')"
                            @blur="notes = $event.target.innerText.trim()"
                            data-no-i18n
                        >{{ notes }}</div>
                    </div>
                </div>

                <!-- Footer Section (Terms & Signature block) -->
                <div class="mt-auto pt-8 border-t doc-border-light flex justify-between items-end select-none">
                    <div class="text-[9px] doc-text-muted space-y-1">
                        <h4 class="font-bold doc-text-dark uppercase tracking-wider text-[8px]">{{ $t('Terms & Conditions') }}</h4>
                        <p>{{ $t('Thank you for your business.') }}</p>
                    </div>
                    <!-- Signature area -->
                    <div class="text-center w-40 border-t doc-border-muted pt-1">
                        <span class="text-[9px] font-semibold doc-text-muted uppercase tracking-wider">{{ $t('Authorized Signature') }}</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { formatBusinessDate } from '@/utils/businessDate.js';
import { ref, computed } from 'vue';
import { orderIdentityLabel, orderIdentityTitleKey, orderIdentityValue } from '../../utils/orderIdentityDisplay.js';
import { receiptItemDisplayTotal } from '../../utils/receiptLineTotals.js';
import { resolveReceiptTaxNumber } from '../../utils/receiptTaxNumber.js';

export default {
    name: 'DeliveryInvoice',
    props: {
        order: { type: Object, required: true },
        items: { type: Array, required: true },
        presentation: { type: Object, default: null },
        storeSettings: { type: Object, default: () => ({}) }
    },
    emits: ['close'],
    setup(props) {
        const customerName = ref(props.order?.customer_name || '');
        const customerPhone = ref(props.order?.customer_phone || '');
        const customerAddress = ref(props.order?.customer_address || '');
        const shippingAddress = ref(props.order?.customer_address || '');
        const notes = ref('');
        const shippingCost = ref(0);
        const pdfLoading = ref(false);
        const invoiceRef = ref(null);

        const documentIdentityLabel = computed(() => orderIdentityLabel(props.order));
        const documentIdentityTitleKey = computed(() => orderIdentityTitleKey(props.order));
        const taxNumber = computed(() => resolveReceiptTaxNumber(props.order, props.storeSettings));

        const isRtl = computed(() => {
            try {
                return document.documentElement.dir === 'rtl';
            } catch (e) {
                return false;
            }
        });

        const grandTotal = computed(() => {
            const orderTotal = props.presentation
                ? Number(props.presentation.summary.total || 0)
                : Number(props.order?.total || 0);
            const shipCost = Number(shippingCost.value || 0);
            return isNaN(shipCost) || shipCost < 0 ? orderTotal : orderTotal + shipCost;
        });

        const printInvoice = () => {
            window.print();
        };

        const downloadInvoicePdf = async () => {
            if (!invoiceRef.value) return;
            pdfLoading.value = true;
            
            const publicNo = orderIdentityValue(props.order) || props.order?.invoice_id;
            const opt = {
                margin: 0,
                filename: `delivery-invoice-${publicNo}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, y: 0, scrollY: 0 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            try {
                const html2pdf = (await import('html2pdf.js')).default;
                await html2pdf().set(opt).from(invoiceRef.value).save();
            } catch (err) {
                console.error("Failed to generate PDF", err);
                if (window.showAdminAlert) {
                    window.showAdminAlert('Failed to generate PDF invoice.', 'error');
                }
            } finally {
                pdfLoading.value = false;
            }
        };

        const formatDate = (value) => formatBusinessDate(value);

        const handleShippingBlur = (event) => {
            const text = event.target.innerText.replace(/[^\d.]/g, '');
            const val = parseFloat(text);
            if (!isNaN(val) && val >= 0) {
                shippingCost.value = val;
            } else {
                shippingCost.value = 0;
            }
            event.target.innerText = Number(shippingCost.value).toFixed(2);
        };

        return {
            customerName,
            customerPhone,
            customerAddress,
            shippingAddress,
            notes,
            shippingCost,
            pdfLoading,
            invoiceRef,
            isRtl,
            grandTotal,
            printInvoice,
            downloadInvoicePdf,
            formatDate,
            receiptItemDisplayTotal,
            handleShippingBlur,
            documentIdentityLabel,
            documentIdentityTitleKey,
            taxNumber
        };
    }
};
</script>

<style scoped>
/* Strict oklch-free HEX definitions to prevent html2canvas parsing crashes */
.doc-text-dark { color: #1e293b !important; }
.doc-text-main { color: #334155 !important; }
.doc-text-muted { color: #64748b !important; }
.doc-text-light { color: #607490 !important; }
.doc-text-white { color: #ffffff !important; }

.doc-bg-muted { background-color: #f1f5f9 !important; }
.doc-bg-light { background-color: #f8fafc !important; }
.doc-bg-dark { background-color: #1e293b !important; }
.doc-bg-white { background-color: #ffffff !important; }

.doc-border-light { border-color: #e2e8f0 !important; }
.doc-border-muted { border-color: #cbd5e1 !important; }

.doc-brand-bar { background-color: #1e293b !important; }

.invoice-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #cbd5e1 !important;
}
.invoice-table th {
    background-color: #f1f5f9 !important;
    border: 1px solid #cbd5e1 !important;
    font-weight: bold;
    color: #1e293b !important;
    padding: 8px 12px;
    font-size: 9px;
    letter-spacing: 0.05em;
}
.invoice-table td {
    border: 1px solid #cbd5e1 !important;
    padding: 8px 12px;
    color: #334155 !important;
}

.doc-row:hover {
    background-color: #f8fafc !important;
}

.a4-sheet {
    width: 210mm;
    min-height: 295mm;
    max-height: 296mm;
    padding: 18mm 18mm 14mm 18mm;
    box-sizing: border-box;
    background-color: #ffffff !important;
    color: #27272a !important;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
}

.editable-field {
    min-height: 1.5em;
    display: inline-block;
    vertical-align: bottom;
    border-bottom: 1px dashed #cbd5e1 !important;
}

.editable-field:empty::before {
    content: attr(data-placeholder);
    color: #607490; /* slate-400 */
    font-style: italic;
    font-weight: normal;
}

.editable-field:hover {
    background-color: #f8fafc; /* slate-50 */
    border-color: #64748b; /* slate-500 */
}

.editable-field:focus {
    background-color: #f1f5f9; /* slate-100 */
    border-color: #1e293b; /* slate-800 */
    border-style: solid;
    outline: none;
}

.shipping-input-editable {
    border-bottom: 1px dashed #cbd5e1 !important;
}
.shipping-input-editable:focus {
    border-color: #1e293b !important;
    border-style: solid;
}

@media print {
    body {
        background: white !important;
        color: black !important;
    }

    body > *:not(.delivery-invoice-portal-wrapper) {
        display: none !important;
    }

    .delivery-invoice-portal-wrapper {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        height: auto !important;
        background: transparent !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: visible !important;
        display: block !important;
    }

    .delivery-invoice-overlay {
        display: block !important;
        position: static !important;
        width: 100% !important;
        height: auto !important;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
    }

    .a4-sheet {
        padding: 10mm !important;
        width: 100% !important;
        min-height: 0 !important;
        max-height: none !important;
        margin: 0 !important;
        box-shadow: none !important;
    }

    .print\:hidden {
        display: none !important;
    }

    @page {
        size: A4 portrait;
        margin: 10mm;
    }
}
</style>

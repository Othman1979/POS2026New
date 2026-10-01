<template>
    <div id="printApp">
        <AdminReportA4 v-if="isA4AdminReport" :print-type="printType" :data="data" />
        <div v-else-if="isAdminReportMode && !printType" class="print-preparing">{{ preparingMessage }}</div>
        <template v-else>
        <div v-if="printType === 'receipt'">
            <!-- Show presentation error if exists -->
            <div v-if="presentationError" class="text-center font-bold text-red-600 border-2 border-red-600 p-3 mb-4 rounded bg-red-50 text-xs font-sans">
              {{ $t('Receipt layout is invalid or missing required financial parameters.') }}
              <div class="text-[9px] mt-1 opacity-70 font-mono">{{ presentationError }}</div>
            </div>
            
            <div v-if="!presentationError">
                <div class="text-center mb-4">
                    <h1 class="text-2xl font-black uppercase" data-no-i18n>{{ data.storeName || $t('PREMIUM POS') }}</h1>
                    <p class="text-[11px] font-bold mt-1">
                      {{ $t('Taken At:') }} <span data-no-i18n>{{ formatBusinessDateTime(data.order_taken_at || data.date) }}</span>
                    </p>
                    <p class="text-[11px] font-bold">
                      <template v-if="data.invoice_display_no">
                        {{ $t('Invoice:') }} #<span data-no-i18n>{{ data.invoice_display_no }}</span>
                      </template>
                      <template v-else-if="data.table_display_no">
                        {{ $t('Table:') }} #<span data-no-i18n>{{ data.table_display_no }}</span>
                      </template>
                      <template v-else>
                        {{ $t('Ticket:') }} #<span data-no-i18n>{{ data.ticket_display_no || data.order_display_no || data.order_id }}</span>
                      </template>
                      | {{ $t('Cashier:') }} <span data-no-i18n>{{ data.cashier }}</span>
                    </p>
                    <p v-if="taxNumber" class="text-[11px] font-bold">
                      {{ $t('Seller tax number') }}: <span data-no-i18n>{{ taxNumber }}</span>
                    </p>
                </div>

                <div class="dashed-line"></div>

                <div class="flex justify-between font-black text-xs mb-2">
                    <span class="w-8">Qty</span>
                    <span class="flex-1">Item</span>
                    <span class="text-right">Total</span>
                </div>

                <div v-for="item in presentation.rows" :key="item.key" class="mb-2 text-xs font-bold flex flex-col">
                    <div v-if="item.kind === 'item'" class="flex justify-between items-start">
                        <span class="w-8">{{ item.qty }}x</span>
                        <span class="flex-1 pr-2" data-no-i18n>{{ serviceChargeDisplayName(item, t) }}</span>
                        <span class="text-right">{{ item.netAmount.toFixed(2) }} JD</span>
                    </div>
                    <div v-if="item.kind === 'item' && item.lineDiscountLabel" class="text-[10px] text-red-600 pl-8 font-bold">
                        {{ item.lineDiscountLabel }} Off (-{{ item.lineDiscountAmount.toFixed(2) }} JD)
                    </div>
                    <div v-if="item.kind === 'bundle_child'" class="flex text-gray-700 pl-4">
                        <span class="flex-1 pr-2" data-no-i18n>&bull; {{ item.name }} &times; {{ item.qty }}</span>
                    </div>
                    <div v-if="item.note && item.note !== 'Auto-Gratuity'" class="text-[10px] pl-8 italic">{{ $t('Note') }}: <span data-no-i18n>{{ item.note }}</span></div>
                </div>

                <div class="dashed-line"></div>

                <div v-if="presentation.taxMode !== 'inclusive'" class="flex justify-between text-xs font-bold mt-1">
                    <span>Subtotal</span><span>{{ presentation.summary.subtotal.toFixed(2) }} JD</span>
                </div>
                <div class="flex justify-between text-xs font-bold mt-1" v-if="presentation.summary.orderDiscountAmount > 0">
                    <span>Discount<template v-if="presentation.summary.orderDiscountLabel"> (<span data-no-i18n>{{ presentation.summary.orderDiscountLabel }}</span>)</template></span>
                    <span data-no-i18n>-{{ presentation.summary.orderDiscountAmount.toFixed(2) }} JD</span>
                </div>
                <div v-if="presentation.taxMode !== 'inclusive'" class="flex justify-between text-xs font-bold mt-1">
                    <span>Tax</span>
                    <span v-if="presentation.summary.taxLabel" class="italic text-[10px]">{{ $t(presentation.summary.taxLabel) }}</span>
                    <span v-else>{{ presentation.summary.taxAmount.toFixed(2) }} JD</span>
                </div>
                <div class="flex justify-between text-xs font-bold mt-1" v-if="Math.abs(presentation.summary.roundingAdjustment) > 0">
                    <span>Rounding</span><span>{{ presentation.summary.roundingAdjustment.toFixed(2) }} JD</span>
                </div>
                
                <div class="flex justify-between text-lg font-black mt-2 pt-2 border-t-2 border-black">
                    <span>TOTAL</span><span>{{ presentation.summary.total.toFixed(2) }} JD</span>
                </div>

                <div class="text-center mt-8 text-[11px] font-bold">Thank you for your visit!</div>
                <div v-if="jofotaraQr" class="mt-4 text-center">
                    <img :src="jofotaraQr" alt="JoFotara QR" style="width:100%;max-width:100%;height:auto;image-rendering:pixelated" class="mx-auto">
                    <p class="text-[8px] mt-1 break-all" data-no-i18n>{{ data.jofotara?.uuid }}</p>
                </div>
            </div>
        </div>

        <div v-if="printType === 'z_report' || printType === 'x_report'" class="thermal-report thermal-latin">
            <div class="report-store" data-no-i18n>{{ data.storeInfo?.store_name || 'POS System' }}</div>
            <h1 class="report-title">{{ printType === 'z_report' ? 'END OF SHIFT (Z-REPORT)' : 'MID-SHIFT AUDIT (X-REPORT)' }}</h1>
            <div class="text-center font-bold" data-no-i18n>Shift ID: #{{ data.shift_id }}</div>
            <div v-if="data.cashier_name" class="text-center font-bold" data-no-i18n>{{ data.cashier_name }}</div>

            <div class="report-major-rule"></div>
            <div class="report-section-title">SALES SUMMARY</div>
            <div class="report-row"><span>Gross Sales</span><span>{{ money(data.gross_sales) }} JD</span></div>
            <div class="report-row"><span>Platform Sales (Not Collected)</span><span>{{ money(data.platform_sales) }} JD</span></div>
            <div v-if="Number(data.total_discounts || 0) > 0" class="report-row"><span>Discounts Applied</span><span>-{{ money(data.total_discounts) }} JD</span></div>

            <div class="report-minor-rule"></div>
            <div class="report-section-title">TENDER BREAKDOWN</div>
            <div class="report-row"><span>Cash Payments</span><span>{{ money(data.cash_sales) }} JD</span></div>
            <div class="report-row"><span>Card Payments</span><span>{{ money(data.card_sales) }} JD</span></div>
            <div v-if="Number(data.cash_expenses || 0) > 0" class="report-row"><span>Cash Expenses</span><span>-{{ money(data.cash_expenses) }} JD</span></div>

            <template v-if="(data.platform_order_type_breakdown || []).length">
                <div class="report-minor-rule"></div>
                <div class="report-section-title">PLATFORM RECEIVABLES BY PROVIDER</div>
                <div v-for="type in data.platform_order_type_breakdown" :key="`platform-${type.order_type_name}`" class="report-row">
                    <span data-no-i18n>{{ type.order_type_name || 'Platform' }}</span><span>{{ money(type.total_sales) }} JD</span>
                </div>
            </template>

            <template v-if="(data.order_type_breakdown || []).length">
                <div class="report-minor-rule"></div>
                <div class="report-section-title">SALES BY ORDER TYPE</div>
                <div v-for="type in data.order_type_breakdown" :key="`order-type-${type.order_type_name}`" class="report-row">
                    <span data-no-i18n>{{ type.order_type_name || 'Standard' }}</span><span>{{ money(type.total_sales) }} JD</span>
                </div>
            </template>

            <template v-if="(data.expense_categories || []).length">
                <div class="report-minor-rule"></div>
                <div class="report-section-title">CASH EXPENSES BY CATEGORY</div>
                <div v-for="category in data.expense_categories" :key="category.category_id" class="report-row">
                    <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>-{{ money(category.total) }} JD</span>
                </div>
            </template>

            <div class="report-major-rule"></div>
            <div class="report-section-title">CASH DRAWER AUDIT</div>
            <div class="report-row"><span>Starting Float</span><span>{{ money(data.starting_cash) }} JD</span></div>
            <div class="report-row font-black"><span>EXPECTED IN DRAWER</span><span>{{ money(data.expected_cash) }} JD</span></div>
            <template v-if="data.actual_cash !== undefined && data.actual_cash !== null">
                <div class="report-row font-black"><span>ACTUAL COUNTED</span><span>{{ money(data.actual_cash) }} JD</span></div>
                <div class="report-minor-rule"></div>
                <div class="report-row font-black"><span>VARIANCE</span><span>{{ money(data.variance) }} JD</span></div>
            </template>
            <div class="text-center font-bold mt-6">--- End of Report ---</div>
        </div>

        <!-- DAILY SUMMARY REPORT -->
        <div v-if="printType === 'daily_summary_report'" :dir="data.direction || 'ltr'" :style="{ textAlign: data.direction === 'rtl' ? 'right' : 'left' }">
            <div class="text-center mb-4">
                <h1 class="text-lg font-black uppercase">{{ $t('Daily Summary Report') }}</h1>
                <p class="text-[11px] font-bold mt-1" data-no-i18n>{{ data.period?.window_label }}</p>
            </div>

            <div class="dashed-line"></div>
            
            <div class="flex justify-between text-xs font-bold mt-2">
                <span>{{ $t('Sales Collected') }}</span><span>{{ money(data.summary?.sales_collected) }} JD</span>
            </div>
            <div v-if="Number(data.summary?.expenses_total || 0) > 0" class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Recorded expenses') }}</span><span>{{ money(data.summary?.expenses_total) }} JD</span>
            </div>
            <div v-if="Number(data.summary?.expenses_total || 0) > 0" class="flex justify-between text-xs font-black mt-1">
                <span>{{ $t('Remaining after expenses') }}</span><span>{{ money(data.summary?.remaining_after_expenses) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Sales Processed') }}</span><span>{{ money(data.summary?.sales_processed) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Refunds Issued') }}</span><span>-{{ money(data.summary?.refunds_issued) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Net Revenue') }}</span><span>{{ money(data.summary?.net_revenue_pre_tax) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Tax') }}</span><span>{{ money(data.summary?.tax_collected) }} JD</span>
            </div>
            <div v-if="Number(data.summary?.service_charges_collected || 0) > 0" class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Service Charge') }}</span><span>{{ money(data.summary?.service_charges_collected) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            
            <div class="flex justify-between text-xs font-bold">
                <span>{{ $t('Cash Payments') }}</span><span>{{ money(paymentAmount('cash')) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Card Payments') }}</span><span>{{ money(paymentAmount('card')) }} JD</span>
            </div>

            <template v-if="data.platform_reconciliation">
                <div class="dashed-line"></div>
                <div class="text-sm font-black mb-1">{{ $t('Platform Payouts') }}</div>
                <div class="flex justify-between text-xs font-bold"><span>{{ $t('Positive Allocations') }}</span><span>{{ money(data.platform_reconciliation.positive_allocations) }} JD</span></div>
                <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Provider Credits Applied') }}</span><span>{{ money(data.platform_reconciliation.provider_credits_applied) }} JD</span></div>
                <div class="flex justify-between text-xs font-bold"><span>{{ $t('Invoice Allocations') }}</span><span>{{ money(data.platform_reconciliation.invoice_allocations) }} JD</span></div>
                <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Deductions') }}</span><span>{{ signedMoney(-Number(data.platform_reconciliation.deductions || 0)) }} JD</span></div>
                <template v-for="(amount, category) in data.platform_reconciliation.deductions_by_category || {}" :key="`platform-deduction-${category}`"><div v-if="Number(amount) !== 0" class="flex justify-between text-[10px] mt-1 ps-2"><span>{{ $t(category) }}</span><span>{{ signedMoney(-Number(amount)) }} JD</span></div></template>
                <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Additions') }}</span><span>{{ money(data.platform_reconciliation.additions) }} JD</span></div>
                <template v-for="(amount, category) in data.platform_reconciliation.additions_by_category || {}" :key="`platform-addition-${category}`"><div v-if="Number(amount) !== 0" class="flex justify-between text-[10px] mt-1 ps-2"><span>{{ $t(category) }}</span><span>{{ signedMoney(Number(amount)) }} JD</span></div></template>
                <div class="flex justify-between text-sm font-black mt-1 pt-1 border-t border-black"><span>{{ $t('Net Received') }}</span><span>{{ money(data.platform_reconciliation.net_received) }} JD</span></div>
                <div class="flex justify-between text-[10px] font-bold mt-1"><span>{{ $t('Settlement count') }} / {{ $t('Reversal count') }}</span><span data-no-i18n>{{ data.platform_reconciliation.settlement_count || 0 }} / {{ data.platform_reconciliation.reversal_count || 0 }}</span></div>
            </template>

            <div class="dashed-line"></div>

            <div class="flex justify-between text-xs font-bold">
                <span>{{ $t('Total Orders') }}</span><span data-no-i18n>{{ data.summary?.total_orders || 0 }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Avg Ticket Size') }}</span><span>{{ money(data.summary?.average_ticket) }} JD</span>
            </div>

            <div class="dashed-line"></div>

            <div class="flex justify-between text-xs font-bold">
                <span>{{ $t('Discounted Orders') }}</span><span data-no-i18n>{{ data.summary?.discounted_orders || 0 }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Refund Events') }}</span><span data-no-i18n>{{ data.summary?.refund_count || 0 }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Void Events') }}</span><span data-no-i18n>{{ data.summary?.void_count || 0 }}</span>
            </div>

            <div class="dashed-line"></div>

            <div class="flex justify-between text-xs font-bold">
                <span>{{ $t('closed shifts') }}</span><span data-no-i18n>{{ data.cash_status?.closed_shifts || 0 }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('active open shifts') }}</span><span data-no-i18n>{{ data.cash_status?.open_shifts || 0 }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('uncounted shifts') }}</span><span data-no-i18n>{{ data.cash_status?.uncounted_shifts || 0 }}</span>
            </div>
            <div v-if="data.cash_status?.closed_outside_window" class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Shifts settled on another business day') }}</span>
                <span data-no-i18n>{{ data.cash_status.closed_outside_window }}</span>
            </div>
            <template v-if="data.cash_status?.closed_shifts > 0 && data.cash_status?.net_variance !== null && data.cash_status?.net_variance !== undefined">
                <div class="flex justify-between text-xs font-bold mt-1">
                    <span>{{ $t('Shortage Total') }}</span><span>{{ money(data.cash_status?.shortage_total) }} JD</span>
                </div>
                <div class="flex justify-between text-xs font-bold mt-1">
                    <span>{{ $t('Overage Total') }}</span><span>{{ money(data.cash_status?.overage_total) }} JD</span>
                </div>
                <div class="flex justify-between text-xs font-bold mt-1">
                    <span>{{ $t('Net Shift Variance') }}</span><span>{{ signedMoney(data.cash_status?.net_variance) }} JD</span>
                </div>
            </template>
            <div v-else-if="data.cash_status?.state === 'in_progress'" class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Reconciliation in progress') }}</span>
            </div>
            <div class="flex justify-between text-sm font-black mt-2 pt-2 border-t-2 border-black">
                <span>{{ $t('Cash Status') }}</span>
                <span>{{
                    data.cash_status?.state === 'no_shifts' && data.cash_status?.closed_outside_window > 0
                        ? $t('No shifts settled in this report window')
                        : $t(data.cash_status?.state || '')
                }}</span>
            </div>

            <div class="text-center mt-6 text-[10px] font-bold">{{ $t('Refunds are counted when issued.') }}</div>
            <div class="text-center mt-2 text-[10px] font-bold">{{ $t('End of Report') }}</div>
        </div>

        <!-- DAILY SALES REPORT -->
        <div v-if="printType === 'daily_sales_report'" :dir="data.direction || 'ltr'" :style="{ textAlign: data.direction === 'rtl' ? 'right' : 'left' }">
            <div class="text-center mb-4">
                <h1 class="text-lg font-black uppercase">{{ $t('Daily Sales Report') }}</h1>
                <p class="text-[11px] font-bold mt-1" data-no-i18n>{{ data.period?.window_label }}</p>
            </div>

            <div class="dashed-line"></div>
            
            <div class="flex justify-between text-xs font-bold mt-2">
                <span>{{ $t('Sales Collected') }}</span><span>{{ money(data.totals?.sales_collected) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Menu Sales') }}</span><span>{{ money(data.totals?.menu_sales) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Service Charges') }}</span><span>{{ money(data.totals?.service_charges_collected) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Sales by Category') }}</div>
            <div v-for="cat in data.categories || []" :key="cat.name" class="mb-2">
                <div class="flex justify-between text-xs font-bold">
                    <span data-no-i18n>{{ cat.name }}</span>
                    <span data-no-i18n>{{ cat.sold_qty }} / {{ money(cat.net_sales) }} JD</span>
                </div>
                <div v-for="sub in cat.subcategories || []" :key="sub.name" class="flex justify-between text-[11px] pr-4 italic">
                    <span data-no-i18n>&bull; {{ sub.name }}</span>
                    <span data-no-i18n>{{ sub.sold_qty }} / {{ money(sub.net_sales) }} JD</span>
                </div>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Products') }}</div>
            <div class="flex justify-between text-[10px] font-black border-b border-black mb-1 pb-1 uppercase">
                <span>{{ $t('Product') }}</span><span>{{ $t('Qty/Net') }}</span>
            </div>
            <div v-for="p in data.products || []" :key="p.item_name" class="flex justify-between text-xs font-bold mb-1">
                <span class="truncate max-w-[150px]" data-no-i18n>{{ p.item_name }}</span>
                <span data-no-i18n class="tabular-nums">{{ p.sold_qty }}{{ p.returned_qty > 0 ? '/' + p.returned_qty : '' }} - {{ money(p.net_sales) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Order Types') }}</div>
            <div v-for="ot in data.order_types || []" :key="ot.name" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ ot.name }} ({{ ot.orders }})</span>
                <span>{{ money(ot.net_sales) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Cashiers') }}</div>
            <div v-for="c in data.cashiers || []" :key="c.name" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ c.name }} ({{ c.orders }})</span>
                <span>{{ money(c.net_sales) }} JD</span>
            </div>

            <template v-if="data.tables_enabled && data.waiters?.length">
                <div class="dashed-line"></div>
                <div class="text-sm font-black uppercase mb-1">{{ $t('Waiters') }}</div>
                <div v-for="w in data.waiters" :key="w.name" class="flex justify-between text-xs font-bold mb-1">
                    <span data-no-i18n>{{ w.name }} ({{ w.orders }})</span>
                    <span>{{ money(w.net_sales) }} JD</span>
                </div>
            </template>

            <template v-if="data.tables_enabled && data.tables?.length">
                <div class="dashed-line"></div>
                <div class="text-sm font-black uppercase mb-1">{{ $t('Tables') }}</div>
                <div v-for="t in data.tables" :key="t.table_number" class="flex justify-between text-xs font-bold mb-1">
                    <span data-no-i18n>{{ $t('Table') }} {{ t.table_number }} ({{ t.section_name }})</span>
                    <span>{{ money(t.net_sales) }} JD</span>
                </div>
            </template>

            <div class="dashed-line"></div>
            <div class="text-center text-[10px] font-bold leading-normal">
                {{ $t('Product and category amounts include tax. Service charges are shown separately.') }}
            </div>
            <div class="text-center mt-3 text-[10px] font-bold">{{ $t('End of Report') }}</div>
        </div>

        <!-- DAILY REFUNDS REPORT -->
        <div v-if="printType === 'daily_refunds_report'" :dir="data.direction || 'ltr'" :style="{ textAlign: data.direction === 'rtl' ? 'right' : 'left' }">
            <div class="text-center mb-4">
                <h1 class="text-lg font-black uppercase">{{ $t('Daily Refunds Report') }}</h1>
                <p class="text-[11px] font-bold mt-1" data-no-i18n>{{ data.period?.window_label }}</p>
            </div>

            <div class="dashed-line"></div>
            
            <div class="flex justify-between text-xs font-bold mt-2">
                <span>{{ $t('Sales Processed') }}</span><span>{{ money(data.summary?.sales_processed) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Refunds Issued') }}</span><span>-{{ money(data.summary?.refund_total) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Refund Rate') }}</span><span>{{ data.summary?.refund_rate !== null ? data.summary.refund_rate + '%' : '—' }}</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>{{ $t('Voids Value') }}</span><span>{{ money(data.summary?.void_value) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Staff Performance') }}</div>
            <div class="flex justify-between text-[10px] font-bold border-b border-black mb-1 pb-1">
                <span>{{ $t('Staff') }}</span><span>{{ $t('Ref/Void') }}</span>
            </div>
            <div v-for="staff in data.by_staff || []" :key="staff.name" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ staff.name }}</span>
                <span data-no-i18n>{{ money(staff.refund_value) }} / {{ money(staff.void_value) }}</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Top Reasons') }}</div>
            <div v-for="r in data.top_reasons || []" :key="r.reason" class="flex justify-between text-xs font-bold mb-1">
                <span>{{ $t(r.reason) }} ({{ r.count }})</span>
                <span>{{ money(r.value) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Refund & Void Events') }}</div>
            <div v-for="ev in data.events || []" :key="ev.refund_id" class="mb-3 text-xs font-bold">
                <div class="flex justify-between border-b border-dashed border-gray-300 pb-0.5">
                    <span data-no-i18n>{{ reportEventIdentity(ev) }} ({{ $t(ev.kind) }})</span>
                    <span data-no-i18n>{{ ev.occurred_at_local }}</span>
                </div>
                <div class="flex justify-between text-[10px] mt-0.5">
                    <span>{{ $t('Amount') }}: {{ money(ev.event_value) }} JD</span>
                    <span data-no-i18n>{{ ev.cashier_name }}</span>
                </div>
                <div class="text-[10px] mt-0.5">{{ $t('Method') }}: {{ $t(ev.refund_method || '—') }}</div>
                <div class="text-[10px] text-gray-700 mt-0.5 italic">{{ $t('Reason') }}: {{ $t(ev.reason || '—') }}</div>
                <!-- Items inside event -->
                <div v-if="ev.items && ev.items.length" class="mt-1 pl-2 border-l-2 border-gray-400">
                    <div v-for="item in ev.items" :key="item.item_name" class="text-[10px] flex justify-between text-gray-700">
                        <span data-no-i18n>&bull; {{ item.item_name }} &times; {{ item.quantity }}</span>
                        <span>{{ money(item.line_total) }} JD</span>
                    </div>
                </div>
            </div>

            <div class="dashed-line"></div>
            <div class="text-center text-[10px] font-bold leading-normal">
                {{ $t('Voided item value — no money returned') }}
            </div>
            <div class="text-center mt-3 text-[10px] font-bold">{{ $t('End of Report') }}</div>
        </div>

        

        <!-- DAILY EXPENSES REPORT -->
        <div v-if="printType === 'daily_expenses_report'" :dir="data.direction || 'ltr'" :style="{ textAlign: data.direction === 'rtl' ? 'right' : 'left' }">
            <div class="text-center mb-4">
                <h1 class="text-lg font-black uppercase">{{ $t('Daily Expenses Report') }}</h1>
                <p class="text-[11px] font-bold mt-1" data-no-i18n>{{ data.period?.window_label }}</p>
            </div>
            <div class="dashed-line"></div>
            <div class="flex justify-between text-xs font-bold"><span>{{ $t('Sales Collected') }}</span><span>{{ money(data.sales_collected) }} JD</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Recorded expenses') }}</span><span>{{ money(data.summary?.total) }} JD</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('From cash drawers') }}</span><span>{{ money(data.summary?.drawer) }} JD</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Outside POS') }}</span><span>{{ money(data.summary?.outside) }} JD</span></div>
            <div class="flex justify-between text-sm font-black mt-2 pt-2 border-t-2 border-black"><span>{{ $t('Remaining after expenses') }}</span><span>{{ money(data.remaining_after_expenses) }} JD</span></div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('By category') }}</div>
            <div v-for="category in data.by_category || []" :key="category.category_id" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ category.category_name }} ({{ category.count }})</span><span>{{ money(category.total) }} JD</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Expense log') }}</div>
            <div v-for="entry in data.entries || []" :key="entry.id" class="mb-3 border-b border-dashed border-gray-300 pb-1 text-xs" :class="entry.status === 'canceled' ? 'opacity-60' : ''">
                <div class="flex justify-between font-black"><span data-no-i18n>#{{ entry.id }} {{ entry.category_name }}</span><span>{{ money(entry.amount) }} JD</span></div>
                <div class="flex justify-between text-[10px]"><span>{{ $t(entry.source) }}<template v-if="entry.shift_id"> #{{ entry.shift_id }}</template></span><span data-no-i18n>{{ formatBusinessDateTime(entry.created_at) }}</span></div>
                <div class="text-[10px]" data-no-i18n>{{ entry.created_by_name }}</div>
                <div v-if="entry.note" class="text-[10px]" data-no-i18n>{{ entry.note }}</div>
                <div v-if="entry.status === 'canceled'" class="font-black">{{ $t('Canceled') }}</div>
            </div>
            <div class="text-center mt-3 text-[10px] font-bold">{{ $t('End of Report') }}</div>
        </div>

        <!-- DAILY INGREDIENTS REPORT -->
        <div v-if="printType === 'daily_ingredients_report'" :dir="data.direction || 'ltr'" :style="{ textAlign: data.direction === 'rtl' ? 'right' : 'left' }">
            <div class="text-center mb-4">
                <h1 class="text-lg font-black uppercase">{{ $t('Ingredients') }}</h1>
                <p class="text-[11px] font-bold mt-1" data-no-i18n>{{ data.period?.window_label }}</p>
            </div>
            <div class="dashed-line"></div>
            <div class="flex justify-between text-xs font-bold"><span>{{ $t('Cost of ingredients used') }}</span><span data-no-i18n>{{ money(data.totals?.used_cost) }} JD</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Waste cost') }}</span><span data-no-i18n>{{ money(data.totals?.waste_cost) }} JD</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Ingredient cost %') }}</span><span data-no-i18n>{{ data.totals?.food_cost_pct == null ? '—' : `${(Number(data.totals.food_cost_pct) * 100).toFixed(2)}%` }}</span></div>
            <div class="flex justify-between text-xs font-bold mt-1"><span>{{ $t('Below minimum stock') }}</span><span data-no-i18n>{{ data.totals?.below_par_count || 0 }}</span></div>
            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Ingredients') }} — {{ $t('Used quantity') }} / {{ $t('Closing stock') }}</div>
            <div v-for="row in data.ingredients || []" :key="row.id" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ row.name }}</span>
                <span data-no-i18n>{{ ingredientQuantity(row.used, row.display_unit) }} / {{ ingredientQuantity(row.closing_expected, row.display_unit) }}</span>
            </div>
            <div class="dashed-line"></div>
            <div class="text-sm font-black uppercase mb-1">{{ $t('Waste by reason') }}</div>
            <div v-for="row in ingredientWasteRows(data)" :key="row.key" class="flex justify-between text-xs font-bold mb-1">
                <span data-no-i18n>{{ row.name }} · {{ row.reason }}</span><span data-no-i18n>{{ row.qty }}</span>
            </div>
            <div class="text-center mt-3 text-[10px] font-bold">{{ $t('End of Report') }}</div>
        </div>

        <div v-if="printType === 'audit_report'" dir="rtl" class="thermal-report thermal-arabic">
            <div class="text-center mb-3">
                <div class="text-lg font-black uppercase tracking-widest" data-no-i18n>{{ data.storeInfo?.store_name || 'POS System' }}</div>
                <template v-if="data.is_period">
                    <h1 class="text-xl font-black">التقرير الدوري</h1>
                    <div class="text-[11px] font-bold" data-no-i18n>من {{ data.period_start_date }} إلى {{ data.period_end_date }}</div>
                </template>
                <template v-else>
                    <h1 class="text-xl font-black" data-no-i18n>جرد {{ data.report_type === 'z_audit' ? 'Z' : 'X' }} / {{ data.serial_label }}</h1>
                    <div class="text-[11px] font-bold" data-no-i18n>{{ data.copy_label === 'REPRINT' ? 'إعادة طباعة' : 'نسخة أصلية' }}</div>
                    <div class="text-[11px] font-bold mt-1">تاريخ العمل: <span data-no-i18n>{{ data.business_date }}</span></div>
                </template>
                <div class="text-[10px] font-bold" data-no-i18n>يوم العمل: {{ String(getBusinessDayStartHour()).padStart(2, '0') }}:00 – {{ String((getBusinessDayStartHour() + 23) % 24).padStart(2, '0') }}:59</div>
                <div class="text-[10px] font-bold mt-1">طُبع بتاريخ <span data-no-i18n>{{ formatAuditDateTime(data.generated_at) }}</span> بواسطة <span data-no-i18n>{{ data.generated_by?.name || 'النظام' }}</span></div>
            </div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">ملخص المبيعات</div>
            <div class="flex justify-between text-xs font-bold"><span>عدد الطلبات</span><span data-no-i18n>{{ data.summary?.total_orders || 0 }}</span></div>
            <div class="flex justify-between text-xs font-bold"><span>المبيعات شاملة الضريبة</span><span>{{ money(data.summary?.sales_incl_tax) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>صافي المبيعات</span><span>{{ money(data.summary?.net_sales_pre_tax) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>الضريبة المحصّلة</span><span>{{ money(data.summary?.tax_collected) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>متوسط الفاتورة</span><span>{{ money(data.summary?.avg_check) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>إجمالي الخصومات</span><span>{{ money(data.summary?.discounts_total) }} د.أ</span></div>
            <div class="flex justify-between text-[11px] font-semibold pr-2"><span>خصم الأصناف</span><span>{{ money(data.summary?.line_discounts_total) }} د.أ</span></div>
            <div class="flex justify-between text-[11px] font-semibold pr-2"><span>خصم الفاتورة</span><span>{{ money(data.summary?.order_discounts_total) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>المرتجعات</span><span data-no-i18n>{{ data.summary?.refund_count || 0 }} / {{ money(data.summary?.refunds_total) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>الطلبات الملغاة</span><span data-no-i18n>{{ data.summary?.void_count || 0 }} / {{ money(data.summary?.void_value) }} د.أ</span></div>
            <div class="text-[10px] font-semibold mt-1">الأرقام أعلاه صافية من الخصومات والمرتجعات والطلبات الملغاة.</div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">المدفوعات</div>
            <div class="flex justify-between text-xs font-bold"><span>نقدًا</span><span>{{ money(data.payments?.cash_sales) }} د.أ</span></div>
            <div class="flex justify-between text-xs font-bold"><span>بالبطاقة</span><span>{{ money(data.payments?.card_sales) }} د.أ</span></div>
            <div class="flex justify-between text-sm font-black mt-1 pt-1 border-t border-black"><span>الإجمالي</span><span>{{ money(data.payments?.total_collected) }} د.أ</span></div>

            <div v-if="data.platform_reconciliation" class="dashed-line"></div>
            <template v-if="data.platform_reconciliation">
                <div class="text-sm font-black mb-1">دفعات منصات التوصيل</div>
                <div class="flex justify-between text-xs font-bold"><span>التخصيصات الموجبة</span><span>{{ money(data.platform_reconciliation.positive_allocations) }} د.أ</span></div>
                <div class="flex justify-between text-xs font-bold mt-1"><span>أرصدة مزود الخدمة المستخدمة</span><span>{{ money(data.platform_reconciliation.provider_credits_applied) }} د.أ</span></div>
                <div class="flex justify-between text-xs font-bold"><span>تخصيصات الفواتير</span><span>{{ money(data.platform_reconciliation.invoice_allocations) }} د.أ</span></div>
                <div class="flex justify-between text-xs font-bold mt-1"><span>الخصومات</span><span>{{ signedMoney(-Number(data.platform_reconciliation.deductions || 0)) }} د.أ</span></div>
                <template v-for="(amount, category) in data.platform_reconciliation.deductions_by_category || {}" :key="`audit-platform-deduction-${category}`"><div v-if="Number(amount) !== 0" class="flex justify-between text-[10px] mt-1 pr-2"><span>{{ $t(category) }}</span><span>{{ signedMoney(-Number(amount)) }} د.أ</span></div></template>
                <div class="flex justify-between text-xs font-bold mt-1"><span>الإضافات</span><span>{{ money(data.platform_reconciliation.additions) }} د.أ</span></div>
                <template v-for="(amount, category) in data.platform_reconciliation.additions_by_category || {}" :key="`audit-platform-addition-${category}`"><div v-if="Number(amount) !== 0" class="flex justify-between text-[10px] mt-1 pr-2"><span>{{ $t(category) }}</span><span>{{ signedMoney(Number(amount)) }} د.أ</span></div></template>
                <div class="flex justify-between text-sm font-black mt-1 pt-1 border-t border-black"><span>صافي المستلم</span><span>{{ money(data.platform_reconciliation.net_received) }} د.أ</span></div>
                <div class="flex justify-between text-[10px] font-bold mt-1"><span>التسويات / الإلغاءات</span><span data-no-i18n>{{ data.platform_reconciliation.settlement_count || 0 }} / {{ data.platform_reconciliation.reversal_count || 0 }}</span></div>
            </template>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">نتيجة مراجعة المناوبات</div>
            <div class="text-center text-base font-black mb-1">{{ auditShiftReview.result }}</div>
            <div class="text-center text-[10px] font-bold mb-1">{{ auditShiftReview.state }}</div>
            <div class="flex justify-between text-xs font-bold"><span>المناوبات المشمولة</span><span data-no-i18n>{{ auditShiftReview.total }}</span></div>
            <div class="flex justify-between text-xs font-bold"><span>تحتاج مراجعة</span><span data-no-i18n>{{ auditShiftReview.needsReview }}</span></div>
            <div class="flex justify-between text-xs font-bold"><span>مفتوحة / بلا جرد فعلي</span><span data-no-i18n>{{ auditShiftReview.open }} / {{ auditShiftReview.uncounted }}</span></div>
            <template v-if="auditShiftReview.netVariance != null">
                <div class="flex justify-between text-xs font-bold"><span>إجمالي العجز</span><span>{{ money(auditShiftReview.shortage) }} د.أ</span></div>
                <div class="flex justify-between text-xs font-bold"><span>إجمالي الزيادة</span><span>{{ money(auditShiftReview.overage) }} د.أ</span></div>
                <div class="flex justify-between text-sm font-black mt-1 pt-1 border-t border-black"><span>صافي فرق المناوبات</span><span>{{ signedMoney(auditShiftReview.netVariance) }} د.أ</span></div>
            </template>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">المناوبات</div>
            <div v-for="shift in data.shifts || []" :key="shift.shift_id" class="mb-3 text-xs font-bold border-b-2 border-black pb-2">
                <div class="flex justify-between text-sm font-black">
                    <span data-no-i18n>#{{ shift.shift_id }} — {{ shift.cashier_name }}</span>
                    <span>{{ shift.status === 'open' ? 'مفتوحة — غير مجرودة' : 'مغلقة' }}</span>
                </div>
                <div class="flex justify-between"><span>بدأت</span><span data-no-i18n>{{ formatAuditDateTime(shift.opened_at) }}</span></div>
                <div class="flex justify-between"><span>انتهت</span><span data-no-i18n>{{ shift.closed_at ? formatAuditDateTime(shift.closed_at) : 'لم تُغلق بعد' }}</span></div>
                <div class="text-xs font-black mt-1">نشاط ضمن نافذة التقرير</div>
                <div class="flex justify-between"><span>عدد الطلبات</span><span data-no-i18n>{{ shift.order_count || 0 }}</span></div>
                <div class="flex justify-between"><span>المبيعات شاملة الضريبة</span><span>{{ money(shift.gross_sales) }} د.أ</span></div>
                <div class="flex justify-between"><span>الضريبة المحصلة</span><span>{{ money(shift.total_tax) }} د.أ</span></div>
                <div class="flex justify-between"><span>نقدًا / بطاقة / منصات</span><span>{{ money(shift.cash_sales) }} / {{ money(shift.card_sales) }} / {{ money(shift.platform_sales) }}</span></div>
                <div class="flex justify-between"><span>خصم أصناف / فاتورة</span><span>{{ money(shift.line_discounts) }} / {{ money(shift.order_discounts) }}</span></div>
                <div class="flex justify-between"><span>المرتجعات</span><span data-no-i18n>{{ shift.refund_count || 0 }} / {{ money(shift.refund_value) }} د.أ</span></div>
                <div class="flex justify-between"><span>الطلبات الملغاة</span><span data-no-i18n>{{ shift.void_count || 0 }} / {{ money(shift.void_value) }} د.أ</span></div>
                <div class="flex justify-between"><span>مصروفات الصندوق</span><span>{{ money(shift.cash_expenses) }} د.أ</span></div>
                <div class="text-xs font-black mt-1">أرصدة المناوبة عند الإغلاق</div>
                <div class="flex justify-between"><span>رصيد الافتتاح</span><span>{{ money(shift.starting_cash) }} د.أ</span></div>
                <template v-if="shiftShowsEquation(shift)">
                    <div class="flex justify-between"><span>+ المبيعات النقدية بعد المرتجعات</span><span>{{ money(shift.cash_sales) }} د.أ</span></div>
                    <div class="flex justify-between"><span>- مصروفات الصندوق</span><span>{{ money(shift.cash_expenses) }} د.أ</span></div>
                    <div class="flex justify-between text-sm font-black mt-1 pt-1 border-t border-black"><span>= النقد المتوقع</span><span>{{ money(shift.expected_cash) }} د.أ</span></div>
                </template>
                <div v-else class="flex justify-between"><span>النقد المتوقع</span><span>{{ money(shift.expected_cash) }} د.أ</span></div>
                <div class="flex justify-between"><span>النقد الفعلي</span><span>{{ moneyOrDash(shift.actual_cash) }}</span></div>
                <div class="flex justify-between text-sm font-black"><span>الفرق (عجز أو زيادة)</span><span>{{ moneyOrDash(shift.variance) }}</span></div>
            </div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">أنواع الطلبات</div>
            <div v-for="type in data.order_types || []" :key="type.order_type_name" class="flex justify-between text-xs font-bold">
                <span data-no-i18n>{{ type.order_type_name }} ({{ type.order_count }})</span>
                <span>{{ money(type.total_sales) }} د.أ</span>
            </div>

            <div v-if="data.blockers?.open_shifts?.length" class="dashed-line"></div>
            <div v-if="data.blockers?.open_shifts?.length" class="text-xs font-black">
                مناوبات مفتوحة: <span data-no-i18n>{{ data.blockers.open_shifts.map(s => `#${s.shift_id} ${s.cashier_name}`).join('، ') }}</span>
            </div>

            <div class="dashed-line"></div>
            <div class="text-center font-black text-sm" data-no-i18n>{{ data.is_period ? 'نهاية التقرير الدوري' : `نهاية تقرير جرد ${data.report_type === 'z_audit' ? 'Z' : 'X'}` }}</div>
            <div v-if="data.payload_hash" class="text-[10px] font-bold break-all mt-2" data-no-i18n>HASH {{ data.payload_hash }}</div>
            <div class="text-center mt-2 text-[10px] font-bold" data-no-i18n>{{ formatAuditDateTime(data.generated_at) }}</div>
        </div>

        <div v-if="['category_items_report', 'y_held_items_report'].includes(printType)" dir="rtl" class="thermal-report thermal-arabic">
            <div class="text-center mb-3">
                <div class="text-lg font-black uppercase tracking-widest" data-no-i18n>{{ data.storeInfo?.store_name || 'POS System' }}</div>
                <h1 class="text-xl font-black" :data-no-i18n="printType === 'y_held_items_report' ? '' : null">{{ printType === 'y_held_items_report' ? 'Y' : 'تقرير الأصناف' }}</h1>
                <template v-if="data.is_period">
                    <div class="text-[11px] font-bold" data-no-i18n>من {{ data.period_start_date }} إلى {{ data.period_end_date }}</div>
                </template>
                <template v-else>
                    <div class="text-[11px] font-bold mt-1">تاريخ العمل: <span data-no-i18n>{{ data.business_date }}</span></div>
                </template>
                <div class="text-[10px] font-bold" data-no-i18n>يوم العمل: {{ String(getBusinessDayStartHour()).padStart(2, '0') }}:00 – {{ String((getBusinessDayStartHour() + 23) % 24).padStart(2, '0') }}:59</div>
                <div class="text-[10px] font-bold mt-1">طُبع بتاريخ <span data-no-i18n>{{ formatBusinessDateTime(data.generated_at) }}</span> بواسطة <span data-no-i18n>{{ data.generated_by?.name || 'النظام' }}</span></div>
            </div>

            <div class="dashed-line"></div>

            <div v-if="printType === 'y_held_items_report'" class="space-y-1 text-xs font-bold mb-2">
                <div class="flex justify-between"><span>عدد الطلبات</span><span data-no-i18n>{{ data.summary?.order_count || 0 }}</span></div>
                <div class="flex justify-between"><span>المجموع قبل خصم الطلب</span><span data-no-i18n>{{ money(data.summary?.subtotal) }} د.أ</span></div>
                <div class="flex justify-between"><span>خصم الأصناف</span><span data-no-i18n>{{ money(data.summary?.line_discount) }} د.أ</span></div>
                <div class="flex justify-between"><span>خصم الطلبات</span><span data-no-i18n>{{ money(data.summary?.order_discount) }} د.أ</span></div>
                <div class="flex justify-between"><span>الضريبة</span><span data-no-i18n>{{ money(data.summary?.tax) }} د.أ</span></div>
                <div class="flex justify-between text-sm font-black"><span>الإجمالي</span><span data-no-i18n>{{ money(data.summary?.total) }} د.أ</span></div>
                <div class="dashed-line"></div>
            </div>

            <div class="text-sm font-black mb-1">المجموعات</div>
            <div v-for="category in data.categories || []" :key="`cat-${category.category_name}`" class="flex justify-between text-xs font-bold">
                <span data-no-i18n>{{ category.category_name }} ({{ category.qty_sold }})</span>
                <span>{{ money(category.gross_revenue) }} د.أ</span>
            </div>

            <template v-if="(data.subcategories || []).length">
                <div class="dashed-line"></div>
                <div class="text-sm font-black mb-1">التصنيفات الفرعية</div>
                <template v-for="group in data.subcategories" :key="`group-${group.category_name}`">
                    <div class="text-xs font-black mt-1 mb-0.5" data-no-i18n>{{ group.category_name }}</div>
                    <div v-for="sub in group.rows" :key="`sub-${group.category_name}-${sub.category_name}`" class="flex justify-between text-xs font-bold pr-2">
                        <span data-no-i18n>{{ sub.category_name }} ({{ sub.qty_sold }})</span>
                        <span>{{ money(sub.gross_revenue) }} د.أ</span>
                    </div>
                </template>
            </template>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">الأصناف</div>
            <div v-for="item in data.items || []" :key="`item-${item.item_name}`" class="mb-1 text-xs font-bold">
                <div class="flex justify-between">
                    <span data-no-i18n>{{ item.item_name }}</span>
                    <span data-no-i18n>{{ item.qty_sold }}×</span>
                </div>
                <div data-no-i18n>{{ money(item.gross_revenue) }} د.أ</div>
            </div>

            <div class="dashed-line"></div>
            <div class="text-center font-black text-sm" data-no-i18n>{{ printType === 'y_held_items_report' ? 'نهاية تقرير Y' : 'نهاية تقرير الأصناف' }}</div>
            <div class="text-center mt-2 text-[10px] font-bold" data-no-i18n>{{ formatBusinessDateTime(data.generated_at) }}</div>
        </div>
        </template>
    </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ingredientQuantity, ingredientWasteRows } from './ingredientReportPresentation.js';
import { setLanguage, t } from '@/shared/i18n.js';
import { orderIdentityLabel, orderIdentityValue } from '../utils/orderIdentityDisplay.js';
import { receiptItemDisplayTotal } from '../utils/receiptLineTotals.js';
import { resolveReceiptPresentation } from '../utils/receiptPresentation.js';
import { serviceChargeDisplayName } from '../utils/serviceChargeDisplay.js';
import { resolveReceiptTaxNumber } from '../utils/receiptTaxNumber.js';
import { initBusinessConfig, formatBusinessDateTime, getBusinessDayStartHour } from '../utils/businessDate.js';
import { formatAuditDateTime, reconciliationFrom, shiftShowsEquation } from './auditReportPresentation.js';
import AdminReportA4 from './AdminReportA4.vue';
import QRCode from 'qrcode';

const ADMIN_REPORT_TYPES = new Set([
    'daily_summary_report',
    'daily_sales_report',
    'daily_refunds_report',
    'daily_expenses_report',
    'daily_ingredients_report',
    'x_report',
    'z_report',
    'audit_report',
    'category_items_report',
    'y_held_items_report'
]);

export default {
    components: { AdminReportA4 },
    setup() {
        const printType = ref('');
        const data = ref({});
        const jofotaraQr = ref('');
        const layout = ref('thermal');
        const isAdminReportMode = ref(false);
        const preparingLanguage = ref('en');
        let removeAdminMessageListener = () => {};
        const money = (value) => Number(value || 0).toFixed(2);
        const signedMoney = (value) => {
            const n = Number(value || 0);
            return `${n > 0 ? '+' : ''}${money(n)}`;
        };
        const paymentAmount = (key) => {
            const payment = (data.value.payments || []).find(row => row.key === key);
            return payment?.amount || 0;
        };
        const reportAverageTicket = (summary = {}) => {
            const orders = Number(summary.total_orders || 0);
            return orders > 0 ? money(Number(summary.gross_sales || 0) / orders) : '0.00';
        };
        const moneyOrDash = (value) => (value === null || value === undefined) ? '—' : `${money(value)} د.أ`;
        const reportEventIdentity = (event = {}) => {
            if (event.kind === 'void' && event.table_number !== null && event.table_number !== undefined && event.table_number !== '') {
                return t('Table {table}').replace('{table}', String(event.table_number));
            }
            return `#${event.invoice_display_no || event.invoice_id || '—'}`;
        };

        const presentationState = computed(() => resolveReceiptPresentation(data.value));
        const auditShiftReview = computed(() => reconciliationFrom(data.value));
        const presentation = computed(() => presentationState.value.presentation);
        const presentationError = computed(() => presentationState.value.error);
        const taxNumber = computed(() => resolveReceiptTaxNumber(data.value, data.value?.storeInfo || {}));
        const isA4AdminReport = computed(() => isAdminReportMode.value && layout.value === 'a4' && ADMIN_REPORT_TYPES.has(printType.value));
        const preparingMessage = computed(() => preparingLanguage.value === 'ar' ? 'جارٍ تجهيز معاينة الطباعة…' : 'Preparing print preview…');

        const applyPrintLayout = (value, reportType = '') => {
            layout.value = value;
            document.documentElement.dataset.printLayout = value;
            document.getElementById('pos-print-page-rule')?.remove();
            const style = document.createElement('style');
            style.id = 'pos-print-page-rule';
            style.textContent = value === 'a4'
                ? reportType === 'audit_report'
                    ? '@page { size: A4 portrait; margin: 0; }'
                    : '@page { size: A4 portrait; margin: 22mm 12mm 16mm; }'
                : '@page { size: 80mm auto; margin: 0; }';
            document.head.appendChild(style);
        };

        const triggerPrint = async (delay = 0) => {
            await nextTick();
            if (document.fonts?.ready) {
                try { await document.fonts.ready; } catch (_) {}
            }
            setTimeout(() => {
                if (printType.value === 'receipt' && presentationError.value) {
                    console.error('Print skipped due to presentation error:', presentationError.value);
                    return;
                }
                window.print();
            }, delay);
        };

        const applyPayload = async (payload) => {
            await setLanguage(payload.language || localStorage.getItem('pos_admin_language') || 'en', { persist: false });
            initBusinessConfig(payload.data?.business_config || {});
            printType.value = payload.type;
            data.value = payload.data;
            if (payload.data?.jofotara?.status === 'accepted' && payload.data.jofotara.qrText) {
                QRCode.toDataURL(payload.data.jofotara.qrText, { width: 556, margin: 4 }).then(url => { jofotaraQr.value = url; });
            }
        };

        onMounted(async () => {
            const params = new URLSearchParams(window.location.search);
            const nonce = params.get('admin_report');
            if (nonce) {
                const requestedLayout = params.get('layout');
                if (!['thermal', 'a4'].includes(requestedLayout) || !window.opener) return;

                isAdminReportMode.value = true;
                preparingLanguage.value = params.get('lang') === 'ar' ? 'ar' : 'en';
                await setLanguage(preparingLanguage.value, { persist: false });
                applyPrintLayout(requestedLayout);

                const opener = window.opener;
                const onMessage = async event => {
                    if (event.origin !== window.location.origin || event.source !== opener) return;
                    const message = event.data;
                    if (!message || message.type !== 'POS_ADMIN_PRINT_PAYLOAD') return;
                    if (message.nonce !== nonce || message.layout !== requestedLayout) return;
                    if (!message.payload || !ADMIN_REPORT_TYPES.has(message.payload.type)) return;

                    window.removeEventListener('message', onMessage);
                    removeAdminMessageListener = () => {};
                    await applyPayload(message.payload);
                    applyPrintLayout(requestedLayout, message.payload.type);
                    await triggerPrint();
                };
                removeAdminMessageListener = () => window.removeEventListener('message', onMessage);
                window.addEventListener('message', onMessage);
                opener.postMessage({ type: 'POS_ADMIN_PRINT_READY', nonce, layout: requestedLayout }, window.location.origin);
                return;
            }

            applyPrintLayout('thermal');
            // Preserve the existing localStorage transport for checkout and legacy receipt callers.
            const payload = JSON.parse(localStorage.getItem('pos_print_payload'));
            if (!payload) return;
            await applyPayload(payload);
            await triggerPrint(500);
        });

        onBeforeUnmount(() => removeAdminMessageListener());

        return {
            getBusinessDayStartHour,
            formatBusinessDateTime,
            ingredientQuantity,
            ingredientWasteRows,
            printType,
            data,
            money,
            moneyOrDash,
            signedMoney,
            paymentAmount,
            reportAverageTicket,
            auditShiftReview,
            formatAuditDateTime,
            shiftShowsEquation,
            reportEventIdentity,
            receiptItemDisplayTotal,
            serviceChargeDisplayName,
            t,
            orderIdentityLabel,
            orderIdentityValue,
            presentation,
            presentationError,
            taxNumber,
            jofotaraQr,
            isAdminReportMode,
            isA4AdminReport,
            preparingMessage
        };
    }
};
</script>

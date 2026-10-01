<template>
    <div class="h-full flex flex-col font-sans animate-fade-in text-foreground bg-background space-y-5 pb-6">
        
        <div class="bg-card border border-border rounded-xl shadow-sm p-5 flex flex-col gap-4 shrink-0">
            <div class="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4 w-full">
                <!-- Left: Back & Title -->
                <div class="flex items-center gap-3">
                    <button @click="goBack" class="w-9 h-9 bg-background border border-input hover:bg-muted text-foreground rounded-lg transition-colors flex items-center justify-center shadow-sm focus:outline-none" type="button">
                        <i :class="['fa-solid', isRtl ? 'fa-arrow-right' : 'fa-arrow-left']"></i>
                    </button>
                    <div>
                        <h2 class="font-display text-sm font-extrabold tracking-tight text-foreground">{{ $t('Waiter Performance History') }}</h2>
                        <p class="text-[10px] text-muted-foreground font-semibold mt-0.5">{{ $t('Daily breakdown of waiters and tables entered') }}</p>
                    </div>
                </div>

                <!-- Right: Date Filter & Refresh -->
                <div class="flex items-center gap-2 self-end sm:self-auto justify-end">
                    <div class="relative flex items-center bg-background border border-input rounded-lg overflow-hidden h-9 px-3 shadow-sm focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-400/30 transition-all">
                        <i class="fa-regular fa-calendar text-muted-foreground text-xs me-2"></i>
                        <input v-model="waiterReportDate" class="bg-transparent border-none text-xs font-semibold text-foreground outline-none cursor-pointer h-full" type="date" @change="fetchWaiterReport"/>
                    </div>
                    <button @click="fetchWaiterReport" class="h-9 w-9 flex items-center justify-center bg-background border border-input hover:bg-muted text-foreground rounded-lg shadow-sm transition-colors focus:outline-none" type="button">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                </div>
            </div>
        </div>

        <!-- Main Content Layout -->
        <div class="bg-card border border-border rounded-md overflow-hidden flex-1 flex flex-col md:flex-row relative shadow-sm min-h-[400px]">
            <!-- Overlay Loading Spinner -->
            <div v-if="isLoading" class="absolute inset-0 bg-background/95 z-20 flex items-center justify-center">
                <i class="fa-solid fa-circle-notch fa-spin text-4xl text-foreground"></i>
            </div>

            <!-- Left Column: Waiters list -->
            <div class="flex-1 p-6 flex flex-col border-b md:border-b-0 md:border-r border-border">
                <p class="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-4 border-b border-border pb-2">{{ $t('Waiter Summary') }}</p>
                
                <div v-if="waitersSummary.length === 0" class="flex-1 flex flex-col items-center justify-center text-muted-foreground py-20">
                    <i class="fa-solid fa-users-slash text-4xl mb-4 opacity-30"></i>
                    <p class="text-sm font-medium">{{ $t('No waiter activity recorded for this day.') }}</p>
                </div>

                <div v-else class="space-y-2 overflow-y-auto premium-scroll flex-1 pe-1 max-h-[60vh]">
                    <div v-for="waiter in waitersSummary" :key="waiter.waiter_id" 
                          @click="selectWaiter(waiter)"
                          :class="[selectedWaiterId === waiter.waiter_id ? 'bg-secondary border-muted-foreground/30 font-semibold' : 'bg-card hover:bg-muted/50 border-border']" 
                          class="p-4 rounded-md border shadow-sm transition-all cursor-pointer flex items-center justify-between select-none">
                        <div class="flex items-center gap-3">
                            <div class="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold font-mono">
                                {{ waiter.waiter_name.substring(0, 2).toUpperCase() }}
                            </div>
                            <div>
                                <p class="text-sm text-foreground" data-no-i18n>{{ waiter.waiter_name }}</p>
                                <p class="text-xs text-muted-foreground mt-0.5">{{ $t('Tables:') }} <span class="font-semibold text-foreground font-mono" data-no-i18n>{{ waiter.total_tables }}</span></p>
                            </div>
                        </div>
                        <div class="text-end flex items-center gap-3">
                            <div>
                                <p class="font-bold text-sm text-foreground font-mono" data-no-i18n>{{ Number(waiter.total_sales).toFixed(2) }} JD</p>
                                <p class="text-[9px] text-muted-foreground uppercase tracking-wider">{{ $t('Total Sales') }}</p>
                            </div>
                            <i :class="['fa-solid text-xs text-muted-foreground transition-transform', isRtl ? 'fa-chevron-left' : 'fa-chevron-right', selectedWaiterId === waiter.waiter_id ? (isRtl ? '-translate-x-1' : 'translate-x-1') : '']"></i>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Right Column: Waiter's Detailed table list -->
            <div class="md:w-1/2 p-6 flex flex-col bg-muted/5">
                <p class="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-4 border-b border-border pb-2">
                    {{ selectedWaiterName ? `${selectedWaiterName} - ${$t('Tables Entered')}` : $t('Table Details') }}
                </p>

                <div v-if="!selectedWaiterId" class="flex-1 flex flex-col items-center justify-center text-muted-foreground py-20 text-center">
                    <i class="fa-solid fa-hand-pointer text-4xl mb-4 opacity-30"></i>
                    <p class="text-sm font-medium">{{ $t('Select a waiter to view their tables list.') }}</p>
                </div>

                <div v-else-if="waiterDetailOrders.length === 0" class="flex-1 flex flex-col items-center justify-center text-muted-foreground py-20 text-center">
                    <i class="fa-solid fa-folder-open text-4xl mb-4 opacity-30"></i>
                    <p class="text-sm font-medium">{{ $t('No tables registered for this waiter.') }}</p>
                </div>

                <div v-else class="space-y-2 overflow-y-auto premium-scroll flex-1 pe-1 max-h-[60vh]">
                    <div v-for="order in waiterDetailOrders" :key="order.invoice_id" 
                          @click="viewOrder(order.invoice_id)" 
                          class="p-4 bg-card hover:bg-muted/50 border border-border hover:border-muted-foreground/30 rounded-md transition-all shadow-sm flex items-center justify-between cursor-pointer active:scale-[0.99]">
                        <div>
                            <div class="flex items-center gap-2 mb-1.5">
                                <span class="bg-secondary border border-border text-foreground px-2 py-0.5 rounded text-[10px] font-bold" data-no-i18n>{{ $t('Table') }} {{ order.table_number }}</span>
                                <span class="text-[10px] font-mono text-muted-foreground">{{ orderIdentityLabel(order, $t) }}</span>
                            </div>
                            <p class="text-xs text-muted-foreground flex items-center gap-1.5" data-no-i18n>
                                <i class="fa-regular fa-clock"></i>
                                {{ getOrderTime(order.created_at) }}
                                <span class="mx-1">•</span>
                                <span class="capitalize">{{ $t(order.payment_method === 'cash' ? 'Cash' : order.payment_method === 'card' ? 'Card' : 'Split') }}</span>
                            </p>
                        </div>
                        <div class="text-end">
                            <p class="font-bold text-sm text-foreground font-mono" data-no-i18n>{{ Number(order.total).toFixed(2) }} JD</p>
                            <span class="text-[10px] font-medium text-primary hover:underline flex items-center gap-1 justify-end mt-1.5">
                                {{ $t('Details') }} <i :class="['fa-solid text-[9px]', isRtl ? 'fa-arrow-left' : 'fa-arrow-right']"></i>
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Transaction Details Modal -->
        <div v-if="showModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4 animate-fade-in">
            <div class="bg-card w-full max-w-5xl rounded-lg shadow-lg overflow-hidden flex flex-col md:flex-row max-h-[95vh] border border-border relative animate-scale-in">
                
                <div v-if="isModalLoading" class="absolute inset-0 bg-background/95 z-20 flex items-center justify-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-4xl text-foreground"></i>
                </div>

                <div class="md:w-3/5 p-6 md:p-8 overflow-y-auto premium-scroll flex flex-col bg-background border-b md:border-b-0 md:border-r border-border">
                    <div class="flex justify-between items-start mb-6 shrink-0">
                        <div>
                            <div class="flex items-center gap-3 mb-2">
                                <span class="px-2.5 py-0.5 bg-secondary text-foreground text-[9px] font-semibold uppercase tracking-wider rounded-md border border-border">{{ $t('Completed') }}</span>
                                <span class="text-muted-foreground text-xs font-semibold uppercase tracking-wider"><span>{{ $t('Queue #') }}</span><span data-no-i18n>{{ selectedOrder?.order_display_no || selectedOrder?.order_id }}</span></span>
                            </div>
                            <h2 class="text-2xl font-semibold tracking-tight text-foreground">{{ $t('Transaction Details') }}</h2>
                            <p class="text-xs font-medium text-muted-foreground font-mono mt-0.5">{{ orderIdentityLabel(selectedOrder, $t) }}</p>
                        </div>
                        <button @click="showModal = false" class="w-9 h-9 bg-background border border-border hover:bg-accent hover:text-accent-foreground rounded-md text-muted-foreground transition-colors flex items-center justify-center shadow-sm">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 shrink-0">
                        <div class="p-4 bg-card border border-border rounded-md shadow-sm">
                            <p class="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{{ $t('Table Specs') }}</p>
                            <div class="flex items-center gap-2 mb-2">
                                <div class="w-6 h-6 rounded-md bg-secondary border border-border text-foreground flex items-center justify-center text-xs"><i class="fa-solid fa-chair"></i></div>
                                <span class="text-sm font-semibold text-foreground" data-no-i18n>{{ $t('Table') }} {{ selectedOrder?.table_number }}</span>
                            </div>
                            <p v-if="selectedOrder?.waiter_name" class="text-xs font-medium text-muted-foreground mb-1">{{ $t('Waiter:') }} <span class="text-foreground font-semibold" data-no-i18n>{{ selectedOrder.waiter_name }}</span></p>
                        </div>
                        <div class="p-4 bg-card border border-border rounded-md shadow-sm">
                            <p class="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{{ $t('Fulfillment Specs') }}</p>
                            <div class="flex items-center gap-2 mb-2">
                                <div class="w-6 h-6 rounded-md bg-secondary border border-border text-foreground flex items-center justify-center text-xs"><i class="fa-solid fa-bell-concierge"></i></div>
                                <span class="text-sm font-semibold text-foreground" data-no-i18n>{{ selectedOrder?.order_type_name || $t('Table Dine-In') }}</span>
                            </div>
                            <p class="text-xs font-medium text-muted-foreground">{{ $t('Placed:') }} <span data-no-i18n>{{ formatDateTime(selectedOrder?.created_at) }}</span></p>
                        </div>
                    </div>

                    <div class="flex-1">
                        <p class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 ps-1 border-b border-border pb-2">{{ $t('Line Items') }} (<span data-no-i18n>{{ selectedOrderItems?.length || 0 }}</span>)</p>
                        <div class="space-y-2">
                            <div v-for="item in selectedOrderItems" :key="item.id" class="flex items-center justify-between p-3 bg-card rounded-md border border-border shadow-sm">
                                <div class="flex items-start gap-3">
                                    <div class="w-10 h-10 bg-secondary border border-border rounded-md flex items-center justify-center text-muted-foreground font-semibold text-xs shrink-0">
                                        <span data-no-i18n>{{ item.quantity }}x</span>
                                    </div>
                                    <div>
                                        <p class="font-semibold text-sm text-foreground leading-tight" data-no-i18n>{{ item.product_name || $t('Unknown Item') }}</p>
                                        <p class="text-[11px] font-medium text-muted-foreground mt-1" data-no-i18n>@ {{ Number(item.price_at_sale || 0).toFixed(2) }} JD</p>
                                        <p v-if="item.note" class="text-[10px] font-medium text-foreground mt-1.5 bg-secondary inline-block px-2 py-0.5 rounded border border-border" data-no-i18n>- {{ item.note }}</p>
                                    </div>
                                </div>
                                <div class="text-end shrink-0 logical-ps-4">
                                    <p class="font-semibold text-foreground" data-no-i18n>{{ (Number(item.price_at_sale || 0) * Number(item.quantity || 1)).toFixed(2) }} JD</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="md:w-2/5 bg-card p-6 md:p-8 flex flex-col border-t md:border-t-0 md:border-l border-border">
                    <div class="mb-8">
                        <p class="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 border-b border-border pb-2">{{ $t('Payment Validation') }}</p>
                        <div class="flex items-center justify-between p-4 bg-muted/50 border border-border rounded-md">
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 bg-background rounded-md border border-border flex items-center justify-center shadow-sm text-foreground text-base">
                                    <i v-if="selectedOrder?.payment_method === 'cash'" class="fa-solid fa-money-bill-wave text-muted-foreground"></i>
                                    <i v-else-if="selectedOrder?.payment_method === 'card'" class="fa-regular fa-credit-card text-muted-foreground"></i>
                                    <i v-else class="fa-solid fa-arrows-split-up-and-left text-muted-foreground"></i>
                                </div>
                                <div>
                                    <p class="text-sm font-semibold text-foreground capitalize">{{ $t(selectedOrder?.payment_method === 'cash' ? 'Cash' : selectedOrder?.payment_method === 'card' ? 'Card' : selectedOrder?.payment_method ? 'Split' : 'Unknown') }}</p>
                                    <p class="text-[10px] font-medium text-muted-foreground mt-0.5"><i class="fa-solid fa-user-tag text-[9px] me-1"></i><span data-no-i18n>{{ selectedOrder?.cashier_name }}</span></p>
                                </div>
                            </div>
                            <i class="fa-solid fa-circle-check text-foreground text-xl"></i>
                        </div>
                    </div>

                    <div class="space-y-3 pt-4 border-t border-border">
                        <div class="flex justify-between text-sm font-medium text-muted-foreground">
                            <span>{{ $t('Subtotal') }}</span>
                            <span data-no-i18n>{{ Number(selectedOrder?.subtotal || 0).toFixed(2) }} JD</span>
                        </div>
                        <div class="flex justify-between text-sm font-medium text-muted-foreground">
                            <span>{{ $t('Tax') }}</span>
                            <span data-no-i18n>{{ Number(selectedOrder?.tax || 0).toFixed(2) }} JD</span>
                        </div>
                        
                        <div v-if="Number(selectedOrder?.discount_value || 0) > 0" class="flex justify-between text-sm font-medium text-destructive">
                            <span>{{ $t('Order Discount') }}</span>
                            <span data-no-i18n>{{ selectedOrder?.discount_type === 'percent' ? '-' + Number(selectedOrder?.discount_value) + '%' : '-' + Number(selectedOrder?.discount_value).toFixed(2) + ' JD' }}</span>
                        </div>
                        
                        <div class="pt-4 mt-2 border-t border-border flex justify-between items-end">
                            <span class="text-sm font-semibold text-foreground uppercase tracking-wider">{{ Number(selectedOrder?.discount_value || 0) > 0 ? $t('Final Total') : $t('Total Amount') }}</span>
                            <span class="text-3xl font-semibold text-foreground tracking-tight" data-no-i18n>{{ Number(selectedOrder?.total || 0).toFixed(2) }} JD</span>
                        </div>
                    </div>

                    <div class="mt-auto space-y-3 pt-6">
                        <div class="flex gap-3 mb-4">
                            <button @click="reprintReceipt" class="flex-1 py-2.5 bg-primary text-primary-foreground font-semibold rounded-md hover:bg-primary/90 transition-all shadow-sm text-xs uppercase tracking-wider flex items-center justify-center gap-2">
                                <i class="fa-solid fa-print"></i> {{ $t('Reprint') }}
                            </button>
                        </div>

                        <div class="p-4 bg-muted/40 border border-border rounded-md space-y-2 shadow-sm">
                            <div class="flex justify-between items-center">
                                <span class="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{{ $t('Amount Tendered') }}</span>
                                <span class="text-sm font-semibold text-foreground" data-no-i18n>{{ Number(selectedOrder?.amount_tendered || 0).toFixed(2) }} JD</span>
                            </div>
                            <div class="flex justify-between items-center">
                                <span class="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{{ $t('Change Due') }}</span>
                                <span class="text-sm font-semibold text-foreground" data-no-i18n>{{ Number(selectedOrder?.change_due || 0).toFixed(2) }} JD</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { fetchJson } from '@/shared/http.js';
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { t, currentLanguage } from '@/shared/i18n.js';
import { getSystemSettings } from '@/shared/systemSettings.js';
import { buildReceiptPayload, printJob } from '@/shared/receiptPrint.js';
import { orderIdentityLabel } from '../../utils/orderIdentityDisplay.js';
import { currentBusinessDate, formatBusinessDateTime, formatBusinessTime } from '../../utils/businessDate.js';

export default {
    setup() {
        const router = useRouter();
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const isLoading = ref(false);
        const getToday = () => currentBusinessDate();
        const waiterReportDate = ref(getToday());
        const waitersSummary = ref([]);
        const waiterOrders = ref([]);
        const selectedWaiterId = ref(null);
        const selectedWaiterName = ref('');

        const showModal = ref(false);
        const selectedOrder = ref(null);
        const selectedOrderItems = ref([]);
        const isModalLoading = ref(false);


        const goBack = () => {
            router.push('/orders');
        };

        const fetchWaiterReport = async () => {
            isLoading.value = true;
            try {
                const data = await fetchJson(`api/admin/reports/waiters?date=${waiterReportDate.value}`);
                if (data.success) {
                    waitersSummary.value = data.summary || [];
                    waiterOrders.value = data.orders || [];
                    if (selectedWaiterId.value) {
                        const exists = waitersSummary.value.some(w => w.waiter_id === selectedWaiterId.value);
                        if (!exists) {
                            selectedWaiterId.value = null;
                            selectedWaiterName.value = '';
                        }
                    }
                }
            } catch (e) {
                console.error(e);
                await window.showAdminAlert(t("Failed to load waiter performance report."));
            } finally {
                isLoading.value = false;
            }
        };

        const selectWaiter = (waiter) => {
            selectedWaiterId.value = waiter.waiter_id;
            selectedWaiterName.value = waiter.waiter_name;
        };

        const waiterDetailOrders = computed(() => {
            if (!selectedWaiterId.value) return [];
            return waiterOrders.value.filter(o => o.waiter_id === selectedWaiterId.value);
        });

        const viewOrder = async (invoiceId) => {
            showModal.value = true;
            isModalLoading.value = true;
            try {
                const data = await fetchJson(`api/admin/order_details?id=${invoiceId}`);
                if (data.success) {
                    selectedOrder.value = data.order;
                    selectedOrderItems.value = data.items;
                }
            } catch (error) {
                await window.showAdminAlert(t("Failed to load order details."));
                showModal.value = false;
            } finally {
                isModalLoading.value = false;
            }
        };

        const reprintReceipt = async () => {
            const localPrinterId = localStorage.getItem("pos_receipt_printer_id") || '';
            const storeSettings = await getSystemSettings();
            const payload = buildReceiptPayload(selectedOrder.value, selectedOrderItems.value, { storeInfo: storeSettings, receiptPrinterId: localPrinterId });
            await printJob(payload, { alert: window.showAdminAlert, t });
        };

        const formatDateTime = (dateVal) => {
            return formatBusinessDateTime(dateVal);
        };

        const getOrderTime = (dateVal) => {
            return formatBusinessTime(dateVal);
        };

        onMounted(() => {
            fetchWaiterReport();
        });

        return {
            isLoading, waiterReportDate, waitersSummary, selectedWaiterId, selectedWaiterName,
            waiterDetailOrders, showModal, selectedOrder, selectedOrderItems, isModalLoading,
            goBack, fetchWaiterReport, selectWaiter, viewOrder, reprintReceipt,
            formatDateTime, getOrderTime, isRtl, orderIdentityLabel
        };
    }
};
</script>

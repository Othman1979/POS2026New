<template>
        <div class="orders-workspace admin-data-page h-full min-h-0 flex flex-col font-sans animate-fade-in text-foreground bg-background">
            <header class="admin-grid-page-bar shrink-0">
                <div class="admin-grid-page-context">
                    <h2>{{ $t('Order History') }}</h2>
                    <span class="admin-grid-record-count"><span class="tabular-nums" data-no-i18n>{{ totalRecords }}</span> {{ $t('orders') }}</span>
                </div>
            </header>

            <section class="admin-grid-command-bar select-none shrink-0 overflow-visible">
                <div class="admin-grid-command-row flex-wrap">
                    <label class="admin-grid-search">
                        <span class="sr-only">{{ $t('Search invoice') }}</span>
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input v-model="searchInvoice" type="search" :placeholder="$t('Search invoice')" autocomplete="off" />
                    </label>
                    <input v-model="searchOrder" type="text" :aria-label="$t('Queue')" :placeholder="$t('Queue')" class="admin-grid-input w-[7rem] tabular-nums" />
                    <input v-model="searchTotal" type="text" inputmode="decimal" :aria-label="$t('Total')" :placeholder="$t('Total')" class="admin-grid-input w-[7.5rem] tabular-nums" />
                    <div class="admin-grid-filter-row">
                        <div class="flex items-center h-9 min-w-[15rem] flex-1 bg-white border border-zinc-300 rounded-[5px] px-2.5">
                            <input v-model="startDate" :aria-label="$t('Start')" class="min-w-0 flex-1 bg-transparent border-none p-0 text-[11px] font-semibold text-foreground outline-none focus:ring-0 tabular-nums" type="date"/>
                            <i :class="['fa-solid text-[8px] text-muted-foreground mx-1.5 shrink-0', isRtl ? 'fa-arrow-left-long' : 'fa-arrow-right-long']" aria-hidden="true"></i>
                            <input v-model="endDate" :aria-label="$t('End')" class="min-w-0 flex-1 bg-transparent border-none p-0 text-[11px] font-semibold text-foreground outline-none focus:ring-0 tabular-nums" type="date"/>
                        </div>
                        <div class="admin-grid-segmented shrink-0">
                            <button @click="setQuickFilter('today')" :class="{ 'is-active': activeQuickDateFilter === 'today' }" type="button">{{ $t('Today') }}</button>
                            <button @click="setQuickFilter('yesterday')" :class="{ 'is-active': activeQuickDateFilter === 'yesterday' }" type="button">{{ $t('Yesterday') }}</button>
                            <button @click="setQuickFilter('week')" :class="{ 'is-active': activeQuickDateFilter === 'week' }" type="button">{{ $t('Last 7 days') }}</button>
                        </div>
                    </div>
                </div>

                <div class="admin-grid-command-row justify-between">
                    <div class="flex items-center gap-2 min-w-0">
                        <div v-if="tablesEnabled" class="admin-grid-segmented shrink-0">
                            <button @click="setOrderSource('register')" :class="{ 'is-active': orderSource === 'register' }" type="button">
                                <i class="fa-solid fa-cash-register me-1.5 text-[10px]" aria-hidden="true"></i>
                                <span>{{ $t('Register') }}</span>
                            </button>
                            <button @click="setOrderSource('tables')" :class="{ 'is-active': orderSource === 'tables' }" type="button">
                                <i class="fa-solid fa-chair me-1.5 text-[10px]" aria-hidden="true"></i>
                                <span>{{ $t('Tables') }}</span>
                            </button>
                        </div>

                        <div class="relative">
                            <button @click="showFilters = !showFilters; showColumnsToggle = false;" :class="{ 'admin-grid-button--soft': activeFilterCount > 0 }" class="admin-grid-button" type="button" :aria-expanded="showFilters">
                                <i class="fa-solid fa-sliders text-[11px]" aria-hidden="true"></i>
                                <span>{{ $t('Filters') }}</span>
                                <span v-if="activeFilterCount > 0" class="min-w-5 h-5 px-1 inline-flex items-center justify-center bg-teal-700 text-white rounded text-[10px] font-bold tabular-nums" data-no-i18n>{{ activeFilterCount }}</span>
                                <i class="fa-solid fa-chevron-down text-[9px] opacity-50" aria-hidden="true"></i>
                            </button>
                            <div v-if="showFilters" @click="showFilters = false" class="fixed inset-0 z-40"></div>
                            <div v-if="showFilters" class="admin-grid-popover logical-inline-start w-[min(21rem,calc(100vw-3rem))] flex flex-col gap-4 max-h-[70vh] overflow-y-auto admin-grid-scroll">
                                <div>
                                    <p class="text-xs font-semibold text-foreground mb-2">{{ $t('Payment') }}</p>
                                    <div class="grid grid-cols-2 gap-2">
                                        <button v-for="method in ['cash', 'card', 'split', 'platform']" :key="method" @click="togglePaymentMethod(method)" :class="selectedPaymentMethods.includes(method) ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-zinc-300 bg-card text-foreground hover:bg-zinc-100'" class="h-9 px-2 border rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                            <i :class="['text-[10px]', selectedPaymentMethods.includes(method) ? 'fa-solid fa-check' : 'fa-regular fa-circle']" aria-hidden="true"></i>
                                            <span>{{ $t(method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : method === 'platform' ? 'Platform' : 'Split') }}</span>
                                        </button>
                                    </div>
                                </div>
                                <div class="border-t border-zinc-200 pt-4">
                                    <p class="text-xs font-semibold text-foreground mb-2">{{ $t('Refund status') }}</p>
                                    <div class="grid grid-cols-2 gap-2">
                                        <button @click="selectedRefundStatus = ''" :class="!selectedRefundStatus ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-zinc-300 bg-card text-foreground hover:bg-zinc-100'" class="h-9 px-2 border rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                            <i :class="['text-[10px]', !selectedRefundStatus ? 'fa-solid fa-check' : 'fa-regular fa-circle']" aria-hidden="true"></i>
                                            <span>{{ $t('All refunds') }}</span>
                                        </button>
                                        <button v-for="status in [{ value: 'none', label: 'Not refunded' }, { value: 'partial', label: 'Partial refund' }, { value: 'full', label: 'Full refund' }]" :key="status.value" @click="selectedRefundStatus = status.value" :class="selectedRefundStatus === status.value ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-zinc-300 bg-card text-foreground hover:bg-zinc-100'" class="h-9 px-2 border rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                            <i :class="['text-[10px]', selectedRefundStatus === status.value ? 'fa-solid fa-check' : 'fa-regular fa-circle']" aria-hidden="true"></i>
                                            <span>{{ $t(status.label) }}</span>
                                        </button>
                                    </div>
                                </div>
                                <div class="border-t border-zinc-200 pt-4">
                                    <p class="text-xs font-semibold text-foreground mb-2">{{ $t('JoFotara status') }}</p>
                                    <div class="grid grid-cols-2 gap-2">
                                        <button @click="selectedJofotaraStatus = ''" :class="!selectedJofotaraStatus ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-zinc-300 bg-card text-foreground hover:bg-zinc-100'" class="h-9 px-2 border rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                            <i :class="['text-[10px]', !selectedJofotaraStatus ? 'fa-solid fa-check' : 'fa-regular fa-circle']" aria-hidden="true"></i>
                                            <span>{{ $t('All JoFotara') }}</span>
                                        </button>
                                        <button v-for="status in [{ value: 'not_submitted', label: 'JoFotara not sent' }, { value: 'accepted', label: 'JoFotara sent' }, { value: 'needs_attention', label: 'Needs attention' }]" :key="status.value" @click="selectedJofotaraStatus = status.value" :class="selectedJofotaraStatus === status.value ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-zinc-300 bg-card text-foreground hover:bg-zinc-100'" class="h-9 px-2 border rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                            <i :class="['text-[10px]', selectedJofotaraStatus === status.value ? 'fa-solid fa-check' : 'fa-regular fa-circle']" aria-hidden="true"></i>
                                            <span>{{ $t(status.label) }}</span>
                                        </button>
                                    </div>
                                </div>
                                <div class="border-t border-zinc-200 pt-4">
                                    <p class="text-xs font-semibold text-foreground mb-2">{{ $t('Cashier') }}</p>
                                    <div class="relative mb-2">
                                        <i class="fa-solid fa-magnifying-glass absolute logical-start-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground" aria-hidden="true"></i>
                                        <input v-model="cashierSearchText" class="w-full h-9 bg-background border border-zinc-300 rounded-lg logical-ps-8 logical-pe-3 text-xs outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 placeholder:text-muted-foreground" :placeholder="$t('Filter cashiers')" type="text"/>
                                    </div>
                                    <div class="max-h-40 overflow-y-auto premium-scroll flex flex-col gap-1">
                                        <button @click="selectCashier(null)" :class="!selectedCashierId ? 'bg-teal-50 text-teal-800' : 'hover:bg-zinc-100'" class="flex items-center gap-2 px-2.5 py-2 text-xs rounded-lg logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 w-full" type="button">
                                            <i class="w-3.5 text-[10px] text-teal-700 flex items-center justify-center" :class="!selectedCashierId ? 'fa-solid fa-check' : ''" aria-hidden="true"></i>
                                            <span>{{ $t('All Cashiers') }}</span>
                                        </button>
                                        <button v-for="cashier in filteredCashiers" :key="cashier.id" @click="selectCashier(cashier.id)" :class="selectedCashierId === cashier.id ? 'bg-teal-50 text-teal-800' : 'hover:bg-zinc-100'" class="flex items-center gap-2 px-2.5 py-2 text-xs rounded-lg logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 w-full" type="button">
                                            <i class="w-3.5 text-[10px] text-teal-700 flex items-center justify-center" :class="selectedCashierId === cashier.id ? 'fa-solid fa-check' : ''" aria-hidden="true"></i>
                                            <span data-no-i18n>{{ cashier.name }}</span>
                                        </button>
                                    </div>
                                </div>
                                <div v-if="orderSource === 'tables'" class="border-t border-zinc-200 pt-4">
                                    <button @click="goToWaiterPerformance(); showFilters = false;" class="w-full h-9 bg-teal-700 text-white hover:bg-teal-800 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40" type="button">
                                        <i class="fa-solid fa-user-clock text-[10px]" aria-hidden="true"></i>
                                        <span>{{ $t('Waiter Performance') }}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-2 shrink-0">
                        <div class="relative hidden md:block">
                            <button @click="showColumnsToggle = !showColumnsToggle; showFilters = false;" class="admin-grid-button" type="button" :aria-expanded="showColumnsToggle">
                                <i class="fa-solid fa-table-columns text-[11px]" aria-hidden="true"></i>
                                <span>{{ $t('Columns') }}</span>
                                <i class="fa-solid fa-chevron-down text-[9px] opacity-50" aria-hidden="true"></i>
                            </button>
                            <div v-if="showColumnsToggle" @click="showColumnsToggle = false" class="fixed inset-0 z-40"></div>
                            <div v-if="showColumnsToggle" class="admin-grid-popover logical-inline-end w-48 flex flex-col gap-1">
                                <p class="px-2 py-1.5 text-xs font-semibold text-foreground border-b border-zinc-200 mb-1">{{ $t('Toggle Columns') }}</p>
                                <button v-for="(val, col) in visibleColumns" :key="col" @click="visibleColumns[col] = !visibleColumns[col]" class="flex items-center gap-2 px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 w-full" type="button">
                                    <i class="w-3.5 text-[10px] text-teal-700 flex items-center justify-center" :class="val ? 'fa-solid fa-check' : ''" aria-hidden="true"></i>
                                    <span>{{ $t(columnLabel(col)) }}</span>
                                </button>
                            </div>
                        </div>
                        <button @click="clearAllFilters" :aria-label="$t('Reset')" class="admin-grid-button" type="button">
                            <i class="fa-solid fa-arrow-rotate-left text-[11px]" aria-hidden="true"></i>
                            <span class="hidden sm:inline">{{ $t('Reset') }}</span>
                        </button>
                    </div>
                </div>

                <div v-if="selectedPaymentMethods.length || selectedCashierId || isDiscounted || selectedRefundStatus || selectedJofotaraStatus" class="admin-grid-command-row overflow-x-auto admin-grid-scroll">
                    <span class="text-[10.5px] font-semibold text-muted-foreground shrink-0">{{ $t('Filters') }}:</span>
                    <button v-for="method in selectedPaymentMethods" :key="method" @click="togglePaymentMethod(method)" class="admin-grid-filter-note" type="button">
                        <span>{{ $t(method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : 'Split') }}</span>
                        <i class="fa-solid fa-xmark text-[9px]" aria-hidden="true"></i>
                    </button>
                    <button v-if="selectedCashierId" @click="selectCashier(null)" class="admin-grid-filter-note" type="button">
                        <span data-no-i18n>{{ selectedCashierName }}</span>
                        <i class="fa-solid fa-xmark text-[9px]" aria-hidden="true"></i>
                    </button>
                    <button v-if="selectedRefundStatus" @click="selectedRefundStatus = ''" class="admin-grid-filter-note" type="button">
                        <span>{{ $t(selectedRefundStatus === 'none' ? 'Not refunded' : selectedRefundStatus === 'partial' ? 'Partial refund' : 'Full refund') }}</span>
                        <i class="fa-solid fa-xmark text-[9px]" aria-hidden="true"></i>
                    </button>
                    <button v-if="selectedJofotaraStatus" @click="selectedJofotaraStatus = ''" class="admin-grid-filter-note" type="button">
                        <span>{{ $t(selectedJofotaraStatus === 'not_submitted' ? 'JoFotara not sent' : selectedJofotaraStatus === 'accepted' ? 'JoFotara sent' : 'Needs attention') }}</span>
                        <i class="fa-solid fa-xmark text-[9px]" aria-hidden="true"></i>
                    </button>
                    <button v-if="isDiscounted" @click="isDiscounted = false" class="admin-grid-filter-note" type="button">
                        <span>{{ $t('Discounted') }}</span>
                        <i class="fa-solid fa-xmark text-[9px]" aria-hidden="true"></i>
                    </button>
                </div>
            </section>

            <!-- Orders ledger -->
            <section class="admin-grid-shell flex-1 min-h-[25rem] flex flex-col relative">
                <div v-if="isLoading" class="absolute inset-0 bg-card/95 z-20 p-5" aria-live="polite" :aria-label="$t('Loading...')">
                    <div class="animate-pulse space-y-4">
                        <div class="h-9 rounded-lg bg-zinc-100"></div>
                        <div v-for="index in 7" :key="index" class="grid grid-cols-[1fr_1.05fr_.95fr_.65fr_1.35fr_.65fr] gap-5 items-center px-3">
                            <span class="h-3 rounded bg-zinc-100"></span>
                            <span class="h-3 rounded bg-zinc-100"></span>
                            <span class="h-3 rounded bg-zinc-100"></span>
                            <span class="h-3 rounded bg-zinc-100"></span>
                            <span class="h-3 rounded bg-zinc-100"></span>
                            <span class="h-3 rounded bg-zinc-100"></span>
                        </div>
                    </div>
                </div>

                <div class="admin-grid-scroll hidden md:block overflow-x-auto overflow-y-auto flex-1">
                    <table class="admin-data-grid min-w-[940px]">
                        <thead class="sticky top-0 z-10">
                            <tr>
                                <th v-if="visibleColumns.identifiers" class="h-11 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] w-[17%]">{{ $t('Order') }}</th>
                                <th v-if="visibleColumns.dateTime" class="h-11 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] w-[18%]">{{ $t('Date & Time') }}</th>
                                <th v-if="visibleColumns.cashier" class="h-11 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] w-[16%]">{{ $t('Cashier') }}</th>
                                <th v-if="visibleColumns.payment" class="h-11 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] w-[11%]">{{ $t('Payment') }}</th>
                                <th v-if="visibleColumns.status" class="h-11 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] w-[23%]">{{ $t('Status') }}</th>
                                <th v-if="visibleColumns.total" class="h-11 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] logical-text-end w-[10%]">{{ $t('Total') }}</th>
                                <th v-if="visibleColumns.action" class="h-11 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.08em] logical-text-end w-[5%]">{{ $t('Action') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-if="orders.length === 0">
                                <td :colspan="Object.values(visibleColumns).filter(Boolean).length" class="py-28 text-center">
                                    <div class="flex flex-col items-center justify-center text-muted-foreground px-6">
                                        <div class="w-11 h-11 rounded-xl bg-zinc-100 border border-zinc-200 flex items-center justify-center mb-3">
                                            <i class="fa-regular fa-folder-open text-base" aria-hidden="true"></i>
                                        </div>
                                        <span class="font-semibold text-sm text-foreground">{{ $t('No orders found') }}</span>
                                        <span class="text-xs text-muted-foreground mt-1.5">{{ $t('Try adjusting your filters or date range') }}</span>
                                    </div>
                                </td>
                            </tr>
                            <tr v-for="order in orders" :key="order.invoice_id" @click="viewOrder(order.invoice_id)" @keydown.enter.self="viewOrder(order.invoice_id)" @keydown.space.self.prevent="viewOrder(order.invoice_id)" :aria-label="$t('View Details') + ': ' + orderIdentityLabel(order, $t)" tabindex="0" :class="rowStatusClass(order)" class="group transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600/40">
                                <td v-if="visibleColumns.identifiers" class="h-[3.65rem] px-5">
                                    <div class="min-w-0">
                                        <p class="admin-grid-primary-text tabular-nums">{{ orderIdentityLabel(order, $t) }}</p>
                                        <p class="admin-grid-secondary-text tabular-nums" data-no-i18n>{{ $t('Order') }} {{ order.order_display_no || order.order_id }}</p>
                                    </div>
                                </td>
                                <td v-if="visibleColumns.dateTime" class="h-[3.65rem] px-5">
                                    <p class="admin-grid-primary-text !font-semibold tabular-nums" data-no-i18n>{{ getOrderDate(order.created_at) }}</p>
                                    <p class="admin-grid-secondary-text tabular-nums" data-no-i18n>{{ getOrderTime(order.created_at) }}</p>
                                </td>
                                <td v-if="visibleColumns.cashier" class="h-[3.65rem] px-5">
                                    <p class="admin-grid-primary-text !font-semibold" data-no-i18n>{{ order.cashier_name || $t('Unknown') }}</p>
                                </td>
                                <td v-if="visibleColumns.payment" class="h-[3.65rem] px-3">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span :class="['admin-grid-status', order.payment_method === 'voided' ? 'is-danger' : order.payment_method === 'split' ? 'is-warning' : 'is-success']">
                                            {{ $t(order.payment_method === 'cash' ? 'Cash' : order.payment_method === 'card' ? 'Card' : order.payment_method === 'platform' ? 'Platform' : order.payment_method === 'voided' ? 'Voided' : 'Split') }}
                                        </span>
                                    </div>
                                </td>
                                <td v-if="visibleColumns.status" class="order-status-cell h-[3.65rem] px-3">
                                    <div class="flex items-center gap-1 flex-wrap">
                                        <span v-if="order.payment_method !== 'voided'" :class="['text-[9px] font-semibold px-1.5 py-0.5 rounded border', jofotaraStatusClass(order.jofotara_status)]">{{ $t(jofotaraStatusLabel(order.jofotara_status)) }}</span>
                                        <span v-if="showJofotaraReturnMarker(order)" :class="['text-[9px] font-semibold px-1.5 py-0.5 rounded border', jofotaraStatusClass(order.jofotara_return_status)]">{{ $t(jofotaraReturnStatusLabel(order.jofotara_return_status)) }}</span>
                                        <span v-if="order.refund_status === 'full'" class="text-[9px] font-semibold px-1.5 py-0.5 rounded border bg-rose-50 text-rose-800 border-rose-200">{{ $t('Full refund') }}</span>
                                        <span v-else-if="order.refund_status === 'partial'" class="text-[9px] font-semibold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-200">{{ $t('Partial refund') }}</span>
                                    </div>
                                </td>
                                <td v-if="visibleColumns.total" class="h-[3.65rem] px-4 logical-text-end" data-no-i18n>
                                    <p class="admin-grid-money">{{ Number(order.total || 0).toFixed(2) }} JD</p>
                                    <p v-if="hasDiscount(order)" class="text-[10px] font-semibold text-amber-700 mt-0.5 tabular-nums">-{{ discountAmount(order).toFixed(2) }} JD</p>
                                </td>
                                <td v-if="visibleColumns.action" :class="{ 'order-row-menu-open': activeRowMenu === order.invoice_id }" class="h-[3.65rem] px-3" @click.stop>
                                    <div class="admin-grid-row-actions">
                                        <div class="relative">
                                            <button @click.stop="toggleRowMenu(order.invoice_id)" :aria-label="$t('More')" type="button">
                                                <i class="fa-solid fa-ellipsis text-xs" aria-hidden="true"></i>
                                            </button>
                                            <div v-if="activeRowMenu === order.invoice_id" @click.stop="activeRowMenu = null" class="fixed inset-0 z-40"></div>
                                            <div v-if="activeRowMenu === order.invoice_id" class="admin-grid-popover logical-inline-end w-44 flex flex-col gap-0.5">
                                                <button @click="copyInvoiceId(order); activeRowMenu = null;" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 w-full" type="button">
                                                    <i class="fa-solid fa-copy text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i>
                                                    <span>{{ $t('Copy Invoice') }}</span>
                                                </button>
                                                <button @click="reprintDirect(order); activeRowMenu = null;" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 w-full" type="button">
                                                    <i class="fa-solid fa-print text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i>
                                                    <span>{{ $t('Reprint') }}</span>
                                                </button>
                                                <button @click="downloadJofotaraXml(order); activeRowMenu = null;" :disabled="!isJofotaraEligible(order)" class="px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start w-full disabled:opacity-40" type="button">{{ $t('Generate XML') }}</button>
                                                <button v-if="jofotaraEnabled && canShowJofotaraInvoiceAction(order)" @click="handleJofotaraInvoice(order); activeRowMenu = null;" :disabled="order.jofotara_status !== 'accepted' && (!isJofotaraEligible(order) || order.jofotara_status === 'submitting' || order.jofotara_status === 'unknown')" class="px-2.5 py-2 text-xs rounded-lg hover:bg-teal-50 hover:text-teal-800 logical-text-start w-full disabled:opacity-40" type="button">{{ $t(jofotaraInvoiceAction(order)) }}</button>
                                                <button @click="openRefundModal(order); activeRowMenu = null;" :disabled="!canRefund || order.payment_method === 'voided' || order.refund_status === 'full'" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-rose-50 hover:text-rose-800 logical-text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 w-full disabled:opacity-40 disabled:cursor-not-allowed" type="button">
                                                    <i class="fa-solid fa-rotate-left text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i>
                                                    <span>{{ $t('Refund') }}</span>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="admin-grid-mobile-list admin-grid-scroll block md:hidden overflow-y-auto flex-1">
                    <div v-if="orders.length === 0" class="py-20 text-center bg-card">
                        <div class="flex flex-col items-center justify-center text-muted-foreground px-6">
                            <div class="w-11 h-11 rounded-xl bg-zinc-100 border border-zinc-200 flex items-center justify-center mb-3">
                                <i class="fa-regular fa-folder-open text-base" aria-hidden="true"></i>
                            </div>
                            <span class="font-semibold text-sm text-foreground">{{ $t('No orders found') }}</span>
                            <span class="text-xs text-muted-foreground mt-1.5">{{ $t('Try adjusting your filters or date range') }}</span>
                        </div>
                    </div>

                    <article v-for="order in orders" :key="order.invoice_id" @click="viewOrder(order.invoice_id)" @keydown.enter.self="viewOrder(order.invoice_id)" @keydown.space.self.prevent="viewOrder(order.invoice_id)" :aria-label="$t('View Details') + ': ' + orderIdentityLabel(order, $t)" tabindex="0" class="admin-grid-mobile-card cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <p class="text-sm font-bold text-foreground tabular-nums">{{ orderIdentityLabel(order, $t) }}</p>
                                    <span class="inline-flex items-center bg-zinc-100 text-muted-foreground text-[9px] px-1.5 py-0.5 rounded font-bold tabular-nums border border-zinc-200" data-no-i18n>{{ $t('Order') }} {{ order.order_display_no || order.order_id }}</span>
                                </div>
                                <div class="flex items-center gap-1 flex-wrap mt-1">
                                    <span v-if="order.payment_method !== 'voided'" :class="['text-[9px] font-semibold px-1.5 py-0.5 rounded border', jofotaraStatusClass(order.jofotara_status)]">{{ $t(jofotaraStatusLabel(order.jofotara_status)) }}</span>
                                    <span v-if="showJofotaraReturnMarker(order)" :class="['text-[9px] font-semibold px-1.5 py-0.5 rounded border', jofotaraStatusClass(order.jofotara_return_status)]">{{ $t(jofotaraReturnStatusLabel(order.jofotara_return_status)) }}</span>
                                    <span v-if="order.refund_status === 'full'" class="text-[9px] font-semibold px-1.5 py-0.5 rounded border bg-rose-50 text-rose-800 border-rose-200">{{ $t('Full refund') }}</span>
                                    <span v-else-if="order.refund_status === 'partial'" class="text-[9px] font-semibold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-200">{{ $t('Partial refund') }}</span>
                                </div>
                                <p class="text-[10px] text-muted-foreground mt-1 tabular-nums" data-no-i18n>{{ formatDateTime(order.created_at) }}</p>
                            </div>
                            <div class="flex items-center gap-1 shrink-0" @click.stop>
                                <div class="relative">
                                    <button @click.stop="toggleRowMenu(order.invoice_id)" :aria-label="$t('More')" class="w-8 h-8 flex items-center justify-center text-muted-foreground hover:bg-zinc-100 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                        <i class="fa-solid fa-ellipsis text-xs" aria-hidden="true"></i>
                                    </button>
                                    <div v-if="activeRowMenu === order.invoice_id" @click.stop="activeRowMenu = null" class="fixed inset-0 z-40"></div>
                                    <div v-if="activeRowMenu === order.invoice_id" class="admin-grid-popover logical-inline-end w-44 flex flex-col gap-0.5">
                                        <button @click="copyInvoiceId(order); activeRowMenu = null;" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start focus-visible:outline-none w-full" type="button"><i class="fa-solid fa-copy text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i><span>{{ $t('Copy Invoice') }}</span></button>
                                        <button @click="reprintDirect(order); activeRowMenu = null;" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start focus-visible:outline-none w-full" type="button"><i class="fa-solid fa-print text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i><span>{{ $t('Reprint') }}</span></button>
                                        <button @click="downloadJofotaraXml(order); activeRowMenu = null;" :disabled="!isJofotaraEligible(order)" class="px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-100 logical-text-start w-full disabled:opacity-40" type="button">{{ $t('Generate XML') }}</button>
                                        <button v-if="jofotaraEnabled && canShowJofotaraInvoiceAction(order)" @click="handleJofotaraInvoice(order); activeRowMenu = null;" :disabled="order.jofotara_status !== 'accepted' && (!isJofotaraEligible(order) || order.jofotara_status === 'submitting' || order.jofotara_status === 'unknown')" class="px-2.5 py-2 text-xs rounded-lg hover:bg-teal-50 hover:text-teal-800 logical-text-start w-full disabled:opacity-40" type="button">{{ $t(jofotaraInvoiceAction(order)) }}</button>
                                        <button @click="openRefundModal(order); activeRowMenu = null;" :disabled="!canRefund || order.payment_method === 'voided' || order.refund_status === 'full'" class="flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg hover:bg-rose-50 hover:text-rose-800 logical-text-start focus-visible:outline-none w-full disabled:opacity-40 disabled:cursor-not-allowed" type="button"><i class="fa-solid fa-rotate-left text-[10px] w-3 text-muted-foreground" aria-hidden="true"></i><span>{{ $t('Refund') }}</span></button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="mt-4 pt-3 border-t border-zinc-200/80 flex items-end justify-between gap-4">
                            <div class="min-w-0 space-y-1.5">
                                <p class="text-xs font-semibold text-foreground truncate" data-no-i18n>{{ order.cashier_name || $t('Unknown') }}</p>
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span :class="order.payment_method === 'voided' ? 'text-rose-700' : 'text-muted-foreground'" class="inline-flex items-center gap-1.5 text-[10px] font-semibold">
                                        <i :class="['fa-solid text-[9px]', order.payment_method === 'cash' ? 'fa-money-bill-wave text-teal-700' : order.payment_method === 'card' ? 'fa-credit-card text-sky-700' : order.payment_method === 'platform' ? 'fa-building-columns text-violet-700' : order.payment_method === 'voided' ? 'fa-ban text-rose-700' : 'fa-code-branch text-amber-700']" aria-hidden="true"></i>
                                        {{ $t(order.payment_method === 'cash' ? 'Cash' : order.payment_method === 'card' ? 'Card' : order.payment_method === 'platform' ? 'Platform' : order.payment_method === 'voided' ? 'Voided' : 'Split') }}
                                    </span>
                                    <span v-if="hasDiscount(order)" class="text-[9px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">{{ $t('Discounted') }}</span>
                                </div>
                            </div>
                            <div class="text-end shrink-0">
                                <p class="text-xl font-bold text-foreground tracking-tight tabular-nums leading-none" data-no-i18n>{{ Number(order.total || 0).toFixed(2) }} JD</p>
                                <p v-if="hasDiscount(order)" class="text-[10px] font-semibold text-amber-700 tabular-nums mt-1" data-no-i18n>-{{ discountAmount(order).toFixed(2) }} JD</p>
                            </div>
                        </div>
                    </article>
                </div>

                <footer class="admin-grid-pagination shrink-0 mt-auto">
                    <div class="admin-grid-pagination-summary hidden sm:flex"><p><strong class="tabular-nums" data-no-i18n>{{ orders.length }}</strong> {{ $t('of') }} <strong class="tabular-nums" data-no-i18n>{{ totalRecords }}</strong> {{ $t('orders') }}</p></div>
                    <div class="admin-grid-pagination-controls w-full sm:w-auto justify-between sm:justify-end">
                        <button @click="prevPage" :disabled="currentPage === 1" :aria-label="$t('Prev')" type="button"><i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']" aria-hidden="true"></i></button>
                        <span>{{ $t('Page') }} <strong class="tabular-nums" data-no-i18n>{{ currentPage }}</strong> / <span class="tabular-nums" data-no-i18n>{{ totalPages || 1 }}</span></span>
                        <button @click="nextPage" :disabled="currentPage === totalPages || totalPages === 0" :aria-label="$t('Next')" type="button"><i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']" aria-hidden="true"></i></button>
                    </div>
                </footer>
            </section>

            <!-- Order details workspace -->
            <teleport to="body">
                <transition name="orders-modal">
                    <div v-if="showModal" @click.self="showModal = false" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/55 backdrop-blur-[2px] sm:p-6">
                        <section role="dialog" aria-modal="true" aria-labelledby="order-details-title" :class="{ 'sm:min-h-[32rem]': isModalLoading }" class="bg-card w-full h-[100dvh] sm:h-auto sm:max-h-[88dvh] lg:max-h-[82dvh] sm:max-w-[52rem] sm:rounded-xl shadow-[0_28px_90px_rgba(9,9,11,0.30)] overflow-hidden flex flex-col border border-zinc-300 relative">
                            <div v-if="isModalLoading" class="absolute inset-x-0 top-20 bottom-0 bg-card/95 z-20 p-6" aria-live="polite" :aria-label="$t('Loading...')">
                                <div class="animate-pulse max-w-4xl mx-auto mt-16 space-y-5">
                                    <div class="h-8 w-52 bg-zinc-100 rounded-lg"></div>
                                    <div class="grid grid-cols-2 gap-3"><div class="h-20 bg-zinc-100 rounded-xl"></div><div class="h-20 bg-zinc-100 rounded-xl"></div></div>
                                    <div v-for="index in 4" :key="index" class="h-16 bg-zinc-100 rounded-xl"></div>
                                </div>
                            </div>

                            <header class="shrink-0 px-4 sm:px-5 py-3.5 border-b border-zinc-200 flex items-center justify-between gap-4 bg-card">
                                <div class="min-w-0">
                                    <div v-if="selectedOrder" class="flex items-center gap-2 flex-wrap mb-1">
                                        <span v-if="selectedOrder?.payment_method === 'voided'" class="text-[10px] font-bold text-rose-800 bg-rose-100 border border-rose-200 rounded-full px-2 py-1">{{ $t('Voided') }}</span>
                                        <span v-else-if="selectedOrder?.refund_status === 'full'" class="text-[10px] font-bold text-rose-800 bg-rose-100 border border-rose-200 rounded-full px-2 py-1">{{ $t('Refunded') }}</span>
                                        <span v-else-if="selectedOrder?.refund_status === 'partial'" class="text-[10px] font-bold text-orange-800 bg-orange-100 border border-orange-200 rounded-full px-2 py-1">{{ $t('Partially Refunded') }}</span>
                                        <span v-else class="text-[10px] font-bold text-teal-800 bg-teal-50 border border-teal-200 rounded-full px-2 py-1">{{ $t('Completed') }}</span>
                                        <span class="text-[10px] font-medium text-muted-foreground">{{ $t('Queue #') }} <span class="tabular-nums text-foreground font-bold" data-no-i18n>{{ selectedOrder?.order_display_no || selectedOrder?.order_id }}</span></span>
                                    </div>
                                    <div class="flex items-baseline gap-2.5 min-w-0">
                                        <h2 id="order-details-title" class="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground whitespace-nowrap">{{ $t('Order details') }}</h2>
                                        <p class="text-xs font-semibold text-muted-foreground tabular-nums truncate">{{ orderIdentityLabel(selectedOrder, $t) }}</p>
                                    </div>
                                </div>
                                <button @click="showModal = false" :aria-label="$t('Close')" class="w-10 h-10 shrink-0 hover:bg-zinc-100 rounded-lg text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button">
                                    <i class="fa-solid fa-xmark text-base" aria-hidden="true"></i>
                                </button>
                            </header>

                            <div v-if="detailError" role="alert" class="p-6 space-y-3">
                                <p>{{ $t(detailError) }}</p>
                                <button type="button" class="admin-grid-button" @click="viewOrder(detailInvoiceId)">{{ $t('Retry') }}</button>
                            </div>
                            <div v-if="selectedOrder && !isModalLoading" class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,.75fr)] min-h-0 flex-1 overflow-y-auto lg:overflow-hidden premium-scroll">
                                <div class="p-4 sm:p-5 lg:overflow-y-auto premium-scroll bg-background">
                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                                        <div class="p-4 bg-card border border-zinc-200 rounded-xl">
                                            <div class="flex items-start gap-3">
                                                <div class="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center text-muted-foreground shrink-0"><i class="fa-regular fa-user text-xs" aria-hidden="true"></i></div>
                                                <div class="min-w-0">
                                                    <p class="text-[10px] font-semibold text-muted-foreground mb-1">{{ $t('Customer') }}</p>
                                                    <p class="font-bold text-foreground text-sm truncate" data-no-i18n>{{ selectedOrder?.customer_name || $t('Walk-in Customer') }}</p>
                                                    <p v-if="selectedOrder?.customer_phone" class="text-xs font-medium text-muted-foreground tabular-nums mt-1" data-no-i18n>{{ selectedOrder.customer_phone }}</p>
                                                    <p v-if="selectedOrder?.customer_address" class="text-[11px] font-medium text-muted-foreground mt-2 leading-relaxed" data-no-i18n>{{ selectedOrder.customer_address }}</p>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="p-4 bg-card border border-zinc-200 rounded-xl">
                                            <div class="flex items-start gap-3">
                                                <div class="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center text-muted-foreground shrink-0"><i class="fa-solid fa-bell-concierge text-xs" aria-hidden="true"></i></div>
                                                <div class="min-w-0">
                                                    <p class="text-[10px] font-semibold text-muted-foreground mb-1">{{ $t('Order info') }}</p>
                                                    <p class="text-sm font-bold text-foreground" data-no-i18n>{{ selectedOrder?.order_type_name || $t('Standard') }}</p>
                                                    <p class="text-[11px] font-medium text-muted-foreground mt-1.5">{{ $t('Placed:') }} <span class="tabular-nums" data-no-i18n>{{ formatDateTime(selectedOrder?.created_at) }}</span></p>
                                                    <p v-if="selectedOrder?.delivery_date" class="text-[11px] font-semibold text-foreground mt-1">{{ $t('Target:') }} <span class="tabular-nums" data-no-i18n>{{ formatScheduledDateTime(selectedOrder.delivery_date) }}</span></p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div>
                                        <div class="flex items-center justify-between mb-3">
                                            <h3 class="text-sm font-bold text-foreground">{{ $t('Items') }}</h3>
                                            <span class="text-[10px] font-bold text-muted-foreground bg-zinc-100 border border-zinc-200 rounded-full px-2 py-1 tabular-nums" data-no-i18n>{{ selectedOrderItems?.length || 0 }}</span>
                                        </div>
                                        <div class="border border-zinc-200 rounded-xl divide-y divide-zinc-200 overflow-hidden bg-card">
                                            <div v-for="line in orderDetailLines" :key="line.id" class="flex items-start justify-between gap-4 p-4 transition-colors" :class="line.display.discountAmount > 0 ? 'bg-amber-50/60' : 'hover:bg-zinc-50'">
                                                <div class="flex items-start gap-3 min-w-0">
                                                    <span class="shrink-0 inline-flex items-center justify-center min-w-8 h-8 px-2 bg-zinc-100 border border-zinc-200 rounded-lg text-foreground font-bold text-[11px] tabular-nums" data-no-i18n>{{ line.quantity }}×</span>
                                                    <div class="min-w-0">
                                                        <div class="flex items-center gap-2 flex-wrap">
                                                            <p class="font-bold text-sm text-foreground leading-tight" data-no-i18n>{{ line.product_name || $t('Unknown Item') }}</p>
                                                            <span v-if="line.display.discountAmount > 0" class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">{{ $t('Discounted') }}</span>
                                                        </div>
                                                        <p class="text-[11px] font-medium text-muted-foreground mt-1"><span>{{ $t('Price incl. tax') }}</span> <span class="tabular-nums text-foreground" data-no-i18n>{{ line.display.unitPrice.toFixed(2) }} JD</span></p>
                                                        <p v-if="line.display.refundedQuantity > 0" class="text-[10px] font-semibold text-rose-700 mt-1"><span>{{ $t('Refunded quantity') }}</span> <span class="tabular-nums" data-no-i18n>{{ line.display.refundedQuantity }}</span> · <span>{{ $t('Remaining quantity') }}</span> <span class="tabular-nums" data-no-i18n>{{ line.display.remainingQuantity }}</span></p>
                                                        <p v-if="line.note" class="text-[11px] font-medium text-muted-foreground mt-2 leading-relaxed" data-no-i18n>{{ line.note }}</p>
                                                    </div>
                                                </div>
                                                <div class="text-end shrink-0 tabular-nums" data-no-i18n>
                                                    <p v-if="line.display.discountAmount > 0" class="text-[10px] text-muted-foreground"><span data-i18n>{{ $t('Before item discount') }}</span> <span class="line-through">{{ line.display.originalTotal.toFixed(2) }} JD</span></p>
                                                    <p class="font-bold text-foreground text-sm"><span v-if="line.display.discountAmount > 0" class="text-[10px] font-medium text-muted-foreground" data-i18n>{{ $t('After item discount') }}</span> {{ line.display.finalTotal.toFixed(2) }} JD</p>
                                                    <p v-if="line.display.discountAmount > 0" class="text-[10px] font-semibold text-amber-700">-{{ line.display.discountAmount.toFixed(2) }} JD</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <aside class="bg-zinc-50 border-t lg:border-t-0 lg:border-s border-zinc-200 p-4 sm:p-5 lg:overflow-y-auto premium-scroll flex flex-col">
                                    <div class="pb-4 border-b border-zinc-200">
                                        <p class="text-xs font-semibold text-muted-foreground">{{ orderDetailTotals.refundedAmount > 0 ? $t('Remaining after refund') : $t('Invoice total') }}</p>
                                        <p class="font-display text-3xl sm:text-4xl font-bold text-foreground tracking-tight tabular-nums mt-2 leading-none" data-no-i18n>{{ (orderDetailTotals.refundedAmount > 0 ? orderDetailTotals.remainingAmount : orderDetailTotals.invoiceTotal).toFixed(2) }} <span class="text-sm font-semibold text-muted-foreground">JD</span></p>
                                    </div>

                                    <div class="py-4 border-b border-zinc-200">
                                        <div class="flex items-center justify-between gap-3">
                                            <div class="flex items-center gap-3 min-w-0">
                                                <div class="w-10 h-10 rounded-lg flex items-center justify-center text-sm shrink-0" :class="selectedOrder?.payment_method === 'cash' ? 'bg-teal-100 text-teal-800' : selectedOrder?.payment_method === 'card' ? 'bg-sky-100 text-sky-800' : selectedOrder?.payment_method === 'platform' ? 'bg-violet-100 text-violet-800' : selectedOrder?.payment_method === 'voided' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'">
                                                    <i :class="['fa-solid', selectedOrder?.payment_method === 'cash' ? 'fa-money-bill-wave' : selectedOrder?.payment_method === 'card' ? 'fa-credit-card' : selectedOrder?.payment_method === 'platform' ? 'fa-building-columns' : selectedOrder?.payment_method === 'voided' ? 'fa-ban' : 'fa-code-branch']" aria-hidden="true"></i>
                                                </div>
                                                <div class="min-w-0">
                                                    <p class="text-[10px] font-semibold text-muted-foreground">{{ $t('Payment') }}</p>
                                                    <p class="text-sm font-bold text-foreground mt-0.5">{{ $t(selectedOrder?.payment_method === 'cash' ? 'Cash' : selectedOrder?.payment_method === 'card' ? 'Card' : selectedOrder?.payment_method === 'platform' ? 'Platform' : selectedOrder?.payment_method === 'voided' ? 'Voided' : selectedOrder?.payment_method ? 'Split' : 'Unknown') }}</p>
                                                </div>
                                            </div>
                                            <p class="text-xs font-semibold text-muted-foreground truncate" data-no-i18n>{{ selectedOrder?.cashier_name }}</p>
                                        </div>
                                    </div>

                                    <div class="py-4 space-y-2.5 border-b border-zinc-200">
                                        <div v-if="orderDetailTotals.orderDiscountAmount > 0" class="flex justify-between text-xs font-medium text-muted-foreground"><span>{{ $t('Before order discount') }}</span><span class="tabular-nums text-foreground font-semibold" data-no-i18n>{{ orderDetailTotals.beforeOrderDiscount.toFixed(2) }} JD</span></div>
                                        <div v-if="orderDetailTotals.orderDiscountAmount > 0" class="flex justify-between text-xs font-semibold text-amber-700"><span>{{ $t('Order Discount') }} <span v-if="selectedOrder?.discount_type === 'percent'" data-no-i18n>({{ Number(selectedOrder.discount_value) }}%)</span></span><span class="tabular-nums" data-no-i18n>-{{ orderDetailTotals.orderDiscountAmount.toFixed(2) }} JD</span></div>
                                        <div class="flex justify-between text-xs font-medium text-muted-foreground"><span>{{ $t('Invoice total') }}</span><span class="tabular-nums text-foreground font-semibold" data-no-i18n>{{ orderDetailTotals.invoiceTotal.toFixed(2) }} JD</span></div>
                                        <div v-if="orderDetailTotals.refundedAmount > 0" class="flex justify-between text-xs font-semibold text-rose-700"><span>{{ $t('Refunded amount') }}</span><span class="tabular-nums" data-no-i18n>-{{ orderDetailTotals.refundedAmount.toFixed(2) }} JD</span></div>
                                        <div v-if="orderDetailTotals.refundedAmount > 0" class="flex justify-between text-xs font-bold text-foreground pt-2 border-t border-zinc-200"><span>{{ $t('Remaining after refund') }}</span><span class="tabular-nums" data-no-i18n>{{ orderDetailTotals.remainingAmount.toFixed(2) }} JD</span></div>
                                    </div>

                                    <div class="grid grid-cols-2 gap-3 py-4">
                                        <div class="p-3.5 bg-card border border-zinc-200 rounded-xl">
                                            <p class="text-[10px] font-semibold text-muted-foreground">{{ $t('Amount Tendered') }}</p>
                                            <p class="text-sm font-bold text-foreground tabular-nums mt-1.5" data-no-i18n>{{ Number(selectedOrder?.amount_tendered || 0).toFixed(2) }} JD</p>
                                        </div>
                                        <div class="p-3.5 bg-card border border-zinc-200 rounded-xl">
                                            <p class="text-[10px] font-semibold text-muted-foreground">{{ $t('Change Due') }}</p>
                                            <p class="text-sm font-bold text-foreground tabular-nums mt-1.5" data-no-i18n>{{ Number(selectedOrder?.change_due || 0).toFixed(2) }} JD</p>
                                        </div>
                                    </div>

                                    <div class="mt-auto pt-3 space-y-2.5">
                                        <button @click="reprintReceipt" class="w-full h-11 bg-teal-700 text-white font-semibold rounded-lg hover:bg-teal-800 active:scale-[0.99] transition text-xs flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40" type="button">
                                            <i class="fa-solid fa-print text-[11px]" aria-hidden="true"></i><span>{{ $t('Reprint') }}</span>
                                        </button>
                                        <div class="grid grid-cols-2 gap-2.5">
                                            <button @click="downloadReceiptPdf" class="h-10 bg-card text-foreground font-semibold rounded-lg border border-zinc-300 hover:bg-zinc-100 transition-colors text-[11px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button"><i class="fa-solid fa-file-pdf text-[10px]" aria-hidden="true"></i><span>{{ $t('Receipt PDF') }}</span></button>
                                            <button @click="showDeliveryInvoice = true" class="h-10 bg-card text-foreground font-semibold rounded-lg border border-zinc-300 hover:bg-zinc-100 transition-colors text-[11px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30" type="button"><i class="fa-solid fa-truck text-[10px]" aria-hidden="true"></i><span>{{ $t('Delivery Invoice') }}</span></button>
                                        </div>
                                        <button v-if="canRefund" @click="openRefundModal(selectedOrder)" :disabled="selectedOrder?.payment_method === 'voided' || selectedOrder?.refund_status === 'full'" class="w-full h-10 bg-card text-rose-700 font-semibold rounded-lg border border-rose-200 hover:bg-rose-50 transition-colors text-[11px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed" type="button"><i class="fa-solid fa-rotate-left text-[10px]" aria-hidden="true"></i><span>{{ $t('Refund') }}</span></button>
                                    </div>
                                </aside>
                            </div>
                        </section>
                    </div>
                </transition>
            </teleport>

            <!-- Hidden A4 Print Container -->
            <teleport to="body">
                <div class="a4-receipt-wrapper" style="position: absolute; left: -9999px; top: -9999px; pointer-events: none;">
                    <A4Receipt v-if="selectedOrder" ref="a4ReceiptRef" :order="selectedOrder" :items="selectedOrderItems" :presentation="selectedOrder.receipt_display_v1" :storeSettings="storeSettings" />
                </div>
            </teleport>

            <!-- Full-screen Delivery Invoice Overlay -->
            <teleport to="body">
                <div v-if="showDeliveryInvoice" class="fixed inset-0 z-[200] bg-zinc-900/60 backdrop-blur-sm overflow-y-auto p-4 md:p-8 flex justify-center items-start delivery-invoice-portal-wrapper">
                    <DeliveryInvoice
                        :order="selectedOrder"
                        :items="selectedOrderItems"
                        :presentation="selectedOrder.receipt_display_v1"
                        :storeSettings="storeSettings"
                        @close="showDeliveryInvoice = false"
                    />
                </div>
            </teleport>

            <!-- Revenue Summary slide-over -->
            <OrdersSummaryPanel :stats="stats" :open="showSummary" @close="showSummary = false" />

            <!-- Refund confirmation -->
            <teleport to="body">
                <transition name="orders-modal">
                    <div v-if="showRefundModal" @click.self="showRefundModal = false" class="fixed inset-0 z-[210] flex items-center justify-center bg-zinc-950/60 backdrop-blur-[2px] p-4">
                        <section role="dialog" aria-modal="true" aria-labelledby="refund-title" class="bg-card w-full max-w-md max-h-[90dvh] rounded-xl shadow-[0_28px_90px_rgba(9,9,11,0.32)] border border-zinc-300 overflow-hidden flex flex-col">
                            <header class="flex items-center justify-between px-5 py-4 border-b border-zinc-200">
                                <div class="min-w-0">
                                    <h3 id="refund-title" class="font-bold text-base text-foreground flex items-center gap-2">
                                        <span class="w-8 h-8 rounded-lg bg-rose-100 text-rose-700 inline-flex items-center justify-center shrink-0"><i class="fa-solid fa-rotate-left text-xs" aria-hidden="true"></i></span>
                                        <span>{{ $t('Refund') }}</span>
                                    </h3>
                                    <p class="text-muted-foreground font-semibold text-[11px] tabular-nums mt-1 ms-10">{{ orderIdentityLabel(refundTarget, $t) }}</p>
                                </div>
                                <button @click="showRefundModal = false" :aria-label="$t('Close')" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-zinc-100 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30" type="button">
                                    <i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
                                </button>
                            </header>
                            <div class="p-5 space-y-5 overflow-y-auto premium-scroll">
                        <div v-if="refundTarget && ['cash','card','split'].includes(refundTarget.payment_method)">
                            <label class="block text-xs font-semibold text-foreground mb-2">{{ $t('Refund Method') }}</label>
                            <select v-model="refundMethod" class="w-full h-10 bg-background border border-zinc-300 rounded-lg px-3 text-xs font-medium text-foreground outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/15 transition-colors">
                                <option value="cash">{{ $t('Cash') }}</option>
                                <option value="card">{{ $t('Card') }}</option>
                                <option value="split">{{ $t('Split') }}</option>
                            </select>
                        </div>
                        <div v-if="refundItemsLoading" class="flex items-center gap-2 text-xs text-muted-foreground py-1">
                            <i class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                            <span>{{ $t('Loading...') }}</span>
                        </div>
                        <div v-if="!refundItemsLoading && refundItems.length > 0">
                            <div class="flex items-center justify-between mb-2">
                                <label class="block text-xs font-semibold text-foreground">{{ $t('Items to Return') }}</label>
                                <button @click="toggleSelectAllRefund" type="button" class="text-[11px] font-semibold text-teal-700 hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 rounded">
                                    {{ refundAllSelected ? $t('Deselect All') : $t('Select All') }}
                                </button>
                            </div>
                            <div class="border border-zinc-200 rounded-xl divide-y divide-zinc-200 overflow-hidden">
                                <div v-for="(item, idx) in refundItems" :key="item.id" class="flex items-center justify-between gap-3 px-3.5 py-3 bg-card">
                                    <div class="min-w-0 flex-1">
                                        <p class="text-xs font-bold text-foreground leading-tight truncate" data-no-i18n>{{ item.product_name }}</p>
                                        <p class="text-[10px] text-muted-foreground tabular-nums mt-1" data-no-i18n>{{ Number(item.price_at_sale).toFixed(2) }} JD × {{ item.remaining }}</p>
                                    </div>
                                    <div class="flex items-center gap-1.5 shrink-0">
                                        <button @click="decRefundItem(idx)" type="button" :disabled="!refundItemQty[idx] || refundItemQty[idx] <= 0" class="w-8 h-8 flex items-center justify-center bg-card border border-zinc-300 rounded-lg text-muted-foreground hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 disabled:opacity-40">
                                            <i class="fa-solid fa-minus text-[9px]"></i>
                                        </button>
                                        <span class="w-7 text-center text-xs font-bold tabular-nums text-foreground" data-no-i18n>{{ refundItemQty[idx] }}</span>
                                        <button @click="incRefundItem(idx)" type="button" :disabled="refundItemQty[idx] >= item.remaining" class="w-8 h-8 flex items-center justify-center bg-card border border-zinc-300 rounded-lg text-muted-foreground hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 disabled:opacity-40">
                                            <i class="fa-solid fa-plus text-[9px]"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-foreground mb-2">{{ $t('Reason') }} <span class="font-normal text-muted-foreground">({{ $t('optional') }})</span></label>
                            <input v-model="refundReason" type="text" :placeholder="$t('Enter refund reason...')" class="w-full h-10 bg-background border border-zinc-300 rounded-lg px-3 text-xs font-medium text-foreground placeholder:text-muted-foreground outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/15 transition-colors"/>
                        </div>
                        <p v-if="refundError" class="text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 px-3 py-2.5 rounded-lg" data-no-i18n>{{ refundError }}</p>
                            </div>
                            <footer class="px-5 py-4 border-t border-zinc-200 flex gap-2.5 bg-zinc-50">
                        <button @click="showRefundModal = false" class="flex-1 h-10 bg-card border border-zinc-300 text-foreground rounded-lg text-xs font-semibold hover:bg-zinc-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/30" type="button">
                            {{ $t('Cancel') }}
                        </button>
                        <button @click="submitRefund" :disabled="refundSubmitting || !refundItemsReady || refundNothingSelected" class="flex-1 h-10 bg-rose-700 text-white rounded-lg text-xs font-semibold hover:bg-rose-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2" type="button">
                            <i v-if="refundSubmitting" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                            <i v-else class="fa-solid fa-rotate-left text-[10px]"></i>
                            {{ $t('Confirm Refund') }}
                        </button>
                            </footer>
                        </section>
                    </div>
                </transition>
            </teleport>
            <transition name="orders-modal">
                <div v-if="showJofotaraModal" class="fixed inset-0 z-[160] bg-slate-950/55 flex items-center justify-center p-4" @click.self="showJofotaraModal = false">
                    <section class="w-full max-w-md max-h-[88dvh] overflow-y-auto bg-card border border-zinc-300 rounded-xl shadow-2xl">
                        <header class="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
                            <div><h3 class="text-sm font-semibold">{{ $t('Electronic invoicing') }}</h3><p class="text-[11px] text-muted-foreground mt-1" data-no-i18n>{{ jofotaraState?.invoice?.document_number }}</p></div>
                            <button @click="showJofotaraModal = false" class="w-9 h-9 rounded-lg border border-zinc-300">×</button>
                        </header>
                        <div class="p-5 space-y-5">
                            <div v-if="jofotaraQrDataUrl" class="flex justify-center"><img :src="jofotaraQrDataUrl" alt="JoFotara QR" class="w-52 h-52 bg-white p-2 border border-zinc-200 rounded-lg"></div>
                            <p v-else class="text-xs text-muted-foreground text-center">{{ $t('No QR code is available yet.') }}</p>
                            <button v-if="jofotaraState?.invoice?.status === 'accepted'" @click="reprintDirect(jofotaraCurrentOrder)" class="w-full h-10 rounded-lg border border-zinc-300 bg-muted text-xs font-semibold hover:bg-zinc-200">{{ $t('Reprint') }}</button>
                            <div v-if="jofotaraState?.returns?.length" class="border-t border-zinc-200 pt-4 space-y-2">
                                <h4 class="text-xs font-semibold">{{ $t('Saved refunds') }}</h4>
                                <div v-for="entry in jofotaraState.returns" :key="entry.id" class="flex items-center justify-between gap-3 p-3 bg-muted rounded-lg border border-zinc-200">
                                    <div class="min-w-0"><p class="text-xs font-semibold tabular-nums" data-no-i18n>{{ Number(entry.amount_refunded).toFixed(2) }} JD</p><p class="text-[10px] text-muted-foreground">{{ entry.reason || $t('No reason') }}</p><p v-if="entry.document?.status === 'rejected' && entry.document?.last_error" class="mt-1 text-[10px] leading-4 text-rose-700 break-words" data-no-i18n>{{ entry.document.last_error }}</p></div>
                                    <button v-if="entry.document?.status === 'accepted' || !isManualJofotaraSource(jofotaraCurrentOrder)" @click="handleJofotaraReturn(entry)" :disabled="entry.document?.status === 'submitting' || entry.document?.status === 'unknown'" class="h-8 px-3 rounded-lg bg-teal-600 text-white text-[11px] font-semibold disabled:opacity-40">{{ $t(entry.document?.status === 'accepted' ? 'View QR' : entry.document?.status === 'rejected' ? 'Retry submission' : 'Send return') }}</button>
                                    <span v-else class="text-[10px] text-muted-foreground">{{ $t(entry.document?.status || 'Waiting for original') }}</span>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </transition>
        </div>

</template>

<script>
import { fetchJson, fetchReadJsonResponse } from '@/shared/http.js';
import permissionPolicy from '@posapp/permission-policy';
import { ref, onMounted, onActivated, onDeactivated, onUnmounted, computed, watch, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { t, currentLanguage } from '@/shared/i18n.js';
import { getSystemSettings } from '@/shared/systemSettings.js';
import { buildReceiptPayload, printJob } from '@/shared/receiptPrint.js';
import A4Receipt from '../components/A4Receipt.vue';
import DeliveryInvoice from '../components/DeliveryInvoice.vue';
import OrdersSummaryPanel from '../components/OrdersSummaryPanel.vue';
import QRCode from 'qrcode';
import {
  orderIdentityLabel,
  orderIdentityValue,
  orderIdentityCopyMessage
} from '../../utils/orderIdentityDisplay.js';
import { topmostDismissibleOrderLayer } from '../../utils/orderOverlayState.js';
import { orderDetailLineDisplay, orderDetailSummary } from '../../utils/receiptLineTotals.js';
import {
  addBusinessDateDays,
  currentBusinessDate,
  formatBusinessDate,
  formatBusinessDateTime,
  formatScheduledDateTime,
  formatBusinessTime
} from '../../utils/businessDate.js';

export default {
    name: 'orders',
    components: {
        A4Receipt,
        DeliveryInvoice,
        OrdersSummaryPanel
    },
    setup() {
        const router = useRouter();
        const route = useRoute();
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const orders = ref([]);
        const isLoading = ref(false);
        const isDiscounted = ref(false);
        
        const searchInvoice = ref('');
        const searchOrder = ref('');
        const searchTotal = ref('');
        
        const getToday = () => currentBusinessDate();
        const startDate = ref(getToday());
        const endDate = ref(getToday());

        // Filter and stats states
        const activeQuickDateFilter = ref('today');
        const stats = ref({
            total_revenue: 0,
            cash_revenue: 0,
            card_revenue: 0,
            platform_revenue: 0,
            split_revenue: 0
        });

        // Shadcn popovers and filtering states
        const selectedPaymentMethods = ref([]);
        const selectedRefundStatus = ref('');
        const selectedJofotaraStatus = ref('');
        const selectedCashierId = ref(null);
        const cashiersList = ref([]);
        const showFilters = ref(false);
        const cashierSearchText = ref('');

        // Column Visibility States
        const showColumnsToggle = ref(false);
        const visibleColumns = ref({
            identifiers: true,
            dateTime: true,
            cashier: true,
            payment: true,
            status: true,
            total: true,
            action: true
        });

        // Action menu state per row
        const activeRowMenu = ref(null);
        const jofotaraEnabled = ref(false);
        const showJofotaraModal = ref(false);
        const jofotaraState = ref(null);
        const jofotaraQrDataUrl = ref('');
        const jofotaraCurrentOrder = ref(null);

        const showModal = ref(false);
        const selectedOrder = ref(null);
        const selectedOrderItems = ref([]);
        const isModalLoading = ref(false);
        const detailError = ref('');
        const detailInvoiceId = ref(null);
        let detailRequestId = 0;
        let detailAbortController = null;
        const cancelDetailRead = () => {
            detailRequestId += 1;
            detailAbortController?.abort();
            detailAbortController = null;
            isModalLoading.value = false;
        };
        watch(showModal, open => {
            if (!open) cancelDetailRead();
        }, { flush: 'sync' });
        const orderDetailLines = computed(() => selectedOrderItems.value.map(item => ({
            ...item,
            display: orderDetailLineDisplay(item, {
                taxInclusive: Number(selectedOrder.value?.tax_inclusive_at_sale) === 1,
                taxExempt: Number(selectedOrder.value?.tax_exempt_at_sale) === 1
            })
        })));
        const orderDetailTotals = computed(() => orderDetailSummary(
            selectedOrder.value,
            orderDetailLines.value.filter(line => line.parent_item_id == null).map(line => line.display),
            selectedOrder.value?.refunds || []
        ));

        const currentPage = ref(1);
        const totalPages = ref(1);
        const totalRecords = ref(0);
        const limit = ref(50);
        let ordersRefreshTimer = null;
        let searchDebounceTimer = null;
        let isFirstActivation = true;
        let ordersRequestId = 0;
        let ordersAbortController = null;

        const cancelOrdersRead = () => {
            ordersRequestId += 1;
            ordersAbortController?.abort();
            ordersAbortController = null;
            isLoading.value = false;
        };

        const tablesEnabled = ref(false);
        const orderSource = ref('register');

        const storeSettings = ref(null);
        const showDeliveryInvoice = ref(false);
        const showSummary = ref(false);
        const a4ReceiptRef = ref(null);

        // Refund modal state
        const showRefundModal = ref(false);
        const refundTarget = ref(null);
        const refundReason = ref('');
        const refundMethod = ref('');
        const refundSubmitting = ref(false);
        const refundError = ref('');
        const refundItems = ref([]);
        const refundItemQty = ref([]);
        const refundItemsLoading = ref(false);
        // True only once order details have loaded successfully. Confirm stays blocked until
        // then, so the operator can never trigger a (default) whole-order refund blind -
        // before the item list paints, or after the load failed.
        const refundItemsReady = ref(false);
        // Monotonic token: each modal open (or reopen) claims the next number. Async
        // order-detail responses only apply if they still own the latest token, so a
        // slow/late/failed response can never write into a modal that has since moved
        // to a different order.
        let refundReqSeq = 0;

        const canRefund = computed(() => {
            try {
                const user = JSON.parse(sessionStorage.getItem('pos_user') || 'null');
                return permissionPolicy.userHas(user, 'pos.refund');
            } catch { return false; }
        });

        const openRefundModal = (order) => {
            refundTarget.value = order;
            const pm = order.payment_method;
            refundMethod.value = (pm === 'cash' || pm === 'card' || pm === 'split' || pm === 'platform') ? pm : 'cash';
            refundReason.value = '';
            refundError.value = '';
            refundItems.value = [];
            refundItemQty.value = [];
            refundItemsReady.value = false;
            refundItemsLoading.value = true;
            showRefundModal.value = true;
            // Claim this open. Every guard below checks the token is still ours; a dropped
            // connection or a server restart just lands in .catch and is ignored if stale.
            // Confirm stays disabled until refundItemsReady flips true, so a stale/failed
            // load can never fall through to an accidental whole-order refund.
            const myReq = ++refundReqSeq;
            fetchJson(`api/admin/order_details?id=${order.invoice_id}`)
                .then(data => {
                    if (myReq !== refundReqSeq) return;
                    if (data.success && Array.isArray(data.items)) {
                        const lines = data.items
                            .filter(it => !it.parent_item_id)
                            .map(it => ({ ...it, remaining: Number(it.quantity) - Number(it.refunded_quantity || 0) }))
                            .filter(it => it.remaining > 0);
                        refundItems.value = lines;
                        refundItemQty.value = lines.map(it => it.remaining);
                        refundItemsReady.value = true;
                    } else {
                        // JSON error body (e.g. 404) - does not reach .catch. Surface it so
                        // the operator sees why Confirm is disabled instead of a dead button.
                        refundError.value = t('Failed to load order details.');
                    }
                })
                .catch(() => {
                    if (myReq !== refundReqSeq) return;
                    refundError.value = t('Failed to load order details.');
                })
                .finally(() => {
                    if (myReq !== refundReqSeq) return;
                    refundItemsLoading.value = false;
                });
        };

        const refundAllSelected = computed(() =>
            refundItems.value.length > 0 &&
            refundItems.value.every((it, i) => refundItemQty.value[i] === it.remaining)
        );

        const refundNothingSelected = computed(() =>
            refundItems.value.every((_, i) => !refundItemQty.value[i] || refundItemQty.value[i] <= 0)
        );

        const incRefundItem = (idx) => {
            const max = refundItems.value[idx]?.remaining ?? 0;
            if ((refundItemQty.value[idx] ?? 0) < max) refundItemQty.value[idx]++;
        };

        const decRefundItem = (idx) => {
            if ((refundItemQty.value[idx] ?? 0) > 0) refundItemQty.value[idx]--;
        };

        const toggleSelectAllRefund = () => {
            if (refundAllSelected.value) {
                refundItemQty.value = refundItems.value.map(() => 0);
            } else {
                refundItemQty.value = refundItems.value.map(it => it.remaining);
            }
        };

        const submitRefund = async () => {
            // Never submit before the item list has loaded successfully: an empty list would
            // omit `items` and the backend would read that as a whole-order refund.
            if (refundSubmitting.value || !refundItemsReady.value) return;
            refundSubmitting.value = true;
            refundError.value = '';
            try {
                const body = { invoice_id: refundTarget.value.invoice_id, intent: 'refund' };
                if (refundReason.value.trim()) body.reason = refundReason.value.trim();
                const pm = refundTarget.value.payment_method;
                if (pm === 'cash' || pm === 'card' || pm === 'split' || pm === 'platform') body.refund_method = refundMethod.value;
                if (refundItems.value.length > 0 && !refundAllSelected.value) {
                    body.items = refundItems.value
                        .map((it, i) => ({ order_item_id: it.id, qty: refundItemQty.value[i] }))
                        .filter(x => x.qty > 0);
                }
                const data = await fetchJson('api/pos/refunds', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify(body)
                });
                if (data.success) {
                    showRefundModal.value = false;
                    await window.showAdminAlert(t('Refund processed successfully.'));
                    fetchOrders();
                } else {
                    refundError.value = data.message || t('Refund failed.');
                }
            } catch (e) {
                refundError.value = t('Network error. Please try again.');
            } finally {
                refundSubmitting.value = false;
            }
        };



        const downloadReceiptPdf = async () => {
            if (!selectedOrder.value || !a4ReceiptRef.value) return;
            const el = a4ReceiptRef.value.$el;
            
            const opt = {
                margin: 0,
                filename: `receipt-INV-${orderIdentityValue(selectedOrder.value) || selectedOrder.value?.invoice_id}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, y: 0, scrollY: 0 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };
            
            try {
                const html2pdf = (await import('html2pdf.js')).default;
                await html2pdf().set(opt).from(el).save();
            } catch (err) {
                console.error("Failed to generate PDF", err);
                if (window.showAdminAlert) {
                    window.showAdminAlert(t ? t('Failed to generate PDF') : 'Failed to generate PDF', 'error');
                }
            }
        };

        const fetchSettings = async () => {
            try {
                const data = await getSystemSettings();
                if (data.success) {
                    tablesEnabled.value = data.tables_enabled === '1';
                    storeSettings.value = data;
                    if (!tablesEnabled.value && orderSource.value === 'tables') setOrderSource('register');
                }
                const jofotara = await fetchJson('api/admin/jofotara/settings');
                if (jofotara.success) jofotaraEnabled.value = Boolean(jofotara.settings.enabled);
            } catch (e) {
                console.error("Failed to load settings in orders page", e);
            }
        };

        const isManualJofotaraSource = order => order?.payment_method === 'platform';
        const canShowJofotaraInvoiceAction = order => !isManualJofotaraSource(order) || order?.jofotara_status === 'accepted';
        const isJofotaraEligible = order => ['cash', 'card', 'split'].includes(order?.payment_method) && !isManualJofotaraSource(order) && Boolean(order?.invoice_number);
        const jofotaraInvoiceAction = order => ({ accepted: 'View QR', rejected: 'Retry submission', submitting: 'Sending…', unknown: 'Needs review' }[order?.jofotara_status] || 'Send to JoFotara');
        const jofotaraOrderStatuses = {
            accepted: { invoice: 'JoFotara sent', return: 'JoFotara return sent', className: 'bg-teal-50 text-teal-800 border-teal-200' },
            not_submitted: { invoice: 'JoFotara not sent', return: 'JoFotara return not sent', className: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
            pending: { invoice: 'JoFotara sending', return: 'JoFotara return sending', className: 'bg-sky-50 text-sky-800 border-sky-200' },
            submitting: { invoice: 'JoFotara sending', return: 'JoFotara return sending', className: 'bg-sky-50 text-sky-800 border-sky-200' },
            rejected: { invoice: 'JoFotara rejected', return: 'JoFotara return rejected', className: 'bg-rose-50 text-rose-800 border-rose-200' },
            unknown: { invoice: 'JoFotara review', return: 'JoFotara return review', className: 'bg-amber-50 text-amber-800 border-amber-200' }
        };
        const jofotaraOrderStatus = status => jofotaraOrderStatuses[status] || jofotaraOrderStatuses.unknown;
        const jofotaraStatusLabel = status => jofotaraOrderStatus(status).invoice;
        const jofotaraStatusClass = status => jofotaraOrderStatus(status).className;
        const jofotaraReturnStatusLabel = status => jofotaraOrderStatus(status).return;
        const showJofotaraReturnMarker = order => order?.payment_method !== 'voided' && order?.refund_status !== 'none' && order?.jofotara_status === 'accepted' && order?.jofotara_return_status != null;
        const downloadJofotaraXml = async order => {
            try {
                const res = await fetch(`api/admin/jofotara/invoices/${order.invoice_id}/xml`);
                if (!res.ok) { const data = await res.json(); return window.showAdminAlert(data.message || t('Failed to generate XML.')); }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url; link.download = `jofotara-${order.invoice_number}.xml`; document.body.appendChild(link); link.click(); link.remove();
                URL.revokeObjectURL(url);
            } catch { await window.showAdminAlert(t('Network error.')); }
        };
        const openJofotaraState = async order => {
            const data = await fetchJson(`api/admin/jofotara/invoices/${order.invoice_id}`);
            if (!data.success) throw new Error(data.message || 'Failed to load JoFotara state.');
            jofotaraCurrentOrder.value = order;
            jofotaraState.value = data;
            jofotaraQrDataUrl.value = data.invoice?.qr_text ? await QRCode.toDataURL(data.invoice.qr_text, { width: 320, margin: 1 }) : '';
            showJofotaraModal.value = true;
        };
        const handleJofotaraInvoice = async order => {
            try {
                if (order.jofotara_status === 'accepted') return openJofotaraState(order);
                const data = await fetchJson(`api/admin/jofotara/invoices/${order.invoice_id}/submit`, { method: 'POST' });
                if (!data.success) return window.showAdminAlert(data.message || t('Submission failed.'));
                order.jofotara_status = data.document.status;
                await openJofotaraState(order);
            } catch { await window.showAdminAlert(t('Network error.')); }
        };
        const handleJofotaraReturn = async entry => {
            try {
                if (entry.document?.status === 'accepted') {
                    jofotaraQrDataUrl.value = entry.document.qr_text ? await QRCode.toDataURL(entry.document.qr_text, { width: 320, margin: 1 }) : '';
                    return;
                }
                const data = await fetchJson(`api/admin/jofotara/refunds/${entry.id}/submit`, { method: 'POST' });
                if (!data.success) return window.showAdminAlert(data.message || t('Submission failed.'));
                if (data.document.status === 'rejected') await window.showAdminAlert(data.document.last_error || t('Submission failed.'));
                await openJofotaraState(jofotaraCurrentOrder.value);
            } catch { await window.showAdminAlert(t('Network error.')); }
        };

        const setOrderSource = (source) => {
            orderSource.value = source;
            currentPage.value = 1;
            fetchOrders();
        };

        const goToWaiterPerformance = () => {
            router.push('/waiterperformance');
        };

        const fetchOrders = async ({ silent = false } = {}) => {
            const requestId = ++ordersRequestId;
            ordersAbortController?.abort();
            ordersAbortController = new AbortController();
            if (!silent) isLoading.value = true;
            try {
                const params = new URLSearchParams({
                    page: String(currentPage.value),
                    limit: String(limit.value),
                    filter_type: orderSource.value
                });
                if (startDate.value) params.set('start_date', startDate.value);
                if (endDate.value) params.set('end_date', endDate.value);
                if (searchInvoice.value.trim()) params.set('invoice', searchInvoice.value.trim());
                if (searchOrder.value.trim()) params.set('order', searchOrder.value.trim());
                if (searchTotal.value.trim()) params.set('total', searchTotal.value.trim());
                if (selectedPaymentMethods.value.length > 0) {
                    params.set('payment_methods', selectedPaymentMethods.value.join(','));
                }
                if (selectedCashierId.value) {
                    params.set('cashier_id', String(selectedCashierId.value));
                }
                if (selectedRefundStatus.value) params.set('refund_status', selectedRefundStatus.value);
                if (selectedJofotaraStatus.value) params.set('jofotara_status', selectedJofotaraStatus.value);

                if (isDiscounted.value) params.set('discounted', '1');

                const data = await fetchJson(`api/admin/orders?${params.toString()}`, {
                    signal: ordersAbortController.signal
                });
                if (requestId !== ordersRequestId) return;
                if (data.success) {
                    orders.value = data.orders;
                    if (data.pagination) {
                        totalPages.value = data.pagination.total_pages;
                        totalRecords.value = data.pagination.total;
                    }
                    if (data.stats) {
                        stats.value = data.stats;
                    }
                }
            } catch (error) {
                if (requestId === ordersRequestId && error.name !== 'AbortError') {
                    console.error("Failed to fetch orders");
                }
            } finally {
                if (requestId === ordersRequestId) {
                    ordersAbortController = null;
                    isLoading.value = false;
                }
            }
        };

        const fetchCashiers = async () => {
            try {
                const data = await fetchJson('api/admin/shifts?action=cashiers&all=true');
                if (data.success) {
                    cashiersList.value = data.cashiers || [];
                }
            } catch (e) {
                console.error("Failed to fetch cashiers list", e);
            }
        };

        const selectedRangeIncludesToday = () => {
            if (!startDate.value && !endDate.value) return true;
            return getToday() >= startDate.value && getToday() <= endDate.value;
        };

        const scheduleOrdersRefresh = () => {
            if (!selectedRangeIncludesToday()) return;
            if (ordersRefreshTimer) clearTimeout(ordersRefreshTimer);
            ordersRefreshTimer = setTimeout(() => fetchOrders({ silent: true }), 500);
        };

        const handleRealtime = (event) => {
            if (event.detail?.type === 'new_order') scheduleOrdersRefresh();
            if (event.detail?.type === 'settings_changed' || event.detail?.type === 'socket_reconnected') {
                fetchSettings();
            }
            if (event.detail?.type === 'socket_reconnected') fetchOrders({ silent: true });
        };

        let isResettingFilters = false;
        let isSettingQuickDate = false;

        watch([searchInvoice, searchOrder, searchTotal, selectedPaymentMethods, selectedCashierId, selectedRefundStatus, selectedJofotaraStatus, isDiscounted], () => {
            if (isResettingFilters) return;
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                currentPage.value = 1;
                fetchOrders();
            }, 300);
        }, { deep: true });

        watch([startDate, endDate], () => {
            if (isResettingFilters || isSettingQuickDate) return;
            activeQuickDateFilter.value = null;
            currentPage.value = 1;
            fetchOrders();
        });

        const nextPage = () => { if (currentPage.value < totalPages.value) { currentPage.value++; fetchOrders(); } };
        const prevPage = () => { if (currentPage.value > 1) { currentPage.value--; fetchOrders(); } };

        const setDateRange = (type) => {
            isSettingQuickDate = true;
            activeQuickDateFilter.value = type;
            const today = currentBusinessDate();
            
            if (type === 'today') {
                startDate.value = today;
                endDate.value = today;
            } else if (type === 'yesterday') {
                const yesterday = addBusinessDateDays(today, -1);
                startDate.value = yesterday;
                endDate.value = yesterday;
            } else if (type === 'week') {
                startDate.value = addBusinessDateDays(today, -6);
                endDate.value = today;
            } else if (type === 'month') {
                startDate.value = `${today.slice(0, 8)}01`;
                endDate.value = today;
            }
            currentPage.value = 1;
            fetchOrders();
            nextTick(() => {
                isSettingQuickDate = false;
            });
        };

        const viewOrder = async (invoiceId) => {
            cancelDetailRead();
            const requestId = detailRequestId;
            const controller = new AbortController();
            detailAbortController = controller;
            detailInvoiceId.value = invoiceId;
            selectedOrder.value = null;
            selectedOrderItems.value = [];
            detailError.value = '';
            showDeliveryInvoice.value = false;
            showModal.value = true;
            isModalLoading.value = true;
            const ownsRequest = () => requestId === detailRequestId && showModal.value;
            try {
                const { response, data } = await fetchReadJsonResponse(`api/admin/order_details?id=${encodeURIComponent(invoiceId)}`, { signal: controller.signal });
                if (!ownsRequest()) return;
                if (response.ok && data.success && data.order && String(data.order.invoice_id) === String(invoiceId) && Array.isArray(data.items)) {
                    selectedOrder.value = {
                        ...data.order,
                        receipt_display_v1: data.receipt_display_v1 || null,
                        receipt_display_legacy_reason: data.receipt_display_legacy_reason || null,
                        receipt_display_error: data.publicCode || null,
                        refunds: data.refunds || []
                    };
                    selectedOrderItems.value = data.items;
                } else {
                    detailError.value = data.message || 'Failed to load order details.';
                }
            } catch (error) {
                if (ownsRequest()) detailError.value = 'Failed to load order details.';
            } finally {
                if (ownsRequest()) {
                    detailAbortController = null;
                    isModalLoading.value = false;
                }
            }
        };

        // Reprint via Node print bridge. No hard block on the local printer id: the
        // admin machine rarely sets one, and the server falls back to the default.
        const reprintReceipt = async () => {
            const localPrinterId = localStorage.getItem("pos_receipt_printer_id") || '';
            const storeSettings = await getSystemSettings();
            const payload = buildReceiptPayload(selectedOrder.value, selectedOrderItems.value, { storeInfo: storeSettings, receiptPrinterId: localPrinterId });
            await printJob(payload, { alert: window.showAdminAlert, t });
        };

        const togglePaymentMethod = (method) => {
            const idx = selectedPaymentMethods.value.indexOf(method);
            if (idx > -1) {
                selectedPaymentMethods.value.splice(idx, 1);
            } else {
                selectedPaymentMethods.value.push(method);
            }
        };

        const selectCashier = (id) => {
            selectedCashierId.value = id;
            showFilters.value = false;
        };

        const clearAllFilters = () => {
            isResettingFilters = true;
            searchInvoice.value = '';
            searchOrder.value = '';
            searchTotal.value = '';
            selectedPaymentMethods.value = [];
            selectedRefundStatus.value = '';
            selectedJofotaraStatus.value = '';
            selectedCashierId.value = null;
            cashierSearchText.value = '';
            isDiscounted.value = false;
            startDate.value = getToday();
            endDate.value = getToday();
            activeQuickDateFilter.value = 'today';
            orderSource.value = 'register';
            currentPage.value = 1;
            fetchOrders();
            setTimeout(() => {
                isResettingFilters = false;
            }, 50);
        };

        const filteredCashiers = computed(() => {
            const query = cashierSearchText.value.toLowerCase().trim();
            if (!query) return cashiersList.value;
            return cashiersList.value.filter(u => u.name && u.name.toLowerCase().includes(query));
        });

        const selectedCashierName = computed(() => {
            const selected = cashiersList.value.find(cashier => String(cashier.id) === String(selectedCashierId.value));
            return selected?.name || '';
        });

        const activeFilterCount = computed(() => {
            let n = selectedPaymentMethods.value.length;
            if (selectedCashierId.value) n += 1;
            if (selectedRefundStatus.value) n += 1;
            if (selectedJofotaraStatus.value) n += 1;
            if (isDiscounted.value) n += 1;
            return n;
        });

        const toggleRowMenu = (invoiceId) => {
            if (activeRowMenu.value === invoiceId) {
                activeRowMenu.value = null;
            } else {
                activeRowMenu.value = invoiceId;
            }
        };

        const copyInvoiceId = async (order) => {
            const value = orderIdentityValue(order);
            if (!value) return;
            await navigator.clipboard.writeText(String(value));
            await window.showAdminAlert(orderIdentityCopyMessage(order, t));
        };

        const reprintDirect = async (order) => {
            let data;
            try {
                data = await fetchJson(`api/admin/order_details?id=${order.invoice_id}`);
            } catch (e) {
                console.error(e);
                await window.showAdminAlert(t("Failed to print. Is your Node.js Spooler running?"));
                return;
            }
            if (!data.success) {
                await window.showAdminAlert(t("Failed to fetch order details for printing."));
                return;
            }
            const localPrinterId = localStorage.getItem("pos_receipt_printer_id") || '';
            const storeSettings = await getSystemSettings();
            const payload = buildReceiptPayload(data.order, data.items, { storeInfo: storeSettings, receiptPrinterId: localPrinterId });
            await printJob(payload, { alert: window.showAdminAlert, t });
        };

        const formatDateTime = (dateVal) => {
            return formatBusinessDateTime(dateVal);
        };

        const getOrderDate = (dateVal) => {
            return formatBusinessDate(dateVal);
        };

        const getOrderTime = (dateVal) => {
            return formatBusinessTime(dateVal);
        };

        const discountAmount = (order) => {
            return Number(order?.order_discount_amount || 0) + Number(order?.line_discount_amount || 0);
        };

        const hasDiscount = (order) => discountAmount(order) > 0;

        const rowStatusClass = (order, variant = 'desktop') => {
            if (order.payment_method === 'voided') {
                return variant === 'mobile' ? 'bg-rose-50/40 border-rose-200' : 'bg-rose-50/35 hover:bg-rose-50 text-foreground';
            }
            if (order.refund_status === 'full') {
                return variant === 'mobile' ? 'bg-rose-50/40 border-rose-200' : 'bg-rose-50/35 hover:bg-rose-50 text-foreground';
            }
            if (order.refund_status === 'partial') {
                return variant === 'mobile' ? 'bg-orange-50/40 border-orange-200' : 'bg-orange-50/30 hover:bg-orange-50 text-foreground';
            }
            if (hasDiscount(order)) {
                return variant === 'mobile' ? 'bg-amber-50/35 border-amber-200' : 'bg-amber-50/25 hover:bg-amber-50 text-foreground';
            }
            return variant === 'mobile' ? 'bg-card border-zinc-200' : 'hover:bg-teal-50/35';
        };

        const columnLabel = (col) => {
            const labels = {
                identifiers: 'Order',
                dateTime: 'Date & Time',
                cashier: 'Cashier',
                payment: 'Payment',
                status: 'Status',
                total: 'Total',
                action: 'Action'
            };
            return labels[col] || col;
        };

        const handleEscapeKey = (event) => {
            if (event.key !== 'Escape') return;

            const layer = topmostDismissibleOrderLayer({
                details: showModal.value,
                delivery: showDeliveryInvoice.value,
                refund: showRefundModal.value,
                summary: showSummary.value
            });

            if (layer === 'refund') showRefundModal.value = false;
            else if (layer === 'delivery') showDeliveryInvoice.value = false;
            else if (layer === 'summary') showSummary.value = false;
            else if (layer === 'details') showModal.value = false;
            else {
                showFilters.value = false;
                showColumnsToggle.value = false;
                activeRowMenu.value = null;
            }
        };

        onMounted(() => {
            fetchSettings();
            fetchCashiers();

            const query = route.query;
            if (query.discounted === '1') {
                isDiscounted.value = true;
                if (query.start_date) startDate.value = String(query.start_date);
                if (query.end_date) endDate.value = String(query.end_date);
            }

            if (query.open_invoice_id) {
                const openId = parseInt(query.open_invoice_id);
                if (openId && !isNaN(openId)) {
                    startDate.value = '';
                    endDate.value = '';
                    if (query.invoice) {
                        searchInvoice.value = String(query.invoice);
                    }
                    viewOrder(openId);
                }
                const newQuery = { ...route.query };
                delete newQuery.open_invoice_id;
                delete newQuery.invoice;
                router.replace({ query: newQuery });
            }

            fetchOrders();
        });

        // Listen for new-order events only while visible; silently re-sync the
        // list on return so orders that arrived while cached/hidden show up.
        onActivated(() => {
            window.addEventListener('admin:realtime', handleRealtime);
            window.addEventListener('keydown', handleEscapeKey);
            if (!isFirstActivation) {
                fetchSettings();
                if (activeQuickDateFilter.value === 'today' && startDate.value !== currentBusinessDate()) setDateRange('today');
                else fetchOrders({ silent: true });
            }
            isFirstActivation = false;
        });

        onDeactivated(() => {
            cancelOrdersRead();
            cancelDetailRead();
            showModal.value = false;
            showDeliveryInvoice.value = false;
            window.removeEventListener('admin:realtime', handleRealtime);
            window.removeEventListener('keydown', handleEscapeKey);
            if (ordersRefreshTimer) { clearTimeout(ordersRefreshTimer); ordersRefreshTimer = null; }
            if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
        });

        onUnmounted(() => {
            cancelOrdersRead();
            cancelDetailRead();
            showModal.value = false;
            showDeliveryInvoice.value = false;
            window.removeEventListener('admin:realtime', handleRealtime);
            window.removeEventListener('keydown', handleEscapeKey);
            if (ordersRefreshTimer) clearTimeout(ordersRefreshTimer);
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        });

        return {
            formatScheduledDateTime,
            orders, isLoading, isDiscounted, searchInvoice, searchOrder, searchTotal, startDate, endDate,
            currentPage, totalPages, totalRecords, nextPage, prevPage,
            fetchOrders, setQuickFilter: setDateRange, setDateRange, stats, activeQuickDateFilter,
            showModal, selectedOrder, selectedOrderItems, orderDetailLines, orderDetailTotals, isModalLoading, detailError, detailInvoiceId, viewOrder,
            reprintReceipt,
            selectedPaymentMethods, selectedRefundStatus, selectedJofotaraStatus, selectedCashierId, cashiersList, showFilters, activeFilterCount, cashierSearchText,
            togglePaymentMethod, selectCashier, clearAllFilters,
            filteredCashiers, selectedCashierName,
            showColumnsToggle, visibleColumns, activeRowMenu, toggleRowMenu, copyInvoiceId, reprintDirect, columnLabel, orderIdentityLabel,
            jofotaraEnabled, showJofotaraModal, jofotaraState, jofotaraQrDataUrl, jofotaraCurrentOrder,
            isManualJofotaraSource, canShowJofotaraInvoiceAction, isJofotaraEligible, jofotaraInvoiceAction, jofotaraStatusLabel, jofotaraStatusClass, jofotaraReturnStatusLabel, showJofotaraReturnMarker, downloadJofotaraXml, handleJofotaraInvoice, handleJofotaraReturn,
            formatDateTime, formatBusinessTime, getOrderDate, getOrderTime,
            discountAmount, hasDiscount, rowStatusClass,
            tablesEnabled, orderSource, setOrderSource, goToWaiterPerformance,
            storeSettings, showDeliveryInvoice, showSummary, a4ReceiptRef, downloadReceiptPdf, isRtl,
            canRefund, showRefundModal, refundTarget, refundReason, refundMethod, refundSubmitting, refundError,
            refundItems, refundItemQty, refundItemsLoading, refundItemsReady, refundAllSelected, refundNothingSelected,
            incRefundItem, decRefundItem, toggleSelectAllRefund,
            openRefundModal, submitRefund
        };
    }};
</script>

<style scoped>
.orders-modal-enter-active,
.orders-modal-leave-active {
    transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.orders-modal-enter-active section,
.orders-modal-leave-active section {
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease;
}

.orders-modal-enter-from,
.orders-modal-leave-to {
    opacity: 0;
}

.orders-modal-enter-from section,
.orders-modal-leave-to section {
    opacity: 0;
    transform: translateY(10px) scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
    .orders-modal-enter-active,
    .orders-modal-leave-active,
    .orders-modal-enter-active section,
    .orders-modal-leave-active section {
        transition: none;
    }
}

@media (max-width: 767px) {
    .orders-workspace .admin-grid-input {
        width: 100%;
    }

    .orders-workspace .admin-grid-filter-row > div:first-child,
    .orders-workspace .admin-grid-filter-row > .admin-grid-segmented {
        grid-column: 1 / -1;
        width: 100%;
        min-width: 0;
    }

    .orders-workspace .admin-grid-segmented button {
        min-width: 0;
        padding-inline: 5px;
    }
}
</style>

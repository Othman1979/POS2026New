<template>

        <div class="admin-data-page h-full min-h-0 flex flex-col font-sans animate-fade-in text-foreground bg-background">

            <header class="admin-grid-page-bar shrink-0">
                <div class="admin-grid-page-context">
                    <h2>{{ $t('Shifts') }}</h2>
                    <span class="admin-grid-record-count"><span class="tabular-nums" data-no-i18n>{{ totalRecords }}</span> {{ $t('shifts') }}</span>
                </div>
                <div class="admin-grid-page-actions">
                    <button @click="refreshAll" :aria-label="$t('Refresh')" class="admin-grid-icon-button" type="button"><i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i></button>
                    <button @click="triggerOpenShift" class="admin-grid-button admin-grid-button--primary" type="button"><i class="fa-solid fa-plus text-[10px]" aria-hidden="true"></i><span>{{ $t('Open Shift') }}</span></button>
                </div>
            </header>

            <!-- Toolbar -->
            <div class="admin-grid-command-bar flex flex-col shrink-0 overflow-visible">
                <!-- Row 1: Search, Filters and Core Actions -->
                <div class="admin-grid-command-row flex-wrap justify-between w-full">
                    <!-- Search & Dropdown Filters -->
                    <div class="admin-grid-command-row flex-1 min-w-0">
                        <!-- Search -->
                        <label class="admin-grid-search">
                            <span class="sr-only">{{ $t('Search shift or cashier') }}</span>
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                            <input v-model="searchQuery" type="search" :placeholder="$t('Search shift or cashier')" autocomplete="off"/>
                        </label>

                        <!-- Dropdowns (Visible on desktop, toggled on mobile) -->
                        <div class="admin-grid-filter-row">
                            <!-- Cashier Filter -->
                            <div class="relative">
                                <button @click="showCashierFilter = !showCashierFilter; showStatusFilter = false;" :class="{ 'admin-grid-button--soft': selectedCashiers.length > 0 }" class="admin-grid-button w-full" type="button" :aria-expanded="showCashierFilter">
                                    <span class="flex items-center gap-1.5">
                                        <i class="fa-solid fa-user text-[11px] opacity-70"></i>
                                        <span>{{ $t('Cashier') }}</span>
                                    </span>
                                    <span v-if="selectedCashiers.length > 0" class="bg-teal-600 text-white px-1.5 rounded text-[10px] font-semibold tabular-nums logical-ms-1" data-no-i18n>{{ selectedCashiers.length }}</span>
                                    <i class="fa-solid fa-chevron-down text-[9px] opacity-50 logical-ms-1"></i>
                                </button>
                                <div v-if="showCashierFilter" @click="showCashierFilter = false" class="fixed inset-0 z-40"></div>
                                <div v-if="showCashierFilter" class="admin-grid-popover logical-inline-start w-48 flex flex-col gap-0.5 max-h-60 overflow-y-auto admin-grid-scroll">
                                    <button v-for="c in cashiers" :key="c.id" @click="toggleCashierFilter(c.id)" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none w-full">
                                        <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedCashiers.includes(c.id) ? 'fa-solid fa-check' : ''"></i>
                                        <span data-no-i18n>{{ c.name }}</span>
                                    </button>
                                    <div v-if="selectedCashiers.length > 0" class="border-t border-border mt-1 pt-1">
                                        <button @click="selectedCashiers = []; showCashierFilter = false" class="w-full text-center text-[10px] py-1 font-semibold hover:bg-muted text-destructive rounded-md">
                                            {{ $t('Clear filters') }}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <!-- Status Filter -->
                            <div class="relative">
                                <button @click="showStatusFilter = !showStatusFilter; showCashierFilter = false;" :class="{ 'admin-grid-button--soft': selectedStatus }" class="admin-grid-button w-full" type="button" :aria-expanded="showStatusFilter">
                                    <span class="flex items-center gap-1.5">
                                        <i class="fa-solid fa-circle-half-stroke text-[11px] opacity-70"></i>
                                        <span>{{ $t('Status') }}</span>
                                    </span>
                                    <i class="fa-solid fa-chevron-down text-[9px] opacity-50 logical-ms-1"></i>
                                </button>
                                <div v-if="showStatusFilter" @click="showStatusFilter = false" class="fixed inset-0 z-40"></div>
                                <div v-if="showStatusFilter" class="admin-grid-popover logical-inline-start w-40 flex flex-col gap-0.5">
                                    <button @click="selectedStatus = ''; showStatusFilter = false" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none w-full">
                                        <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedStatus === '' ? 'fa-solid fa-check' : ''"></i>
                                        <span>{{ $t('All Statuses') }}</span>
                                    </button>
                                    <button @click="selectedStatus = 'open'; showStatusFilter = false" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none w-full">
                                        <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedStatus === 'open' ? 'fa-solid fa-check' : ''"></i>
                                        <span>{{ $t('Active') }}</span>
                                    </button>
                                    <button @click="selectedStatus = 'closed'; showStatusFilter = false" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none w-full">
                                        <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedStatus === 'closed' ? 'fa-solid fa-check' : ''"></i>
                                        <span>{{ $t('Closed') }}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Core Actions -->
                    <div class="flex items-center gap-2 shrink-0 justify-end">
                        <!-- Reset Filters -->
                        <button @click="clearAllFilters" class="admin-grid-button">
                            <i class="fa-solid fa-arrow-rotate-left text-[10px]"></i>
                            <span>{{ $t('Reset') }}</span>
                        </button>
                    </div>
                </div>

                <!-- Row 2: Date Filters & Audit Printing -->
                <div class="admin-grid-command-row flex-wrap justify-between w-full">
                    <div class="flex items-center gap-2 min-w-0 flex-wrap">
                        <label class="text-[10.5px] font-semibold text-muted-foreground">{{ isPeriodMode ? $t('From') : $t('Business Date') }}</label>
                        
                        <div class="flex items-center bg-white border border-zinc-300 rounded-[5px] px-2.5 h-9 w-full sm:w-auto">
                            <input v-model="filterDateFrom" :aria-label="$t('Start')" class="bg-transparent border-none p-0 text-xs font-medium text-foreground outline-none focus:ring-0 w-[6.5rem] text-center tabular-nums cursor-pointer" type="date"/>
                            <template v-if="isPeriodMode">
                                <i :class="['fa-solid text-[9px] text-muted-foreground mx-1.5', isRtl ? 'fa-arrow-left-long' : 'fa-arrow-right-long']"></i>
                                <input v-model="filterDateTo" :min="filterDateFrom" :aria-label="$t('End')" class="bg-transparent border-none p-0 text-xs font-medium text-foreground outline-none focus:ring-0 w-[6.5rem] text-center tabular-nums cursor-pointer" type="date"/>
                            </template>
                        </div>

                        <label class="admin-grid-button cursor-pointer focus-within:ring-2 focus-within:ring-teal-600/30" :class="{ 'admin-grid-button--soft': isPeriodMode }">
                            <input type="checkbox" v-model="isPeriodMode" class="sr-only" />
                            <i class="fa-solid fa-calendar-week text-[10px]"></i>
                            <span>{{ $t('Period') }}</span>
                        </label>

                        <div v-if="auditStatus?.open_shifts?.length" class="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                            <span class="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-700">
                                <i class="fa-solid fa-triangle-exclamation text-[10px]"></i>
                                <span data-no-i18n>{{ auditStatus.open_shifts.length }}</span>
                                <span>{{ $t('Open') }}</span>
                            </span>
                        </div>
                    </div>

                    <div class="flex items-center justify-end gap-1.5 flex-wrap">
                        <ReportPrintMenu
                            :label="$t('Print X Report')"
                            variant="admin-grid-button admin-grid-button--dark"
                            :disabled="isPeriodMode"
                            :busy="isPrinting"
                            @select="layout => printAuditReport(layout, 'x_audit')"
                        />
                        <ReportPrintMenu
                            :label="auditStatus?.z_document ? `${$t('Reprint')} ${auditStatus.z_document.serial_label}` : $t('Print Z Report')"
                            variant="admin-grid-button admin-grid-button--primary"
                            :disabled="isPeriodMode || (!auditStatus?.can_issue_z && !auditStatus?.z_document)"
                            :busy="isPrinting"
                            @select="layout => printAuditReport(layout, 'z_audit')"
                        />
                        <ReportPrintMenu
                            v-if="isPeriodMode"
                            :label="$t('Print Period Report')"
                            variant="admin-grid-button admin-grid-button--soft"
                            :busy="isPrinting"
                            @select="printPeriodReport"
                        />
                        <ReportPrintMenu
                            :label="$t('Items Report')"
                            variant="admin-grid-button"
                            :busy="isPrinting"
                            @select="printItemsReport"
                        />
                        <ReportPrintMenu
                            label="Y"
                            variant="admin-grid-button admin-grid-button--soft min-w-9"
                            :busy="isPrinting"
                            @select="printYReport"
                        />
                        <ReportPrintMenu
                            v-if="yArchive"
                            :label="$t('Reopen last Y')"
                            variant="admin-grid-button"
                            :busy="isPrinting"
                            @select="reopenYArchive"
                        />
                        <button v-if="yArchive" @click="restoreYArchive" :disabled="isYRestoring" class="admin-grid-button">
                            {{ isYRestoring ? $t('Restoring...') : $t('Restore last Y') }}
                        </button>
                    </div>
                </div>
            </div>

            <!-- Active Filters List -->
            <div v-if="searchQuery || selectedCashiers.length > 0 || selectedStatus" class="flex flex-wrap items-center gap-1.5">
                <span class="text-[10.5px] font-semibold text-muted-foreground logical-me-1">{{ $t('Active Filters:') }}</span>

                <span v-if="searchQuery" class="admin-grid-filter-note">
                    <span>{{ $t('Search:') }} "{{ searchQuery }}"</span>
                    <button @click="searchQuery = ''" class="hover:text-destructive focus:outline-none"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <span v-for="cId in selectedCashiers" :key="cId" class="admin-grid-filter-note">
                    <span data-no-i18n>{{ cashiers.find(c => c.id === cId)?.name || cId }}</span>
                    <button @click="toggleCashierFilter(cId)" class="hover:text-destructive focus:outline-none"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <span v-if="selectedStatus" class="admin-grid-filter-note">
                    <span>{{ selectedStatus === 'open' ? $t('Active') : $t('Closed') }}</span>
                    <button @click="selectedStatus = ''" class="hover:text-destructive focus:outline-none"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <button @click="clearAllFilters" class="text-xs font-semibold text-destructive hover:bg-destructive/10 px-2.5 py-1 rounded-md transition-colors focus:outline-none">
                    {{ $t('Reset') }}
                </button>
            </div>

            <!-- Main Content Container -->
            <section class="admin-grid-shell flex-1 min-h-0 flex flex-col relative">
                <div v-if="isLoading" class="absolute inset-0 bg-background/95 z-20 flex items-center justify-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-600"></i>
                </div>

                <!-- Desktop Table View (md and above) -->
                <div class="admin-grid-scroll hidden md:block overflow-x-auto overflow-y-auto flex-1">
                    <table class="admin-data-grid min-w-[900px]">
                        <thead class="sticky top-0 z-10">
                            <tr>
                                <th class="py-2 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start w-[18%]">{{ $t('Shift') }}</th>
                                <th class="py-2 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start w-[12%]">{{ $t('Status') }}</th>
                                <th class="py-2 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start w-[30%]">{{ $t('Hours') }}</th>
                                <th class="logical-text-end w-[15%]">{{ $t('Gross Sales') }}</th>
                                <th class="logical-text-end w-[15%]">{{ $t('Expected Cash') }}</th>
                                <th class="logical-text-end w-[10%]">{{ $t('Variance') }}</th>
                                <th class="py-2 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end w-24">{{ $t('Action') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-if="shifts.length === 0">
                                <td colspan="7" class="py-24 text-center text-muted-foreground">
                                    <div class="flex flex-col items-center justify-center">
                                        <i class="fa-solid fa-clock-rotate-left text-3xl mb-3 opacity-40"></i>
                                        <p class="font-medium text-sm">{{ $t('No shifts found') }}</p>
                                    </div>
                                </td>
                            </tr>
                            <tr v-for="shift in shifts" :key="shift.id">
                                <td>
                                    <div class="admin-grid-primary-text tabular-nums" data-no-i18n>#{{ shift.id }}</div>
                                    <div class="admin-grid-secondary-text" data-no-i18n>{{ shift.cashier_name || $t('Unknown') }}</div>
                                </td>
                                <td class="py-1.5 px-5">
                                    <span v-if="shift.is_active" class="admin-grid-status is-active">{{ $t('Active') }}</span>
                                    <span v-else class="admin-grid-status">{{ $t('Closed') }}</span>
                                    <div v-if="shift.variance_hint?.kind === 'starting_cash_mismatch'" class="text-[10px] font-medium text-amber-700 mt-1 leading-snug">{{ $t('Starting cash may be wrong: previous shift closed with a different count') }}</div>
                                    <div v-else-if="shift.variance_hint?.kind === 'count_excluded_opening'" class="text-[10px] font-medium text-amber-700 mt-1 leading-snug">{{ $t('Closing count may have omitted the opening cash') }}</div>
                                </td>
                                <td class="py-1.5 px-5 text-xs font-medium text-muted-foreground">
                                    <div><span class="text-[9px] text-muted-foreground uppercase font-semibold w-7 inline-block">{{ $t('IN') }}</span> <span data-no-i18n class="text-foreground font-medium tabular-nums">{{ formatDateTime(shift.opened_at) }}</span></div>
                                    <div class="mt-0.5"><span class="text-[9px] text-muted-foreground uppercase font-semibold w-7 inline-block">{{ $t('OUT') }}</span> <span data-no-i18n class="text-foreground font-medium tabular-nums">{{ shift.closed_at ? formatDateTime(shift.closed_at) : '—' }}</span></div>
                                </td>
                                <td class="logical-text-end">
                                    <span class="admin-grid-money" data-no-i18n>{{ formatMoney(shift.gross_sales) }} JD</span>
                                </td>
                                <td class="logical-text-end">
                                    <span class="admin-grid-money" data-no-i18n>{{ formatMoney(shift.live_expected_cash) }} JD</span>
                                </td>
                                <td class="logical-text-end">
                                    <span v-if="varianceInfo(shift.variance).kind === 'pending'" class="text-xs font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceInfo(shift.variance).kind === 'perfect'" class="inline-flex items-center gap-1 text-xs font-semibold text-teal-700"><i class="fa-solid fa-check text-[10px]"></i> {{ $t('Perfect') }}</span>
                                    <span v-else class="text-xs font-semibold tabular-nums" :class="varianceInfo(shift.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(shift.variance).text }}</span>
                                </td>
                                <td class="logical-text-end">
                                    <div class="admin-grid-row-actions"><button @click="openShiftModal(shift)">
                                        {{ shift.is_active ? $t('Audit') : $t('View Report') }}
                                    </button></div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Mobile Card List View (Visible under md) -->
                <div class="admin-grid-mobile-list admin-grid-scroll block md:hidden overflow-y-auto flex-1">
                    <div v-if="shifts.length === 0" class="py-20 text-center bg-card border border-zinc-300 rounded-xl">
                        <div class="flex flex-col items-center justify-center text-muted-foreground">
                            <i class="fa-solid fa-clock-rotate-left text-3xl mb-3 opacity-40"></i>
                            <span class="font-medium text-sm">{{ $t('No shifts found') }}</span>
                        </div>
                    </div>

                    <article v-for="shift in shifts" :key="shift.id" class="admin-grid-mobile-card flex flex-col gap-3">
                        <div class="flex justify-between items-start gap-3">
                            <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                    <span class="font-semibold text-foreground text-sm tabular-nums" data-no-i18n>#{{ shift.id }}</span>
                                    <span v-if="shift.is_active" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-700">
                                        <span class="relative flex h-1.5 w-1.5">
                                          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-500 opacity-75"></span>
                                          <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-teal-500"></span>
                                        </span>
                                        {{ $t('Active') }}
                                    </span>
                                    <span v-else class="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>{{ $t('Closed') }}</span>
                                    <div v-if="shift.variance_hint?.kind === 'starting_cash_mismatch'" class="text-[10px] font-medium text-amber-700 mt-1 leading-snug">{{ $t('Starting cash may be wrong: previous shift closed with a different count') }}</div>
                                    <div v-else-if="shift.variance_hint?.kind === 'count_excluded_opening'" class="text-[10px] font-medium text-amber-700 mt-1 leading-snug">{{ $t('Closing count may have omitted the opening cash') }}</div>
                                </div>
                                <div class="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                                    <i class="fa-solid fa-user text-[9px] opacity-60"></i>
                                    <span data-no-i18n>{{ shift.cashier_name || $t('Unknown') }}</span>
                                </div>
                            </div>

                            <button @click="openShiftModal(shift)" class="admin-grid-mobile-action shrink-0 px-3">
                                {{ shift.is_active ? $t('Audit') : $t('View Report') }}
                            </button>
                        </div>

                        <!-- Shift hours -->
                        <div class="text-[10px] text-muted-foreground border-t border-zinc-200 pt-2 flex flex-col gap-0.5">
                            <div>
                                <span class="font-semibold text-muted-foreground uppercase text-[8px] tracking-wider w-7 inline-block">{{ $t('IN') }}</span>
                                <span data-no-i18n class="text-foreground font-medium tabular-nums">{{ formatDateTime(shift.opened_at) }}</span>
                            </div>
                            <div>
                                <span class="font-semibold text-muted-foreground uppercase text-[8px] tracking-wider w-7 inline-block">{{ $t('OUT') }}</span>
                                <span data-no-i18n class="text-foreground font-medium tabular-nums">{{ shift.closed_at ? formatDateTime(shift.closed_at) : '—' }}</span>
                            </div>
                        </div>

                        <!-- Shift statistics grid -->
                        <div class="grid grid-cols-3 gap-2 border-t border-zinc-200 pt-3">
                            <div>
                                <p class="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Sales') }}</p>
                                <p class="text-[11px] font-bold text-foreground mt-1 tabular-nums" data-no-i18n>{{ formatMoney(shift.gross_sales) }} JD</p>
                            </div>
                            <div>
                                <p class="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Expected') }}</p>
                                <p class="text-[11px] font-bold text-foreground mt-1 tabular-nums" data-no-i18n>{{ formatMoney(shift.live_expected_cash) }} JD</p>
                            </div>
                            <div class="text-end">
                                <p class="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Variance') }}</p>
                                <div class="mt-1 flex items-center justify-end">
                                    <span v-if="varianceInfo(shift.variance).kind === 'pending'" class="text-[10px] font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceInfo(shift.variance).kind === 'perfect'" class="inline-flex items-center gap-0.5 text-[10px] font-semibold text-teal-700">
                                        <i class="fa-solid fa-check text-[9px]"></i>
                                        <span>{{ $t('Perfect') }}</span>
                                    </span>
                                    <span v-else class="text-[11px] font-bold tabular-nums" :class="varianceInfo(shift.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(shift.variance).text }}</span>
                                </div>
                            </div>
                        </div>
                    </article>
                </div>

                <!-- Pagination Footer -->
                <footer class="admin-grid-pagination shrink-0 mt-auto">
                    <div class="admin-grid-pagination-summary hidden sm:flex"><p><strong class="tabular-nums" data-no-i18n>{{ shifts.length }}</strong> {{ $t('of') }} <strong class="tabular-nums" data-no-i18n>{{ totalRecords }}</strong> {{ $t('shifts') }}</p></div>
                    <div class="admin-grid-pagination-controls w-full sm:w-auto justify-between sm:justify-end">
                        <button @click="prevPage" :disabled="currentPage === 1" :aria-label="$t('Prev')"><i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']"></i></button>
                        <span>{{ $t('Page') }} <strong class="tabular-nums" data-no-i18n>{{ currentPage }}</strong> / <span class="tabular-nums" data-no-i18n>{{ totalPages || 1 }}</span></span>
                        <button @click="nextPage" :disabled="currentPage === totalPages || totalPages === 0" :aria-label="$t('Next')"><i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']"></i></button>
                    </div>
                </footer>
            </section>

            <!-- Open Shift Modal -->
            <ModalShell :show="showOpenModal" :title="$t('Open New Shift')" width-class="max-w-sm" @close="showOpenModal = false">
                <form @submit.prevent="submitOpenShift" class="flex-1 flex flex-col overflow-y-auto">
                    <div class="p-6 space-y-4">
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Assign Cashier') }}</label>
                            <select v-model="openShiftForm.user_id" @change="refreshOpenShiftSuggestion" required class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-10">
                                <option value="" disabled>{{ $t('Select available cashier...') }}</option>
                                <option v-for="c in eligibleCashiers" :key="c.id" :value="c.id" data-no-i18n>{{ c.name }}</option>
                            </select>
                            <p v-if="eligibleCashiers.length === 0" class="text-[10px] font-semibold text-destructive mt-1.5">{{ $t('No cashiers available (all have open shifts).') }}</p>
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Starting Cash Float (JD)') }}</label>
                            <div class="relative">
                                <span class="absolute logical-start-3 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold text-xs">JD</span>
                                <input v-model.number="openShiftForm.starting_cash" @input="openShiftCashEdited = true" type="number" step="0.01" min="0" required class="w-full bg-muted border border-zinc-300 rounded-lg py-2.5 logical-ps-9 logical-pe-4 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
                            </div>
                        </div>
                    </div>

                    <div class="p-4 border-t border-zinc-200 bg-muted flex justify-end gap-2.5 shrink-0">
                        <button type="button" @click="showOpenModal = false" class="h-9 px-4 bg-card border border-zinc-300 text-foreground font-medium rounded-lg hover:bg-zinc-200 transition-colors text-xs">{{ $t('Cancel') }}</button>
                        <button type="submit" :disabled="isOpening || isLoadingOpenShiftSuggestion || eligibleCashiers.length === 0" class="h-9 px-4 bg-teal-600 text-white hover:bg-teal-700 font-medium rounded-lg transition-colors text-xs disabled:opacity-50 flex gap-2 items-center">
                            <i v-if="isOpening" class="fa-solid fa-circle-notch fa-spin"></i> {{ $t('Open Shift') }}
                        </button>
                    </div>
                </form>
            </ModalShell>

            <!-- View / Close Shift Modal -->
            <ModalShell :show="showModal" width-class="max-w-5xl" @close="showModal = false">
                <template #header>
                    <h3 class="font-display font-semibold text-foreground text-base tracking-tight">{{ $t('Shift Audit') }} <span data-no-i18n>#{{ selectedShift?.id }}</span></h3>
                </template>
                <div class="p-6 overflow-y-auto premium-scroll space-y-5">
                    <div class="flex flex-wrap justify-between items-center gap-4">
                        <div>
                            <p class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Cashier') }}</p>
                            <p class="text-sm font-semibold text-foreground mt-0.5" data-no-i18n>{{ selectedShift?.cashier_name }}</p>
                        </div>
                        <span v-if="selectedShift?.is_active" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-700">
                            <span class="relative flex h-1.5 w-1.5"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-500 opacity-75"></span><span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-teal-500"></span></span>
                            {{ $t('Shift Active') }}
                        </span>
                        <span v-else class="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>{{ $t('Shift Closed') }}</span>
                    </div>

                    <div v-if="isLoadingShiftDetails" class="min-h-52 flex items-center justify-center text-teal-700" role="status">
                        <i class="fa-solid fa-circle-notch fa-spin text-2xl" aria-hidden="true"></i>
                        <span class="sr-only">{{ $t('Loading...') }}</span>
                    </div>
                    <div v-else-if="shiftDetailsError" class="min-h-52 rounded-lg border border-rose-200 bg-rose-50 p-6 flex flex-col items-center justify-center gap-4 text-center">
                        <p class="text-sm font-semibold text-rose-700">{{ $t(shiftDetailsError) }}</p>
                        <button type="button" class="admin-grid-button" @click="openShiftModal(selectedShift)">{{ $t('Retry') }}</button>
                    </div>

                    <div v-else class="grid grid-cols-1 lg:grid-cols-[1.35fr_.9fr] gap-5 items-start">
                        <section class="bg-muted/40 p-5 rounded-lg border border-zinc-200">
                            <h4 class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-b border-zinc-200 pb-2 mb-4">{{ $t('Drawer cash calculation') }}</h4>

                            <div class="flex justify-between items-center text-xs font-medium text-muted-foreground mb-3">
                                <label for="shift-starting-cash">{{ $t('Starting Cash') }}</label>
                                <div v-if="!isEditingCash" class="flex items-center gap-2">
                                    <span class="text-foreground font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.starting_cash) }} JD</span>
                                    <button type="button" @click="beginCashEdit" :aria-label="$t('Edit Starting Cash')" class="text-muted-foreground hover:text-foreground transition-colors logical-ms-1"><i class="fa-solid fa-pen text-[10px]"></i></button>
                                </div>
                                <div v-else class="flex items-center gap-2">
                                    <input id="shift-starting-cash" type="number" v-model.number="newStartingCash" step="0.01" min="0" max="99999999.99" :disabled="isUpdatingCash" class="w-28 bg-card border border-zinc-300 rounded p-1.5 text-end text-foreground font-semibold focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 text-xs outline-none tabular-nums">
                                </div>
                            </div>
                            <div class="flex justify-between text-xs font-medium text-muted-foreground mb-3">
                                <span>{{ $t('Cash received from sales') }}</span>
                                <span class="text-foreground font-semibold tabular-nums" data-no-i18n>+{{ formatMoney(selectedShift?.gross_cash_sales) }} JD</span>
                            </div>
                            <div class="flex justify-between text-xs font-semibold text-rose-700 mb-3">
                                <span>{{ $t('Cash refunds paid from drawer') }}</span>
                                <span class="tabular-nums" data-no-i18n>{{ Number(selectedShift?.cash_refunds || 0) > 0 ? '-' : '' }}{{ formatMoney(selectedShift?.cash_refunds) }} JD</span>
                            </div>
                            <div class="flex justify-between text-xs font-semibold text-rose-700 mb-2">
                                <span>{{ $t('Cash expenses paid from drawer') }}</span>
                                <span class="tabular-nums" data-no-i18n>{{ Number(selectedShift?.cash_expenses || 0) > 0 ? '-' : '' }}{{ formatMoney(selectedShift?.cash_expenses) }} JD</span>
                            </div>
                            <div v-if="selectedShift?.expense_categories?.length" class="mb-4 rounded-md border border-rose-100 bg-card px-3 py-2">
                                <p class="text-[10px] font-bold text-muted-foreground mb-1.5">{{ $t('Expense details') }}</p>
                                <div v-for="category in selectedShift.expense_categories" :key="category.category_id" class="flex justify-between gap-4 py-1 text-[11px] text-muted-foreground">
                                    <span><span data-no-i18n>{{ category.category_name }}</span> · <span data-no-i18n>{{ category.count }}</span> {{ $t('entries') }}</span>
                                    <span class="font-semibold tabular-nums" data-no-i18n>-{{ formatMoney(category.total) }} JD</span>
                                </div>
                            </div>

                            <div class="flex justify-between text-sm font-semibold text-foreground py-4 border-y border-zinc-200">
                                <span>{{ $t('Expected Cash In Drawer') }}</span>
                                <span class="text-teal-700 font-bold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.live_expected_cash) }} JD</span>
                            </div>

                            <div v-if="!selectedShift?.is_active" class="bg-card p-4 rounded-lg border border-zinc-200 space-y-3 mt-4">
                                <div class="flex justify-between items-center gap-3 text-xs font-semibold text-foreground">
                                    <label for="shift-ending-cash">{{ $t('Ending Cash') }}</label>
                                    <div v-if="!isEditingCash" class="flex items-center gap-2">
                                        <span class="tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.actual_cash) }} JD</span>
                                        <button type="button" @click="beginCashEdit" :aria-label="$t('Edit Ending Cash')" class="text-muted-foreground hover:text-foreground transition-colors"><i class="fa-solid fa-pen text-[10px]"></i></button>
                                    </div>
                                    <input v-else id="shift-ending-cash" type="number" v-model.number="newActualCash" step="0.01" min="0" max="99999999.99" :disabled="isUpdatingCash" class="w-28 bg-card border border-zinc-300 rounded p-1.5 text-end text-foreground font-semibold focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 text-xs outline-none tabular-nums">
                                </div>
                                <div class="flex justify-between text-xs font-semibold border-t border-zinc-200 pt-2"><span class="text-muted-foreground uppercase tracking-wider">{{ $t('Variance:') }}</span><span v-if="varianceInfo(selectedShift?.variance).kind === 'perfect'" class="text-teal-700 font-semibold flex items-center gap-1"><i class="fa-solid fa-check"></i> {{ $t('Perfect') }}</span><span v-else class="font-semibold tabular-nums" :class="varianceInfo(selectedShift?.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(selectedShift?.variance).text }}</span></div>
                                <div v-if="selectedShift?.drawer_change_since_previous_close != null" class="flex justify-between text-xs font-semibold border-t border-zinc-200 pt-2">
                                    <span class="text-muted-foreground uppercase tracking-wider">{{ $t('Change since previous close') }}</span>
                                    <span class="tabular-nums" data-no-i18n>{{ formatMoney(selectedShift.drawer_change_since_previous_close) }} JD</span>
                                </div>
                                <div v-if="selectedShift?.variance_hint" class="space-y-2 border-t border-zinc-200 pt-2">
                                    <p v-if="selectedShift.variance_hint.kind === 'starting_cash_mismatch'" class="text-xs font-medium text-amber-700">{{ $t('Starting cash may be wrong: previous shift closed with a different count') }}</p>
                                    <p v-else-if="selectedShift.variance_hint.kind === 'count_excluded_opening'" class="text-xs font-medium text-amber-700">{{ $t('Closing count may have omitted the opening cash') }}</p>
                                    <button type="button" @click="applyVarianceSuggestion" :disabled="isUpdatingCash" class="admin-grid-button">{{ $t('Apply suggestion') }}</button>
                                </div>
                            </div>
                            <div v-if="isEditingCash" class="mt-4 space-y-3">
                                <p v-if="cashEditError" role="alert" class="text-xs text-destructive">{{ $t(cashEditError) }}</p>
                                <div class="flex justify-end gap-2">
                                    <button type="button" @click="isEditingCash = false" :disabled="isUpdatingCash" class="admin-grid-button">{{ $t('Cancel') }}</button>
                                    <button type="button" @click="updateShiftCash" :disabled="isUpdatingCash || !!cashEditError" class="admin-grid-button admin-grid-button--primary"><i v-if="isUpdatingCash" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>{{ $t('Save Changes') }}</button>
                                </div>
                            </div>
                        </section>

                        <div class="space-y-5">
                            <section class="bg-card p-5 rounded-lg border border-zinc-200 space-y-3">
                                <h4 class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-b border-zinc-200 pb-2">{{ $t('Other shift totals') }}</h4>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Net sales after refunds') }}</span><span class="font-semibold tabular-nums text-foreground" data-no-i18n>{{ formatMoney(selectedShift?.gross_sales) }} JD</span></div>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Net sales before tax') }}</span><span class="font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.net_sales_pre_tax) }} JD</span></div>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Tax collected after refunds') }}</span><span class="font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.tax_collected) }} JD</span></div>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Card Sales (Not in drawer)') }}</span><span class="font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.card_sales) }} JD</span></div>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Platform Sales (Not collected)') }}</span><span class="font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.platform_sales) }} JD</span></div>
                                <div class="flex justify-between text-xs text-muted-foreground"><span>{{ $t('Total Discounts') }}</span><span class="font-semibold tabular-nums" data-no-i18n>{{ formatMoney(selectedShift?.total_discounts) }} JD</span></div>
                                <div class="pt-3 border-t border-zinc-200 text-[10px] text-muted-foreground space-y-1.5"><div class="flex justify-between gap-4"><span>{{ $t('Opened At') }}</span><span class="tabular-nums text-foreground" data-no-i18n>{{ formatDateTime(selectedShift?.opened_at) }}</span></div><div v-if="selectedShift?.closed_at" class="flex justify-between gap-4"><span>{{ $t('Closed At') }}</span><span class="tabular-nums text-foreground" data-no-i18n>{{ formatDateTime(selectedShift?.closed_at) }}</span></div></div>
                                <ReportPrintMenu class="w-full pt-2" :label="selectedShift?.is_active ? $t('Print X-Report (Audit)') : $t('Print Z-Report (Final)')" variant="w-full h-9 admin-grid-button" :busy="isPrinting" @select="printShiftReport" />
                            </section>

                            <section v-if="selectedShift?.is_active" class="bg-rose-50 p-5 rounded-lg border border-rose-200 space-y-4">
                                <h4 class="text-[11px] font-semibold text-rose-700 tracking-tight flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> {{ $t('Admin Override') }}</h4>
                                <p class="text-[10px] text-muted-foreground leading-normal">{{ $t('You can manually close this shift if the cashier abandoned the register. Please enter the actual cash counted in the physical drawer.') }}</p>
                                <div><label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Counted Cash (JD)') }}</label><input v-model.number="actualCashInput" type="number" step="0.01" min="0" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums"></div>
                                <button @click="adminForceCloseShift" :disabled="isClosing || actualCashInput === '' || actualCashInput === null" class="w-full h-9 bg-destructive text-destructive-foreground font-medium text-xs rounded-lg hover:bg-destructive/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 focus:outline-none"><i v-if="isClosing" class="fa-solid fa-circle-notch fa-spin"></i><i v-else class="fa-solid fa-lock text-[11px]"></i>{{ $t('Force Close Shift') }}</button>
                            </section>
                        </div>
                    </div>
                </div>
            </ModalShell>

        </div>

</template>

<script>
import { formatBusinessDateTime } from '@/utils/businessDate.js';
import { fetchJson } from '@/shared/http.js';
import { ref, onMounted, computed, watch } from 'vue';
import { t, currentLanguage } from '@/shared/i18n.js';
import { currentBusinessDate } from '../../utils/businessDate.js';
import { formatMoney, varianceIsZero } from '../../utils/money.js';
import ModalShell from '../components/ModalShell.vue';
import ReportPrintMenu from '../components/ReportPrintMenu.vue';
import { useShiftReportPrint } from '../composables/useShiftReportPrint.js';

export default {
    components: { ModalShell, ReportPrintMenu },
    setup() {
        const shifts = ref([]);
        const isLoading = ref(false);
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const searchQuery = ref('');
        let searchTimer = null;
        let fetchSeq = 0;
        let auditSeq = 0;
        let openShiftCheckSeq = 0;
        let shiftDetailsSeq = 0;
        const currentPage = ref(1);
        const totalPages = ref(1);
        const totalRecords = ref(0);

        // Shadcn popovers and filtering states
        const selectedCashiers = ref([]);
        const selectedStatus = ref('');
        const showCashierFilter = ref(false);
        const showStatusFilter = ref(false);
        const cashiers = ref([]);
        const showMobileFilters = ref(false);

        // View/Audit Modal State
        const showModal = ref(false);
        const selectedShift = ref(null);
        const isLoadingShiftDetails = ref(false);
        const shiftDetailsError = ref('');
        const isClosing = ref(false);
        const actualCashInput = ref('');

        // Open Shift State
        const showOpenModal = ref(false);
        const isOpening = ref(false);
        const eligibleCashiers = ref([]);
        const openShiftForm = ref({ user_id: '', starting_cash: 0 });
        const openShiftCashEdited = ref(false);
        const isLoadingOpenShiftSuggestion = ref(false);

        // Printing
        const { printReport, isPrinting } = useShiftReportPrint();
        const filterDateFrom = ref(currentBusinessDate());
        const filterDateTo = ref(currentBusinessDate());
        const isPeriodMode = ref(false);
        const isYRestoring = ref(false);
        const yArchive = ref(null);
        const auditStatus = ref(null);

        // Corrections use the existing audited cash-update endpoint.
        const isEditingCash = ref(false);
        const newStartingCash = ref(0);
        const newActualCash = ref(0);
        const isUpdatingCash = ref(false);
        const cashEditError = computed(() => {
            if (!selectedShift.value) return '';
            const values = [newStartingCash.value];
            if (!selectedShift.value.is_active) values.push(newActualCash.value);
            return values.some(value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 99999999.99)
                ? 'Enter a valid cash amount from 0 to 99,999,999.99.' : '';
        });
        const beginCashEdit = () => {
            if (!selectedShift.value || isUpdatingCash.value) return;
            newStartingCash.value = selectedShift.value.starting_cash;
            newActualCash.value = selectedShift.value.actual_cash;
            isEditingCash.value = true;
        };

        const fetchShifts = async () => {
            const seq = ++fetchSeq;
            isLoading.value = true;
            try {
                const params = new URLSearchParams();
                params.set('page', String(currentPage.value));
                params.set('limit', '50');
                if (selectedCashiers.value.length > 0) {
                    params.set('cashier_ids', selectedCashiers.value.join(','));
                }
                if (selectedStatus.value) {
                    params.set('status', selectedStatus.value);
                }
                if (searchQuery.value.trim()) {
                    params.set('search', searchQuery.value.trim());
                }
                params.set('start_date', filterDateFrom.value);
                params.set('end_date', isPeriodMode.value ? filterDateTo.value : filterDateFrom.value);
                const data = await fetchJson(`api/admin/shifts?${params.toString()}`);
                if (seq !== fetchSeq) return;  // a newer fetch superseded this one
                if (data.success) {
                    shifts.value = data.shifts;
                    if (data.pagination) {
                        totalPages.value = data.pagination.total_pages;
                        totalRecords.value = data.pagination.total;
                    }
                }
            } catch (error) {
                console.error("Failed to load shifts");
            } finally {
                if (seq === fetchSeq) isLoading.value = false;
            }
        };

        const fetchAuditStatus = async () => {
            const seq = ++auditSeq;
            try {
                const params = new URLSearchParams({ business_date: filterDateFrom.value });
                const data = await fetchJson(`api/admin/audit-reports/status?${params.toString()}`);
                if (seq !== auditSeq) return; // a newer audit-status fetch superseded this one
                if (data.success) auditStatus.value = data;
            } catch (error) {
                console.error("Failed to load audit report status", error);
            }
        };

        const refreshAll = () => {
            fetchShifts();
            fetchAuditStatus();
        };

        const fetchCashiers = async () => {
            try {
                const data = await fetchJson('api/admin/shifts?action=cashiers&all=true');
                if (data.success) {
                    cashiers.value = data.cashiers || [];
                }
            } catch (e) {
                console.error("Failed to load cashiers for filtering", e);
            }
        };

        const refreshOpenShiftSuggestion = async () => {
            const seq = ++openShiftCheckSeq;
            openShiftForm.value.starting_cash = 0;
            openShiftCashEdited.value = false;
            const userId = openShiftForm.value.user_id;
            if (!userId) {
                isLoadingOpenShiftSuggestion.value = false;
                return;
            }
            isLoadingOpenShiftSuggestion.value = true;
            try {
                const data = await fetchJson(`api/auth/shifts?action=check&user_id=${userId}`);
                if (seq !== openShiftCheckSeq || openShiftCashEdited.value) return;
                openShiftForm.value.starting_cash = data.suggested_starting_cash ?? 0;
            } catch (e) { }
            finally {
                if (seq === openShiftCheckSeq) isLoadingOpenShiftSuggestion.value = false;
            }
        };

        const triggerOpenShift = async () => {
            openShiftForm.value = { user_id: '', starting_cash: 0 };
            await refreshOpenShiftSuggestion();
            try {
                const data = await fetchJson('api/admin/shifts?action=cashiers');
                if (data.success) eligibleCashiers.value = data.cashiers;
            } catch (e) { }
            showOpenModal.value = true;
        };

        const submitOpenShift = async () => {
            if (isLoadingOpenShiftSuggestion.value) return;
            if (!openShiftForm.value.user_id) {
                await window.showAdminAlert(t("Please select a cashier."));
                return;
            }

            isOpening.value = true;
            try {
                const data = await fetchJson('api/admin/shifts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(openShiftForm.value)
                });
                if (data.success) {
                    showOpenModal.value = false;
                    refreshAll();
                } else {
                    await window.showAdminAlert(data.message);
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error."));
            } finally {
                isOpening.value = false;
            }
        };

        onMounted(() => {
            fetchShifts();
            fetchCashiers();
            fetchAuditStatus();
            fetchYArchiveStatus();
        });

        watch([selectedCashiers, selectedStatus], () => {
            currentPage.value = 1;
            fetchShifts();
        }, { deep: true });

        watch(searchQuery, () => {
            currentPage.value = 1;
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(fetchShifts, 300);
        });

        // Keep filterDateTo from ever silently drifting before filterDateFrom (e.g. From
        // edited while Period is off and To is hidden) — clamp it immediately rather than
        // only on explicit Reset, so re-enabling Period never sends an inverted range.
        watch(filterDateFrom, (newFrom) => {
            if (filterDateTo.value < newFrom) {
                filterDateTo.value = newFrom;
            }
        });

        // Re-syncing To to From when Period turns off keeps the pair consistent even if
        // some future code path mutates filterDateTo directly while Period is off.
        watch(isPeriodMode, (enabled) => {
            if (!enabled) {
                filterDateTo.value = filterDateFrom.value;
            }
        });

        watch([filterDateFrom, filterDateTo, isPeriodMode], () => {
            currentPage.value = 1;
            fetchShifts();
            fetchAuditStatus();
        });

        const toggleCashierFilter = (id) => {
            const idx = selectedCashiers.value.indexOf(id);
            if (idx > -1) {
                selectedCashiers.value.splice(idx, 1);
            } else {
                selectedCashiers.value.push(id);
            }
        };

        const clearAllFilters = () => {
            selectedCashiers.value = [];
            selectedStatus.value = '';
            searchQuery.value = '';
            currentPage.value = 1;
            showMobileFilters.value = false;
            filterDateFrom.value = currentBusinessDate();
            filterDateTo.value = currentBusinessDate();
            isPeriodMode.value = false;
            showCashierFilter.value = false;
            showStatusFilter.value = false;
            refreshAll();
        };

        // Single source of truth for the closed-shift variance branch. Each render
        // site keeps its own size classes and reads .kind / .text from here.
        const varianceInfo = (v) => {
            if (v === null || v === undefined) return { kind: 'pending', text: '' };
            if (varianceIsZero(v)) return { kind: 'perfect', text: '' };
            if (v > 0) return { kind: 'over', text: '+' + formatMoney(v) + ' JD' };
            return { kind: 'short', text: '-' + formatMoney(Math.abs(v)) + ' JD' };
        };

        const openShiftModal = async (shift) => {
            const seq = ++shiftDetailsSeq;
            selectedShift.value = shift;
            actualCashInput.value = '';
            isEditingCash.value = false;
            newStartingCash.value = shift.starting_cash;
            newActualCash.value = shift.actual_cash;
            shiftDetailsError.value = '';
            isLoadingShiftDetails.value = true;
            showModal.value = true;
            try {
                const type = shift.is_active ? 'x_report' : 'z_report';
                const data = await fetchJson(`api/admin/shift-reports/${shift.id}/print-payload?type=${type}`);
                if (seq !== shiftDetailsSeq || !showModal.value) return;
                if (!data.success || !data.print_payload) {
                    throw new Error(data.message || 'Could not load complete shift details.');
                }
                selectedShift.value = {
                    ...shift,
                    ...data.print_payload,
                    id: shift.id,
                    is_active: shift.is_active,
                    live_expected_cash: data.print_payload.expected_cash,
                    variance_hint: shift.variance_hint,
                    drawer_change_since_previous_close: shift.drawer_change_since_previous_close,
                };
                newStartingCash.value = selectedShift.value.starting_cash;
                newActualCash.value = selectedShift.value.actual_cash;
            } catch (_) {
                if (seq === shiftDetailsSeq && showModal.value) {
                    shiftDetailsError.value = 'Could not load complete shift details.';
                }
            } finally {
                if (seq === shiftDetailsSeq) isLoadingShiftDetails.value = false;
            }
        };

        const adminForceCloseShift = async () => {
            const confirmed = await window.showAdminConfirm(
                t("Are you sure you want to force close this shift? The cashier will be locked out of the terminal."),
                t("Force Close Shift")
            );
            if (!confirmed) return;

            isClosing.value = true;
            try {
                const data = await fetchJson('api/admin/shifts', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: selectedShift.value.id,
                        expected_cash: selectedShift.value.live_expected_cash,
                        actual_cash: actualCashInput.value
                    })
                });
                
                if (data.success) {
                    showModal.value = false;
                    refreshAll();
                } else {
                    await window.showAdminAlert(data.message);
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error while closing shift."));
            } finally {
                isClosing.value = false;
            }
        };

        const requestPrintPayload = async (url, options, fallbackMessage) => {
            const isSpooler = options?.body && JSON.parse(options.body).delivery === 'spooler';
            try {
                const data = await fetchJson(url, options);
                if (isSpooler && data.success && !data.print_queued) {
                    await window.showAdminAlert(t('The report was not queued. Check Printing before retrying.'));
                    return false;
                }
                if (data.success && data.print_payload) return data.print_payload;
                await window.showAdminAlert(data.message || t(fallbackMessage));
            } catch (_) {
                await window.showAdminAlert(t(isSpooler
                    ? 'The print result could not be confirmed. It may already be queued. Check Printing before retrying.'
                    : 'Network error while preparing print preview.'));
            }
            return false;
        };

        // Capture the clicked selection before the asynchronous A4 handshake or Y confirmation.
        const printShiftReport = (layout) => {
            const shift = selectedShift.value;
            if (!shift) return false;
            const shiftId = shift.id;
            const type = shift.is_active ? 'x_report' : 'z_report';
            return printReport(layout, async (delivery) => {
                if (delivery.delivery === 'spooler') {
                    return requestPrintPayload(`api/admin/shift-reports/${shiftId}/print`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...delivery, type }),
                    }, 'Could not prepare the shift report.');
                }
                const data = await fetchJson(
                    `api/admin/shift-reports/${shiftId}/print-payload?type=${type}`
                );
                if (!data.success || !data.print_payload) {
                    await window.showAdminAlert(data.message || t('Could not prepare the shift report.'));
                    return false;
                }
                return data.print_payload;
            });
        };

        const printAuditReport = (layout, reportType) => {
            const businessDate = filterDateFrom.value;
            return printReport(layout, async (delivery) => {
                const payload = await requestPrintPayload('api/admin/audit-reports/print', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...delivery,
                        report_type: reportType,
                        business_date: businessDate,
                    }),
                }, 'Could not prepare audit report.');
                await fetchAuditStatus();
                return payload;
            });
        };

        const printPeriodReport = (layout) => {
            const dates = { start_date: filterDateFrom.value, end_date: filterDateTo.value };
            return printReport(layout, (delivery) => requestPrintPayload(
                'api/admin/audit-reports/print-period',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...delivery,
                        ...dates,
                    }),
                },
                'Could not prepare period report.'
            ));
        };

        const reportDateBody = () => isPeriodMode.value
            ? { start_date: filterDateFrom.value, end_date: filterDateTo.value }
            : { business_date: filterDateFrom.value };

        const printItemsReport = (layout) => {
            const dates = reportDateBody();
            return printReport(layout, (delivery) => requestPrintPayload(
                'api/admin/audit-reports/print-items',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...dates, ...delivery }),
                },
                'Could not prepare items report.'
            ));
        };

        const printYReport = (layout) => {
            const dates = reportDateBody();
            return printReport(layout, async (delivery) => {
                const confirmed = await window.showAdminConfirm(t('Print Y and remove the included held orders?'));
                if (!confirmed) return false;
                try {
                    return await requestPrintPayload('api/admin/audit-reports/print-y', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...dates, ...delivery }),
                    }, 'Could not prepare Y report.');
                } finally {
                    await fetchYArchiveStatus();
                }
            });
        };

        const reopenYArchive = (layout) => {
            const archiveId = yArchive.value?.id;
            if (!archiveId) return false;
            return printReport(layout, async (delivery) => {
                if (delivery.delivery === 'spooler') {
                    return requestPrintPayload(`api/admin/audit-reports/y-archives/${archiveId}/print`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(delivery),
                    }, 'Could not reopen Y report.');
                }
                return requestPrintPayload(
                    `api/admin/audit-reports/y-archives/${archiveId}/print-payload`,
                    undefined,
                    'Could not reopen Y report.'
                );
            });
        };

        const fetchYArchiveStatus = async () => {
            try {
                const data = await fetchJson('api/admin/audit-reports/y-archive-status');
                yArchive.value = data.success ? data.archive : null;
            } catch (_) {
                yArchive.value = null;
            }
        };

        const restoreYArchive = async () => {
            if (!yArchive.value || isYRestoring.value) return;
            isYRestoring.value = true;
            try {
                const confirmed = await window.showAdminConfirm(t('Restore the held orders removed by the last Y report?'));
                if (!confirmed) return;
                const data = await fetchJson('api/admin/audit-reports/restore-y', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ archive_id: yArchive.value.id })
                });
                await window.showAdminAlert(t(data.message || (data.success
                    ? 'Y held orders restored.'
                    : 'Could not restore Y held orders.')));
                await fetchYArchiveStatus();
            } catch (_) {
                await window.showAdminAlert(t('Network error while restoring Y held orders.'));
            } finally {
                isYRestoring.value = false;
            }
        };

        const applyVarianceSuggestion = () => {
            const suggested = selectedShift.value.variance_hint?.suggested || {};
            isEditingCash.value = true;
            newStartingCash.value = suggested.starting_cash ?? selectedShift.value.starting_cash;
            newActualCash.value = suggested.actual_cash ?? selectedShift.value.actual_cash;
        };

        const updateShiftCash = async () => {
            if (isUpdatingCash.value || !selectedShift.value || cashEditError.value) return;
            const cents = v => Math.round(Number(v) * 100);
            const body = { shift_id: selectedShift.value.id };
            if (cents(newStartingCash.value) !== cents(selectedShift.value.starting_cash)) {
                body.starting_cash = newStartingCash.value;
            }
            if (!selectedShift.value.is_active && cents(newActualCash.value) !== cents(selectedShift.value.actual_cash)) {
                body.actual_cash = newActualCash.value;
            }
            if (body.starting_cash === undefined && body.actual_cash === undefined) {
                isEditingCash.value = false;
                return;
            }
            isUpdatingCash.value = true;
            try {
                if (!selectedShift.value.is_active) {
                    const confirmed = await window.showAdminConfirm(
                        t("This changes a closed shift's drawer numbers. Sales are not affected. Continue?")
                    );
                    if (!confirmed) return;
                }
                const data = await fetchJson('api/auth/shifts?action=update_cash', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (data.success) {
                    isEditingCash.value = false;
                    refreshAll();
                    showModal.value = false; 
                } else {
                    await window.showAdminAlert(data.message);
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error."));
            } finally {
                isUpdatingCash.value = false;
            }
        };

        const nextPage = () => { if (currentPage.value < totalPages.value) { currentPage.value++; fetchShifts(); } };
        const prevPage = () => { if (currentPage.value > 1) { currentPage.value--; fetchShifts(); } };

        const formatDateTime = (value) => formatBusinessDateTime(value);

        return {
            shifts, isLoading, searchQuery, currentPage, totalPages, totalRecords,
            showModal, selectedShift, isClosing, actualCashInput,
            isLoadingShiftDetails, shiftDetailsError,
            showOpenModal, isOpening, eligibleCashiers, openShiftForm, openShiftCashEdited, isLoadingOpenShiftSuggestion,
            refreshOpenShiftSuggestion,
            openShiftModal, adminForceCloseShift, triggerOpenShift, submitOpenShift,
            isPrinting, printShiftReport, formatMoney, varianceInfo, fetchShifts, nextPage, prevPage,
            auditStatus, printAuditReport, fetchAuditStatus, refreshAll,
            filterDateFrom, filterDateTo, isPeriodMode, printPeriodReport,
            printItemsReport,
            printYReport, reopenYArchive, isYRestoring, yArchive, restoreYArchive,
            isEditingCash, newStartingCash, newActualCash, isUpdatingCash, cashEditError, beginCashEdit, updateShiftCash, applyVarianceSuggestion,
            selectedCashiers, selectedStatus, showCashierFilter, showStatusFilter,
            cashiers, toggleCashierFilter, clearAllFilters, showMobileFilters,
            formatDateTime, isRtl
        };
    }}
</script>

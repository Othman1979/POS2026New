<template>

        <div class="admin-data-page h-full min-h-0 flex flex-col font-sans animate-fade-in text-foreground bg-background">
            <header class="admin-grid-page-bar shrink-0">
                <div class="admin-grid-page-context">
                    <h2>{{ $t('Customers') }}</h2>
                    <span class="admin-grid-record-count"><span class="tabular-nums" data-no-i18n>{{ totalRecords }}</span> {{ $t('customers') }}</span>
                </div>
                <div class="admin-grid-page-actions">
                    <button @click="fetchCustomers" :aria-label="$t('Refresh')" class="admin-grid-icon-button" type="button">
                        <i class="fa-solid fa-rotate-right text-[10px]" aria-hidden="true"></i>
                    </button>
                    <button @click="openModal()" class="admin-grid-button admin-grid-button--primary" type="button">
                        <i class="fa-solid fa-plus text-[10px]" aria-hidden="true"></i>
                        <span>{{ $t('Add Customer') }}</span>
                    </button>
                </div>
            </header>

            <section class="admin-grid-command-bar shrink-0" :aria-label="$t('Search')">
                <div class="admin-grid-command-row">
                    <label class="admin-grid-search">
                        <span class="sr-only">{{ $t('Search name or phone') }}</span>
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input v-model="searchQuery" type="search" :placeholder="$t('Search name or phone')" autocomplete="off" />
                    </label>
                </div>
            </section>

            <section class="admin-grid-shell flex-1 min-h-0 flex flex-col relative">
                <div v-if="isLoading" class="absolute inset-0 bg-background/95 z-20 flex items-center justify-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-xl text-teal-700" aria-hidden="true"></i>
                </div>

                <div class="admin-grid-scroll hidden md:block overflow-x-auto overflow-y-auto flex-1">
                    <table class="admin-data-grid min-w-[780px]">
                        <thead class="sticky top-0 z-10">
                            <tr>
                                <th class="w-[31%]">{{ $t('Customer') }}</th>
                                <th class="w-[35%]">{{ $t('Contact') }}</th>
                                <th class="logical-text-end w-[12%]">{{ $t('Orders') }}</th>
                                <th class="logical-text-end w-[14%]">{{ $t('Total Spent') }}</th>
                                <th class="logical-text-end w-[8%]">{{ $t('Actions') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-if="customers.length === 0">
                                <td colspan="5" class="!h-44 text-center text-muted-foreground">
                                    <p class="text-sm font-semibold text-foreground">{{ $t('No customers found') }}</p>
                                </td>
                            </tr>
                            <tr v-for="c in customers" :key="c.id">
                                <td>
                                    <p class="admin-grid-primary-text" data-no-i18n>{{ c.name || $t('Unknown') }}</p>
                                    <p class="admin-grid-secondary-text"><span>{{ $t('ID') }}</span> <span class="tabular-nums" data-no-i18n>{{ c.id }}</span></p>
                                </td>
                                <td>
                                    <p class="admin-grid-primary-text !font-semibold tabular-nums" data-no-i18n>{{ c.phone || $t('No Phone') }}</p>
                                    <p v-if="c.address" class="admin-grid-secondary-text max-w-xs" :title="c.address" data-no-i18n>{{ c.address }}</p>
                                </td>
                                <td class="logical-text-end">
                                    <span class="font-semibold tabular-nums" data-no-i18n>{{ c.total_orders || 0 }}</span>
                                </td>
                                <td class="logical-text-end" data-no-i18n>
                                    <span class="admin-grid-money">{{ Number(c.total_spent || 0).toFixed(2) }} JD</span>
                                </td>
                                <td class="logical-text-end">
                                    <div class="admin-grid-row-actions">
                                        <button @click="openModal(c)" :aria-label="$t('Edit')" type="button">
                                            <i class="fa-solid fa-pen" aria-hidden="true"></i>
                                        </button>
                                        <button @click="deleteCustomer(c.id)" :aria-label="$t('Delete')" class="is-danger" type="button">
                                            <i class="fa-solid fa-trash" aria-hidden="true"></i>
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="admin-grid-mobile-list admin-grid-scroll block md:hidden overflow-y-auto flex-1">
                    <div v-if="customers.length === 0" class="py-20 text-center bg-card">
                        <p class="font-semibold text-sm text-foreground">{{ $t('No customers found') }}</p>
                    </div>

                    <article v-for="c in customers" :key="c.id" class="admin-grid-mobile-card">
                        <div class="flex items-start justify-between gap-4">
                            <div class="min-w-0">
                                <p class="admin-grid-primary-text !text-sm" data-no-i18n>{{ c.name || $t('Unknown') }}</p>
                                <p class="admin-grid-secondary-text"><span>{{ $t('ID') }}</span> <span class="tabular-nums" data-no-i18n>{{ c.id }}</span></p>
                            </div>
                            <p class="admin-grid-money shrink-0" data-no-i18n>{{ Number(c.total_spent || 0).toFixed(2) }} JD</p>
                        </div>

                        <div class="grid grid-cols-2 gap-4 border-t border-zinc-200 mt-3 pt-3">
                            <div class="min-w-0">
                                <p class="text-[10px] font-semibold text-muted-foreground">{{ $t('Contact') }}</p>
                                <p class="text-xs font-semibold text-foreground mt-1 truncate tabular-nums" data-no-i18n>{{ c.phone || $t('No Phone') }}</p>
                                <p v-if="c.address" class="text-[10px] text-muted-foreground mt-0.5 truncate" :title="c.address" data-no-i18n>{{ c.address }}</p>
                            </div>
                            <div class="text-end">
                                <p class="text-[10px] font-semibold text-muted-foreground">{{ $t('Orders') }}</p>
                                <p class="text-[10px] text-muted-foreground mt-0.5"><span class="tabular-nums" data-no-i18n>{{ c.total_orders || 0 }}</span> {{ $t('Orders') }}</p>
                            </div>
                        </div>
                        <div class="admin-grid-mobile-actions">
                            <button @click="openModal(c)" class="admin-grid-mobile-action" type="button"><i class="fa-solid fa-pen text-[10px]" aria-hidden="true"></i><span>{{ $t('Edit') }}</span></button>
                            <button @click="deleteCustomer(c.id)" class="admin-grid-mobile-action is-danger" type="button"><i class="fa-solid fa-trash text-[10px]" aria-hidden="true"></i><span>{{ $t('Delete') }}</span></button>
                        </div>
                    </article>
                </div>

                <footer class="admin-grid-pagination shrink-0 mt-auto">
                    <div class="admin-grid-pagination-summary hidden sm:flex"><p><strong class="tabular-nums" data-no-i18n>{{ customers.length }}</strong> {{ $t('of') }} <strong class="tabular-nums" data-no-i18n>{{ totalRecords }}</strong> {{ $t('customers') }}</p></div>
                    <div class="admin-grid-pagination-controls w-full sm:w-auto justify-between sm:justify-end">
                        <button @click="prevPage" :disabled="currentPage === 1" :aria-label="$t('Prev')" type="button"><i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']" aria-hidden="true"></i></button>
                        <span>{{ $t('Page') }} <strong class="tabular-nums" data-no-i18n>{{ currentPage }}</strong> / <span class="tabular-nums" data-no-i18n>{{ totalPages || 1 }}</span></span>
                        <button @click="nextPage" :disabled="currentPage === totalPages || totalPages === 0" :aria-label="$t('Next')" type="button"><i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']" aria-hidden="true"></i></button>
                    </div>
                </footer>
            </section>

            <div v-if="showModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div class="bg-card rounded-xl shadow-2xl w-full max-w-md overflow-hidden border border-border flex flex-col max-h-[95vh] relative animate-in zoom-in-95 duration-150">
                    <div class="px-6 py-4 border-b border-zinc-200 flex justify-between items-center shrink-0">
                        <h3 class="font-display font-semibold text-foreground text-base tracking-tight">
                            {{ isEditing ? $t('Edit Customer') : $t('New Customer') }}
                        </h3>
                        <button @click="showModal = false" :aria-label="$t('Close')" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition-colors">
                            <i class="fa-solid fa-xmark text-lg"></i>
                        </button>
                    </div>

                    <form @submit.prevent="saveCustomer" class="flex-1 flex flex-col">
                        <div class="p-6 space-y-4">

                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Mobile Phone *') }}</label>
                                    <input v-model="form.phone" type="text" required placeholder="07..." class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Full Name *') }}</label>
                                    <input v-model="form.name" type="text" required :placeholder="$t('Customer name')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground">
                                </div>
                            </div>

                            <div>
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Delivery Address') }}</label>
                                <textarea v-model="form.address" rows="2" :placeholder="$t('Street, Building, Apt...')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground resize-none"></textarea>
                            </div>
                        </div>

                        <div class="p-4 border-t border-zinc-200 bg-muted flex justify-end gap-2.5 shrink-0">
                            <button type="button" @click="showModal = false" class="h-9 px-4 bg-card border border-zinc-300 text-foreground font-medium rounded-lg hover:bg-zinc-200 transition-colors text-xs">{{ $t('Cancel') }}</button>
                            <button type="submit" class="h-9 px-4 bg-teal-600 text-white hover:bg-teal-700 font-medium rounded-lg transition-colors text-xs">
                                {{ isEditing ? $t('Save Changes') : $t('Save Customer') }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

        </div>
    
</template>

<script>
import { fetchJson } from '@/shared/http.js';
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { t, currentLanguage } from '@/shared/i18n.js';

export default {
    setup() {
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const customers = ref([]);
        const isLoading = ref(false);
        const searchQuery = ref('');
        const currentPage = ref(1);
        const totalPages = ref(1);
        const totalRecords = ref(0);
        const limit = ref(50);
        let searchDebounceTimer = null;

        const showModal = ref(false);
        const isEditing = ref(false);
        const form = ref({ id: null, name: '', phone: '', address: '' });

        const fetchCustomers = async () => {
            isLoading.value = true;
            try {
                const params = new URLSearchParams({
                    page: String(currentPage.value),
                    limit: String(limit.value)
                });
                if (searchQuery.value.trim()) params.set('search', searchQuery.value.trim());

                const data = await fetchJson(`api/admin/customers?${params.toString()}`);
                if (data.success) {
                    customers.value = data.customers;
                    if (data.pagination) {
                        totalPages.value = data.pagination.total_pages;
                        totalRecords.value = data.pagination.total;
                    }
                }
            } catch (e) {
                console.error("Failed to load customers", e);
            } finally {
                isLoading.value = false;
            }
        };

        onMounted(() => fetchCustomers());
        onUnmounted(() => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        });

        watch(searchQuery, () => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                currentPage.value = 1;
                fetchCustomers();
            }, 300);
        });


        const nextPage = () => {
            if (currentPage.value < totalPages.value) {
                currentPage.value++;
                fetchCustomers();
            }
        };
        const prevPage = () => {
            if (currentPage.value > 1) {
                currentPage.value--;
                fetchCustomers();
            }
        };

        const openModal = (customer = null) => {
            if (customer) {
                isEditing.value = true;
                form.value = { ...customer };
            } else {
                isEditing.value = false;
                form.value = { id: null, name: '', phone: '', address: '' };
            }
            showModal.value = true;
        };


        const saveCustomer = async () => {
            if (!form.value.name || !form.value.phone) {
                await window.showAdminAlert(t("Name and Phone are required."));
                return;
            }
            
            const isEdit = isEditing.value;
            const backupCustomers = [...customers.value];
            const backupTotal = totalRecords.value;
            const tempId = isEdit ? form.value.id : 'temp-cust-' + Date.now();

            // Optimistic update
            if (isEdit) {
                const index = customers.value.findIndex(c => c.id === form.value.id);
                if (index !== -1) {
                    customers.value[index] = {
                        ...customers.value[index],
                        name: form.value.name,
                        phone: form.value.phone,
                        address: form.value.address
                    };
                }
            } else {
                customers.value.unshift({
                    id: tempId,
                    name: form.value.name,
                    phone: form.value.phone,
                    address: form.value.address,
                    total_orders: 0,
                    total_spent: 0
                });
                totalRecords.value++;
            }

            showModal.value = false;
            window.showAdminToast(isEdit ? t("Customer updated successfully.") : t("Customer created successfully."), "success");

            const method = isEdit ? 'PUT' : 'POST';
            try {
                const data = await fetchJson('api/admin/customers', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(form.value)
                });
                
                if (data.success) {
                    if (!isEdit) {
                        const index = customers.value.findIndex(c => c.id === tempId);
                        if (index !== -1) {
                            customers.value[index].id = data.id;
                        }
                    }
                } else {
                    customers.value = backupCustomers;
                    totalRecords.value = backupTotal;
                    showModal.value = true;
                    await window.showAdminAlert(data.message || t("Action failed."));
                }
            } catch (e) {
                customers.value = backupCustomers;
                totalRecords.value = backupTotal;
                showModal.value = true;
                await window.showAdminAlert(t("Network error."));
            }
        };

        const deleteCustomer = async (id) => {
            if (!await window.showAdminConfirm(t("Are you sure you want to delete this customer?"))) return;
            
            const backupCustomers = [...customers.value];
            const backupTotal = totalRecords.value;

            customers.value = customers.value.filter(c => c.id !== id);
            totalRecords.value = Math.max(0, totalRecords.value - 1);
            window.showAdminToast(t("Customer removed successfully."), "success");

            try {
                const data = await fetchJson('api/admin/customers', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                });
                
                if (!data.success) {
                    customers.value = backupCustomers;
                    totalRecords.value = backupTotal;
                    window.showAdminAlert(data.message || t("Failed to delete customer."));
                }
            } catch (e) {
                customers.value = backupCustomers;
                totalRecords.value = backupTotal;
                window.showAdminAlert(t("Network error."));
            }
        };

        return {
            customers, isLoading, searchQuery,
            currentPage, totalPages, totalRecords, nextPage, prevPage,
            showModal, isEditing, form, openModal, saveCustomer, deleteCustomer, isRtl
        };
    }}
</script>

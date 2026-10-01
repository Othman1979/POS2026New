<template>

        <div class="h-full flex flex-col font-sans animate-fade-in text-foreground bg-background space-y-5 pb-6">

            <!-- Toolbar -->
            <div class="bg-card border border-zinc-300 rounded-xl flex flex-col gap-3.5 shrink-0 p-4">
                <!-- Row 1: Search and Core Actions -->
                <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 w-full">
                    <!-- Search -->
                    <div class="relative w-full lg:max-w-md">
                        <i class="fa-solid fa-magnifying-glass absolute logical-start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none"></i>
                        <input v-model="searchQuery" type="text" :placeholder="$t('Search name, role or PIN')" class="w-full h-9 bg-muted border border-zinc-300 rounded-lg logical-ps-9 logical-pe-3 text-xs font-medium text-foreground placeholder:text-muted-foreground outline-none focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all"/>
                    </div>

                    <!-- Actions -->
                    <div class="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-between lg:justify-end w-full lg:w-auto shrink-0">
                        <!-- Mobile Filters Toggle -->
                        <button @click="showMobileFilters = !showMobileFilters" :class="[showMobileFilters ? 'bg-teal-600 text-white border-teal-600' : 'bg-muted border-zinc-300 text-foreground hover:bg-zinc-200']" class="md:hidden h-9 px-3 border rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 shrink-0" type="button">
                            <i class="fa-solid fa-sliders"></i>
                            <span>{{ $t('Filters') }}</span>
                            <span v-if="selectedRoles.length > 0 || selectedSections.length > 0" class="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block"></span>
                        </button>

                        <div class="flex items-center gap-2">
                            <!-- Add User Button -->
                            <button @click="openModal(null)" class="h-9 px-3 bg-teal-600 text-white hover:bg-teal-700 font-medium rounded-lg transition-colors text-xs flex items-center justify-center gap-1.5">
                                <i class="fa-solid fa-plus text-[10px]"></i> <span>{{ $t('Add User') }}</span>
                            </button>
                            <!-- Reset Filters -->
                            <button @click="clearAllFilters" class="h-9 px-3 bg-muted border border-zinc-300 hover:bg-zinc-200 text-foreground rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                                <i class="fa-solid fa-arrow-rotate-left text-[10px]"></i>
                                <span>{{ $t('Reset') }}</span>
                            </button>
                            <!-- Refresh -->
                            <button @click="fetchUsersAndSections" :aria-label="$t('Refresh')" class="h-9 w-9 flex items-center justify-center bg-muted border border-zinc-300 hover:bg-zinc-200 text-foreground rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                                <i class="fa-solid fa-rotate-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Row 2: Filters -->
                <div :class="[showMobileFilters ? 'flex' : 'hidden md:flex']" class="flex-col md:flex-row md:items-center justify-start gap-2 border-t border-zinc-200 pt-3.5 flex-wrap w-full">
                    <!-- Role Filter -->
                    <div class="relative">
                        <button @click="showRoleFilter = !showRoleFilter; showSectionFilter = false;" :class="[selectedRoles.length > 0 ? 'border-teal-500 bg-teal-100 text-teal-700' : 'border-zinc-300 bg-muted text-foreground hover:bg-zinc-200']" class="h-9 px-3 border rounded-lg text-xs font-medium flex items-center justify-between gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 w-full sm:w-auto" type="button">
                            <span class="flex items-center gap-1.5">
                                <i class="fa-solid fa-user-shield text-[11px] opacity-70"></i>
                                <span>{{ $t('Role') }}</span>
                            </span>
                            <span v-if="selectedRoles.length > 0" class="bg-teal-600 text-white px-1.5 rounded text-[10px] font-semibold tabular-nums logical-ms-1" data-no-i18n>{{ selectedRoles.length }}</span>
                            <i class="fa-solid fa-chevron-down text-[9px] opacity-50 logical-ms-1"></i>
                        </button>
                        <div v-if="showRoleFilter" @click="showRoleFilter = false" class="fixed inset-0 z-40"></div>
                        <div v-if="showRoleFilter" class="absolute logical-start-0 mt-1.5 w-48 bg-popover text-popover-foreground border border-border rounded-lg shadow-md z-50 p-1 flex flex-col gap-0.5 animate-in fade-in zoom-in-95 duration-100">
                            <button v-for="role in ['admin', 'cashier', 'waiter', 'call_center']" :key="role" @click="toggleRoleFilter(role)" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 w-full">
                                <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedRoles.includes(role) ? 'fa-solid fa-check' : ''"></i>
                                <span>{{ $t(role) }}</span>
                            </button>
                            <div v-if="selectedRoles.length > 0" class="border-t border-border mt-1 pt-1">
                                <button @click="selectedRoles = []; showRoleFilter = false" class="w-full text-center text-[10px] py-1 font-semibold hover:bg-muted text-destructive rounded-md">
                                    {{ $t('Clear filters') }}
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Section Filter -->
                    <div class="relative">
                        <button @click="showSectionFilter = !showSectionFilter; showRoleFilter = false;" :class="[selectedSections.length > 0 ? 'border-teal-500 bg-teal-100 text-teal-700' : 'border-zinc-300 bg-muted text-foreground hover:bg-zinc-200']" class="h-9 px-3 border rounded-lg text-xs font-medium flex items-center justify-between gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 w-full sm:w-auto" type="button">
                            <span class="flex items-center gap-1.5">
                                <i class="fa-solid fa-map-location-dot text-[11px] opacity-70"></i>
                                <span>{{ $t('Sections') }}</span>
                            </span>
                            <span v-if="selectedSections.length > 0" class="bg-teal-600 text-white px-1.5 rounded text-[10px] font-semibold tabular-nums logical-ms-1" data-no-i18n>{{ selectedSections.length }}</span>
                            <i class="fa-solid fa-chevron-down text-[9px] opacity-50 logical-ms-1"></i>
                        </button>
                        <div v-if="showSectionFilter" @click="showSectionFilter = false" class="fixed inset-0 z-40"></div>
                        <div v-if="showSectionFilter" class="absolute logical-start-0 mt-1.5 w-56 bg-popover text-popover-foreground border border-border rounded-lg shadow-md z-50 p-1 flex flex-col gap-0.5 max-h-60 overflow-y-auto premium-scroll animate-in fade-in zoom-in-95 duration-100">
                            <button v-for="sec in sections" :key="sec.id" @click="toggleSectionFilter(sec.id)" class="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-md hover:bg-muted text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 w-full">
                                <i class="w-3.5 text-[10px] text-teal-600 flex items-center justify-center" :class="selectedSections.includes(sec.id) ? 'fa-solid fa-check' : ''"></i>
                                <span data-no-i18n>{{ sec.name }}</span>
                            </button>
                            <div v-if="selectedSections.length > 0" class="border-t border-border mt-1 pt-1">
                                <button @click="selectedSections = []; showSectionFilter = false" class="w-full text-center text-[10px] py-1 font-semibold hover:bg-muted text-destructive rounded-md">
                                    {{ $t('Clear filters') }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Active Filters List -->
            <div v-if="searchQuery || selectedRoles.length > 0 || selectedSections.length > 0" class="flex flex-wrap items-center gap-2 px-1">
                <span class="text-xs text-muted-foreground logical-me-1.5">{{ $t('Active Filters:') }}</span>

                <span v-if="searchQuery" class="inline-flex items-center gap-1 px-2 py-1 bg-muted text-foreground text-xs rounded-md border border-zinc-200">
                    <span>{{ $t('Search:') }} "{{ searchQuery }}"</span>
                    <button @click="searchQuery = ''" class="hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <span v-for="r in selectedRoles" :key="r" class="inline-flex items-center gap-1 px-2 py-1 bg-muted text-foreground text-xs rounded-md border border-zinc-200">
                    <span>{{ $t(r) }}</span>
                    <button @click="toggleRoleFilter(r)" class="hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <span v-for="secId in selectedSections" :key="secId" class="inline-flex items-center gap-1 px-2 py-1 bg-muted text-foreground text-xs rounded-md border border-zinc-200">
                    <span data-no-i18n>{{ sections.find(s => s.id === secId)?.name || secId }}</span>
                    <button @click="toggleSectionFilter(secId)" class="hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"><i class="fa-solid fa-xmark text-[10px] logical-ms-1"></i></button>
                </span>

                <button @click="clearAllFilters" class="text-xs font-semibold text-destructive hover:bg-destructive/10 px-2.5 py-1 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                    {{ $t('Reset') }}
                </button>
            </div>

            <!-- Main Content Grid -->
            <div class="bg-card border border-zinc-300 rounded-xl overflow-hidden flex-1 flex flex-col relative">
                <div v-if="isLoading" class="absolute inset-0 bg-background/85 z-30 flex items-center justify-center">
                    <i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-600"></i>
                </div>

                <!-- Desktop Table View (md and above) -->
                <div class="hidden md:block overflow-x-auto overflow-y-auto premium-scroll flex-1">
                    <table class="w-full text-start min-w-[900px]">
                        <thead class="sticky top-0 bg-zinc-200/80 backdrop-blur border-b border-zinc-300 z-10">
                            <tr>
                                <th class="py-3 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('User') }}</th>
                                <th class="py-3 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Role') }}</th>
                                <th class="py-3 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Permissions') }}</th>
                                <th class="py-3 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Sections') }}</th>
                                <th class="py-3 px-5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end">{{ $t('Actions') }}</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-zinc-200 bg-card text-foreground">
                            <tr v-if="filteredUsers.length === 0">
                                <td colspan="5" class="py-24 text-center text-muted-foreground">
                                    <div class="flex flex-col items-center justify-center">
                                        <i class="fa-solid fa-users-slash text-3xl mb-3 opacity-40"></i>
                                        <p class="font-medium text-sm">{{ $t('No users found') }}</p>
                                    </div>
                                </td>
                            </tr>
                            <tr v-for="user in filteredUsers" :key="user.id" class="even:bg-muted/50 hover:bg-teal-50/60 transition-colors">
                                <td class="py-3 px-5">
                                    <div class="flex items-center gap-3">
                                        <div class="w-9 h-9 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center font-semibold text-sm uppercase shrink-0">
                                            {{ user.name ? user.name.charAt(0).toUpperCase() : 'U' }}
                                        </div>
                                        <div>
                                            <p class="font-semibold text-foreground text-sm flex items-center gap-2">
                                                <span data-no-i18n>{{ user.name }}</span>
                                                <span v-if="user.id == activeUserId" class="bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider">{{ $t('You') }}</span>
                                            </p>
                                            <p class="text-[10px] font-medium text-muted-foreground mt-0.5 flex items-center gap-1.5">
                                                <span>{{ $t('PIN') }}</span>
                                                <span data-no-i18n class="font-semibold tabular-nums">{{ isPinVisible(user.id) ? user.user_number : '••••' }}</span>
                                                <button @click="togglePinVisibility(user.id)" :aria-label="$t('Toggle PIN')" class="text-muted-foreground hover:text-foreground p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                                                    <i class="fa-solid" :class="isPinVisible(user.id) ? 'fa-eye-slash' : 'fa-eye'"></i>
                                                </button>
                                            </p>
                                        </div>
                                    </div>
                                </td>
                                <td class="py-3 px-5">
                                    <span v-if="user.role === 'admin'" class="inline-flex items-center gap-1.5 bg-muted text-foreground px-2.5 py-1 rounded-md text-[11px] font-medium"><i class="fa-solid fa-crown text-[10px] text-amber-500"></i> {{ $t('Admin') }}</span>
                                    <span v-else-if="user.role === 'cashier'" class="inline-flex items-center gap-1.5 bg-muted text-foreground px-2.5 py-1 rounded-md text-[11px] font-medium"><i class="fa-solid fa-cash-register text-[10px] opacity-60"></i> {{ $t('Cashier') }}</span>
                                    <span v-else-if="user.role === 'waiter'" class="inline-flex items-center gap-1.5 bg-muted text-foreground px-2.5 py-1 rounded-md text-[11px] font-medium"><i class="fa-solid fa-bell-concierge text-[10px] opacity-60"></i> {{ $t('Waiter') }}</span>
                                    <span v-else-if="user.role === 'call_center'" class="inline-flex items-center gap-1.5 bg-muted text-foreground px-2.5 py-1 rounded-md text-[11px] font-medium"><i class="fa-solid fa-headset text-[10px] opacity-60"></i> {{ $t('Call Center') }}</span>
                                </td>
                                <td class="py-3 px-5 text-center">
                                    <div v-if="user.role === 'admin' || user.role === 'programmer'" class="text-[10px] font-medium text-teal-700">{{ $t('Full Access') }}</div>
                                    <div v-else-if="user.role === 'call_center'" class="text-[10px] font-medium text-muted-foreground">{{ $t('Fixed role') }}</div>
                                    <div v-else class="text-[10px] font-medium text-foreground">
                                        <span class="tabular-nums" data-no-i18n>{{ (user.permissions || []).length }}</span> {{ $t('permissions') }}
                                    </div>
                                </td>
                                <td class="py-3 px-5 text-center">
                                    <span v-if="user.role === 'admin' || user.role === 'programmer' || user.table_access_scope === 'all'" class="text-[10px] font-medium text-teal-700">{{ $t('All sections') }}</span>
                                    <span v-else-if="user.role === 'call_center'" class="text-[10px] font-medium text-muted-foreground">{{ $t('Fixed role') }}</span>
                                    <span v-else-if="user.table_access_scope !== 'selected' || !user.allowed_sections" class="text-[10px] font-medium text-destructive bg-destructive/10 px-2 py-0.5 rounded">{{ $t('No sections') }}</span>
                                    <span v-else class="bg-muted text-foreground px-2 py-0.5 rounded-md text-[11px] font-medium">
                                        <span class="tabular-nums" data-no-i18n>{{ user.allowed_sections.split(',').length }}</span> {{ $t('sections') }}
                                    </span>
                                </td>
                                <td class="py-3 px-5 text-end">
                                    <div class="flex justify-end gap-1">
                                        <button @click="openModal(user)" :aria-label="$t('Edit')" class="w-8 h-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[10px]"></i></button>
                                        <button @click="deleteUser(user.id)" :disabled="user.id == 1 || user.id == activeUserId" :aria-label="$t('Delete')" :class="['w-8 h-8 rounded-md flex items-center justify-center transition-colors text-[10px]', user.id == 1 || user.id == activeUserId ? 'text-muted-foreground/30 cursor-not-allowed' : 'text-muted-foreground hover:bg-rose-100 hover:text-rose-600']"><i class="fa-solid fa-trash"></i></button>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Mobile Card List View (Visible under md) -->
                <div class="block md:hidden overflow-y-auto premium-scroll flex-1 p-4 space-y-3 bg-muted/10">
                    <div v-if="filteredUsers.length === 0" class="py-20 text-center bg-card border border-zinc-300 rounded-xl">
                        <div class="flex flex-col items-center justify-center text-muted-foreground">
                            <i class="fa-solid fa-users-slash text-3xl mb-3 opacity-40"></i>
                            <span class="font-medium text-sm">{{ $t('No users found') }}</span>
                        </div>
                    </div>

                    <div v-for="user in filteredUsers" :key="user.id" class="bg-card border border-zinc-300 rounded-xl p-4 transition-transform active:scale-[0.99] flex flex-col gap-3">
                        <div class="flex justify-between items-start gap-3">
                            <div class="flex items-center gap-3 min-w-0">
                                <div class="w-10 h-10 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center font-semibold text-base uppercase shrink-0">
                                    {{ user.name ? user.name.charAt(0).toUpperCase() : 'U' }}
                                </div>
                                <div class="min-w-0">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span class="font-semibold text-foreground text-sm" data-no-i18n>{{ user.name }}</span>
                                        <span v-if="user.id == activeUserId" class="bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider">{{ $t('You') }}</span>
                                    </div>
                                    <div class="text-[10px] text-muted-foreground mt-1 flex items-center gap-1.5">
                                        <span>{{ $t('PIN') }}</span>
                                        <span data-no-i18n class="font-semibold tabular-nums">{{ isPinVisible(user.id) ? user.user_number : '••••' }}</span>
                                        <button @click="togglePinVisibility(user.id)" :aria-label="$t('Toggle PIN')" class="text-muted-foreground hover:text-foreground p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                                            <i class="fa-solid" :class="isPinVisible(user.id) ? 'fa-eye-slash' : 'fa-eye'"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div class="flex justify-end gap-1 shrink-0 -me-1 -mt-1">
                                <button @click="openModal(user)" :aria-label="$t('Edit')" class="w-8 h-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[10px]"></i></button>
                                <button @click="deleteUser(user.id)" :disabled="user.id == 1 || user.id == activeUserId" :aria-label="$t('Delete')" :class="['w-8 h-8 rounded-md flex items-center justify-center transition-colors', user.id == 1 || user.id == activeUserId ? 'text-muted-foreground/30 cursor-not-allowed' : 'text-muted-foreground hover:bg-rose-100 hover:text-rose-600']"><i class="fa-solid fa-trash text-[10px]"></i></button>
                            </div>
                        </div>

                        <!-- Role + sections -->
                        <div class="text-[10px] text-muted-foreground border-t border-zinc-200 pt-2 flex flex-col gap-1.5">
                            <div class="flex items-center justify-between">
                                <span class="font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('Role') }}</span>
                                <div>
                                    <span v-if="user.role === 'admin'" class="inline-flex items-center gap-1 bg-muted text-foreground px-2 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-crown text-amber-500"></i> {{ $t('Admin') }}</span>
                                    <span v-else-if="user.role === 'cashier'" class="inline-flex items-center gap-1 bg-muted text-foreground px-2 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-cash-register opacity-60"></i> {{ $t('Cashier') }}</span>
                                    <span v-else-if="user.role === 'waiter'" class="inline-flex items-center gap-1 bg-muted text-foreground px-2 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-bell-concierge opacity-60"></i> {{ $t('Waiter') }}</span>
                                    <span v-else-if="user.role === 'call_center'" class="inline-flex items-center gap-1 bg-muted text-foreground px-2 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-headset opacity-60"></i> {{ $t('Call Center') }}</span>
                                </div>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('Sections') }}</span>
                                <div>
                                    <span v-if="user.role === 'admin' || user.role === 'programmer' || user.table_access_scope === 'all'" class="text-[10px] font-medium text-teal-700">{{ $t('All sections') }}</span>
                                    <span v-else-if="user.role === 'call_center'" class="text-[10px] font-medium text-muted-foreground">{{ $t('Fixed role') }}</span>
                                    <span v-else-if="user.table_access_scope !== 'selected' || !user.allowed_sections" class="text-[10px] font-medium text-destructive bg-destructive/10 px-2 py-0.5 rounded">{{ $t('No sections') }}</span>
                                    <span v-else class="bg-muted text-foreground px-2 py-0.5 rounded text-[10px] font-medium">
                                        <span class="tabular-nums" data-no-i18n>{{ user.allowed_sections.split(',').length }}</span> {{ $t('sections') }}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <!-- Permissions -->
                        <div v-if="user.role !== 'admin' && user.role !== 'programmer' && user.role !== 'call_center'" class="text-[10px] text-muted-foreground border-t border-zinc-200 pt-2 flex items-center justify-between">
                            <span class="font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('Permissions') }}</span>
                            <div class="font-medium text-foreground">
                                <span class="tabular-nums" data-no-i18n>{{ (user.permissions || []).length }}</span> {{ $t('permissions') }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Create / Edit User Modal -->
            <div v-if="showModal" @click.self="showModal = false" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div role="dialog" aria-modal="true" aria-labelledby="userModalTitle" class="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl overflow-hidden animate-scale-in flex flex-col max-h-[90vh]">
                    <div class="px-6 py-4 border-b border-zinc-200 flex items-center justify-between shrink-0">
                        <h3 id="userModalTitle" class="font-display font-semibold text-foreground text-base tracking-tight">
                            {{ isEditing ? $t('Edit User') : $t('Add New User') }}
                        </h3>
                        <button @click="showModal = false" :aria-label="$t('Close')" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition-colors"><i class="fa-solid fa-xmark text-lg"></i></button>
                    </div>

                    <div class="overflow-y-auto premium-scroll flex-1 min-h-0">
                    <fieldset :disabled="isSaving" class="p-6 space-y-5 text-xs min-w-0">

                        <div v-if="editConflict" role="alert" class="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
                            <p>{{ $t('This user was changed elsewhere. Reload the user before saving again.') }}</p>
                            <button type="button" @click="reloadEditedUser" :disabled="isSaving" class="mt-2 h-10 rounded-lg border border-amber-600 px-3 font-medium">{{ $t('Load saved version') }}</button>
                        </div>

                        <div v-if="uncertainSave" role="alert" class="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
                            <p>{{ $t('The save response was lost. Check the saved user before trying again.') }}</p>
                            <button type="button" @click="checkSavedUser" :disabled="isSaving" class="mt-2 h-11 rounded-lg border border-amber-600 px-3 font-medium">{{ $t('Check saved user') }}</button>
                        </div>

                        <div>
                            <label for="user-full-name" class="block text-xs font-semibold text-muted-foreground mb-1.5">{{ $t('Full name') }}</label>
                            <input id="user-full-name" type="text" v-model="form.name" :placeholder="$t('Employee name')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9">
                        </div>

                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label for="user-login-pin" class="block text-xs font-semibold text-muted-foreground mb-1.5">{{ $t('PIN code') }}</label>
                                <input id="user-login-pin" type="text" v-model="form.user_number" placeholder="1234" maxlength="8" inputmode="numeric" pattern="[0-9]*" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                            </div>
                            <div>
                                <label for="user-role" class="block text-xs font-semibold text-muted-foreground mb-1.5">{{ $t('Role') }}</label>
                                <select id="user-role" v-model="form.role" @change="handleRoleChange" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option value="cashier">{{ $t('Cashier') }}</option>
                                    <option value="waiter">{{ $t('Waiter') }}</option>
                                    <option value="call_center">{{ $t('Call Center') }}</option>
                                    <option value="admin">{{ $t('Admin') }}</option>
                                </select>
                            </div>
                        </div>

                        <!-- Manager Override PIN (admins only) -->
                        <div v-if="hasGodMode">
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Manager Override PIN') }}</label>
                            <input type="text" v-model="form.admin_override_pin" maxlength="8" inputmode="numeric" pattern="[0-9]*" :placeholder="isEditing ? $t('Leave blank to keep current') : $t('Optional')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                            <p class="text-[10px] text-muted-foreground mt-1.5">{{ $t('Used to approve manager overrides at the register.') }}</p>
                        </div>

                        <div v-if="!hasGodMode && !isFixedRole" class="border-t border-border pt-4 space-y-3">
                            <p v-if="roleChanged" class="text-sm text-muted-foreground" role="status">{{ $t('Role changed. Review permissions and table access before saving.') }}</p>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label for="user-table-scope" class="block text-sm font-semibold mb-1.5">{{ $t('Table sections') }}</label>
                                    <select id="user-table-scope" v-model="form.table_access_scope" class="h-11 w-full border border-border rounded-lg bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary">
                                        <option value="all">{{ $t('All sections') }}</option>
                                        <option value="selected">{{ $t('Selected sections') }}</option>
                                        <option value="none">{{ $t('No table access') }}</option>
                                    </select>
                                </div>
                                <div>
                                    <label for="user-permission-preset" class="block text-sm font-semibold mb-1.5">{{ $t('Permission preset') }}</label>
                                    <select id="user-permission-preset" v-model="selectedPreset" @change="applyPreset" :disabled="!permissionReady" class="h-11 w-full border border-border rounded-lg bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
                                        <option value="custom">{{ $t('Custom permissions') }}</option>
                                        <option v-if="form.role==='cashier'" value="cashier">{{ $t('Cashier') }}</option>
                                        <option v-if="form.role==='cashier'" value="cashier_tables">{{ $t('Cashier with table service') }}</option>
                                        <option v-if="form.role==='waiter'" value="waiter">{{ $t('Waiter') }}</option>
                                    </select>
                                </div>
                            </div>
                            <p class="text-sm text-muted-foreground">{{ $t('Presets replace the selected permissions. Review the access preview before saving.') }}</p>
                            <div v-if="form.table_access_scope==='selected'" class="flex flex-wrap gap-2">
                                <button v-for="sec in sections" :key="sec.id" type="button" @click="toggleSection(sec.id)" :aria-pressed="form.allowed_sections.includes(sec.id)"
                                    :class="['h-11 px-3 rounded-lg border text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary', form.allowed_sections.includes(sec.id) ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted']">
                                    <span data-no-i18n>{{ sec.name }}</span>
                                </button>
                                <p v-if="!sectionSelectionValid" class="w-full text-sm text-muted-foreground" role="status">{{ $t('Select at least one existing section.') }}</p>
                            </div>
                        </div>

                        <p v-if="hasGodMode" class="text-sm text-muted-foreground">{{ $t('Administrators have full access. Individual permission switches do not restrict this role.') }}</p>
                        <p v-else-if="isFixedRole" class="text-sm text-muted-foreground">{{ $t('Call center users can prepare and send orders. They cannot take payment or access tables.') }}</p>
                        <template v-else>
                            <UserPermissions v-if="permissionReady" v-model="form.permissions" @update:model-value="onPermissionsChanged" :catalog="permissionCatalog" :role="form.role" :table-scope="form.table_access_scope" :section-ids="form.allowed_sections" />
                            <div v-else class="border-t border-border pt-4 text-sm" role="status">
                                <p>{{ isLoading ? $t('Loading permissions…') : $t('Permissions could not be loaded. Retry before saving this user.') }}</p>
                                <button v-if="!isLoading" type="button" @click="fetchUsersAndSections" class="h-11 mt-2 px-4 border border-border rounded-lg hover:bg-muted">{{ $t('Retry') }}</button>
                            </div>
                        </template>

                    </fieldset>
                    </div>

                    <div class="px-6 py-4 border-t border-zinc-200 flex justify-end gap-2.5 shrink-0 bg-muted">
                        <button @click="showModal = false" class="h-9 px-4 bg-card border border-zinc-300 text-foreground hover:bg-zinc-200 font-medium rounded-lg text-xs transition-colors flex items-center justify-center">
                            {{ $t('Cancel') }}
                        </button>
                        <button @click="saveUser" :disabled="isSaving || editConflict || uncertainSave || !sectionSelectionValid || (!permissionReady && !hasGodMode && !isFixedRole)" class="h-9 px-4 bg-teal-600 text-white font-medium rounded-lg hover:bg-teal-700 text-xs transition-colors flex items-center justify-center disabled:opacity-50">
                            {{ $t('Save') }}
                        </button>
                    </div>
                </div>
            </div>

        </div>
    
</template>

<script>
import { fetchJson, fetchJsonResponseWithTimeout } from '@/shared/http.js';
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { t } from '@/shared/i18n.js';
import UserPermissions from '@/admin/components/UserPermissions.vue';
import permissionPolicy from '@posapp/permission-policy';

export default {
    components: { UserPermissions },
    setup() {
        const users = ref([]);
        const sections = ref([]);
        const isLoading = ref(false);
        const searchQuery = ref('');
        const activeUserId = ref(null);

        // Filter states
        const selectedRoles = ref([]);
        const selectedSections = ref([]);
        const showRoleFilter = ref(false);
        const showSectionFilter = ref(false);
        const showMobileFilters = ref(false);

        // Visible PINs state
        const visiblePins = ref(new Set());

        const togglePinVisibility = (userId) => {
            if (visiblePins.value.has(userId)) {
                visiblePins.value.delete(userId);
            } else {
                visiblePins.value.add(userId);
            }
        };

        const isPinVisible = (userId) => {
            return visiblePins.value.has(userId);
        };

        // Modal state
        const showModal = ref(false);
        const isEditing = ref(false);
        const isSaving = ref(false);
        const editConflict = ref(false);
        const uncertainSave = ref(null);
        const selectedPreset = ref('cashier');
        const originalRole = ref('cashier');
        const form = ref({
            id: null,
            name: '',
            user_number: '',
            role: 'cashier',
            table_access_scope: 'all',
            permissions: [],
            allowed_sections: [],
            admin_override_pin: ''
        });

        const permissionCatalog = ref([]);
        const permissionReady = ref(false);
        let pendingPreset = null;
        let userReadGeneration = 0;

        const fetchUsersAndSections = async () => {
            const generation = ++userReadGeneration;
            isLoading.value = true;
            permissionReady.value = false;
            try {
                const data = await fetchJson('api/admin/users');
                if (generation !== userReadGeneration) return;
                if (data.success) {
                    users.value = data.users || [];
                    sections.value = data.sections || [];
                }

                const permData = await fetchJson('api/admin/permissions');
                if (generation !== userReadGeneration) return;
                if (permData.success) {
                    permissionCatalog.value = permData.catalog || [];
                    permissionReady.value = permissionCatalog.value.length > 0;
                    if (permissionReady.value && pendingPreset) {
                        if (!isEditing.value) form.value.permissions = permissionPolicy.presetPermissions(pendingPreset, permissionCatalog.value);
                        pendingPreset = null;
                    }
                }
            } catch (e) {
                console.error("Failed to load user list", e);
            } finally {
                if (generation === userReadGeneration) isLoading.value = false;
            }
        };

        const handleModalKeydown = (e) => {
            if (e.key === 'Escape' && showModal.value) showModal.value = false;
        };

        onMounted(() => {
            const userStr = sessionStorage.getItem('pos_user');
            if (userStr) {
                activeUserId.value = JSON.parse(userStr).id;
            }
            fetchUsersAndSections();
            window.addEventListener('keydown', handleModalKeydown);
        });

        onUnmounted(() => {
            window.removeEventListener('keydown', handleModalKeydown);
        });

        const filteredUsers = computed(() => {
            const query = searchQuery.value.toLowerCase().trim();
            return users.value.filter(u => {
                const matchesSearch = !query || 
                    (u.name && u.name.toLowerCase().includes(query)) ||
                    (u.user_number && u.user_number.toLowerCase().includes(query)) ||
                    (u.role && u.role.toLowerCase().includes(query));

                const matchesRole = selectedRoles.value.length === 0 || selectedRoles.value.includes(u.role);

                const matchesSection = selectedSections.value.length === 0 || 
                    u.role === 'admin' || 
                    u.role === 'programmer' ||
                    (() => {
                        const scope = permissionPolicy.getTableSectionIds(u);
                        if (scope === null) return true;
                        if (!scope.length) return false;
                        const userSecs = scope;
                        return selectedSections.value.some(secId => userSecs.includes(secId));
                    })();

                return matchesSearch && matchesRole && matchesSection;
            });
        });

        const hasGodMode = computed(() => {
            return form.value.role === 'admin' || form.value.role === 'programmer';
        });
        const isFixedRole = computed(() => form.value.role === 'call_center');

        const sectionSelectionValid = computed(() => hasGodMode.value || isFixedRole.value || form.value.table_access_scope !== 'selected' || form.value.allowed_sections.length > 0);
        const roleChanged = computed(() => isEditing.value && originalRole.value !== form.value.role);
        const applyPreset = () => {
            if (selectedPreset.value === 'custom') return;
            if (!permissionReady.value) { pendingPreset = selectedPreset.value; return; }
            form.value.permissions = permissionPolicy.presetPermissions(selectedPreset.value, permissionCatalog.value);
            pendingPreset = null;
        };
        const onPermissionsChanged = () => { selectedPreset.value = 'custom'; };
        const handleRoleChange = () => {
            form.value.admin_override_pin = '';
            selectedPreset.value = 'custom';
            pendingPreset = null;
            if (isFixedRole.value || hasGodMode.value) {
                form.value.permissions = [];
                form.value.allowed_sections = [];
                form.value.table_access_scope = isFixedRole.value ? 'none' : 'all';
            } else if (!isEditing.value) {
                selectedPreset.value = form.value.role === 'waiter' ? 'waiter' : 'cashier';
                form.value.allowed_sections = [];
                form.value.table_access_scope = form.value.role === 'waiter' ? 'none' : 'all';
                applyPreset();
            } else {
                form.value.permissions = form.value.permissions.filter(key => permissionPolicy.canAssignPermission(form.value.role, key));
            }
        };

        const toggleRoleFilter = (role) => {
            const idx = selectedRoles.value.indexOf(role);
            if (idx > -1) {
                selectedRoles.value.splice(idx, 1);
            } else {
                selectedRoles.value.push(role);
            }
        };

        const toggleSectionFilter = (id) => {
            const idx = selectedSections.value.indexOf(id);
            if (idx > -1) {
                selectedSections.value.splice(idx, 1);
            } else {
                selectedSections.value.push(id);
            }
        };

        const clearAllFilters = () => {
            searchQuery.value = '';
            selectedRoles.value = [];
            selectedSections.value = [];
            showMobileFilters.value = false;
        };

        const openModal = (user = null) => {
            if (isSaving.value) return;
            if (uncertainSave.value) { showModal.value = true; return; }
            editConflict.value = false;
            selectedPreset.value = user ? 'custom' : 'cashier';
            originalRole.value = user?.role || 'cashier';
            pendingPreset = !user && !permissionReady.value ? 'cashier' : null;
            if (user) {
                isEditing.value = true;
                form.value = {
                    id: user.id,
                    edit_version: user.edit_version,
                    name: user.name,
                    user_number: user.user_number,
                    role: user.role,
                    table_access_scope: user.table_access_scope || 'none',
                    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
                    allowed_sections: user.allowed_sections ? user.allowed_sections.split(',').map(Number) : [],
                    admin_override_pin: ''
                };
            } else {
                isEditing.value = false;
                form.value = {
                    id: null,
                    name: '',
                    user_number: '',
                    role: 'cashier',
                    table_access_scope: 'all',
                    permissions: permissionPolicy.presetPermissions('cashier', permissionCatalog.value),
                    allowed_sections: [],
                    admin_override_pin: ''
                };
            }
            showModal.value = true;
        };

        const toggleSection = (id) => {
            const index = form.value.allowed_sections.indexOf(id);
            if (index === -1) form.value.allowed_sections.push(id);
            else form.value.allowed_sections.splice(index, 1);
        };

        const saveUser = async () => {
            if (isSaving.value || editConflict.value || uncertainSave.value || !sectionSelectionValid.value) return;
            if (!permissionReady.value && !hasGodMode.value && !isFixedRole.value) {
                window.showAdminAlert(t("Permissions could not be loaded. Retry before saving this user."));
                return;
            }
            if (!form.value.name || !form.value.user_number) {
                window.showAdminAlert(t("Name and PIN are required."));
                return;
            }

            const isCallCenter = form.value.role === 'call_center';
            const payload = {
                ...form.value,
                permissions: isCallCenter ? [] : form.value.permissions,
                table_access_scope: isCallCenter ? 'none' : hasGodMode.value ? 'all' : form.value.table_access_scope,
                allowed_sections: !isCallCenter && form.value.table_access_scope === 'selected' ? form.value.allowed_sections.join(',') : ''
            };

            const isEdit = isEditing.value;
            userReadGeneration++;
            isLoading.value = false;
            isSaving.value = true;
            const method = isEdit ? 'PUT' : 'POST';
            try {
                const { data } = await fetchJsonResponseWithTimeout('api/admin/users', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (data.success) {
                    const saved = { ...(data.user || payload), id: isEdit ? payload.id : data.id, edit_version: data.edit_version, admin_override_pin: '', is_active: 1 };
                    form.value.admin_override_pin = '';
                    if (isEdit) users.value = users.value.map(user => user.id === payload.id ? saved : user);
                    else users.value.push(saved);
                    showModal.value = false;
                    window.showAdminToast(isEdit ? t("User updated.") : t("User created."), "success");
                } else {
                    editConflict.value = data.code === 'USER_EDIT_CONFLICT';
                    showModal.value = true;
                    if (!editConflict.value) window.showAdminAlert(t(data.message || "Action failed."));
                }
            } catch (e) {
                uncertainSave.value = { id: isEdit ? payload.id : null, user_number: payload.user_number.trim() };
                showModal.value = true;
            } finally {
                isSaving.value = false;
            }
        };

        const checkSavedUser = async () => {
            if (isSaving.value || !uncertainSave.value) return;
            const submitted = uncertainSave.value;
            const generation = ++userReadGeneration;
            isSaving.value = true;
            try {
                const { data } = await fetchJsonResponseWithTimeout('api/admin/users');
                if (generation !== userReadGeneration || !data.success) throw new Error('Read failed');
                users.value = data.users || [];
                sections.value = data.sections || [];
                const current = users.value.find(user => submitted.id != null ? user.id === submitted.id : user.user_number === submitted.user_number);
                uncertainSave.value = null;
                isSaving.value = false;
                if (current) openModal(current);
                else if (submitted.id != null) showModal.value = false;
                else window.showAdminAlert(t('No saved user was found. Review the draft before retrying.'));
            } catch (_) {
                window.showAdminAlert(t('Network error.'));
            } finally { isSaving.value = false; }
        };

        const reloadEditedUser = async () => {
            const userId = form.value.id;
            const generation = ++userReadGeneration;
            isSaving.value = true;
            try {
                const data = await fetchJson('api/admin/users');
                if (generation !== userReadGeneration) return;
                if (!data.success) throw new Error(data.message);
                users.value = data.users || [];
                sections.value = data.sections || [];
                const current = users.value.find(user => user.id === userId);
                isSaving.value = false;
                if (current) openModal(current);
                else showModal.value = false;
            } catch (_) {
                window.showAdminAlert(t('Network error.'));
            } finally {
                isSaving.value = false;
            }
        };

        const deleteUser = async (id) => {
            if (id == 1 || id == activeUserId.value) {
                window.showAdminAlert(t("Cannot deactivate primary admin or your own account."));
                return;
            }
            if (!await window.showAdminConfirm(t("Are you sure you want to deactivate this user?"))) return;
            
            const backupUsers = [...users.value];
            users.value = users.value.filter(u => u.id !== id);
            window.showAdminToast(t("User deactivated."), "success");

            try {
                const data = await fetchJson('api/admin/users', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                });
                
                if (!data.success) {
                    users.value = backupUsers;
                    window.showAdminAlert(data.message || t("Failed to deactivate user."));
                }
            } catch (e) {
                users.value = backupUsers;
                window.showAdminAlert(t("Network error."));
            }
        };

        return {
            sections, isLoading, searchQuery, filteredUsers, activeUserId,
            showModal, isEditing, isSaving, editConflict, uncertainSave, checkSavedUser, reloadEditedUser, form, hasGodMode, isFixedRole, handleRoleChange,
            openModal, saveUser, deleteUser, toggleSection,
            selectedRoles, showRoleFilter, toggleRoleFilter, clearAllFilters,
            visiblePins, togglePinVisibility, isPinVisible,
            selectedSections, showSectionFilter, toggleSectionFilter, showMobileFilters, fetchUsersAndSections,
            permissionCatalog, permissionReady, selectedPreset, applyPreset, onPermissionsChanged, sectionSelectionValid, roleChanged
        };
    }
}
</script>

<template>

        <div class="h-full flex flex-col font-sans animate-fade-in text-foreground bg-background space-y-3 pb-6 relative select-none">
            <BatchProductWorkspace
                v-if="activeTab === 'batch-products'"
                :categories-tree="popoverCategoriesTree"
                :stock-enabled="stockEnabled"
                @close="activeTab = 'products'"
                @saved="onBatchProductsSaved"
            />

            <template v-else>
            
            <!-- Compact inventory command header -->
            <div class="inventory-page-bar shrink-0">
                
                <!-- Left Hand Actions (Show Back to Products if in a sub-view) -->
                <div>
                    <button v-if="activeTab !== 'products'" @click="backToProducts"
                        class="h-9 px-3 bg-muted border border-zinc-300 text-foreground hover:bg-zinc-200 font-bold rounded-md text-xs flex items-center gap-1.5 transition-all focus:outline-none animate-fade-in">
                        <i :class="['fa-solid text-[10px]', isRtl ? 'fa-arrow-right' : 'fa-arrow-left']"></i>
                        <span>{{ $t('Back to Products') }}</span>
                    </button>
                    <div v-else class="inventory-page-context">
                        <h2>{{ $t('Products') }}</h2>
                        <span class="inventory-record-count"><span data-no-i18n>{{ totalRecords }}</span> {{ $t('Items') }}</span>
                    </div>
                </div>

                <!-- Right Hand Actions (Dynamic based on Tab) -->
                <div class="inventory-page-actions">
                    
                    <!-- 1. Catalog Actions (Catalog view by default) -->
                    <template v-if="activeTab === 'products'">
                        <div class="relative">
                            <button @click="showCatalogActions = !showCatalogActions" class="inventory-button inventory-button--quiet" type="button" aria-haspopup="menu" :aria-expanded="showCatalogActions">
                                <span>{{ $t('More') }}</span>
                                <i class="fa-solid fa-chevron-down text-[9px] opacity-50"></i>
                            </button>
                            <div v-if="showCatalogActions" @click="showCatalogActions = false" class="fixed inset-0 z-40"></div>
                            <div v-if="showCatalogActions" class="inventory-actions-menu" role="menu">
                                <button role="menuitem" @click="exportToCSV(); showCatalogActions = false">{{ $t('Export') }}</button>
                                <button role="menuitem" @click="showImportModal = true; showCatalogActions = false">{{ $t('Import') }}</button>
                                <button role="menuitem" @click="activeTab='categories'; showCatalogActions = false">{{ $t('Categories') }}</button>
                            </div>
                        </div>
                        <!-- Restock -->
                        <button v-if="stockTabsEnabled" @click="activeTab='stock-items'" class="inventory-button inventory-button--quiet">
                            <span>{{ $t('Stock levels') }}</span>
                        </button>
                        <button v-if="stockEnabled" @click="activeTab='purchases'" class="inventory-button inventory-button--quiet">
                            <span>{{ $t('Purchase invoices') }}</span>
                        </button>
                        <button v-if="stockTabsEnabled" @click="activeTab='counts'" class="inventory-button inventory-button--quiet">
                            <span>{{ $t('Stock counts') }}</span>
                        </button>

                        <!-- Add multiple products -->
                        <button @click="activeTab='batch-products'" class="inventory-button inventory-button--secondary">
                            <span>{{ $t('Add Multiple') }}</span>
                        </button>

                        <!-- Add product -->
                        <button @click="openProductModal()" class="inventory-button inventory-button--primary">
                            <i class="fa-solid fa-plus text-[10px]"></i>
                            <span>{{ $t('Add Product') }}</span>
                        </button>
                    </template>

                    <!-- 2. Categories Actions -->
                    <template v-else-if="activeTab === 'categories'">
                        <button @click="openCategoryModal()" class="inventory-button inventory-button--primary">
                            <i class="fa-solid fa-plus text-[10px]"></i>
                            <span>{{ $t('Add Category') }}</span>
                        </button>
                    </template>

                    
                </div>
            </div>

            <!-- Single-line data-grid toolbar -->
            <div v-if="activeTab === 'products'" class="inventory-command-bar shrink-0">
                <div class="inventory-command-row">

                    <!-- Search Input -->
                    <div class="inventory-search-field">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input v-model="searchQuery" :placeholder="$t('Search items, barcodes...')" type="search"/>
                        <button v-if="searchQuery" @click="searchQuery = ''" :aria-label="$t('Clear search')" type="button">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>

                    <!-- Filter popovers -->
                    <div class="inventory-filter-row" :aria-label="$t('Filters')">

                        <label class="inventory-select-control inventory-select-control--category" :class="{ 'is-filtered': categoryFilter }">
                            <span class="sr-only">{{ $t('Category') }}</span>
                            <select v-model="categoryFilter">
                                <option value="">{{ $t('Category') }}</option>
                                <option v-for="cat in popoverCategoriesTree" :key="cat.id" :value="String(cat.id)" data-no-i18n>{{ cat.treeLabel }}</option>
                            </select>
                        </label>

                        <label v-if="activeTab === 'products'" class="inventory-select-control" :class="{ 'is-filtered': statusFilter !== 'all' }">
                            <span class="sr-only">{{ $t('Status') }}</span>
                            <select v-model="statusFilter">
                                <option value="all">{{ $t('Status') }}</option>
                                <option value="active">{{ $t('Active') }}</option>
                                <option value="inactive">{{ $t('Inactive') }}</option>
                            </select>
                        </label>

                        <label v-if="stockEnabled && activeTab === 'products'" class="inventory-select-control" :class="{ 'is-filtered': stockFilter !== 'all' }">
                            <span class="sr-only">{{ $t('Stock') }}</span>
                            <select v-model="stockFilter">
                                <option value="all">{{ $t('Stock') }}</option>
                                <option value="in">{{ $t('In Stock') }}</option>
                                <option value="low">{{ $t('Low Stock') }}</option>
                                <option value="out">{{ $t('Out of Stock') }}</option>
                            </select>
                        </label>

                        <label v-if="activeTab === 'products'" class="inventory-select-control inventory-select-control--sort" :class="{ 'is-filtered': sortBy !== 'newest' }">
                            <span class="sr-only">{{ $t('Sort') }}</span>
                            <select v-model="sortBy">
                                <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ $t(opt.label) }}</option>
                            </select>
                        </label>

                        <button v-if="hasActiveFilters" @click="clearAllFilters" class="inventory-clear-filters" type="button">{{ $t('Clear filters') }}</button>

                        <!-- Refresh database trigger -->
                        <button @click="fetchInventory" :aria-label="$t('Refresh')" :title="$t('Refresh')" class="inventory-refresh-button" type="button">
                            <i class="fa-solid fa-rotate-right"></i>
                        </button>
                    </div>
                </div>

            </div>

            <!-- Content Area -->
            <div class="inventory-grid-shell bg-card border border-zinc-300 overflow-hidden flex-1 flex flex-col relative">
                
                <!-- Loading Progress Stripe at top border -->
                <div v-if="isLoading" class="absolute top-0 left-0 right-0 h-0.5 bg-muted overflow-hidden z-20">
                    <div class="h-full bg-primary w-1/3 animate-[infinite-scroll_1.5s_infinite_linear]"></div>
                </div>

                <div class="inventory-grid-scroll overflow-x-auto overflow-y-auto flex-1">
                    
                    <!-- 1. PRODUCTS CATALOG VIEW -->
                    <template v-if="activeTab === 'products'">
                        
                        <!-- Skeleton Loading Screen -->
                        <div v-if="isLoading && products.length === 0" class="divide-y divide-border/60">
                            <div v-for="idx in 5" :key="'skp'+idx" class="p-4 flex flex-col md:flex-row gap-4 items-center justify-between animate-pulse">
                                <div class="flex items-center gap-3 flex-1 w-full">
                                    <div class="w-4 h-4 rounded bg-muted"></div>
                                    <div class="space-y-2 flex-1">
                                        <div class="h-4 bg-muted rounded w-2/5"></div>
                                        <div class="h-3 bg-muted rounded w-1/5"></div>
                                    </div>
                                </div>
                                <div class="h-4 bg-muted rounded w-24 hidden md:block"></div>
                                <div class="h-4 bg-muted rounded w-16 hidden md:block"></div>
                                <div class="h-4 bg-muted rounded w-20 hidden md:block"></div>
                                <div class="h-7 bg-muted rounded w-32"></div>
                            </div>
                        </div>

                        <!-- Empty state -->
                        <div v-else-if="products.length === 0" class="py-24 text-center">
                            <div class="flex flex-col items-center gap-3 text-muted-foreground max-w-sm mx-auto">
                                <i class="fa-solid fa-box-open text-5xl opacity-20 mb-2"></i>
                                <h3 class="font-bold text-base text-foreground">{{ $t('No products found in catalog.') }}</h3>
                                <p class="text-xs text-muted-foreground leading-relaxed">{{ $t('Try adjusting your filters, searching other terms, or add a new product.') }}</p>
                                <button v-if="hasActiveFilters" @click="clearAllFilters" class="text-xs font-semibold px-4 py-2 mt-2 bg-muted border border-zinc-300 text-foreground hover:bg-zinc-200 rounded-md focus:outline-none transition-colors">
                                    {{ $t('Clear All Filters') }}
                                </button>
                                <button @click="openProductModal()" class="text-xs font-semibold px-4 py-2 mt-2 bg-primary text-white hover:bg-primary/90 rounded-md focus:outline-none transition-colors">
                                    {{ $t('Add First Product') }}
                                </button>
                            </div>
                        </div>

                        <!-- Content Render -->
                        <template v-else>
                            <!-- Desktop Table (>= md) -->
                            <table class="inventory-data-grid w-full text-start min-w-[980px] hidden md:table">
                                <colgroup>
                                    <col :style="{ width: stockEnabled ? '35%' : '40%' }">
                                    <col :style="{ width: stockEnabled ? '25%' : '28%' }">
                                    <col :style="{ width: stockEnabled ? '15%' : '18%' }">
                                    <col v-if="stockEnabled" style="width: 15%;">
                                    <col :style="{ width: stockEnabled ? '10%' : '14%' }">
                                    <col style="width: 132px;">
                                </colgroup>
                                <thead class="sticky top-0 z-10 select-none">
                                    <tr>
                                        <th>{{ $t('Item Details') }}</th>
                                        <th>{{ $t('Category') }}</th>
                                        <th>{{ $t('Price') }}</th>
                                        <th v-if="stockEnabled">{{ $t('Stock') }}</th>
                                        <th>{{ $t('Status') }}</th>
                                        <th><span class="sr-only">{{ $t('Actions') }}</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="p in products" :key="'p'+p.id">
                                        <td>
                                            <div class="min-w-0">
                                                <div class="flex items-center gap-2">
                                                    <span v-if="p.background_color" class="inventory-color-dot" :style="{ backgroundColor: p.background_color }" :title="$t('Custom Background: ') + p.background_color"></span>
                                                    <p class="inventory-product-name" data-no-i18n>{{ p.name }}</p>
                                                </div>
                                                <div class="inventory-product-meta">
                                                    <span v-if="p.barcode" class="tabular-nums select-all" data-no-i18n>{{ p.barcode }}</span>
                                                    <span v-else>{{ $t('No Barcode') }}</span>
                                                    <span v-if="p.extra_barcodes?.length" class="tabular-nums" dir="ltr" :title="`${$t('Extra barcodes')}: ${p.extra_barcodes.join(' | ')}`" data-no-i18n>+{{ p.extra_barcodes.length }}<span class="sr-only"> {{ $t('Extra barcodes') }}</span></span>
                                                    <span v-if="parseModCount(p.modifiers) > 0">
                                                        <span class="tabular-nums" data-no-i18n>{{ parseModCount(p.modifiers) }}</span> {{ $t('Modifiers') }}
                                                    </span>
                                                </div>
                                            </div>
                                        </td>
                                        <td>
                                            <span class="inventory-category-text" data-no-i18n>{{ getCategoryName(p.category_id) }}</span>
                                        </td>
                                        <td>
                                            <div class="inventory-price-cell">
                                                <span><strong class="tabular-nums" data-no-i18n>{{ Number(p.price).toFixed(2) }}</strong> {{ $t('JD') }}</span>
                                                <small v-if="Number(p.tax_rate) > 0"><span data-no-i18n>{{ p.tax_rate }}%</span> {{ $t('Tax') }}</small>
                                            </div>
                                        </td>
                                        <td v-if="stockEnabled">
                                            <div v-if="p.stock !== null && p.stock !== ''" class="inventory-stock-cell" :class="Number(p.stock) <= 0 ? 'is-out' : Number(p.stock) <= lowStockThreshold ? 'is-low' : ''">
                                                <strong class="tabular-nums" data-no-i18n>{{ p.stock }}</strong>
                                                <small v-if="Number(p.stock) <= 0">{{ $t('Out of Stock') }}</small>
                                                <small v-else-if="Number(p.stock) <= lowStockThreshold">{{ $t('Low Stock') }}</small>
                                            </div>
                                            <span v-else class="inventory-muted-value">{{ $t(p.stock_item_id ? 'Not counted yet' : 'Unlimited') }}</span>
                                        </td>
                                        <td>
                                            <span v-if="p.is_active == 1" class="inventory-status is-active">
                                                <span></span> {{ $t('Active') }}
                                            </span>
                                            <span v-else class="inventory-status">
                                                <span></span> {{ $t('Inactive') }}
                                            </span>
                                        </td>
                                        <td>
                                            <div class="inventory-row-actions">
                                                <button @click="openProductModal(p)" :aria-label="$t('Edit Item')" :title="$t('Edit Item')"><i class="fa-solid fa-pen"></i></button>
                                                <button @click="openProductModal(p, 'modifiers')" :aria-label="$t('Edit Modifiers')" :title="$t('Edit Modifiers')"><i class="fa-solid fa-sliders"></i></button>
                                                <button @click="toggleActive(p)" :aria-label="$t('Toggle Active')" :title="$t('Toggle Active')"><i class="fa-solid fa-power-off"></i></button>
                                                <button @click="deleteItem(p.id)" :aria-label="$t('Delete')" :title="$t('Delete')" class="is-danger"><i class="fa-solid fa-trash"></i></button>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>

                            <!-- Mobile Grid Layout (< md) -->
                            <div class="inventory-mobile-list md:hidden select-none">
                                <div v-for="p in products" :key="'mp'+p.id" class="inventory-mobile-card">
                                    <div class="flex items-start justify-between gap-3">
                                        <div class="flex items-start gap-2.5">
                                            <div class="min-w-0">
                                                <div class="flex items-center gap-1.5">
                                                    <span v-if="p.background_color" class="w-2.5 h-2.5 rounded-full border border-border shadow-sm shrink-0" :style="{ backgroundColor: p.background_color }"></span>
                                                    <h4 class="font-bold text-[13px] text-foreground leading-tight" data-no-i18n>{{ p.name }}</h4>
                                                </div>
                                                <p class="text-[10px] text-muted-foreground mt-0.5" data-no-i18n>{{ getCategoryName(p.category_id) }}</p>
                                            </div>
                                        </div>
                                        <span v-if="p.is_active == 1" class="inventory-status is-active">
                                            <span></span> {{ $t('Active') }}
                                        </span>
                                        <span v-else class="inventory-status">
                                            <span></span> {{ $t('Inactive') }}
                                        </span>
                                    </div>

                                    <div class="flex items-center justify-between text-xs border-t border-b border-border/40 py-2">
                                        <div>
                                            <span class="text-muted-foreground text-[10px] block">{{ $t('Price') }}</span>
                                            <span class="font-black text-foreground tabular-nums" data-no-i18n>{{ Number(p.price).toFixed(2) }}</span> <span class="text-[9px] text-muted-foreground font-semibold">{{ $t('JD') }}</span>
                                        </div>
                                        <div v-if="stockEnabled">
                                            <span class="text-muted-foreground text-[10px] block text-end">{{ $t('Stock') }}</span>
                                            <span v-if="p.stock !== null && p.stock !== ''" class="font-black text-foreground block text-end tabular-nums" :class="Number(p.stock) <= 0 ? 'text-destructive' : Number(p.stock) <= lowStockThreshold ? 'text-amber-500' : 'text-foreground'" data-no-i18n>
                                                {{ p.stock }}
                                            </span>
                                            <span v-else class="text-[10px] text-muted-foreground/50 block text-end italic font-semibold">{{ $t(p.stock_item_id ? 'Not counted yet' : 'Unlimited') }}</span>
                                        </div>
                                        <div>
                                            <span class="text-muted-foreground text-[10px] block text-end">{{ $t('Modifiers') }}</span>
                                            <span class="font-bold text-foreground block text-end tabular-nums" data-no-i18n>{{ parseModCount(p.modifiers) }}</span>
                                        </div>
                                    </div>

                                    <div class="inventory-mobile-actions">
                                        <button @click="openProductModal(p)" :aria-label="$t('Edit')" class="inventory-mobile-action inventory-mobile-action--label">
                                            <i class="fa-solid fa-pen text-[9px]"></i> {{ $t('Edit') }}
                                        </button>
                                        <button @click="openProductModal(p, 'modifiers')" :aria-label="$t('Edit Modifiers')" class="inventory-mobile-action inventory-mobile-action--label">
                                            <i class="fa-solid fa-sliders text-[9px]"></i> {{ $t('Modifiers') }}
                                        </button>
                                        <button @click="toggleActive(p)" :aria-label="$t('Toggle Active')" class="inventory-mobile-action">
                                            <i class="fa-solid fa-power-off text-[10px]" :class="p.is_active == 1 ? 'text-emerald-500' : 'text-muted-foreground'"></i>
                                        </button>
                                        <button @click="deleteItem(p.id)" :aria-label="$t('Delete')" class="inventory-mobile-action is-danger">
                                            <i class="fa-solid fa-trash text-[10px]"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </template>

                    <!-- 2. CATEGORIES TREE VIEW -->
                    <template v-else-if="activeTab === 'categories'">
                        
                        <!-- Skeleton Loading Screen -->
                        <div v-if="isLoading && paginatedCategories.length === 0" class="divide-y divide-border/60">
                            <div v-for="idx in 5" :key="'skc'+idx" class="p-4 flex items-center justify-between animate-pulse">
                                <div class="space-y-2 flex-1">
                                    <div class="h-4 bg-muted rounded w-1/4"></div>
                                    <div class="h-3 bg-muted rounded w-1/12"></div>
                                </div>
                                <div class="h-4 bg-muted rounded w-24 hidden md:block"></div>
                                <div class="h-7 bg-muted rounded w-20"></div>
                            </div>
                        </div>

                        <!-- Empty state -->
                        <div v-else-if="filteredCategories.length === 0" class="py-24 text-center">
                            <div class="flex flex-col items-center gap-3 text-muted-foreground max-w-sm mx-auto">
                                <i class="fa-solid fa-folder-open text-5xl opacity-20 mb-2"></i>
                                <h3 class="font-bold text-base text-foreground">{{ $t('No categories found.') }}</h3>
                                <p class="text-xs text-muted-foreground leading-relaxed">{{ $t('Classify products by adding a new parent or subcategory.') }}</p>
                                <button @click="openCategoryModal()" class="text-xs font-semibold px-4 py-2 mt-2 bg-primary text-white hover:bg-primary/90 rounded-md focus:outline-none transition-colors">
                                    {{ $t('Add Category') }}
                                </button>
                            </div>
                        </div>

                        <!-- Content Render -->
                        <template v-else>
                            <!-- Desktop Table (>= md) -->
                            <table class="w-full text-start min-w-[700px] hidden md:table">
                                <colgroup>
                                    <col style="width: 40%;">
                                    <col style="width: 35%;">
                                    <col style="width: 15%;">
                                    <col style="width: 10%;">
                                </colgroup>
                                <thead class="bg-zinc-200/80 backdrop-blur border-b border-zinc-300 sticky top-0 z-10 select-none">
                                    <tr>
                                        <th class="py-2 px-4 font-bold text-[10px] text-muted-foreground uppercase tracking-wider select-none">{{ $t('Category Name') }}</th>
                                        <th class="py-2 px-4 font-bold text-[10px] text-muted-foreground uppercase tracking-wider select-none">{{ $t('Parent Category') }}</th>
                                        <th class="py-2 px-4 font-bold text-[10px] text-muted-foreground uppercase tracking-wider select-none text-center">{{ $t('Status') }}</th>
                                        <th class="py-2 px-4"></th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-zinc-200">
                                    <tr v-for="c in paginatedCategories" :key="'c'+c.id" class="group even:bg-muted/50 hover:bg-muted/60 transition-colors duration-150">
                                        <td class="py-1.5 px-4">
                                            <div class="flex items-center gap-2">
                                                <p class="text-[13px] font-bold text-foreground" data-no-i18n>{{ c.name }}</p>
                                                <span v-if="c.is_notes === 1" class="inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 text-[9px] text-amber-700 font-bold px-1.5 py-0.2 rounded uppercase tracking-wider select-none">
                                                    <i class="fa-solid fa-note-sticky text-[8px]"></i> {{ $t('Notes') }}
                                                </span>
                                                <span v-if="c.is_price_list_root" class="inline-flex items-center bg-primary/10 border border-primary/20 text-[9px] text-primary/90 font-bold px-1.5 py-0.2 rounded uppercase tracking-wider select-none">{{ $t('Price list') }}</span>
                                                <span v-else-if="c.price_list_root_name" class="text-[10px] text-muted-foreground select-none">
                                                    {{ $t('Price list') }}: <span class="font-semibold" data-no-i18n>{{ c.price_list_root_name }}</span>
                                                </span>
                                            </div>
                                        </td>
                                        <td class="py-1.5 px-4">
                                            <span v-if="c.parent_name" class="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded font-semibold border border-zinc-200" data-no-i18n>
                                                {{ c.parent_name }} <i :class="['fa-solid text-[8px] mx-1 text-muted-foreground/50', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']"></i> {{ c.name }}
                                            </span>
                                            <span v-else class="inline-flex items-center gap-1.5 text-[10px] text-emerald-700 bg-emerald-500/10 px-2 py-0.5 rounded font-bold uppercase tracking-wider border border-emerald-500/10">
                                                <i class="fa-solid fa-folder text-[9px] opacity-70"></i> {{ $t('Top level') }}
                                            </span>
                                        </td>
                                        <td class="py-1.5 px-4 text-center">
                                            <span v-if="c.is_active == 1" class="inline-flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-700 font-bold px-2 py-0.5 rounded-full whitespace-nowrap uppercase tracking-wider animate-fade-in">
                                                <span class="w-1 h-1 rounded-full bg-emerald-500 shrink-0"></span> {{ $t('Active') }}
                                            </span>
                                            <span v-else class="inline-flex items-center gap-1 bg-muted border border-border text-[10px] text-muted-foreground font-bold px-2 py-0.5 rounded-full whitespace-nowrap uppercase tracking-wider animate-fade-in">
                                                <span class="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0"></span> {{ $t('Inactive') }}
                                            </span>
                                        </td>
                                        <td class="py-1.5 px-4 logical-text-end">
                                            <div class="flex items-center gap-1 justify-end opacity-100 xl:opacity-0 xl:group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                                                <button @click="openCategoryModal(c)" :title="$t('Edit Item')" class="w-7 h-7 inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors focus:outline-none"><i class="fa-solid fa-pen text-[10px]"></i></button>
                                                <button v-if="c.is_price_list_root" @click="openPriceListModal(c)" :title="$t('Prices')" class="h-7 px-2 inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors focus:outline-none text-[10px] font-bold">{{ $t('Prices') }}</button>
                                                <button @click="openCategoryCopyModal(c)" :title="$t('Copy')" class="w-7 h-7 inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors focus:outline-none"><i class="fa-regular fa-copy text-[10px]"></i></button>
                                                <button @click="toggleCategoryActive(c)" :title="$t('Toggle Active')" class="w-7 h-7 inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors focus:outline-none"><i class="fa-solid fa-power-off text-[10px]"></i></button>
                                                <button @click="deleteCategory(c.id)" :title="$t('Delete')" class="w-7 h-7 inline-flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded transition-colors focus:outline-none"><i class="fa-solid fa-trash text-[10px]"></i></button>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>

                            <!-- Mobile Card View (< md) -->
                            <div class="md:hidden divide-y divide-border/60">
                                <div v-for="c in paginatedCategories" :key="'mc'+c.id" class="p-4 flex flex-col gap-2 hover:bg-muted/10 transition-colors">
                                    <div class="flex items-start justify-between gap-3">
                                        <div>
                                            <div class="flex items-center gap-1.5 flex-wrap mb-1">
                                                <h4 class="font-bold text-[13px] text-foreground leading-tight" data-no-i18n>{{ c.name }}</h4>
                                                <span v-if="c.is_notes === 1" class="inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 text-[9px] text-amber-700 font-bold px-1.5 py-0.2 rounded uppercase tracking-wider select-none">
                                                    <i class="fa-solid fa-note-sticky text-[8px]"></i> {{ $t('Notes') }}
                                                </span>
                                                <span v-if="c.is_price_list_root" class="inline-flex items-center bg-primary/10 border border-primary/20 text-[9px] text-primary/90 font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
                                                    {{ $t('Price list') }}
                                                </span>
                                                <span v-else-if="c.price_list_root_name" class="text-[10px] text-muted-foreground select-none">
                                                    {{ $t('Price list') }}: <span class="font-semibold" data-no-i18n>{{ c.price_list_root_name }}</span>
                                                </span>
                                            </div>
                                            <p class="text-[10px] text-muted-foreground mt-1 select-none">
                                                <span v-if="c.parent_name" data-no-i18n>{{ $t('Parent:') }} {{ c.parent_name }}</span>
                                                <span v-else class="text-emerald-600 font-bold uppercase tracking-wider text-[9px]">{{ $t('Top level') }}</span>
                                            </p>
                                        </div>
                                        <span v-if="c.is_active == 1" class="inline-flex items-center gap-1 bg-emerald-500/10 text-[9px] text-emerald-700 font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap uppercase tracking-wider">
                                            {{ $t('Active') }}
                                        </span>
                                        <span v-else class="inline-flex items-center gap-1 bg-muted text-[9px] text-muted-foreground font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap uppercase tracking-wider">
                                            {{ $t('Inactive') }}
                                        </span>
                                    </div>
                                    <div class="grid grid-cols-2 gap-2 pt-1.5 sm:flex sm:justify-end">
                                        <button v-if="c.is_price_list_root" @click="openPriceListModal(c)" class="h-11 px-3 bg-primary text-white hover:bg-primary/90 rounded-md text-[11px] font-bold transition-colors">
                                            {{ $t('Prices') }}
                                        </button>
                                        <button @click="openCategoryCopyModal(c)" class="h-11 px-3 bg-card border border-zinc-300 text-foreground hover:bg-muted rounded-md text-[11px] font-bold transition-colors">
                                            {{ $t('Copy') }}
                                        </button>
                                        <button @click="openCategoryModal(c)" :aria-label="$t('Edit')" class="h-11 px-3 bg-muted border border-zinc-300 text-foreground hover:bg-zinc-200 rounded-md text-[11px] font-bold flex items-center justify-center gap-1 transition-colors focus:outline-none">
                                            <i class="fa-solid fa-pen text-[9px]"></i> {{ $t('Edit') }}
                                        </button>
                                        <button @click="toggleCategoryActive(c)" :aria-label="$t('Toggle Active')" class="h-11 px-3 bg-muted border border-zinc-300 text-foreground hover:bg-zinc-200 rounded-md flex items-center justify-center transition-colors focus:outline-none">
                                            <i class="fa-solid fa-power-off text-[10px]" :class="c.is_active == 1 ? 'text-emerald-500' : 'text-muted-foreground'"></i>
                                        </button>
                                        <button @click="deleteCategory(c.id)" :aria-label="$t('Delete')" class="h-11 px-3 bg-destructive/10 text-destructive hover:bg-destructive/20 rounded-md flex items-center justify-center transition-colors focus:outline-none">
                                            <i class="fa-solid fa-trash text-[10px]"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </template>

                    <template v-else-if="activeTab === 'stock-items'">
                        <StockWorkingList />
                    </template>
                    <template v-else-if="activeTab === 'purchases'">
                        <component :is="PurchaseInvoicesTab" ref="purchasesTab" item-kind="product" />
                    </template>
                    <template v-else-if="activeTab === 'counts'">
                        <component :is="StockCountsTab" ref="countsTab" />
                    </template>
                </div>

                <!-- Pagination Footer (Hidden for stock levels and purchases) -->
                <div v-if="activeTab !== 'stock-items' && activeTab !== 'purchases' && activeTab !== 'counts'" class="inventory-pagination shrink-0 mt-auto">
                    <div class="inventory-pagination-summary">
                        <p><span class="tabular-nums" data-no-i18n>{{ pageStart }}</span>&ndash;<span class="tabular-nums" data-no-i18n>{{ pageEnd }}</span> {{ $t('of') }} <span class="tabular-nums" data-no-i18n>{{ totalRecords }}</span></p>
                        <label>
                            <span>{{ $t('Rows') }}</span>
                            <select v-model.number="pageSize" data-no-i18n>
                                <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
                            </select>
                        </label>
                    </div>
                    <div class="inventory-pagination-controls">
                        <button @click="previousPage" :disabled="currentPage === 1" :aria-label="$t('Prev')"><i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']"></i></button>
                        <span>{{ $t('Page') }} <strong class="tabular-nums" data-no-i18n>{{ currentPage }}</strong> / <span class="tabular-nums" data-no-i18n>{{ totalPages || 1 }}</span></span>
                        <button @click="nextPage" :disabled="currentPage === totalPages || totalPages === 0" :aria-label="$t('Next')"><i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']"></i></button>
                    </div>
                </div>
            </div>

            <!-- Product Modal -->
            <ProductModal
                :show="showProductModal"
                :product="editingProduct"
                :categories-tree="popoverCategoriesTree"
                :stock-enabled="stockEnabled"
                :recipe-ledger-enabled="recipeLedgerEnabled"
                :initial-tab="productInitialTab"
                @close="showProductModal = false"
                @saved="onProductSaved"
                @stock-activated="onStockActivated"
                @packs-saved="fetchInventory"
                @open-stock="openProductStock"
            />

            <!-- Category Modal -->
            <CategoryModal
                :show="showCategoryModal"
                :category="editingCategory"
                :eligible-parents="eligibleParentCategories"
                @close="showCategoryModal = false"
                @saved="onCategorySaved"
            />
            <CategoryPriceListModal :show="showPriceListModal" :root="priceListRoot" @close="showPriceListModal = false" @saved="onPriceListSaved" />
            <CategoryCopyModal :show="showCategoryCopyModal" :source="copySourceCategory" :eligible-parents="eligibleCopyParentCategories" @close="showCategoryCopyModal = false" @saved="onCategoryCopySaved" />

            <!-- Import Catalog Modal Overlay -->
            <ImportModal v-if="showImportModal" @close="showImportModal = false" @imported="fetchInventory" />

            </template>

        </div>
    
</template>

<script>
import { formatBusinessDateTime, currentBusinessDate } from '@/utils/businessDate.js';
import { ref, onMounted, onActivated, onDeactivated, onUnmounted, computed, watch, nextTick } from 'vue';
import { currentLanguage, t } from '@/shared/i18n.js';
import { fetchJson } from '@/shared/http.js';
import { useRoute, useRouter } from 'vue-router';
import { getSystemSettings } from '@/shared/systemSettings.js';
import ImportModal from '../components/ImportModal.vue';
import ProductModal from '../components/ProductModal.vue';
import CategoryModal from '../components/CategoryModal.vue';
import CategoryPriceListModal from '../components/CategoryPriceListModal.vue';
import CategoryCopyModal from '../components/CategoryCopyModal.vue';
import BatchProductWorkspace from '../components/BatchProductWorkspace.vue';
import StockWorkingList from '../components/StockWorkingList.vue';
import { lazyPosComponent } from '../../pos/lazyPosComponent.js';

export default {
    name: 'inventory',
    components: {
        ImportModal,
        ProductModal,
        CategoryModal,
        CategoryPriceListModal,
        CategoryCopyModal,
        BatchProductWorkspace,
        StockWorkingList
    },
    setup() {
        const route = useRoute();
        const router = useRouter();
        const activeTab = ref('products'); // 'products' | 'categories' | 'purchases' | 'counts' | 'batch-products' | 'stock-items'
        const products = ref([]);
        const categories = ref([]);
        const searchQuery = ref('');
        const isLoading = ref(false);
        const stockEnabled = ref(false);
        const recipeLedgerEnabled = ref(false);
        const lowStockThreshold = ref(3);
        const pageSize = ref(12);
        
        const productCurrentPage = ref(1);
        const categoryCurrentPage = ref(1);
        const productTotalRecords = ref(0);
        const productTotalPageCount = ref(1);
        const productStats = ref({ active_products: 0, low_stock: 0 });

        // Filter values
        const categoryFilter = ref('');
        const statusFilter = ref('all');
        const stockFilter = ref('all');
        const pageSizeOptions = [12, 24, 48, 96];

        const showCatalogActions = ref(false);
        const sortBy = ref('newest');
        const sortOptions = [
            { value: 'newest', label: 'Newest' },
            { value: 'name', label: 'Name (A–Z)' },
            { value: 'price_desc', label: 'Price (high–low)' },
            { value: 'stock_asc', label: 'Stock (low–high)' }
        ];

        const isRtl = computed(() => currentLanguage.value === 'ar');
        const hasActiveFilters = computed(() => categoryFilter.value || statusFilter.value !== 'all' || (stockEnabled.value && stockFilter.value !== 'all') || sortBy.value !== 'newest');

        // Lazy: the purchase-invoice editor is only fetched when its tab opens.
        const PurchaseInvoicesTab = lazyPosComponent(() => import('../components/purchases/PurchaseInvoicesTab.vue'), () => {
            window.showAdminAlert?.(t('Purchase invoices could not be loaded. Check the connection and open the tab again.'));
            activeTab.value = 'products';
        });
        const purchasesTab = ref(null);
        const StockCountsTab = lazyPosComponent(() => import('../components/counts/StockCountsTab.vue'), () => {
            window.showAdminAlert?.(t('Stock counts could not be loaded. Check the connection and open the tab again.'));
            activeTab.value = 'products';
        });
        const countsTab = ref(null);
        // Stock levels and counts serve both stock tracking and the recipe ledger. Purchase invoices
        // hold products only, so they need product stock on (ingredients buy from their own page).
        const stockTabsEnabled = computed(() => stockEnabled.value || recipeLedgerEnabled.value);
        const confirmLeaveTab = async () => {
            if (activeTab.value === 'purchases' && purchasesTab.value) return purchasesTab.value.confirmDiscard();
            if (activeTab.value === 'counts' && countsTab.value) return countsTab.value.confirmDiscard();
            return true;
        };
        const backToProducts = async () => {
            if (!await confirmLeaveTab()) return;
            activeTab.value = 'products';
            clearAllFilters();
        };

        const clearAllFilters = () => {
            searchQuery.value = '';
            categoryFilter.value = '';
            statusFilter.value = 'all';
            stockFilter.value = 'all';
            sortBy.value = 'newest';
            productCurrentPage.value = 1;
            reload();
        };

        let productSearchTimer = null;
        let isFirstActivation = true;
        let fetchSeq = 0;
        let inventoryActive = true;
        let inventoryReadController = null;
        let categoriesDirty = true;
        let eventRefreshDirty = false;
        let eventRefreshScheduled = false;

        const scheduleEventRefresh = () => {
            if (!inventoryActive || !eventRefreshDirty || inventoryReadController || eventRefreshScheduled) return;
            eventRefreshScheduled = true;
            nextTick(() => {
                eventRefreshScheduled = false;
                if (inventoryActive && eventRefreshDirty && !inventoryReadController) {
                    void fetchInventory({ silent: true });
                }
            });
        };

        const cancelInventoryRead = () => {
            inventoryActive = false;
            fetchSeq += 1;
            inventoryReadController?.abort();
            inventoryReadController = null;
            eventRefreshDirty = false;
            isLoading.value = false;
        };

        // Unified Dialog Modals State
        const showProductModal = ref(false);
        const showImportModal = ref(false);
        const editingProduct = ref(null);
        const productInitialTab = ref('general');

        const showCategoryModal = ref(false);
        const editingCategory = ref(null);
        const showPriceListModal = ref(false);
        const priceListRoot = ref(null);
        const showCategoryCopyModal = ref(false);
        const copySourceCategory = ref(null);

        const setProductPage = (rows, explicitTotal = null, explicitPageCount = null) => {
            const limit = Math.max(1, Number(pageSize.value) || 12);
            const total = Math.max(0, Number(explicitTotal ?? rows.length) || 0);
            const totalPages = Math.max(1, Number(explicitPageCount || Math.ceil(total / limit)) || 1);

            productTotalRecords.value = total;
            productTotalPageCount.value = totalPages;

            if (productCurrentPage.value > totalPages) {
                productCurrentPage.value = totalPages;
            }

            products.value = rows.slice(0, limit);
        };

        const applyProductResponse = (prodRes) => {
            const rows = Array.isArray(prodRes.products) ? prodRes.products : [];
            const limit = Math.max(1, Number(pageSize.value) || 12);
            const total = prodRes.pagination?.total ?? rows.length;
            const totalPages = prodRes.pagination?.total_pages ?? Math.ceil(Number(total) / limit);

            const start = (productCurrentPage.value - 1) * limit;
            const pageRows = rows.length > limit ? rows.slice(start, start + limit) : rows;
            setProductPage(pageRows, total, totalPages);

            productStats.value = {
                active_products: Number(prodRes.stats?.active_products || 0),
                low_stock: Number(prodRes.stats?.low_stock || 0)
            };
        };

        const fetchInventory = async ({ silent = false, refreshCategories = true } = {}) => {
            if (!inventoryActive) return;
            if (refreshCategories) categoriesDirty = true;
            eventRefreshDirty = false; // This read includes all signals received before it started.
            inventoryReadController?.abort();
            const controller = new AbortController();
            inventoryReadController = controller;
            if (!silent) isLoading.value = true;
            const seq = ++fetchSeq;
            try {
                const productParams = new URLSearchParams({
                    page: String(productCurrentPage.value),
                    limit: String(pageSize.value)
                });
                if (searchQuery.value.trim()) productParams.set('search', searchQuery.value.trim());
                if (categoryFilter.value) productParams.set('category_ids', String(categoryFilter.value));
                if (statusFilter.value !== 'all') productParams.set('status', statusFilter.value);
                if (stockEnabled.value && stockFilter.value !== 'all') productParams.set('stock_status', stockFilter.value);
                if (sortBy.value && sortBy.value !== 'newest') productParams.set('sort', sortBy.value);

                const [prodRes, catRes, setRes] = await Promise.all([
                    fetchJson(`api/admin/products?${productParams.toString()}`, { signal: controller.signal }),
                    categoriesDirty ? fetchJson('api/admin/categories', { signal: controller.signal }) : null,
                    getSystemSettings()
                ]);

                if (seq !== fetchSeq) return; // superseded by a newer fetch — drop stale data
                if (catRes?.success) {
                    categories.value = catRes.categories;
                    // An event during this read may describe newer categories.
                    categoriesDirty = eventRefreshDirty;
                }
                if (setRes.success) {
                    const stockSetting = setRes.stock_enabled ?? setRes.settings?.enable_stock_management?.value;
                    stockEnabled.value = stockSetting === '1' || stockSetting === 1 || stockSetting === true;
                    recipeLedgerEnabled.value = setRes.recipe_ledger_enabled === '1';
                    if (setRes.low_stock_threshold !== undefined) {
                        lowStockThreshold.value = parseInt(setRes.low_stock_threshold, 10) || 3;
                    }
                    // An open purchase invoice or count with unsaved work or a write in flight stays open; the operator leaves through Back.
                    const openWorkUnsaved = (activeTab.value === 'purchases' && !!purchasesTab.value?.unsaved) || (activeTab.value === 'counts' && !!countsTab.value?.unsaved);
                    const tabGone = !openWorkUnsaved && ((!stockTabsEnabled.value && ['stock-items', 'counts'].includes(activeTab.value)) || (!stockEnabled.value && activeTab.value === 'purchases'));
                    if (!stockEnabled.value && (stockFilter.value !== 'all' || tabGone)) {
                        stockFilter.value = 'all';
                        if (tabGone) activeTab.value = 'products';
                        productCurrentPage.value = 1;
                        // The parallel products read used the previous stock
                        // filter. Reconcile once before painting those rows.
                        reload({ silent });
                        return;
                    }
                }
                if (prodRes.success) applyProductResponse(prodRes);
            } catch (e) {
                if (seq === fetchSeq && e.name !== 'AbortError') console.error("Failed to load inventory", e);
            } finally {
                if (seq === fetchSeq) {
                    inventoryReadController = null;
                    isLoading.value = false;
                    scheduleEventRefresh();
                }
            }
        };

        // Collapse multiple fetch triggers fired in the same tick into a single request.
        let reloadScheduled = false;
        const reload = ({ silent = false } = {}) => {
            if (reloadScheduled) return;
            reloadScheduled = true;
            nextTick(() => { reloadScheduled = false; fetchInventory({ silent, refreshCategories: false }); });
        };

        // ERP CSV Data Exporter
        const exportToCSV = async () => {
            const baseParams = () => {
                const p = new URLSearchParams();
                if (searchQuery.value.trim()) p.set('search', searchQuery.value.trim());
                if (categoryFilter.value) p.set('category_ids', String(categoryFilter.value));
                if (statusFilter.value !== 'all') p.set('status', statusFilter.value);
                if (stockEnabled.value && stockFilter.value !== 'all') p.set('stock_status', stockFilter.value);
                if (sortBy.value && sortBy.value !== 'newest') p.set('sort', sortBy.value);
                return p;
            };

            // Page through the whole filtered set (server caps each page at 200).
            const rows = [];
            let page = 1;
            const limit = 200;
            try {
                while (true) {
                    if (page > 100) break; // safety: never loop past ~20k rows on a bad `total`
                    const p = baseParams();
                    p.set('page', String(page));
                    p.set('limit', String(limit));
                    const data = await fetchJson(`api/admin/products?${p.toString()}`);
                    if (!data.success || !Array.isArray(data.products)) break;
                    rows.push(...data.products);
                    const total = data.pagination?.total ?? rows.length;
                    if (data.products.length < limit || rows.length >= total) break;
                    page++;
                }
            } catch (e) {
                console.error('CSV export failed', e);
                await window.showAdminAlert(t("Export failed. Please try again."));
                return;
            }

            const headers = [ t('Product ID'), t('Name'), t('Barcode'), t('Extra barcodes'), t('Category'), t('Price (JD)'), t('Stock'), t('Status') ];
            const csvRows = [
                headers.join(','),
                ...rows.map(p => [
                    p.id,
                    `"${String(p.name).replace(/"/g, '""')}"`,
                    p.barcode || '',
                    `"${(p.extra_barcodes || []).join(' | ').replace(/"/g, '""')}"`,
                    `"${getCategoryName(p.category_id).replace(/"/g, '""')}"`,
                    Number(p.price).toFixed(2),
                    p.stock !== null && p.stock !== undefined && p.stock !== '' ? p.stock : t(p.stock_item_id ? 'Not counted yet' : 'Unlimited'),
                    p.is_active ? t('Active') : t('Inactive')
                ].join(','))
            ];
            const blob = new Blob(["﻿" + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", `inventory_${currentBusinessDate()}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            window.showAdminToast(t("Catalog exported to CSV."), "success");
        };

        const handleInventoryChange = () => {
            categoriesDirty = true;
            eventRefreshDirty = true;
            scheduleEventRefresh();
        };

        onMounted(() => {
            fetchInventory();
        });

        // Listen for inventory_changed only while visible; silently re-sync on
        // return so stock changes made elsewhere while cached/hidden show up.
        // The Ingredients page links here with ?tab=counts. ?tab=purchases opens product purchase invoices; once
        // the settings are read, the tab-gone check above sends it back to products when product stock is off.
        const openRequestedTab = async () => {
            const tab = route.query.tab;
            if (tab !== 'purchases' && tab !== 'counts') return;
            router.replace({ name: 'inventory' });
            if (activeTab.value !== tab && await confirmLeaveTab()) activeTab.value = tab;
        };
        onActivated(() => {
            inventoryActive = true;
            openRequestedTab();
            window.addEventListener('inventory_changed', handleInventoryChange);
            window.addEventListener('settings_changed', handleInventoryChange);
            window.addEventListener('socket_reconnected', handleInventoryChange);
            if (!isFirstActivation) {
                fetchInventory({ silent: true });
            }
            isFirstActivation = false;
        });

        onDeactivated(() => {
            cancelInventoryRead();
            window.removeEventListener('inventory_changed', handleInventoryChange);
            window.removeEventListener('settings_changed', handleInventoryChange);
            window.removeEventListener('socket_reconnected', handleInventoryChange);
            showCatalogActions.value = false;
            if (productSearchTimer) { clearTimeout(productSearchTimer); productSearchTimer = null; }
        });

        onUnmounted(() => {
            cancelInventoryRead();
            window.removeEventListener('inventory_changed', handleInventoryChange);
            window.removeEventListener('settings_changed', handleInventoryChange);
            window.removeEventListener('socket_reconnected', handleInventoryChange);
            showCatalogActions.value = false;
            if (productSearchTimer) clearTimeout(productSearchTimer);
        });

        const filteredCategories = computed(() => {
            if (!searchQuery.value) return categories.value;
            const q = searchQuery.value.toLowerCase();
            return categories.value.filter(c => c.name.toLowerCase().includes(q));
        });

        // Category tree for select dropdown hierarchy (recursive traversal).
        // Children are indexed by parent once so the traversal is O(n) rather
        // than filtering the full list at every node.
        const ROOT_KEY = '__root__';
        const popoverCategoriesTree = computed(() => {
            const list = [];

            const childrenByParent = new Map();
            for (const c of categories.value) {
                const key = (!c.parent_id || c.parent_id == 0) ? ROOT_KEY : String(c.parent_id);
                if (!childrenByParent.has(key)) childrenByParent.set(key, []);
                childrenByParent.get(key).push(c);
            }

            const traverse = (parentKey, depth) => {
                const children = childrenByParent.get(parentKey) || [];

                children.sort((a, b) => a.name.localeCompare(b.name));

                for (const child of children) {
                    let prefix = "";
                    if (depth > 0) {
                        prefix = "\u00A0\u00A0".repeat(depth) + "└─ ";
                    }
                    let label = child.name;
                    if (child.is_notes === 1) {
                        label += ` (${t('Notes')})`;
                    }
                    
                    list.push({
                        ...child,
                        level: depth,
                        treeLabel: prefix + label
                    });
                    
                    traverse(String(child.id), depth + 1);
                }
            };

            traverse(ROOT_KEY, 0);
            return list;
        });

        const productTotalPages = computed(() => productTotalPageCount.value);
        const categoryTotalPages = computed(() => Math.max(1, Math.ceil(filteredCategories.value.length / pageSize.value)));
        const totalPages = computed(() => activeTab.value === 'products' ? productTotalPages.value : categoryTotalPages.value);
        const totalRecords = computed(() => activeTab.value === 'products' ? productTotalRecords.value : filteredCategories.value.length);

        const currentPage = computed({
            get: () => activeTab.value === 'products' ? productCurrentPage.value : categoryCurrentPage.value,
            set: (page) => {
                const next = Math.min(Math.max(Number(page) || 1, 1), totalPages.value);
                if (activeTab.value === 'products') productCurrentPage.value = next;
                else categoryCurrentPage.value = next;
            }
        });

        const categoryOffset = computed(() => (categoryCurrentPage.value - 1) * pageSize.value);
        const paginatedCategories = computed(() => filteredCategories.value.slice(categoryOffset.value, categoryOffset.value + pageSize.value));
        const pageStart = computed(() => totalRecords.value === 0 ? 0 : ((currentPage.value - 1) * pageSize.value) + 1);
        const pageEnd = computed(() => Math.min(currentPage.value * pageSize.value, totalRecords.value));

        const setPage = (page) => {
            const previous = currentPage.value;
            currentPage.value = page;
            if ((activeTab.value === 'products') && previous !== currentPage.value) reload();
        };

        const nextPage = () => setPage(currentPage.value + 1);
        const previousPage = () => setPage(currentPage.value - 1);

        watch(searchQuery, () => {
            productCurrentPage.value = 1;
            categoryCurrentPage.value = 1;
            
            if (productSearchTimer) clearTimeout(productSearchTimer);
            productSearchTimer = setTimeout(() => {
                if (activeTab.value === 'products') reload();
            }, 300);
        });

        watch(pageSize, () => {
            productCurrentPage.value = 1;
            categoryCurrentPage.value = 1;
            if (activeTab.value === 'products') reload();
        });

        watch(activeTab, (tab) => {
            showCatalogActions.value = false;
            if (tab === 'products') {
                statusFilter.value = 'all';
                stockFilter.value = 'all';
                productCurrentPage.value = 1;
                reload();
            }
        });

        watch([categoryFilter, statusFilter, stockFilter, sortBy], () => {
            if (activeTab.value === 'products') {
                productCurrentPage.value = 1;
                reload();
            }
        });

        const buildEligibleParentCategories = (excludedCategoryId) => {
            const result = [];
            const byId = new Map(categories.value.map(c => [String(c.id), c]));
            const isDescendant = (catId, targetId) => {
                let current = byId.get(String(catId));
                const visited = new Set();
                while (current) {
                    const currentId = String(current.id);
                    if (visited.has(currentId)) return false;
                    visited.add(currentId);
                    if (current.parent_id == targetId) return true;
                    current = byId.get(String(current.parent_id));
                }
                return false;
            };

            for (const cat of popoverCategoriesTree.value) {
                if (excludedCategoryId && cat.id == excludedCategoryId) continue;
                if (cat.is_notes === 1) continue;
                if (excludedCategoryId && isDescendant(cat.id, excludedCategoryId)) continue;
                result.push(cat);
            }
            return result;
        };

        const eligibleParentCategories = computed(() => buildEligibleParentCategories(editingCategory.value?.id));
        const eligibleCopyParentCategories = computed(() => buildEligibleParentCategories(copySourceCategory.value?.id));

        const getCategoryName = (id) => {
            const cat = categories.value.find(c => c.id == id);
            if (!cat) return t('Uncategorized');
            const byId = new Map(categories.value.map(category => [String(category.id), category]));
            const parts = [];
            const visited = new Set();
            let current = cat;
            while (current && !visited.has(String(current.id))) {
                visited.add(String(current.id));
                parts.unshift(current.name);
                current = current.parent_id ? byId.get(String(current.parent_id)) : null;
            }
            return parts.join(' > ');
        };

        // --- MODIFIERS ENGINE (kept in parent for parseModCount badge usage) ---
        const parseModCount = (modStr) => {
            if (!modStr) return 0;
            try {
                let arr = JSON.parse(modStr);
                if (typeof arr === 'string') arr = JSON.parse(arr);
                return Array.isArray(arr) ? arr.length : 0;
            } catch(e) { return 0; }
        };

        // --- PRODUCT ACTIONS ---
        const openProductModal = (product = null, tab = 'general') => {
            editingProduct.value = product || null;
            productInitialTab.value = tab;
            showProductModal.value = true;
        };

        const onStockActivated = (state) => {
            if (String(editingProduct.value?.id) === String(state.product_id)) {
                editingProduct.value = { ...editingProduct.value, stock: state.stock, stock_version: state.stock_version, stock_item_id: state.stock_item_id };
            }
            reload();
        };
        const openProductStock = async () => {
            showProductModal.value = false;
            activeTab.value = 'counts';
        };
        const onProductSaved = () => {
            showProductModal.value = false;
            fetchInventory();
        };

        const onBatchProductsSaved = () => {
            activeTab.value = 'products';
            fetchInventory();
        };

        const toggleActive = async (p) => {
            const originalStatus = p.is_active;
            const nextStatus = originalStatus == 1 ? 0 : 1;
            p.is_active = nextStatus;

            try {
                const data = await fetchJson('api/admin/products', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: p.id, is_active: nextStatus })
                });
                if (data.success) {
                    window.showAdminToast(t("Status updated."), "success");
                } else {
                    p.is_active = originalStatus;
                    await window.showAdminAlert(data.message || t("Error toggling status"));
                }
            } catch (e) { 
                p.is_active = originalStatus;
                await window.showAdminAlert(t("Error toggling status due to network error")); 
            }
        };

        const deleteItem = async (id) => {
            const confirmed = await window.showAdminConfirm(
                t("Deactivate this product? It will be hidden from the POS but kept for reporting."),
                t("Delete Product")
            );
            if (!confirmed) return;

            try {
                const data = await fetchJson('api/admin/products', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                });
                if (data.success) {
                    window.showAdminToast(t("Product deleted successfully."), "success");
                    fetchInventory({ silent: true });
                } else {
                    await window.showAdminAlert(data.message || t("Failed to delete product."));
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error."));
            }
        };

        // --- CATEGORY ACTIONS ---
        const openCategoryModal = (category = null) => {
            editingCategory.value = category || null;
            showCategoryModal.value = true;
        };

        const openPriceListModal = (category) => { priceListRoot.value = category; showPriceListModal.value = true; };
        const openCategoryCopyModal = (category) => { copySourceCategory.value = category; showCategoryCopyModal.value = true; };
        const onPriceListSaved = () => { showPriceListModal.value = false; fetchInventory({ silent: true }); };
        const onCategoryCopySaved = () => { showCategoryCopyModal.value = false; fetchInventory(); };

        const onCategorySaved = () => {
            showCategoryModal.value = false;
            fetchInventory();
        };

        const toggleCategoryActive = async (c) => {
            const originalStatus = c.is_active;
            const nextStatus = originalStatus == 1 ? 0 : 1;
            c.is_active = nextStatus;

            try {
                const data = await fetchJson('api/admin/categories', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: c.id,
                        name: c.name,
                        parent_id: c.parent_id || null,
                        is_active: nextStatus,
                        is_notes: Number(c.is_notes) === 1,
                        is_price_list_root: Boolean(c.is_price_list_root)
                    })
                });
                if (data.success) {
                    window.showAdminToast(t("Category status updated."), "success");
                } else {
                    c.is_active = originalStatus;
                    await window.showAdminAlert(data.message || t("Error toggling status"));
                }
            } catch (e) { 
                c.is_active = originalStatus;
                await window.showAdminAlert(t("Error toggling status due to network error")); 
            }
        };

        const deleteCategory = async (id) => {
            const category = categories.value.find(item => item.id == id);
            const message = category?.is_price_list_root
                ? t('Delete this price list? Its categories will return to normal prices, and products directly inside it will become uncategorized.')
                : t('Delete this category? Products inside will become uncategorized.');
            const confirmed = await window.showAdminConfirm(
                message,
                t("Delete Category")
            );
            if (!confirmed) return;

            try {
                const data = await fetchJson('api/admin/categories', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                });
                if (data.success) {
                    window.showAdminToast(t("Category deleted successfully."), "success");
                    fetchInventory({ silent: true });
                } else {
                    await window.showAdminAlert(data.message || t("Failed to delete category."));
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error."));
            }
        };

        return {
            formatBusinessDateTime,
            activeTab, PurchaseInvoicesTab, purchasesTab, StockCountsTab, countsTab, stockTabsEnabled, backToProducts, products, categories, searchQuery, isLoading, filteredCategories, eligibleParentCategories, eligibleCopyParentCategories, popoverCategoriesTree, getCategoryName,
            pageSize, pageSizeOptions, totalRecords, totalPages, currentPage, pageStart, pageEnd, isRtl,
            paginatedCategories, setPage, nextPage, previousPage,
            categoryFilter, statusFilter, stockFilter, hasActiveFilters, clearAllFilters, fetchInventory,
            toggleActive, deleteItem, stockEnabled, recipeLedgerEnabled, lowStockThreshold,
            toggleCategoryActive, deleteCategory,
            parseModCount,

            // Custom Filters Dropdown state
            showCatalogActions,
            sortBy, sortOptions,

            // Product Modal
            showProductModal, showImportModal, editingProduct, productInitialTab, openProductModal, onProductSaved, onStockActivated, openProductStock, onBatchProductsSaved,

            // Category Modal
            showCategoryModal, editingCategory, openCategoryModal, onCategorySaved,
            showPriceListModal, priceListRoot, openPriceListModal, onPriceListSaved,
            showCategoryCopyModal, copySourceCategory, openCategoryCopyModal, onCategoryCopySaved,

            // ERP Upgrades
            exportToCSV
        };
    }}
</script>

<style scoped>
.inventory-page-bar,
.inventory-command-row,
.inventory-page-actions,
.inventory-filter-row,
.inventory-pagination,
.inventory-pagination-summary,
.inventory-pagination-controls {
    display: flex;
    align-items: center;
}

.inventory-page-bar {
    min-height: 38px;
    justify-content: space-between;
    gap: 12px;
}

.inventory-page-context {
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
}

.inventory-page-context h2 {
    color: hsl(var(--foreground));
    font-size: 15px;
    font-weight: 750;
    letter-spacing: -0.01em;
    line-height: 1.2;
}

.inventory-record-count {
    color: hsl(var(--muted-foreground));
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
}

.inventory-page-actions {
    justify-content: flex-end;
    gap: 6px;
}

.inventory-button,
.inventory-back-button {
    height: 36px;
    border: 1px solid hsl(var(--border));
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding-inline: 12px;
    color: hsl(var(--foreground));
    background: hsl(var(--card));
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
}

.inventory-button:hover,
.inventory-back-button:hover {
    background: hsl(var(--muted));
    border-color: #c5c9cc;
}

.inventory-button:focus-visible,
.inventory-back-button:focus-visible,
.inventory-refresh-button:focus-visible,
.inventory-clear-filters:focus-visible,
.inventory-row-actions button:focus-visible,
.inventory-mobile-action:focus-visible,
.inventory-pagination button:focus-visible,
.inventory-search-field input:focus-visible,
.inventory-select-control select:focus-visible,
.inventory-pagination select:focus-visible {
    outline: 2px solid rgba(36, 64, 94, 0.28);
    outline-offset: 1px;
}

.inventory-button--primary {
    color: white;
    background: #24405e;
    border-color: #24405e;
    padding-inline: 15px;
}

.inventory-button--primary:hover {
    color: white;
    background: #1d3450;
    border-color: #1d3450;
}

.inventory-button--quiet {
    color: #3d454b;
    border-color: #cfd3d7;
    background: #f0f2f2;
}

.inventory-button--quiet:hover {
    color: #242a2f;
    border-color: #b8bec3;
    background: #e7e7e7;
}

.inventory-button--quiet:active {
    background: #dfdfdf;
}

.inventory-button--secondary {
    color: #24405e;
    border-color: rgba(36, 64, 94, 0.48);
    background: #dce4ee;
}

.inventory-button--secondary:hover {
    color: #1d3450;
    background: #bcc9dc;
    border-color: #24405e;
}

.inventory-button--secondary:active {
    background: #dce4ee;
}

.inventory-count-badge {
    min-width: 18px;
    height: 18px;
    padding-inline: 5px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #7c4a03;
    background: #f8e4b8;
    font-size: 10px;
    font-weight: 800;
}

.inventory-actions-menu {
    position: absolute;
    inset-inline-start: 0;
    top: calc(100% + 6px);
    z-index: 50;
    width: 184px;
    padding: 5px;
    border: 1px solid #cfd3d7;
    border-radius: 6px;
    background: #ffffff;
    box-shadow: 0 4px 10px rgba(17, 24, 39, 0.12);
}

.inventory-actions-menu button {
    width: 100%;
    min-height: 38px;
    padding-inline: 11px;
    border-radius: 4px;
    color: #30373d;
    background: transparent;
    font-size: 12px;
    font-weight: 650;
    text-align: start;
}

.inventory-actions-menu button:hover,
.inventory-actions-menu button:focus-visible {
    color: #1d3450;
    background: #eef2f7;
    outline: none;
}

.inventory-command-bar {
    padding: 7px;
    border: 1px solid #d7dade;
    border-radius: 7px;
    background: #f6f7f7;
}

.inventory-command-row {
    gap: 7px;
    min-width: 0;
}

.inventory-search-field {
    position: relative;
    flex: 1 1 230px;
    min-width: 180px;
}

.inventory-search-field > i {
    position: absolute;
    inset-inline-start: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: #6e757d;
    font-size: 11px;
    pointer-events: none;
}

.inventory-search-field input {
    width: 100%;
    height: 36px;
    padding-inline-start: 31px;
    padding-inline-end: 31px;
    border: 1px solid #cfd3d7;
    border-radius: 5px;
    color: hsl(var(--foreground));
    background: hsl(var(--card));
    font-size: 12px;
    font-weight: 550;
    outline: none;
}

.inventory-search-field input::placeholder {
    color: #6d747a;
}

.inventory-search-field input:focus {
    border-color: #5c7ca3;
    box-shadow: 0 0 0 2px rgba(36, 64, 94, 0.1);
}

.inventory-search-field input::-webkit-search-cancel-button {
    appearance: none;
}

.inventory-search-field button {
    position: absolute;
    inset-inline-end: 4px;
    top: 3px;
    width: 30px;
    height: 30px;
    border-radius: 4px;
    color: #6b737b;
    font-size: 11px;
}

.inventory-search-field button:hover {
    color: hsl(var(--foreground));
    background: hsl(var(--muted));
}

.inventory-filter-row {
    flex: 1 1 auto;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
}

.inventory-select-control {
    flex: 0 1 116px;
    min-width: 96px;
}

.inventory-select-control--category {
    flex-basis: 152px;
    min-width: 118px;
}

.inventory-select-control--sort {
    flex-basis: 144px;
    min-width: 116px;
}

.inventory-select-control select,
.inventory-pagination select {
    width: 100%;
    height: 36px;
    border: 1px solid #cfd3d7;
    border-radius: 5px;
    padding-inline: 9px 25px;
    color: #343a40;
    background-color: hsl(var(--card));
    font-size: 11px;
    font-weight: 650;
    outline: none;
    text-overflow: ellipsis;
}

.inventory-select-control select:hover,
.inventory-pagination select:hover {
    border-color: #aeb4b9;
}

.inventory-select-control.is-filtered select {
    color: #1d3450;
    border-color: rgba(36, 64, 94, 0.6);
    background-color: #eef2f7;
}

.inventory-clear-filters {
    min-width: max-content;
    height: 34px;
    padding-inline: 7px;
    border-radius: 4px;
    color: #8c3b3b;
    font-size: 11px;
    font-weight: 700;
}

.inventory-clear-filters:hover {
    background: #faeeee;
}

.inventory-refresh-button {
    flex: 0 0 36px;
    width: 36px;
    height: 36px;
    border: 1px solid #cfd3d7;
    border-radius: 5px;
    color: #4b535a;
    background: hsl(var(--card));
    font-size: 11px;
}

.inventory-refresh-button:hover {
    border-color: #aeb4b9;
    background: hsl(var(--muted));
}

.inventory-grid-shell {
    border-radius: 7px;
    box-shadow: none;
}

.inventory-grid-scroll {
    scrollbar-color: #b9bec3 #eef0f1;
    scrollbar-width: thin;
}

.inventory-grid-scroll::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

.inventory-grid-scroll::-webkit-scrollbar-track {
    background: #eef0f1;
}

.inventory-grid-scroll::-webkit-scrollbar-thumb {
    border: 2px solid #eef0f1;
    border-radius: 4px;
    background: #b9bec3;
}

.inventory-grid-scroll::-webkit-scrollbar-thumb:hover {
    background: #969da3;
}

.inventory-data-grid {
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
}

.inventory-data-grid thead {
    background: #eef0f1;
    box-shadow: inset 0 -1px 0 #cfd3d7;
}

.inventory-data-grid th {
    height: 38px;
    padding-inline: 14px;
    color: #596168;
    font-size: 10.5px;
    font-weight: 750;
    letter-spacing: 0.01em;
    text-align: start;
    white-space: nowrap;
}

.inventory-data-grid td {
    height: 53px;
    padding: 6px 14px;
    border-bottom: 1px solid #e5e7e9;
    color: hsl(var(--foreground));
    font-size: 12px;
    vertical-align: middle;
}

.inventory-data-grid tbody tr:nth-child(even) {
    background: #fbfcfc;
}

.inventory-data-grid tbody tr:hover {
    background: #eef2f7;
}

.inventory-data-grid tbody tr:last-child td {
    border-bottom: 0;
}

.inventory-data-grid th:last-child,
.inventory-data-grid td:last-child {
    position: sticky;
    inset-inline-end: 0;
    z-index: 2;
    border-inline-start: 1px solid #e1e4e6;
    background: hsl(var(--card));
}

.inventory-data-grid th:last-child {
    z-index: 12;
    background: #eef0f1;
}

.inventory-data-grid tbody tr:nth-child(even) td:last-child {
    background: #fbfcfc;
}

.inventory-data-grid tbody tr:hover td:last-child {
    background: #eef2f7;
}

.inventory-product-name {
    min-width: 0;
    overflow: hidden;
    color: #171b1f;
    font-size: 12.5px;
    font-weight: 720;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.inventory-color-dot {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border: 1px solid rgba(0, 0, 0, 0.14);
    border-radius: 2px;
}

.inventory-product-meta {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    margin-top: 3px;
    color: #6f767b;
    font-size: 9.5px;
    font-weight: 550;
    line-height: 1.1;
}

.inventory-product-meta span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.inventory-category-text {
    display: block;
    overflow: hidden;
    color: #515960;
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.inventory-price-cell,
.inventory-stock-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
}

.inventory-price-cell > span {
    color: #343a40;
    font-size: 10px;
    font-weight: 600;
}

.inventory-price-cell strong,
.inventory-stock-cell strong {
    color: #171b1f;
    font-size: 12.5px;
    font-weight: 760;
}

.inventory-price-cell small,
.inventory-stock-cell small {
    color: #6f767b;
    font-size: 9px;
    font-weight: 600;
}

.inventory-stock-cell.is-low strong,
.inventory-stock-cell.is-low small {
    color: #9a5d06;
}

.inventory-stock-cell.is-out strong,
.inventory-stock-cell.is-out small {
    color: #a53b3b;
}

.inventory-muted-value {
    color: #6d7479;
    font-size: 10px;
    font-weight: 600;
}

.inventory-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #697178;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
}

.inventory-status > span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #a9afb4;
}

.inventory-status.is-active {
    color: #176b4d;
}

.inventory-status.is-active > span {
    background: #2d9b6c;
}

.inventory-row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
}

.inventory-row-actions button {
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #626a71;
    font-size: 10px;
}

.inventory-row-actions button:hover {
    color: #20262b;
    border-color: #d5d9dc;
    background: #f4f5f5;
}

.inventory-row-actions button.is-danger:hover,
.inventory-mobile-action.is-danger:hover {
    color: #a53b3b;
    border-color: #efcccc;
    background: #faeeee;
}

.inventory-mobile-list {
    background: #f5f6f6;
}

.inventory-mobile-card {
    padding: 14px;
    border-bottom: 1px solid #dfe2e4;
    background: hsl(var(--card));
}

.inventory-mobile-card:last-child {
    border-bottom: 0;
}

.inventory-mobile-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 42px 42px;
    gap: 6px;
    padding-top: 4px;
}

.inventory-mobile-action {
    min-width: 42px;
    height: 42px;
    border: 1px solid #d3d7da;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: #40474e;
    background: #f7f8f8;
    font-size: 11px;
    font-weight: 700;
}

.inventory-mobile-action:hover {
    background: #eef0f1;
}

.inventory-mobile-action.is-danger {
    color: #a53b3b;
}

.inventory-pagination {
    min-height: 46px;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-top: 1px solid #d5d8db;
    background: #f4f5f5;
}

.inventory-pagination-summary,
.inventory-pagination-controls {
    gap: 10px;
    color: #626a71;
    font-size: 10.5px;
    font-weight: 600;
}

.inventory-pagination-summary p span {
    color: #252b30;
    font-weight: 750;
}

.inventory-pagination-summary label {
    display: flex;
    align-items: center;
    gap: 6px;
}

.inventory-pagination select {
    width: 62px;
    height: 30px;
    padding-inline: 7px;
    font-size: 10px;
}

.inventory-pagination-controls button {
    width: 32px;
    height: 32px;
    border: 1px solid #cfd3d7;
    border-radius: 5px;
    color: #41494f;
    background: hsl(var(--card));
    font-size: 10px;
}

.inventory-pagination-controls button:hover:not(:disabled) {
    border-color: #aeb4b9;
    background: #e9ebec;
}

.inventory-pagination-controls button:disabled {
    opacity: 0.38;
    cursor: not-allowed;
}

.inventory-pagination-controls strong {
    color: #252b30;
}

@media (max-width: 1100px) and (min-width: 768px) {
    .inventory-data-grid {
        min-width: 820px;
    }

    .inventory-search-field {
        flex-basis: 180px;
    }

    .inventory-select-control {
        flex-basis: 102px;
        min-width: 86px;
    }

    .inventory-select-control--category,
    .inventory-select-control--sort {
        flex-basis: 122px;
        min-width: 100px;
    }

    .inventory-clear-filters {
        max-width: 76px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

@media (max-width: 767px) {
    .inventory-page-bar {
        align-items: stretch;
        flex-direction: column;
    }

    .inventory-page-context {
        min-height: 30px;
    }

    .inventory-page-actions {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
        width: 100%;
    }

    .inventory-page-actions > .relative,
    .inventory-page-actions > .relative .inventory-button {
        width: 100%;
    }

    .inventory-button,
    .inventory-back-button {
        min-height: 42px;
    }

    .inventory-command-row {
        align-items: stretch;
        flex-direction: column;
    }

    .inventory-search-field {
        flex: none;
        width: 100%;
        min-width: 0;
    }

    .inventory-search-field input,
    .inventory-select-control select,
    .inventory-refresh-button {
        height: 42px;
    }

    .inventory-search-field button {
        top: 6px;
    }

    .inventory-filter-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        width: 100%;
    }

    .inventory-select-control,
    .inventory-select-control--category,
    .inventory-select-control--sort {
        min-width: 0;
    }

    .inventory-clear-filters {
        min-height: 42px;
        border: 1px solid #ecd2d2;
        background: #fff8f8;
    }

    .inventory-refresh-button {
        width: 100%;
    }

    .inventory-grid-shell {
        border-radius: 6px;
    }

    .inventory-pagination {
        align-items: stretch;
        flex-direction: column;
    }

    .inventory-pagination-summary,
    .inventory-pagination-controls {
        justify-content: space-between;
    }
}

@media (max-width: 420px) {
    .inventory-page-actions {
        grid-template-columns: 74px minmax(0, 1fr);
    }

    .inventory-page-actions .inventory-button--primary {
        grid-column: 1 / -1;
    }

    .inventory-mobile-actions {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 42px 42px;
    }
}

@media (prefers-reduced-motion: reduce) {
    .inventory-data-grid *,
    .inventory-command-bar *,
    .inventory-page-bar * {
        scroll-behavior: auto !important;
        transition: none !important;
    }
}
</style>

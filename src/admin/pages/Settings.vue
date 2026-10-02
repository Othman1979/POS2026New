<template>

        <div class="h-full flex flex-col font-sans animate-fade-in text-foreground bg-background relative space-y-5 pb-6">

            <transition name="toast">
                <div v-if="toastMessage" role="status" aria-live="polite" class="fixed top-6 left-1/2 transform -translate-x-1/2 z-[200] bg-card text-foreground px-4 py-2.5 rounded-lg shadow-md flex items-center gap-2.5 text-xs font-semibold border border-zinc-300">
                    <i class="fa-solid fa-circle-check text-teal-600"></i> {{ toastMessage }}
                </div>
            </transition>

            <!-- Underline tab bar + actions -->
            <div class="flex items-end justify-between gap-3 border-b border-zinc-300 shrink-0">
                <div role="tablist" class="flex items-stretch gap-6 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    <button role="tab" :aria-selected="activeTab === 'general'" @click="activeTab = 'general'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'general' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        <i class="fa-solid fa-store me-1.5 opacity-70"></i>{{ $t('General') }}
                    </button>
                    <button role="tab" :aria-selected="activeTab === 'deviceAccess'" @click="activeTab = 'deviceAccess'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'deviceAccess' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        <i class="fa-solid fa-shield-halved me-1.5 opacity-70"></i>{{ $t('Device access') }}
                    </button>
                    <button role="tab" :aria-selected="activeTab === 'hardware'" @click="activeTab = 'hardware'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'hardware' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        <i class="fa-solid fa-print me-1.5 opacity-70"></i>{{ $t('Printers') }}
                    </button>
                    <button role="tab" :aria-selected="activeTab === 'printQueue'" @click="activeTab = 'printQueue'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'printQueue' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        <i class="fa-solid fa-list-check me-1.5 opacity-70"></i>{{ $t('Print queue') }}
                    </button>
                    <button role="tab" :aria-selected="activeTab === 'orders'" @click="activeTab = 'orders'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'orders' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        <i class="fa-solid fa-layer-group me-1.5 opacity-70"></i>{{ $t('Order types') }}
                    </button>
                    <button role="tab" :aria-selected="activeTab === 'jofotara'" @click="activeTab = 'jofotara'" :class="['relative px-1 py-3 border-b-2 -mb-px text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', activeTab === 'jofotara' ? 'border-teal-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground']">
                        {{ $t('Electronic invoicing') }}
                    </button>
                </div>

                <div class="flex items-center gap-2 pb-2 shrink-0">
                    <button v-if="activeTab === 'general'" @click="saveSettings" :disabled="isSaving || loadFailed" class="h-9 px-4 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                        <i v-if="isSaving" class="fa-solid fa-circle-notch fa-spin"></i>
                        <i v-else class="fa-solid fa-floppy-disk"></i> <span>{{ $t('Save settings') }}</span>
                    </button>

                    <button v-if="activeTab === 'hardware'" @click="editPrinter(null)" class="h-9 px-4 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors text-xs flex items-center justify-center gap-2">
                        <i class="fa-solid fa-plus text-[10px]"></i> <span>{{ $t('Add printer') }}</span>
                    </button>

                    <button v-if="activeTab === 'orders'" @click="editOrderType(null)" class="h-9 px-4 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors text-xs flex items-center justify-center gap-2">
                        <i class="fa-solid fa-plus text-[10px]"></i> <span>{{ $t('Add order type') }}</span>
                    </button>

                    <button v-if="activeTab === 'jofotara'" @click="saveJofotaraSettings" :disabled="jofotaraSaving" class="h-9 px-4 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                        {{ $t('Save settings') }}
                    </button>

                    <button @click="loadData" class="h-9 w-9 flex items-center justify-center bg-muted border border-zinc-300 hover:bg-zinc-200 text-foreground rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                </div>
            </div>

            <!-- Loader -->
            <div v-if="isLoading" class="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-card border border-zinc-300 rounded-xl p-20">
                <i class="fa-solid fa-circle-notch fa-spin text-3xl mb-4 text-teal-600"></i>
                <p class="text-xs font-semibold">{{ $t('Loading settings…') }}</p>
            </div>

            <!-- Content -->
            <template v-else>
                <!-- 1. GENERAL TAB -->
                <DeviceAccessSettings v-if="activeTab === 'deviceAccess'" />

                <div v-if="activeTab === 'general'" class="flex-1 overflow-y-auto premium-scroll bg-card border border-zinc-300 rounded-xl">
                    <div v-if="loadFailed" class="m-6 mb-0 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2">
                        <i class="fa-solid fa-triangle-exclamation"></i>{{ $t('Could not load current settings. Refresh before making changes.') }}
                    </div>
                    <div class="p-6 space-y-8 max-w-4xl">

                        <!-- Store details -->
                        <section class="space-y-5">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-store text-muted-foreground"></i> {{ $t('Store details') }}
                            </h3>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Store name') }}</label>
                                    <input type="text" v-model="storeName" :placeholder="$t('e.g. POS Cafe')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9">
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Phone') }}</label>
                                    <input type="text" v-model="storePhone" placeholder="(555) 123-4567" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                                </div>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Address') }}</label>
                                <textarea v-model="storeAddress" rows="2" :placeholder="$t('Street, City, Zip')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground resize-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">{{ $t('Logo') }}</label>
                                <div class="flex items-center gap-4">
                                    <div class="w-12 h-12 rounded-lg bg-muted border border-zinc-300 flex items-center justify-center overflow-hidden shrink-0">
                                        <img v-if="storeIcon" :src="storeIcon + '?v=' + iconVersion" class="w-full h-full object-contain" />
                                        <i v-else class="fa-solid fa-image text-muted-foreground text-lg"></i>
                                    </div>
                                    <div class="flex flex-col gap-1.5">
                                        <div class="flex items-center gap-2">
                                            <label class="h-8 px-3 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors text-[11px] flex items-center justify-center gap-1.5 cursor-pointer">
                                                <input type="file" ref="fileInput" @change="handleIconUpload" accept="image/png,image/jpeg,image/x-icon,image/webp" class="hidden" :disabled="isUploadingIcon">
                                                <i v-if="isUploadingIcon" class="fa-solid fa-circle-notch fa-spin"></i>
                                                <i v-else class="fa-solid fa-upload"></i>
                                                <span>{{ $t('Upload') }}</span>
                                            </label>
                                            <button v-if="storeIcon" @click="handleIconRemove" type="button" class="h-8 px-3 bg-muted border border-zinc-300 text-foreground font-semibold rounded-lg hover:bg-rose-100 hover:text-rose-600 hover:border-rose-200 transition-colors text-[11px] flex items-center justify-center gap-1.5">
                                                <i class="fa-solid fa-trash"></i>
                                                <span>{{ $t('Remove') }}</span>
                                            </button>
                                        </div>
                                        <p class="text-[10px] text-muted-foreground font-medium">{{ $t('PNG, JPG, ICO or WEBP — max 1 MB') }}</p>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- Language -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-language text-muted-foreground"></i> {{ $t('Language') }}
                            </h3>
                            <p class="text-xs text-muted-foreground">{{ $t('Choose the admin language and layout direction.') }}</p>
                            <div class="grid grid-cols-2 gap-3 max-w-md">
                                <button v-for="option in languageChoices" :key="option.value" type="button" @click="selectLanguage(option.value)" :aria-pressed="adminLanguage === option.value"
                                    :class="['p-4 rounded-lg border transition-colors text-start flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40', adminLanguage === option.value ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-zinc-300 bg-muted text-foreground hover:bg-zinc-200']">
                                    <span class="text-sm font-semibold">{{ option.nativeLabel }}</span>
                                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ option.label }}</span>
                                </button>
                            </div>
                        </section>

                        <!-- POS options -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-sliders text-muted-foreground"></i> {{ $t('POS options') }}
                            </h3>

                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', barcodeEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-barcode text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Barcode scanning') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Listens for scanner keystrokes anywhere.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="barcodeEnabled" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', quickNumpadMode ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-calculator text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Quick numpad mode') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Enter an amount, then choose a product. Press × first to enter a quantity.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="quickNumpadMode" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', quantityPresetsEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-gauge-high text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Quantity preset buttons') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Show 0.125, 0.25, 0.5 and 0.75 above the keypad.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="quantityPresetsEnabled" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', tablesEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-utensils text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Table management') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Track orders by table.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="tablesEnabled" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', stockEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-boxes-stacked text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Stock management') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Enforce inventory limits and out-of-stock.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="stockEnabled" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', recipeLedgerEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-carrot text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Recipe ingredients') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Records recipe ingredients per sale, with optional costs and counts. Does not affect product stock and never blocks a sale.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="recipeLedgerEnabled" class="accent-teal-600 w-4 h-4">
                                </label>

                                <p class="text-xs text-muted-foreground sm:col-span-2">{{ $t('Tracking is optional. Turning it off keeps history and clears balance certainty. Count stock after resuming only if you need accurate remaining quantities.') }}</p>

                                <div v-if="stockEnabled" class="flex items-center justify-between gap-3 p-4 rounded-lg border border-zinc-300 bg-muted/40">
                                    <div>
                                        <span class="text-xs font-semibold block text-foreground">{{ $t('Low stock threshold') }}</span>
                                        <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Products at or below this level trigger alerts.') }}</span>
                                    </div>
                                    <input type="number" v-model="lowStockThreshold" min="1" step="1" class="w-20 bg-card border border-zinc-300 rounded-lg py-1.5 px-3 text-xs font-bold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none text-center tabular-nums">
                                </div>

                                <div class="flex items-center justify-between gap-3 p-4 rounded-lg border border-zinc-300 bg-muted/40">
                                    <div>
                                        <span class="text-xs font-semibold block text-foreground">{{ $t('First-shift starting cash (JD)') }}</span>
                                        <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Prefills the first shifts of each business day. Cashiers can change it before opening.') }}</span>
                                    </div>
                                    <input type="number" v-model="firstShiftStartingCash" min="0" max="99999999.99" step="0.01" class="w-28 bg-card border border-zinc-300 rounded-lg py-1.5 px-3 text-xs font-bold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none text-center tabular-nums">
                                </div>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', taxInclusivePricing ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-receipt text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Tax-inclusive customer receipts') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Customer receipts show item prices including tax and hide separate subtotal and tax rows. Tax is still calculated and recorded.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="taxInclusivePricing" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label class="flex items-center justify-between gap-3 p-4 rounded-lg border border-zinc-300 cursor-pointer">
                                    <div>
                                        <span class="text-xs font-semibold block text-foreground">{{ $t('Separate order numbers by order type') }}</span>
                                        <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Each type has its own daily sequence: A-1, B-1, C-1. Letters follow the order-type list. Existing ticket numbers stay unchanged.') }}</span>
                                    </div>
                                    <input type="checkbox" v-model="orderTypeNumbering" class="accent-teal-600 w-4 h-4 shrink-0">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', useInvoiceNoOnly ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-hashtag text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Receipt layout: show invoice line only') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Hide order number and rely on the invoice sequence.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="useInvoiceNoOnly" class="accent-teal-600 w-4 h-4">
                                </label>

                                <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', serviceChargeEnabled ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                    <div class="flex items-center gap-3">
                                        <i class="fa-solid fa-percent text-lg text-muted-foreground"></i>
                                        <div>
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Service charge') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Add a service fee to orders.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="serviceChargeEnabled" class="accent-teal-600 w-4 h-4">
                                </label>
                            </div>

                            <div v-if="serviceChargeEnabled" class="p-4 bg-muted/40 rounded-lg border border-zinc-200 animate-fade-in max-w-md grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Service charge (%)') }}</label>
                                    <input type="number" v-model="serviceChargePercentage" min="0" max="100" step="0.0001" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-xs font-bold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none h-9 text-center tabular-nums">
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Tax on service fee (%)') }}</label>
                                    <input type="number" v-model="serviceChargeTaxRate" min="0" max="100" step="0.01" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-xs font-bold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none h-9 text-center tabular-nums">
                                </div>
                                <div v-if="Number(serviceChargeTaxRate || 0) === 0">
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Service charge JoFotara treatment') }}</label>
                                    <select v-model="serviceChargeTaxCategory" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-xs font-bold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none h-9">
                                        <option value="O">{{ $t('Zero-rated (O)') }}</option>
                                        <option value="Z">{{ $t('Tax-exempt (Z)') }}</option>
                                    </select>
                                </div>
                                <label v-if="tablesEnabled" :class="['col-span-2 flex items-center justify-between gap-4 p-3 rounded-lg border cursor-pointer transition-colors', autoApplyServiceCharge ? 'bg-teal-50/70 border-teal-300' : 'bg-card border-zinc-300 hover:bg-zinc-50']">
                                    <div class="flex items-center gap-3 min-w-0">
                                        <i class="fa-solid fa-bell-concierge text-teal-600" aria-hidden="true"></i>
                                        <div class="min-w-0">
                                            <span class="text-xs font-semibold block text-foreground">{{ $t('Add service charge to table orders automatically') }}</span>
                                            <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('New table orders show the service charge as soon as items are added.') }}</span>
                                        </div>
                                    </div>
                                    <input type="checkbox" v-model="autoApplyServiceCharge" class="accent-teal-600 w-4 h-4 shrink-0">
                                </label>
                            </div>

                            <div v-if="tablesEnabled" class="p-4 bg-muted/40 rounded-lg border border-zinc-200 animate-fade-in max-w-md">
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Table mode') }}</label>
                                <select v-model="tableMode" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option value="fixed">{{ $t('Fixed floor plan') }}</option>
                                    <option value="dynamic">{{ $t('Dynamic tabs') }}</option>
                                </select>
                            </div>
                        </section>

                        <!-- Printing -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-print text-muted-foreground"></i> {{ $t('Printing') }}
                            </h3>
                            <div class="max-w-md">
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Print method') }}</label>
                                <select v-model="printMethod" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option value="browser">{{ $t('Browser printing (Ctrl+P / AirPrint)') }}</option>
                                    <option value="backend">{{ $t('Local print server (silent)') }}</option>
                                </select>
                                <p class="text-[10px] text-muted-foreground mt-2 leading-relaxed">{{ $t('For silent printing, set up your printers in the Printers tab and run the local print service.') }}</p>
                            </div>

                            <label v-if="printMethod === 'backend'" :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors max-w-md', duplicateCustomerReceipt ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                <div class="flex items-center gap-3">
                                    <i class="fa-solid fa-copy text-lg text-muted-foreground"></i>
                                    <div>
                                        <span class="text-xs font-semibold block text-foreground">{{ $t('Print customer receipt twice') }}</span>
                                        <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Automatically print a second copy of the customer receipt at checkout.') }}</span>
                                    </div>
                                </div>
                                <input type="checkbox" v-model="duplicateCustomerReceipt" class="accent-teal-600 w-4 h-4">
                            </label>
                        </section>

                        <!-- Maintenance -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <div class="max-w-2xl rounded-xl border border-rose-200 bg-rose-50/70 p-5">
                                <h3 class="font-display font-semibold text-xs text-rose-800 flex items-center gap-2">
                                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                                    {{ $t('Reset operational data') }}
                                </h3>
                                <div class="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup">
                                    <label :class="['flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-xs', maintenanceScope === 'operational' ? 'border-rose-400 bg-card' : 'border-rose-200']">
                                        <input type="radio" value="operational" v-model="maintenanceScope" class="accent-rose-600 mt-0.5">
                                        <span>
                                            <span class="font-semibold block text-rose-800">{{ $t('Operational data only') }}</span>
                                            <span class="text-rose-700 leading-relaxed block mt-0.5">{{ $t('Clears orders, held orders, shifts, expenses, JoFotara documents and print history. Products, categories, customers, users and settings stay intact.') }}</span>
                                        </span>
                                    </label>
                                    <label :class="['flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-xs', maintenanceScope === 'factory' ? 'border-rose-400 bg-card' : 'border-rose-200']">
                                        <input type="radio" value="factory" v-model="maintenanceScope" class="accent-rose-600 mt-0.5">
                                        <span>
                                            <span class="font-semibold block text-rose-800">{{ $t('Full reset (fresh start)') }}</span>
                                            <span class="text-rose-700 leading-relaxed block mt-0.5">{{ $t('Also deletes all products, categories, packs, ingredients, recipes, suppliers, customers, purchase invoices, stock counts, stock movements and the activity log. Users, permissions, settings, order types, tables and printers stay.') }}</span>
                                        </span>
                                    </label>
                                </div>
                                <p class="mt-1 text-[10px] font-semibold text-rose-700">
                                    {{ $t('Use only while terminals are idle, then reload each POS terminal.') }}
                                </p>
                                <form class="mt-4 flex flex-col sm:flex-row gap-2" @submit.prevent="resetOperationalData">
                                    <input
                                        v-model="maintenancePassword"
                                        type="password"
                                        autocomplete="new-password"
                                        :placeholder="$t('Maintenance password')"
                                        class="h-9 flex-1 bg-card border border-rose-200 rounded-lg px-3 text-xs font-semibold text-foreground focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 outline-none"
                                    >
                                    <button
                                        type="submit"
                                        :disabled="maintenanceResetting || !maintenancePassword"
                                        class="h-9 px-4 rounded-lg bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                                    >
                                        <i v-if="maintenanceResetting" class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
                                        <i v-else class="fa-solid fa-trash-can" aria-hidden="true"></i>
                                        {{ maintenanceScope === 'factory' ? $t('Reset the whole system') : $t('Reset operational data') }}
                                    </button>
                                </form>
                            </div>
                        </section>
                    </div>
                </div>

                <!-- 2. PRINTERS TAB -->
                <div v-if="activeTab === 'hardware'" class="bg-card border border-zinc-300 rounded-xl overflow-hidden flex-1 flex flex-col relative">
                    <!-- Desktop -->
                    <div class="hidden md:block overflow-x-auto overflow-y-auto premium-scroll flex-1">
                        <table class="w-full text-start min-w-[900px]">
                            <thead class="sticky top-0 bg-zinc-200/80 backdrop-blur border-b border-zinc-300 z-10">
                                <tr>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Printer') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Connection') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Role') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Categories') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end">{{ $t('Actions') }}</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-zinc-200 text-foreground">
                                <tr v-if="printers.length === 0">
                                    <td colspan="5" class="py-20 text-center text-muted-foreground">
                                        <i class="fa-solid fa-print text-4xl mb-4 opacity-30"></i>
                                        <p class="font-medium text-sm">{{ $t('No printers configured.') }}</p>
                                    </td>
                                </tr>
                                <tr v-for="p in printers" :key="p.id" class="even:bg-muted/50 hover:bg-teal-50/60 transition-colors">
                                    <td class="py-2.5 px-4">
                                        <div class="flex items-center gap-3">
                                            <div class="w-8 h-8 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center shrink-0">
                                                <i class="fa-solid fa-print text-xs"></i>
                                            </div>
                                            <div>
                                                <p class="font-semibold text-foreground text-xs" data-no-i18n>{{ p.name }}</p>
                                                <p class="text-[10px] font-medium text-muted-foreground mt-0.5">{{ $t(p.type === 'network' ? 'Network' : 'Windows') }}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="py-2.5 px-4">
                                        <div v-if="p.type === 'network'" class="text-xs font-semibold text-foreground"><i class="fa-solid fa-network-wired text-muted-foreground me-1.5"></i><span data-no-i18n class="tabular-nums">{{ p.network_ip }}:{{ p.network_port }}</span></div>
                                        <div v-else class="text-xs font-semibold text-foreground"><i class="fa-brands fa-windows text-muted-foreground me-1.5"></i><span data-no-i18n>{{ p.windows_name }}</span></div>
                                        <div class="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                                            <span class="font-semibold">{{ $t('Print station') }}:</span>
                                            <span class="bg-muted border border-zinc-200 px-1.5 py-0.5 rounded text-[10px]" data-no-i18n>{{ p.spooler_id || 'primary' }}</span>
                                        </div>
                                    </td>
                                    <td class="py-2.5 px-4 text-center">
                                        <span v-if="p.role === 'receipt'" class="bg-muted border border-zinc-200 text-foreground px-2 py-0.5 rounded-md text-[10px] font-semibold">{{ $t('Receipts') }}</span>
                                        <span v-else class="bg-muted border border-zinc-200 text-muted-foreground px-2 py-0.5 rounded-md text-[10px] font-semibold">{{ $t('Kitchen/Prep') }}</span>
                                    </td>
                                    <td class="py-2.5 px-4">
                                        <span v-if="p.role === 'receipt'" class="text-[10px] font-medium text-muted-foreground/60">{{ $t('N/A') }}</span>
                                        <span v-else-if="!p.categories || p.categories.length === 0" class="text-[10px] font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">{{ $t('No categories') }}</span>
                                        <div v-else class="flex flex-wrap gap-1">
                                            <span v-for="catId in p.categories" :key="catId" class="bg-muted text-foreground border border-zinc-200 px-1.5 py-0.5 rounded text-[10px] font-medium">
                                                <span data-no-i18n>{{ getCategoryName(catId) }}</span>
                                            </span>
                                        </div>
                                    </td>
                                    <td class="py-2.5 px-4 text-end">
                                        <div class="flex justify-end gap-1">
                                            <button @click="editPrinter(p)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[11px]"></i></button>
                                            <button @click="deletePrinter(p.id)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors flex items-center justify-center"><i class="fa-solid fa-trash text-[11px]"></i></button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Mobile -->
                    <div class="block md:hidden overflow-y-auto premium-scroll flex-1 p-4 space-y-3">
                        <div v-if="printers.length === 0" class="py-20 text-center text-muted-foreground">
                            <i class="fa-solid fa-print text-4xl mb-4 opacity-30"></i>
                            <p class="font-medium text-sm">{{ $t('No printers configured.') }}</p>
                        </div>
                        <div v-for="p in printers" :key="p.id" class="bg-card border border-zinc-300 rounded-xl p-4 flex flex-col gap-3">
                            <div class="flex justify-between items-start">
                                <div class="flex items-center gap-3">
                                    <div class="w-8 h-8 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center text-xs">
                                        <i class="fa-solid fa-print"></i>
                                    </div>
                                    <div>
                                        <span class="font-semibold text-foreground text-sm" data-no-i18n>{{ p.name }}</span>
                                        <div class="text-[10px] text-muted-foreground mt-0.5">{{ $t(p.type === 'network' ? 'Network' : 'Windows') }}</div>
                                    </div>
                                </div>
                                <div class="flex justify-end gap-1 shrink-0">
                                    <button @click="editPrinter(p)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[11px]"></i></button>
                                    <button @click="deletePrinter(p.id)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors flex items-center justify-center"><i class="fa-solid fa-trash text-[11px]"></i></button>
                                </div>
                            </div>
                            <div class="text-[10px] text-muted-foreground border-t border-zinc-200 pt-2 flex flex-col gap-1.5">
                                <div class="flex items-center justify-between">
                                    <span class="font-semibold text-muted-foreground">{{ $t('Connection') }}:</span>
                                    <span v-if="p.type === 'network'" class="text-foreground font-semibold tabular-nums" data-no-i18n>{{ p.network_ip }}:{{ p.network_port }}</span>
                                    <span v-else class="text-foreground font-semibold" data-no-i18n>{{ p.windows_name }}</span>
                                </div>
                                <div class="flex items-center justify-between">
                                    <span class="font-semibold text-muted-foreground">{{ $t('Role') }}:</span>
                                    <span class="bg-muted border border-zinc-200 text-foreground px-2 py-0.5 rounded text-[10px] font-semibold">{{ p.role === 'receipt' ? $t('Receipts') : $t('Kitchen/Prep') }}</span>
                                </div>
                                <div class="flex items-center justify-between">
                                    <span class="font-semibold text-muted-foreground">{{ $t('Print station') }}:</span>
                                    <span class="text-foreground font-semibold" data-no-i18n>{{ p.spooler_id || 'primary' }}</span>
                                </div>
                                <div v-if="p.role === 'kitchen'" class="flex flex-col gap-1">
                                    <span class="font-semibold text-muted-foreground mb-0.5">{{ $t('Categories') }}:</span>
                                    <div class="flex flex-wrap gap-1">
                                        <span v-for="catId in p.categories" :key="catId" class="bg-muted text-foreground border border-zinc-200 px-1.5 py-0.5 rounded text-[10px] font-medium">
                                            <span data-no-i18n>{{ getCategoryName(catId) }}</span>
                                        </span>
                                        <span v-if="!p.categories || p.categories.length === 0" class="text-[10px] text-rose-600">{{ $t('No categories') }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="activeTab === 'jofotara'" class="bg-card border border-zinc-300 rounded-xl overflow-y-auto premium-scroll flex-1">
                    <div class="max-w-3xl p-6 space-y-6">
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 pb-5">
                            <div>
                                <h3 class="text-sm font-semibold text-foreground">{{ $t('Electronic invoicing') }}</h3>
                                <p class="text-xs text-muted-foreground mt-1">{{ $t('Enter the details issued by JoFotara. XML previews do not send anything.') }}</p>
                                <p class="text-[11px] font-semibold mt-2" :class="jofotaraReadiness === 'ready' ? 'text-teal-700' : jofotaraReadiness === 'incomplete' ? 'text-amber-700' : 'text-muted-foreground'">{{ $t(jofotaraReadiness === 'ready' ? 'Ready' : jofotaraReadiness === 'incomplete' ? 'Incomplete' : 'Disabled') }}</p>
                            </div>
                            <label class="flex items-center gap-3 text-xs font-semibold">
                                <span>{{ jofotaraForm.enabled ? $t('Enabled') : $t('Disabled') }}</span>
                                <input v-model="jofotaraForm.enabled" type="checkbox" class="w-4 h-4 accent-teal-600">
                            </label>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                            <label class="sm:col-span-2 flex items-start justify-between gap-4 rounded-lg border border-zinc-300 bg-muted/30 p-4">
                                <span>
                                    <span class="block text-xs font-semibold text-foreground">{{ $t('Submit new documents automatically') }}</span>
                                    <span class="block mt-1 text-[11px] leading-relaxed text-muted-foreground">{{ $t('Starts with sales and returns created after you enable it. Older, rejected, or uncertain documents always require review.') }}</span>
                                </span>
                                <input v-model="jofotaraForm.auto_submit" type="checkbox" class="w-4 h-4 mt-0.5 accent-teal-600 shrink-0">
                            </label>
                            <label class="sm:col-span-2 flex items-start justify-between gap-4 rounded-lg border border-zinc-300 bg-muted/30 p-4">
                                <span>
                                    <span class="block text-xs font-semibold text-foreground">{{ $t('Archive JoFotara XML files') }}</span>
                                    <span class="block mt-1 text-[11px] leading-relaxed text-muted-foreground">{{ $t('Save every generated XML before sending, including failed submissions.') }}</span>
                                </span>
                                <input v-model="jofotaraForm.archive_xml" type="checkbox" class="w-4 h-4 mt-0.5 accent-teal-600 shrink-0">
                            </label>
                            <label class="space-y-1.5 sm:col-span-2"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Tax registration') }}</span><select v-model="jofotaraForm.tax_registration_type" @change="selectJofotaraProfile" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"><option value="sales_tax">{{ $t('Sales-tax registered') }}</option><option value="income_tax">{{ $t('Income tax only') }}</option></select><p class="text-[11px] text-muted-foreground">{{ $t('This applies to new sales. Saved tables and invoices keep their original tax profile.') }}</p></label>
                            <label class="space-y-1.5"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Client ID') }}</span><input v-model="jofotaraForm.client_id" type="text" autocomplete="off" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"></label>
                            <label class="space-y-1.5"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Secret key') }}</span><input v-model="jofotaraForm.secret_key" type="password" autocomplete="new-password" :placeholder="jofotaraForm.secret_configured ? $t('Saved — leave blank to keep it') : ''" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"></label>
                            <label class="space-y-1.5"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Income source sequence') }}</span><input v-model="jofotaraForm.income_source_sequence" type="text" inputmode="numeric" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"></label>
                            <label class="space-y-1.5"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Seller tax number') }}</span><input v-model="jofotaraForm.seller_tax_number" type="text" inputmode="numeric" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"></label>
                            <label class="space-y-1.5 sm:col-span-2"><span class="text-[11px] font-semibold text-muted-foreground">{{ $t('Registered seller name') }}</span><input v-model="jofotaraForm.seller_registered_name" type="text" class="w-full h-10 px-3 bg-muted border border-zinc-300 rounded-lg text-xs outline-none focus:bg-card focus:border-teal-500"></label>
                        </div>
                        <p class="text-[11px] text-muted-foreground">{{ $t('Fresh installations leave every credential empty.') }}</p>
                    </div>
                </div>

                <!-- 3. PRINT QUEUE TAB -->
                <div v-if="activeTab === 'printQueue'" class="bg-card border border-zinc-300 rounded-xl overflow-hidden flex-1 flex flex-col relative">
                    <div class="overflow-y-auto premium-scroll flex-1 p-5 space-y-5">
                        <div v-if="visibleStations.length" class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            <article v-for="station in visibleStations" :key="station.spooler_id" class="border border-zinc-200 rounded-lg p-4 bg-muted/30">
                                <div class="flex items-start justify-between gap-3">
                                    <div>
                                        <div class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Print station') }}</div>
                                        <div class="mt-1 text-sm font-black text-foreground" data-no-i18n>{{ station.spooler_id }}</div>
                                    </div>
                                    <span :class="['px-2 py-0.5 rounded border text-[10px] font-semibold', statusBadgeClass(station.online ? 'ok' : station.paused ? 'offline' : 'pending')]">
                                        {{ $t(station.paused ? 'Paused' : station.online ? 'Online' : 'Offline') }}
                                    </span>
                                </div>
                                <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
                                    <div><span class="text-muted-foreground">{{ $t('Agent status') }}</span><strong class="block text-foreground">{{ $t(formatQueueLabel(station.agent_status)) }}</strong></div>
                                    <div><span class="text-muted-foreground">{{ $t('Last sync') }}</span><strong class="block text-foreground tabular-nums" data-no-i18n>{{ formatQueueDate(station.last_sync_at) }}</strong></div>
                                    <div><span class="text-muted-foreground">{{ $t('Local queue') }}</span><strong class="block text-foreground tabular-nums" data-no-i18n>{{ station.local_queue_depth ?? '-' }}</strong></div>
                                    <div><span class="text-muted-foreground">{{ $t('Renderer') }}</span><strong class="block text-foreground">{{ $t(formatQueueLabel(station.renderer)) }}</strong></div>
                                    <div><span class="text-muted-foreground">{{ $t('Helper') }}</span><strong class="block text-foreground">{{ $t(formatQueueLabel(station.helper)) }}</strong></div>
                                </div>
                                <div v-if="station.last_error === 'PRINTER_RECOVERY_REQUIRED'" role="alert" class="mt-3 text-sm text-rose-700">{{ $t('Printer recovery required. Check the last ticket and contact support before resuming this printer.') }}</div>
                                <div v-else-if="station.last_error === 'PRINTER_ENDPOINT_OWNERSHIP_CONFLICT'" role="alert" class="mt-3 text-sm text-rose-700">{{ $t('This network printer has conflicting assignments. Remove duplicate entries and keep it on one print station.') }}</div>
                                <div v-else-if="station.last_error" class="mt-3 text-[10px] text-rose-700" data-no-i18n>{{ station.last_error }}</div>
                                <StationHealthNotice :station="station" />
                                <div class="mt-4 flex flex-wrap gap-2">
                                    <button v-if="station.agent_status === 'active'" @click="drainSpoolerStation(station)" :disabled="stationActionId === station.spooler_id" class="h-8 px-3 bg-muted border border-zinc-300 text-foreground rounded-lg hover:bg-zinc-200 text-[10px] font-semibold disabled:opacity-50">{{ $t('Drain station') }}</button>
                                    <button v-if="['active', 'draining'].includes(station.agent_status)" @click="replaceSpoolerStation(station)" :disabled="stationActionId === station.spooler_id" class="h-8 px-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg hover:bg-rose-100 text-[10px] font-semibold disabled:opacity-50">{{ $t('Force replace') }}</button>
                                </div>
                            </article>
                        </div>
                        <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div class="border border-zinc-200 rounded-lg p-4 bg-muted/30">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Spooler') }}</span>
                                    <i :class="['fa-solid fa-circle text-[9px]', printQueueHealth.spooler?.active ? 'text-teal-600' : 'text-rose-600']"></i>
                                </div>
                                <div class="mt-2 text-lg font-black text-foreground">{{ printQueueHealth.spooler?.active ? $t('Online') : $t('Offline') }}</div>
                                <div class="mt-1 text-[10px] text-muted-foreground">{{ printQueueHealth.spooler?.count || 0 }} {{ $t('connected stations') }}</div>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div v-for="state in queueStateCards" :key="state.status" class="border border-zinc-200 rounded-lg p-4 bg-muted/30">
                                <div class="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t(state.label) }}</div>
                                <div class="mt-2 text-lg font-black text-foreground tabular-nums">{{ state.count }}</div>
                            </div>
                        </div>
                        <div v-if="printQueueHealth.stations.length" class="flex justify-end">
                            <button @click="downloadPrintQueueDiagnostics" class="h-8 px-3 bg-muted border border-zinc-300 text-foreground rounded-lg hover:bg-zinc-200 text-[10px] font-semibold">{{ $t('Download diagnostics') }}</button>
                        </div>

                        <section class="space-y-2">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-print text-muted-foreground"></i>{{ $t('Printer status') }}
                            </h3>
                            <div class="overflow-x-auto border border-zinc-200 rounded-lg">
                                <table class="w-full text-start min-w-[560px]">
                                    <thead class="bg-zinc-200/80 border-b border-zinc-300">
                                        <tr>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Printer') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Status') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Last printed') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end">{{ $t('Last error') }}</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-zinc-200 text-foreground">
                                        <tr v-if="printQueueHealth.printers.length === 0">
                                            <td colspan="4" class="py-10 text-center text-xs text-muted-foreground">{{ $t('No printers configured.') }}</td>
                                        </tr>
                                        <tr v-for="printer in printQueueHealth.printers" :key="printer.id" class="even:bg-muted/40">
                                            <td class="py-2.5 px-4">
                                                <div class="font-semibold text-xs" data-no-i18n>{{ printer.name }}</div>
                                                <div class="text-[10px] text-muted-foreground">{{ $t(printer.role === 'kitchen' ? 'Kitchen/Prep' : 'Receipts') }}</div>
                                            </td>
                                            <td class="py-2.5 px-4 text-center">
                                                <span :class="['px-2 py-0.5 rounded border text-[10px] font-semibold', statusBadgeClass(printer.device_status)]">{{ $t(formatQueueLabel(printer.device_status)) }}</span>
                                            </td>
                                            <td class="py-2.5 px-4 text-center text-[10px] font-semibold tabular-nums" data-no-i18n :title="printer.last_printed_at ? formatQueueDate(printer.last_printed_at) : ''">{{ printer.last_printed_at ? formatAgo(printer.last_printed_at) : '-' }}</td>
                                            <td class="py-2.5 px-4 text-end text-[10px] text-muted-foreground" data-no-i18n>
                                                <template v-if="printer.last_error_code">{{ printer.last_error_code }}<span class="block tabular-nums">{{ formatAgo(printer.last_error_at) }}</span></template>
                                                <template v-else>-</template>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </section>

                        <section class="space-y-2">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-clock-rotate-left text-muted-foreground"></i>{{ $t('Recent print jobs') }}
                            </h3>
                            <div class="overflow-x-auto border border-zinc-200 rounded-lg">
                                <table class="w-full text-start min-w-[920px]">
                                    <thead class="bg-zinc-200/80 border-b border-zinc-300">
                                        <tr>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Job') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('State') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Printer') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Duration') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Confidence') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Error') }}</th>
                                            <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end">{{ $t('Actions') }}</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-zinc-200 text-foreground">
                                        <tr v-if="printQueueHealth.recent.length === 0">
                                            <td colspan="7" class="py-10 text-center text-xs text-muted-foreground">{{ $t('No print jobs found.') }}</td>
                                        </tr>
                                        <tr v-for="job in printQueueHealth.recent" :key="job.id" class="even:bg-muted/40">
                                            <td class="py-2.5 px-4">
                                                <div class="font-semibold text-xs tabular-nums" data-no-i18n>#{{ job.id }}</div>
                                                <div class="text-[10px] text-muted-foreground" data-no-i18n>{{ job.print_type || '-' }}</div>
                                            </td>
                                            <td class="py-2.5 px-4 text-center">
                                                <span :class="['px-2 py-0.5 rounded border text-[10px] font-semibold', statusBadgeClass(job.status)]">{{ $t(formatQueueLabel(job.status)) }}</span>
                                            </td>
                                            <td class="py-2.5 px-4 text-center text-xs font-semibold" data-no-i18n>{{ job.printer_id || '-' }}</td>
                                            <td class="py-2.5 px-4 text-center text-xs tabular-nums" data-no-i18n>{{ job.duration_ms == null ? '-' : `${job.duration_ms}ms` }}</td>
                                            <td class="py-2.5 px-4 text-center text-[10px] font-semibold">{{ $t(formatConfidence(job.confidence)) }}</td>
                                            <td class="py-2.5 px-4 text-[10px] text-muted-foreground max-w-[220px] truncate" data-no-i18n>{{ job.last_error || '-' }}</td>
                                            <td class="py-2.5 px-4 text-end space-x-1.5 rtl:space-x-reverse">
                                                <button v-if="['pending', 'sent', 'local_accepted'].includes(job.status)" @click="cancelPrintJob(job)" :disabled="cancelingJobId === job.id" class="h-8 px-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg hover:bg-rose-100 transition-colors text-[10px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
                                                    <i v-if="cancelingJobId === job.id" class="fa-solid fa-circle-notch fa-spin"></i>
                                                    <i v-else class="fa-solid fa-ban"></i>
                                                    <span>{{ $t('Cancel Print') }}</span>
                                                </button>
                                                <button v-if="['acknowledged', 'dead_letter'].includes(job.status)" @click="reprintQueueJob(job)" :disabled="reprintingJobId === job.id" class="h-8 px-3 bg-muted border border-zinc-300 text-foreground rounded-lg hover:bg-zinc-200 transition-colors text-[10px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
                                                    <i v-if="reprintingJobId === job.id" class="fa-solid fa-circle-notch fa-spin"></i>
                                                    <i v-else class="fa-solid fa-print"></i>
                                                    <span>{{ $t('Reprint') }}</span>
                                                </button>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                </div>

                <!-- 4. ORDER TYPES TAB -->
                <div v-if="activeTab === 'orders'" class="bg-card border border-zinc-300 rounded-xl overflow-hidden flex-1 flex flex-col relative">
                    <div class="shrink-0 min-h-16 px-4 py-3 bg-muted/70 border-b border-zinc-300 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-5">
                        <div>
                            <h3 class="text-xs font-semibold text-foreground">{{ $t('Default order type for new orders') }}</h3>
                            <p class="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{{ $t('Selected automatically for new register orders. Tables and previous orders are not affected.') }}</p>
                        </div>
                        <p class="shrink-0 text-[11px] font-semibold text-muted-foreground">
                            {{ $t('Current:') }}
                            <span class="text-teal-700" data-no-i18n>{{ currentDefaultOrderType?.name || $t('Unspecified') }}</span>
                        </p>
                    </div>

                    <!-- Desktop -->
                    <div class="hidden md:block overflow-x-auto overflow-y-auto premium-scroll flex-1">
                        <table class="w-full text-start min-w-[820px]">
                            <thead class="sticky top-0 bg-zinc-200/80 backdrop-blur border-b border-zinc-300 z-10">
                                <tr>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('ID') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-start">{{ $t('Name') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Requirement') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-center">{{ $t('Default') }}</th>
                                    <th class="py-2.5 px-4 text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-end">{{ $t('Actions') }}</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-zinc-200 text-foreground">
                                <tr v-if="orderTypes.length === 0">
                                    <td colspan="5" class="py-20 text-center text-muted-foreground">
                                        <i class="fa-solid fa-layer-group text-4xl mb-4 opacity-30"></i>
                                        <p class="font-medium text-sm">{{ $t('No order types configured.') }}</p>
                                    </td>
                                </tr>
                                <tr v-for="t in orderTypes" :key="t.id" :class="['transition-colors', t.is_default == 1 ? 'bg-teal-50/60' : 'even:bg-muted/50 hover:bg-teal-50/60']">
                                    <td class="py-2.5 px-4 font-semibold text-muted-foreground text-xs tabular-nums" data-no-i18n>#{{ t.id }}</td>
                                    <td class="py-2.5 px-4 font-semibold text-foreground text-xs" data-no-i18n>{{ t.name }}</td>
                                    <td class="py-2.5 px-4 text-center">
                                        <span v-if="t.requires_hash == 1" class="bg-rose-50 text-rose-600 px-2 py-0.5 rounded border border-rose-200 text-[10px] font-semibold"><i class="fa-solid fa-hashtag me-1"></i>{{ $t('Hash Required') }}</span>
                                        <span v-if="t.is_deferred_settlement == 1" class="ms-1 bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200 text-[10px] font-semibold"><i class="fa-solid fa-truck me-1"></i>{{ $t('Platform settlement') }}</span>
                                        <span v-if="t.requires_hash != 1 && t.is_deferred_settlement != 1" class="text-[10px] font-semibold text-muted-foreground">{{ $t('Standard') }}</span>
                                    </td>
                                    <td class="py-2.5 px-4 text-center">
                                        <div v-if="t.is_default == 1" class="inline-flex items-center justify-center gap-1.5">
                                            <span class="px-2.5 py-1.5 rounded-md bg-teal-700 text-white text-[11px] font-semibold">{{ $t('Default') }}</span>
                                            <button type="button" class="h-11 px-2 text-[11px] font-semibold text-muted-foreground hover:text-rose-700 disabled:opacity-50" :disabled="isSavingDefaultOrderType" @click="setDefaultOrderType(null)">{{ $t('Remove') }}</button>
                                        </div>
                                        <button v-else type="button" class="h-11 min-w-32 px-3 rounded-lg border border-zinc-300 bg-card text-[11px] font-semibold text-foreground hover:border-teal-400 hover:bg-teal-50 hover:text-teal-800 transition-colors disabled:opacity-50" :disabled="isSavingDefaultOrderType" @click="setDefaultOrderType(t)">{{ $t('Set as default') }}</button>
                                    </td>
                                    <td class="py-2.5 px-4 text-end">
                                        <div class="flex justify-end gap-1">
                                            <button @click="editOrderType(t)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[11px]"></i></button>
                                            <button @click="deleteOrderType(t.id)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors flex items-center justify-center"><i class="fa-solid fa-trash text-[11px]"></i></button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Mobile -->
                    <div class="block md:hidden overflow-y-auto premium-scroll flex-1 p-4 space-y-3">
                        <div v-if="orderTypes.length === 0" class="py-20 text-center text-muted-foreground">
                            <i class="fa-solid fa-layer-group text-4xl mb-4 opacity-30"></i>
                            <p class="font-medium text-sm">{{ $t('No order types configured.') }}</p>
                        </div>
                        <div v-for="t in orderTypes" :key="t.id" :class="['border rounded-xl p-4 flex flex-col gap-3', t.is_default == 1 ? 'bg-teal-50/60 border-teal-300' : 'bg-card border-zinc-300']">
                            <div class="flex justify-between items-start">
                                <div>
                                    <span class="font-semibold text-foreground text-sm" data-no-i18n>{{ t.name }}</span>
                                    <span class="text-[10px] text-muted-foreground ms-1.5 tabular-nums" data-no-i18n>#{{ t.id }}</span>
                                </div>
                                <div class="flex justify-end gap-1 shrink-0">
                                    <button @click="editOrderType(t)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center justify-center"><i class="fa-solid fa-pen text-[11px]"></i></button>
                                    <button @click="deleteOrderType(t.id)" class="w-8 h-8 rounded-lg text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors flex items-center justify-center"><i class="fa-solid fa-trash text-[11px]"></i></button>
                                </div>
                            </div>
                            <div class="text-[10px] text-muted-foreground border-t border-zinc-200 pt-2 flex items-center justify-between">
                                <span class="font-semibold text-muted-foreground">{{ $t('Requirement') }}:</span>
                                <span v-if="t.requires_hash == 1" class="bg-rose-50 text-rose-600 px-2 py-0.5 rounded border border-rose-200 text-[10px] font-semibold"><i class="fa-solid fa-hashtag me-1"></i>{{ $t('Hash Required') }}</span>
                                <span v-if="t.is_deferred_settlement == 1" class="bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200 text-[10px] font-semibold"><i class="fa-solid fa-truck me-1"></i>{{ $t('Platform settlement') }}</span>
                                <span v-if="t.requires_hash != 1 && t.is_deferred_settlement != 1" class="text-[10px] text-muted-foreground font-semibold">{{ $t('Standard') }}</span>
                            </div>
                            <div class="border-t border-zinc-200 pt-3">
                                <div v-if="t.is_default == 1" class="flex items-center justify-between gap-2">
                                    <span class="px-2.5 py-1.5 rounded-md bg-teal-700 text-white text-[11px] font-semibold">{{ $t('Default') }}</span>
                                    <button type="button" class="h-11 px-3 text-[11px] font-semibold text-muted-foreground hover:text-rose-700 disabled:opacity-50" :disabled="isSavingDefaultOrderType" @click="setDefaultOrderType(null)">{{ $t('Remove') }}</button>
                                </div>
                                <button v-else type="button" class="w-full h-11 px-3 rounded-lg border border-zinc-300 bg-card text-[11px] font-semibold text-foreground hover:border-teal-400 hover:bg-teal-50 hover:text-teal-800 transition-colors disabled:opacity-50" :disabled="isSavingDefaultOrderType" @click="setDefaultOrderType(t)">{{ $t('Set as default') }}</button>
                            </div>
                        </div>
                    </div>
                </div>
            </template>

            <!-- Printer Modal -->
            <div v-if="showPrinterModal" @click.self="showPrinterModal = false" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div role="dialog" aria-modal="true" class="bg-card rounded-xl shadow-2xl w-full max-w-lg overflow-hidden border border-zinc-300 flex flex-col max-h-[95vh] animate-scale-in">

                    <div class="px-6 py-4 border-b border-zinc-200 flex justify-between items-center shrink-0">
                        <h3 class="font-display font-semibold text-foreground text-sm">
                            {{ printerForm.id ? $t('Edit printer') : $t('Add printer') }}
                        </h3>
                        <button @click="showPrinterModal = false" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition-colors"><i class="fa-solid fa-xmark"></i></button>
                    </div>

                    <div class="flex-1 overflow-y-auto premium-scroll p-6 space-y-6">

                        <div class="space-y-4">
                            <h4 class="font-display text-[11px] font-semibold text-muted-foreground border-b border-zinc-200 pb-2">{{ $t('Printer details') }}</h4>

                            <div>
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Name *') }}</label>
                                <input v-model="printerForm.name" type="text" :placeholder="$t('e.g. Front Counter')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Role') }}</label>
                                    <select v-model="printerForm.role" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                        <option value="receipt">{{ $t('Customer Receipts') }}</option>
                                        <option value="kitchen">{{ $t('Kitchen/Prep Station') }}</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Connection type') }}</label>
                                    <select v-model="printerForm.type" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                        <option value="windows">{{ $t('Windows Print Spooler') }}</option>
                                        <option value="network">{{ $t('Direct Network (IP)') }}</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div class="space-y-4">
                            <h4 class="font-display text-[11px] font-semibold text-muted-foreground border-b border-zinc-200 pb-2">{{ $t('Connection') }}</h4>

                            <div>
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Assigned print station') }}</label>
                                <select v-model="printerForm.spooler_id" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option v-for="station in availableSpoolers" :key="station.id" :value="station.id">{{ station.id === 'primary' ? $t('Primary station') : station.name }}{{ station.id !== 'primary' && station.name !== station.id ? ` (${station.id})` : '' }}</option>
                                </select>
                                <p class="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">{{ $t('Choose the computer that runs this printer.') }}</p>
                            </div>

                            <div v-if="printerForm.type === 'network'" class="grid grid-cols-3 gap-4">
                                <div class="col-span-2">
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('IP Address *') }}</label>
                                    <input v-model="printerForm.network_ip" type="text" placeholder="192.168.1.100" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Port') }}</label>
                                    <input v-model="printerForm.network_port" type="text" placeholder="9100" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                                </div>
                            </div>

                            <div v-if="printerForm.type === 'windows'">
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Windows Printer Name *') }}</label>
                                <input v-model="printerForm.windows_name" type="text" :placeholder="$t('e.g. POS-80C')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9">
                                <p class="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">{{ $t("Must match the exact name shown in Windows 'Printers & Scanners'.") }}</p>
                            </div>
                        </div>

                        <div v-if="printerForm.role === 'kitchen'" class="space-y-4">
                            <h4 class="font-display text-[11px] font-semibold text-muted-foreground border-b border-zinc-200 pb-2">{{ $t('Routed Categories') }}</h4>
                            <p class="text-xs text-muted-foreground">{{ $t('Choose which categories print to this prep station.') }}</p>
                            <p class="text-xs text-muted-foreground">{{ $t('Subcategories use their selected printers instead of the parent category printers. Without a subcategory selection, the parent applies.') }}</p>

                            <div class="space-y-3">
                                <div v-for="mCat in mainCategories" :key="'pcat'+mCat.id" class="bg-muted/40 p-3 rounded-lg border border-zinc-200">
                                    <label :class="['flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors mb-2', printerForm.categories.includes(mCat.id) ? 'bg-teal-50/60 border-teal-300' : 'bg-card border-zinc-300 hover:bg-muted']">
                                        <span class="text-xs font-semibold" :class="printerForm.categories.includes(mCat.id) ? 'text-teal-700' : 'text-foreground'"><span data-no-i18n>{{ mCat.name }}</span> <span class="text-muted-foreground font-normal">({{ $t('Main') }})</span></span>
                                        <input type="checkbox" :value="mCat.id" v-model="printerForm.categories" class="accent-teal-600 w-4 h-4">
                                    </label>

                                    <div v-if="getSubcategories(mCat.id).length > 0" class="grid grid-cols-1 sm:grid-cols-2 gap-2 ps-4 border-s border-zinc-200 ms-2">
                                        <label v-for="sub in getSubcategories(mCat.id)" :key="sub.id" :class="['flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors', printerForm.categories.includes(sub.id) ? 'bg-teal-50/60 border-teal-300' : 'bg-card border-zinc-300 hover:bg-muted']">
                                            <span class="text-xs font-semibold" :class="printerForm.categories.includes(sub.id) ? 'text-teal-700' : 'text-muted-foreground'">
                                                <i class="fa-solid fa-level-up-alt fa-rotate-90 me-1.5 opacity-40"></i><span data-no-i18n>{{ sub.name }}</span>
                                            </span>
                                            <input type="checkbox" :value="sub.id" v-model="printerForm.categories" class="accent-teal-600 w-3.5 h-3.5">
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </div>

                    <div class="px-6 py-4 border-t border-zinc-200 bg-muted flex justify-end gap-3 shrink-0">
                        <button @click="showPrinterModal = false" class="px-4 py-2 bg-card border border-zinc-300 text-foreground hover:bg-zinc-200 font-semibold rounded-lg text-xs transition-colors">{{ $t('Cancel') }}</button>
                        <button @click="savePrinter" class="px-5 py-2 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 text-xs transition-colors">
                            {{ $t('Save printer') }}
                        </button>
                    </div>
                </div>
            </div>

            <!-- Order Type Modal -->
            <div v-if="showOrderTypeModal" @click.self="showOrderTypeModal = false" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div role="dialog" aria-modal="true" class="bg-card rounded-xl shadow-2xl w-full max-w-sm overflow-hidden border border-zinc-300 flex flex-col max-h-[95vh] animate-scale-in">

                    <div class="px-6 py-4 border-b border-zinc-200 flex justify-between items-center shrink-0">
                        <h3 class="font-display font-semibold text-foreground text-sm">
                            {{ typeForm.id ? $t('Edit Order Type') : $t('New Order Type') }}
                        </h3>
                        <button @click="showOrderTypeModal = false" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition-colors"><i class="fa-solid fa-xmark"></i></button>
                    </div>

                    <div class="p-6 space-y-5">
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Name *') }}</label>
                            <input v-model="typeForm.name" type="text" :placeholder="$t('e.g. Dine In, Takeaway')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9">
                        </div>

                        <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', typeForm.requires_hash ? 'bg-rose-50 border-rose-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                            <div class="flex items-center gap-3">
                                <i class="fa-solid fa-hashtag text-lg" :class="typeForm.requires_hash ? 'text-rose-600' : 'text-muted-foreground'"></i>
                                <div>
                                    <span class="text-xs font-semibold block" :class="typeForm.requires_hash ? 'text-rose-700' : 'text-foreground'">{{ $t('Require Hash Number') }}</span>
                                    <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Forces cashier to enter an ID.') }}</span>
                                </div>
                            </div>
                            <input type="checkbox" v-model="typeForm.requires_hash" class="accent-rose-600 w-4 h-4">
                        </label>

                        <label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', typeForm.is_deferred_settlement ? 'bg-amber-50 border-amber-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                            <div class="flex items-center gap-3">
                                <i class="fa-solid fa-truck text-lg" :class="typeForm.is_deferred_settlement ? 'text-amber-700' : 'text-muted-foreground'"></i>
                                <div>
                                    <span class="text-xs font-semibold block" :class="typeForm.is_deferred_settlement ? 'text-amber-800' : 'text-foreground'">{{ $t('Deferred platform settlement') }}</span>
                                    <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Held orders close as platform sales and do not enter the cash drawer.') }}</span>
                                </div>
                            </div>
                            <input type="checkbox" v-model="typeForm.is_deferred_settlement" class="accent-amber-600 w-4 h-4">
                        </label>
                    </div>

                    <div class="px-6 py-4 border-t border-zinc-200 bg-muted flex justify-end gap-3 shrink-0">
                        <button @click="showOrderTypeModal = false" class="px-4 py-2 bg-card border border-zinc-300 text-foreground hover:bg-zinc-200 font-semibold rounded-lg text-xs transition-colors">{{ $t('Cancel') }}</button>
                        <button @click="saveOrderType" class="px-5 py-2 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 text-xs transition-colors">
                            {{ $t('Save Type') }}
                        </button>
                    </div>
                </div>
            </div>

        </div>

</template>

<script>
import { formatBusinessDateTime } from '@/utils/businessDate.js';
import { fetchJson } from '@/shared/http.js';
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { currentLanguage, languageChoices, setLanguage, t } from '@/shared/i18n.js';
import { invalidateSystemSettings } from '@/shared/systemSettings.js';
import DeviceAccessSettings from '../components/settings/DeviceAccessSettings.vue';
import StationHealthNotice from '../components/settings/StationHealthNotice.vue';
import { createPrintQueueRefreshController } from '../composables/printQueueRefreshController.js';

export default {
    components: { DeviceAccessSettings, StationHealthNotice },
    setup() {
        // Tab State
        const activeTab = ref('general');
        const jofotaraSaving = ref(false);
        const blankJofotaraProfile = () => ({ client_id: '', secret_key: '', secret_configured: false, income_source_sequence: '', seller_tax_number: '', seller_registered_name: '' });
        const jofotaraForm = ref({ enabled: false, auto_submit: false, archive_xml: true, auto_submit_since: null, tax_registration_type: 'sales_tax', profiles: { sales_tax: blankJofotaraProfile(), income_tax: blankJofotaraProfile() }, ...blankJofotaraProfile() });
        const jofotaraReadiness = computed(() => {
            if (!jofotaraForm.value.enabled) return 'disabled';
            return jofotaraForm.value.client_id && (jofotaraForm.value.secret_key || jofotaraForm.value.secret_configured) && jofotaraForm.value.income_source_sequence && jofotaraForm.value.seller_tax_number && jofotaraForm.value.seller_registered_name ? 'ready' : 'incomplete';
        });

        // General Settings State
        const barcodeEnabled = ref(false);
        const quickNumpadMode = ref(false);
        const quantityPresetsEnabled = ref(true);
        const tablesEnabled = ref(false);
        const stockEnabled = ref(false);
        const recipeLedgerEnabled = ref(false);
        const lowStockThreshold = ref('3');
        const firstShiftStartingCash = ref('0');
        const taxInclusivePricing = ref(false);
        const useInvoiceNoOnly = ref(false);
        const orderTypeNumbering = ref(false);
        const tableMode = ref('fixed');
        const printMethod = ref('browser');
        const duplicateCustomerReceipt = ref(false);
        const storeName = ref('');
        const storeAddress = ref('');
        const storePhone = ref('');
        const adminLanguage = ref(currentLanguage.value);
        const serviceChargeEnabled = ref(false);
        const serviceChargePercentage = ref('10');
        const serviceChargeTaxRate = ref('0');
        const serviceChargeTaxCategory = ref('O');
        const autoApplyServiceCharge = ref(false);
        watch([tablesEnabled, serviceChargeEnabled], ([tablesOn, serviceChargeOn]) => {
            if (!tablesOn || !serviceChargeOn) autoApplyServiceCharge.value = false;
        });
        watch(() => Number(serviceChargeTaxRate.value || 0), (rate, previousRate) => {
            if (rate > 0) serviceChargeTaxCategory.value = 'S';
            else if (previousRate > 0) serviceChargeTaxCategory.value = 'O';
        });

        const storeIcon = ref(null);
        const fileInput = ref(null);
        const isUploadingIcon = ref(false);
        const iconVersion = ref(Date.now());

        // Printers State
        const printers = ref([]);
        const categories = ref([]);
        const showPrinterModal = ref(false);
        const printQueueHealth = ref({
            summary: [],
            recent: [],
            printers: [],
            spooler: { active: false, count: 0 },
            stations: []
        });
        const reprintingJobId = ref(null);
        const cancelingJobId = ref(null);
        const stationActionId = ref(null);

        // Form states
        const printerForm = ref({
            id: null, name: '', role: 'receipt', type: 'windows',
            network_ip: '', network_port: '9100', windows_name: '', spooler_id: 'primary', status_capability: 'write_only', categories: []
        });
        const availableSpoolers = computed(() => {
            const stations = new Map([['primary', { id: 'primary', name: 'Primary station' }]]);
            // api/admin/print-queue/health returns `stations`, keyed by spooler_id.
            // This read `spoolers`, a key the endpoint has never sent, so the loop
            // never ran and the picker offered nothing but 'primary' - a registered
            // station was visible on the print-queue panel and unusable here.
            for (const station of printQueueHealth.value.stations || []) {
                if (!station?.spooler_id) continue;
                stations.set(station.spooler_id, { id: station.spooler_id, name: station.name || station.spooler_id });
            }
            const currentId = printerForm.value.spooler_id;
            if (currentId && !stations.has(currentId)) stations.set(currentId, { id: currentId, name: currentId });
            return [...stations.values()];
        });

        const isSaving = ref(false);
        const isLoading = ref(true);
        const loadFailed = ref(false);
        const toastMessage = ref('');
        const maintenancePassword = ref('');
        const maintenanceResetting = ref(false);
        const maintenanceScope = ref('operational');
        let toastTimeout = null;

        // Order Types State
        const orderTypes = ref([]);
        const showOrderTypeModal = ref(false);
        const typeForm = ref({ id: null, name: '', requires_hash: false, is_deferred_settlement: false });
        const isSavingDefaultOrderType = ref(false);
        const currentDefaultOrderType = computed(() => orderTypes.value.find(type => type.is_default == 1) || null);

        const showToast = (msg) => {
            toastMessage.value = msg;
            if (toastTimeout) clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => { toastMessage.value = ''; }, 3000);
        };

        const formatQueueLabel = (value) => String(value || 'unknown')
            .split('_')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');

        const statusBadgeClass = (status) => {
            if (['acknowledged', 'ok'].includes(status)) return 'bg-teal-50 text-teal-700 border-teal-200';
            if (['failed', 'dead_letter', 'offline', 'paper_out', 'cover_open', 'jammed', 'error'].includes(status)) return 'bg-rose-50 text-rose-700 border-rose-200';
            if (['pending', 'processing', 'sent', 'paper_low'].includes(status)) return 'bg-amber-50 text-amber-700 border-amber-200';
            return 'bg-muted text-muted-foreground border-zinc-200';
        };

        const formatQueueDate = (value) => formatBusinessDateTime(value);

        // The agent stamps these in UTC ISO form when a job finishes, so they read as
        // "3 minutes ago" without any clock the page has to keep ticking.
        const formatAgo = (value) => {
            const then = Date.parse(value);
            if (!Number.isFinite(then)) return '-';
            const seconds = Math.round((then - Date.now()) / 1000);
            const format = new Intl.RelativeTimeFormat(currentLanguage.value, { numeric: 'auto' });
            for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
                if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
            }
            return format.format(Math.min(seconds, 0), 'second');
        };

        const formatConfidence = (value) => ({
            device_confirmed: 'Device confirmed',
            os_accepted: 'Windows accepted',
            bytes_sent: 'Bytes sent',
            stored_on_terminal: 'Stored on terminal',
            cancel_requested: 'Cancellation pending',
            unknown: 'Unknown'
        }[value] || 'Unknown');

        // A station left behind by an identity change is offline with no printers; it is
        // not a fault, so it leaves the list. Everything that can print or is reachable stays.
        const visibleStations = computed(() => printQueueHealth.value.stations.filter(station =>
            station.online || station.last_error || station.station_mismatch || !Array.isArray(station.printers) || station.printers.length > 0));

        const queueStateCards = computed(() => {
            const countFor = (status) => Number(printQueueHealth.value.summary.find(row => row.status === status)?.count || 0);
            return [
                { status: 'pending', label: 'Pending', count: countFor('pending') },
                { status: 'failed', label: 'Failed', count: countFor('failed') }
            ];
        });

        const loadPrintQueueHealth = async () => {
            const data = await fetchJson('api/admin/print-queue/health');
            if (data.success) {
                printQueueHealth.value = {
                    summary: data.summary || [],
                    recent: data.recent || [],
                    printers: data.printers || [],
                    spooler: data.spooler || { active: false, count: 0 },
                    stations: data.stations || []
                };
            }
        };
        const printQueueRefresh = createPrintQueueRefreshController({
            load: loadPrintQueueHealth
        });

        const selectLanguage = async (language) => {
            const prev = adminLanguage.value;
            adminLanguage.value = language;
            if (await setLanguage(language) === false) {
                // A later click may have superseded this async language load.
                if (adminLanguage.value !== language) return;
                adminLanguage.value = prev;
                await window.showAdminAlert(t("Unable to load the selected language."));
                return;
            }

            try {
                const data = await fetchJson('api/system/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ admin_language: language })
                });
                if (data.success) {
                    invalidateSystemSettings();
                    showToast(t("Language updated."));
                    savedGeneralSettings.admin_language = language;
                } else {
                    await setLanguage(prev);
                    adminLanguage.value = prev;
                    await window.showAdminAlert(data.message || t("Failed to save settings."));
                }
            } catch (error) {
                await setLanguage(prev);
                adminLanguage.value = prev;
                await window.showAdminAlert(t("Network error."));
            }
        };

        const loadData = async ({ printQueueHealthBootstrap = null } = {}) => {
            isLoading.value = true;
            try {
                loadFailed.value = false;
                // 1. Load General Settings
                const dataSet = await fetchJson('api/system/settings');
                if (!dataSet.success) throw new Error('settings load failed');
                if (dataSet.success) {
                    barcodeEnabled.value = dataSet.barcode_enabled === '1';
                    quickNumpadMode.value = dataSet.quick_numpad_mode === '1';
                    quantityPresetsEnabled.value = dataSet.quantity_presets_enabled !== '0';
                    tablesEnabled.value = dataSet.tables_enabled === '1';
                    stockEnabled.value = dataSet.stock_enabled === '1';
                    recipeLedgerEnabled.value = dataSet.recipe_ledger_enabled === '1';
                    lowStockThreshold.value = dataSet.low_stock_threshold || '3';
                    firstShiftStartingCash.value = dataSet.first_shift_starting_cash || '0';
                    taxInclusivePricing.value = dataSet.tax_inclusive_pricing === '1';
                    useInvoiceNoOnly.value = dataSet.use_invoice_no_only === '1';
                    orderTypeNumbering.value = dataSet.order_type_numbering === '1';
                    tableMode.value = dataSet.table_mode || 'fixed';
                    printMethod.value = dataSet.print_method || 'browser';
                    duplicateCustomerReceipt.value = dataSet.duplicate_customer_receipt === '1';
                    storeName.value = dataSet.store_name || '';
                    storeAddress.value = dataSet.store_address || '';
                    storePhone.value = dataSet.store_phone || '';
                    adminLanguage.value = dataSet.admin_language || currentLanguage.value;
                    await setLanguage(adminLanguage.value);
                    serviceChargeEnabled.value = dataSet.service_charge_enabled === '1';
                    serviceChargePercentage.value = dataSet.service_charge_percentage || '10';
                    serviceChargeTaxRate.value = dataSet.service_charge_tax_rate || '0';
                    serviceChargeTaxCategory.value = dataSet.service_charge_jofotara_tax_category || 'O';
                    autoApplyServiceCharge.value = dataSet.auto_apply_service_charge === '1';
                    storeIcon.value = dataSet.store_icon || null;
                    savedGeneralSettings = generalSettingsPayload();
                }

                // 2. Load Printers
                const dataPrint = await fetchJson('api/admin/printers');
                if (dataPrint.success) printers.value = dataPrint.data;

                // 3. Load Categories (for kitchen printer routing)
                const dataCat = await fetchJson('api/admin/categories');
                if (dataCat.success) categories.value = dataCat.categories;

                // 4. Load Order Types
                const dataTypes = await fetchJson('api/admin/order_types');
                if (dataTypes.success) orderTypes.value = dataTypes.data;

                // 5. Load Print Queue Health
                await (printQueueHealthBootstrap
                    || printQueueRefresh.refreshNow({ force: true }));

                const dataJofotara = await fetchJson('api/admin/jofotara/settings');
                if (dataJofotara.success) {
                    jofotaraForm.value = { ...jofotaraForm.value, ...dataJofotara.settings, secret_key: '' };
                    selectJofotaraProfile();
                }

            } catch (error) {
                console.error("Failed to load settings data", error);
                loadFailed.value = true;
            } finally {
                isLoading.value = false;
            }
        };

        watch(activeTab, (tab) => {
            void printQueueRefresh.setActive(tab === 'printQueue');
        });
        onMounted(() => {
            printQueueRefresh.start();
            const printQueueHealthBootstrap = printQueueRefresh.refreshNow({ force: true });
            void loadData({ printQueueHealthBootstrap });
            void printQueueRefresh.setActive(
                activeTab.value === 'printQueue',
                { reconcile: false }
            );
        });
        onUnmounted(() => {
            printQueueRefresh.stop();
            if (toastTimeout) clearTimeout(toastTimeout);
        });

        const handleModalEsc = (e) => {
            if (e.key !== 'Escape') return;
            if (showPrinterModal.value) showPrinterModal.value = false;
            if (showOrderTypeModal.value) showOrderTypeModal.value = false;
        };
        onMounted(() => window.addEventListener('keydown', handleModalEsc));
        onUnmounted(() => window.removeEventListener('keydown', handleModalEsc));

        // --- GENERAL SETTINGS ACTIONS ---
        let savedGeneralSettings = {};
        const generalSettingsPayload = () => ({
                barcode_enabled: barcodeEnabled.value ? '1' : '0',
                quick_numpad_mode: quickNumpadMode.value ? '1' : '0',
                quantity_presets_enabled: quantityPresetsEnabled.value ? '1' : '0',
                tables_enabled: tablesEnabled.value ? '1' : '0',
                stock_enabled: stockEnabled.value ? '1' : '0',
                recipe_ledger_enabled: recipeLedgerEnabled.value ? '1' : '0',
                low_stock_threshold: lowStockThreshold.value,
                first_shift_starting_cash: firstShiftStartingCash.value,
                tax_inclusive_pricing: taxInclusivePricing.value ? '1' : '0',
                use_invoice_no_only: useInvoiceNoOnly.value ? '1' : '0',
                order_type_numbering: orderTypeNumbering.value ? '1' : '0',
                table_mode: tableMode.value,
                print_method: printMethod.value,
                duplicate_customer_receipt: duplicateCustomerReceipt.value ? '1' : '0',
                store_name: storeName.value,
                store_address: storeAddress.value,
                store_phone: storePhone.value,
                admin_language: adminLanguage.value,
                service_charge_enabled: serviceChargeEnabled.value ? '1' : '0',
                service_charge_percentage: serviceChargePercentage.value,
                service_charge_tax_rate: serviceChargeTaxRate.value,
                service_charge_jofotara_tax_category: serviceChargeTaxCategory.value,
                auto_apply_service_charge: serviceChargeEnabled.value && tablesEnabled.value && autoApplyServiceCharge.value ? '1' : '0'
        });

        const saveSettings = async () => {
            if (isSaving.value) return;
            if (loadFailed.value) {
                await window.showAdminAlert(t("Settings failed to load — reload before saving to avoid overwriting saved values."));
                return;
            }
            isSaving.value = true;
            const payload = Object.fromEntries(Object.entries(generalSettingsPayload())
                .filter(([key, value]) => String(value) !== String(savedGeneralSettings[key])));

            try {
                if (!Object.keys(payload).length) {
                    showToast(t("Settings saved."));
                    return;
                }
                const data = await fetchJson('api/system/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (data.success) {
                    savedGeneralSettings = { ...savedGeneralSettings, ...payload };
                    invalidateSystemSettings();
                    showToast(t("Settings saved."));
                } else {
                    await window.showAdminAlert(data.message || t("Failed to save settings."));
                }
            } catch (error) {
                await window.showAdminAlert(t("Network error."));
            } finally {
                isSaving.value = false;
            }
        };

        const resetOperationalData = async () => {
            if (!maintenancePassword.value || maintenanceResetting.value) return;
            const factory = maintenanceScope.value === 'factory';
            if (factory && !window.confirm(t('This deletes all products, categories, stock and sales permanently. Continue?'))) return;
            maintenanceResetting.value = true;
            try {
                const url = factory ? '/api/admin/maintenance/factory-reset' : '/api/admin/maintenance/reset-operational-data';
                const data = await fetchJson(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: maintenancePassword.value })
                });
                if (!data.success) {
                    await window.showAdminAlert(data.message || t('Failed to reset operational data.'));
                    return;
                }
                maintenancePassword.value = '';
                showToast(factory ? t('The system was reset to a fresh start.') : t('Operational data was reset.'));
                await loadData();
            } catch (error) {
                await window.showAdminAlert(error.message || t('Failed to reset operational data.'));
            } finally {
                maintenanceResetting.value = false;
            }
        };

        const saveJofotaraSettings = async () => {
            jofotaraSaving.value = true;
            try {
                const data = await fetchJson('api/admin/jofotara/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jofotaraForm.value) });
                if (!data.success) return window.showAdminAlert(data.message || t('Failed to save settings.'));
                jofotaraForm.value.secret_key = '';
                await loadData();
                showToast(t('Settings saved.'));
            } catch { await window.showAdminAlert(t('Network error.')); }
            finally { jofotaraSaving.value = false; }
        };

        const selectJofotaraProfile = () => {
            const profile = jofotaraForm.value.tax_registration_type;
            const values = jofotaraForm.value.profiles?.[profile] || blankJofotaraProfile();
            Object.assign(jofotaraForm.value, { ...values, secret_key: '' });
        };

        // --- PRINTER ACTIONS ---
        const editPrinter = (printer = null) => {
            if (printer) {
                printerForm.value = {
                    id: printer.id,
                    name: printer.name,
                    role: printer.role,
                    type: printer.type,
                    network_ip: printer.network_ip || '',
                    network_port: printer.network_port || '9100',
                    windows_name: printer.windows_name || '',
                    spooler_id: printer.spooler_id || 'primary',
                    status_capability: printer.status_capability || 'write_only',
                    categories: printer.categories ? [...printer.categories] : []
                };
            } else {
                printerForm.value = {
                    id: null, name: '', role: 'receipt', type: 'windows',
                    network_ip: '', network_port: '9100', windows_name: '', spooler_id: 'primary', status_capability: 'write_only', categories: []
                };
            }
            showPrinterModal.value = true;
        };

        const deletePrinter = async (id) => {
            if (!await window.showAdminConfirm(t("Remove this printer from the system?"))) return;
            try {
                const data = await fetchJson('api/admin/printers', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
                if (data.success) {
                    showToast(t("Printer deleted."));
                    await loadData();
                } else {
                    window.showAdminAlert(data.message);
                }
            } catch (e) { window.showAdminAlert(t("Network error.")); }
        };

        const savePrinter = async () => {
            if (!printerForm.value.name) {
                await window.showAdminAlert(t("Printer name is required."));
                return;
            }
            if (printerForm.value.type === 'windows' && !printerForm.value.windows_name) {
                await window.showAdminAlert(t("Windows Printer Name is required."));
                return;
            }
            if (printerForm.value.type === 'network' && !printerForm.value.network_ip) {
                await window.showAdminAlert(t("Network IP is required."));
                return;
            }

            const method = printerForm.value.id ? 'PUT' : 'POST';
            try {
                const data = await fetchJson('api/admin/printers', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(printerForm.value)
                });
                if (data.success) {
                    showPrinterModal.value = false;
                    showToast(t("Printer saved."));
                    await loadData();
                } else {
                    await window.showAdminAlert(t(data.message || 'Failed to save settings.'));
                }
            } catch (e) { await window.showAdminAlert(t("Network error.")); }
        };

        const reprintQueueJob = async (job) => {
            const uncertain = job.last_failure_class === 'uncertain';
            if (uncertain && !window.confirm(t('This ticket may already have printed. Check the paper and complete printer recovery first. Queue a reprint?'))) return;
            const reason = window.prompt(t('Reprint reason'), '');
            if (reason === null) return;
            reprintingJobId.value = job.id;
            try {
                const data = await fetchJson(`api/admin/print-queue/${job.id}/reprint`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason, confirm_uncertain: uncertain })
                });
                if (data.success) {
                    showToast(t('Reprint queued.'));
                    await printQueueRefresh.refreshNow({ force: true });
                } else {
                    await window.showAdminAlert(data.message || t('Failed to queue reprint.'));
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error."));
            } finally {
                reprintingJobId.value = null;
            }
        };

        const cancelPrintJob = async (job) => {
            if (!window.confirm(t('Are you sure you want to cancel this print job?'))) return;
            cancelingJobId.value = job.id;
            try {
                const data = await fetchJson(`api/admin/print-queue/${job.id}/cancel`, {
                    method: 'POST'
                });
                if (data.success) {
                    job.status = data.outcome;
                    showToast(data.outcome === 'canceled' ? t('Print job canceled.') : t('Print job cancellation requested.'));
                    await printQueueRefresh.refreshNow({ force: true });
                } else {
                    await window.showAdminAlert(data.message || t('Failed to cancel print job.'));
                }
            } catch (err) {
                await window.showAdminAlert(t('Network error.'));
            } finally {
                cancelingJobId.value = null;
            }
        };

        const runStationAction = async (station, url, body, successMessage) => {
            stationActionId.value = station.spooler_id;
            try {
                const data = await fetchJson(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {})
                });
                if (data.success) showToast(t(successMessage));
                else await window.showAdminAlert(data.message || t('Print station action failed.'));
            } catch (error) {
                await window.showAdminAlert(t('Network error.'));
            } finally {
                stationActionId.value = null;
                await printQueueRefresh.refreshNow({ force: true });
            }
        };

        const drainSpoolerStation = async (station) => {
            if (!window.confirm(t('Drain permanently retires this station identity once its queue empties. It cannot be reactivated - recovery requires resetting the agent identity on the station PC. Continue?'))) return;
            await runStationAction(station, `api/admin/spooler-agents/${encodeURIComponent(station.spooler_id)}/drain`, {}, 'Station is draining.');
        };

        const replaceSpoolerStation = async (station) => {
            if (!window.confirm(t('Force replacement requires the old terminal to be stopped. Any unresolved job stays outcome unknown. Continue?'))) return;
            await runStationAction(
                station,
                `api/admin/spooler-agents/${encodeURIComponent(station.spooler_id)}/replace`,
                { force: true, confirm_old_terminal_stopped: true },
                'Station replacement requested.'
            );
        };

        const downloadPrintQueueDiagnostics = async () => {
            try {
                const response = await fetch('/api/admin/print-queue/diagnostics', { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP_${response.status}`);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = 'print-queue-diagnostics.json';
                anchor.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                await window.showAdminAlert(t('Unable to download diagnostics.'));
            }
        };

        const mainCategories = computed(() => categories.value.filter(c => !c.parent_id || c.parent_id == 0));

        const getSubcategories = (parentId) => {
            return categories.value.filter(c => c.parent_id == parentId);
        };

        const getCategoryName = (id) => {
            const cat = categories.value.find(c => c.id == id);
            if (!cat) return 'Unknown';
            if (cat.parent_id && cat.parent_id != 0) {
                const parent = categories.value.find(c => c.id == cat.parent_id);
                if (parent) return `${parent.name} > ${cat.name}`;
            }
            return cat.name;
        };

        // --- ORDER TYPE ACTIONS ---
        const editOrderType = (type = null) => {
            if (type) {
                typeForm.value = { id: type.id, name: type.name, requires_hash: type.requires_hash == 1, is_deferred_settlement: type.is_deferred_settlement == 1 };
            } else {
                typeForm.value = { id: null, name: '', requires_hash: false, is_deferred_settlement: false };
            }
            showOrderTypeModal.value = true;
        };

        const saveOrderType = async () => {
            if (!typeForm.value.name) {
                await window.showAdminAlert(t("Name is required."));
                return;
            }
            const method = typeForm.value.id ? 'PUT' : 'POST';
            try {
                const data = await fetchJson('api/admin/order_types', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(typeForm.value)
                });
                if (data.success) {
                    showOrderTypeModal.value = false;
                    showToast(t("Order type saved."));
                    await loadData();
                } else await window.showAdminAlert(data.message);
            } catch (e) { await window.showAdminAlert(t("Network error.")); }
        };

        const deleteOrderType = async (id) => {
            if (!await window.showAdminConfirm(t("Delete this order type?"))) return;
            try {
                const data = await fetchJson('api/admin/order_types', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
                if (data.success) {
                    showToast(t("Order type deleted."));
                    await loadData();
                } else {
                    window.showAdminAlert(data.message);
                }
            } catch (e) { window.showAdminAlert(t("Network error.")); }
        };

        const setDefaultOrderType = async (type) => {
            if (isSavingDefaultOrderType.value) return;
            isSavingDefaultOrderType.value = true;
            try {
                const data = await fetchJson('api/system/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ default_order_type_id: type ? String(type.id) : '' })
                });
                if (!data.success) {
                    await window.showAdminAlert(data.message || t('Failed to save settings.'));
                    return;
                }
                orderTypes.value = orderTypes.value.map(item => ({
                    ...item,
                    is_default: type && String(item.id) === String(type.id) ? 1 : 0
                }));
                showToast(t(type ? 'Default order type updated.' : 'Default order type removed.'));
            } catch (e) {
                await window.showAdminAlert(t('Network error.'));
            } finally {
                isSavingDefaultOrderType.value = false;
            }
        };

         const handleIconUpload = async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            if (file.size > 1024 * 1024) {
                await window.showAdminAlert(t("File is too large. Max 1 MB."));
                return;
            }

            const formData = new FormData();
            formData.append('icon', file);

            isUploadingIcon.value = true;
            try {
                const res = await fetch('api/system/brand-icon', {
                    method: 'POST',
                    body: formData
                });

                const contentType = res.headers.get("content-type");
                let data;
                if (contentType && contentType.includes("application/json")) {
                    data = await res.json();
                } else {
                    const text = await res.text();
                    await window.showAdminAlert(`Server Error (${res.status}): ${text.slice(0, 150)}`);
                    return;
                }

                if (data.success) {
                    storeIcon.value = data.store_icon;
                    invalidateSystemSettings();
                    iconVersion.value++;
                    showToast(t("Icon saved."));
                } else {
                    await window.showAdminAlert(data.message || t("Failed to upload icon."));
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error.") + ` (${e.message})`);
            } finally {
                isUploadingIcon.value = false;
                if (fileInput.value) fileInput.value.value = '';
            }
        };

        const handleIconRemove = async () => {
            if (!await window.showAdminConfirm(t("Are you sure you want to remove the brand icon?"))) return;

            try {
                const res = await fetch('api/system/brand-icon', {
                    method: 'DELETE'
                });

                const contentType = res.headers.get("content-type");
                let data;
                if (contentType && contentType.includes("application/json")) {
                    data = await res.json();
                } else {
                    const text = await res.text();
                    await window.showAdminAlert(`Server Error (${res.status}): ${text.slice(0, 150)}`);
                    return;
                }

                if (data.success) {
                    storeIcon.value = null;
                    invalidateSystemSettings();
                    iconVersion.value++;
                    showToast(t("Icon removed."));
                } else {
                    await window.showAdminAlert(data.message || t("Failed to remove icon."));
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error.") + ` (${e.message})`);
            }
        };

        return {
            activeTab, isLoading, isSaving, toastMessage, loadData, loadFailed,
            jofotaraForm, jofotaraSaving, jofotaraReadiness, saveJofotaraSettings, selectJofotaraProfile,
            barcodeEnabled, quickNumpadMode, quantityPresetsEnabled, tablesEnabled, stockEnabled, recipeLedgerEnabled, taxInclusivePricing, useInvoiceNoOnly, orderTypeNumbering, tableMode, printMethod, duplicateCustomerReceipt, storeName, storeAddress, storePhone, lowStockThreshold, firstShiftStartingCash, saveSettings,
            adminLanguage, languageChoices, selectLanguage,
            printers, showPrinterModal, printerForm, availableSpoolers, editPrinter, deletePrinter, savePrinter, getCategoryName,
            printQueueHealth, visibleStations, queueStateCards, reprintingJobId, reprintQueueJob, formatQueueLabel, formatQueueDate, formatAgo, formatConfidence, statusBadgeClass,
            cancelingJobId, cancelPrintJob,
            stationActionId, drainSpoolerStation, replaceSpoolerStation, downloadPrintQueueDiagnostics,
            orderTypes, showOrderTypeModal, typeForm, editOrderType, saveOrderType, deleteOrderType, getSubcategories, mainCategories,
            currentDefaultOrderType, isSavingDefaultOrderType, setDefaultOrderType,
            serviceChargeEnabled, serviceChargePercentage, serviceChargeTaxRate, serviceChargeTaxCategory, autoApplyServiceCharge,
            maintenancePassword, maintenanceResetting, maintenanceScope, resetOperationalData,
            storeIcon, fileInput, isUploadingIcon, handleIconUpload, handleIconRemove, iconVersion
        };
    }
}
</script>

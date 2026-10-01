<template>
    <ModalShell :show="show" :title="isEditing ? $t('Edit Product') : $t('New Product')" width-class="max-w-2xl" @close="requestClose">
            <template #header>
                <div>
                    <h3 class="font-display font-semibold tracking-tight text-foreground text-sm">
                        <span>{{ isEditing ? $t('Edit Product') : $t('New Product') }}</span>
                    </h3>
                    <p v-if="isEditing" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mt-1">{{ $t('Editing:') }} <span class="text-foreground" data-no-i18n>{{ productForm.name }}</span></p>
                </div>
            </template>

            <!-- Modal Navigation Tabs -->
            <div class="border-b border-zinc-200 bg-card px-6 flex shrink-0">
                <button type="button" @click="selectTab('general')" :class="[productModalTab === 'general' ? 'border-primary text-foreground font-bold' : 'border-transparent text-muted-foreground hover:text-foreground']" class="py-3 px-1 border-b-2 text-xs font-semibold transition-all focus:outline-none mr-6">
                    {{ $t('Details') }}
                </button>
                <button v-if="!productForm.is_bundle" type="button" @click="selectTab('modifiers')" :class="[productModalTab === 'modifiers' ? 'border-primary text-foreground font-bold' : 'border-transparent text-muted-foreground hover:text-foreground']" class="py-3 px-1 border-b-2 text-xs font-semibold transition-all focus:outline-none mr-6">
                    {{ $t('Modifiers') }}
                    <span v-if="productForm.parsedMods?.length > 0" class="bg-primary text-primary-foreground text-[8px] font-black rounded-full px-1.5 py-0.5 ml-1" data-no-i18n>{{ productForm.parsedMods.length }}</span>
                </button>
                <button v-if="recipeLedgerEnabled && !stockTracked" type="button" @click="selectTab('recipe')" :class="[productModalTab === 'recipe' ? 'border-primary text-foreground font-bold' : 'border-transparent text-muted-foreground hover:text-foreground']" class="py-3 px-1 border-b-2 text-xs font-semibold transition-all focus:outline-none">
                    {{ $t('Recipe') }}
                </button>
            </div>

            <!-- Modal Form Body -->
            <form @submit.prevent="saveProduct" class="flex-1 flex flex-col overflow-y-auto premium-scroll bg-card">

                <!-- TAB 1: DETAILS -->
                <div v-show="productModalTab === 'general'" class="p-6 space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Product Name *') }}</label>
                            <input v-model="productForm.name" type="text" required :placeholder="$t('Espresso')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 placeholder:text-muted-foreground">
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Category') }}</label>
                            <select v-model="productForm.category_id" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9">
                                <option value="">{{ $t('Uncategorized') }}</option>
                                <option v-for="cat in categoriesTree" :key="cat.id" :value="cat.id" data-no-i18n>
                                    {{ cat.treeLabel }}
                                </option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">
                                {{ productForm.tax_rate > 0 ? $t('Price incl. Tax (JD) *') : $t('Price (JD) *') }}
                            </label>
                            <input v-model="productForm.price" type="number" step="0.01" required placeholder="0.00" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-bold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums">
                            <p v-if="productForm.tax_rate > 0 && productForm.price > 0" class="text-[10px] text-muted-foreground mt-1">
                                {{ $t('Pre-tax') }}: <span class="font-semibold tabular-nums" data-no-i18n>{{ (productForm.price / (1 + productForm.tax_rate / 100)).toFixed(3) }} JD</span>
                            </p>
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Cost (JD)') }}</label>
                            <input v-model="productForm.cost_price" type="number" step="0.01" placeholder="0.00" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums">
                            <p v-if="productMargin !== null" class="text-[10px] text-muted-foreground mt-1">{{ $t('Margin') }}: <span class="font-semibold text-primary tabular-nums" data-no-i18n>{{ productMargin }}%</span></p>
                        </div>
                        <div>
                            <label for="product-barcode" class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Barcode') }}</label>
                            <input id="product-barcode" ref="barcodeInput" v-model="productForm.barcode" type="text" autocomplete="off" :placeholder="$t('Scan or Enter...')" :aria-invalid="barcodeError ? 'true' : undefined" :aria-describedby="barcodeError ? 'product-barcode-error' : undefined" :class="barcodeError ? 'border-destructive' : 'border-zinc-300'" class="w-full bg-muted border rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums" @input="barcodeError = ''">

                            <div class="mt-2.5">
                                <label for="product-extra-barcode" class="flex items-baseline justify-between text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">
                                    <span>{{ $t('Extra barcodes') }}</span>
                                    <span v-if="productForm.extra_barcodes.length" class="font-semibold tabular-nums normal-case" data-no-i18n>{{ productForm.extra_barcodes.length }}/{{ MAX_EXTRA_BARCODES }}</span>
                                </label>
                                <ul v-if="productForm.extra_barcodes.length" class="flex flex-wrap gap-1.5 mb-2" :aria-label="$t('Extra barcodes')">
                                    <li v-for="code in productForm.extra_barcodes" :key="code" class="inline-flex items-center gap-0.5 max-w-full bg-muted border border-zinc-300 rounded-md ps-2 pe-0.5 h-7 text-xs font-semibold text-foreground tabular-nums">
                                        <span class="truncate" dir="ltr" data-no-i18n>{{ code }}</span>
                                        <button type="button" :aria-label="`${$t('Remove barcode')} ${code}`" :title="$t('Remove barcode')" class="w-6 h-6 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary" @click="removeExtraBarcode(code)">
                                            <i class="fa-solid fa-xmark text-[10px]" aria-hidden="true"></i>
                                        </button>
                                    </li>
                                </ul>
                                <div class="flex gap-2">
                                    <input id="product-extra-barcode" ref="extraBarcodeField" v-model="extraBarcodeInput" type="text" autocomplete="off" :placeholder="$t('Scan or type another barcode')" :aria-invalid="extraBarcodeMessage ? 'true' : undefined" :aria-describedby="extraBarcodeMessage ? 'product-extra-barcode-message' : undefined" :class="extraBarcodeMessage ? 'border-destructive' : 'border-zinc-300'" class="min-w-0 flex-1 bg-muted border rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums placeholder:text-muted-foreground" @keydown.enter="onExtraBarcodeEnter" @input="extraBarcodeMessage = ''">
                                    <button type="button" class="shrink-0 px-3 h-9 bg-card border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-lg text-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" @click="addExtraBarcode">{{ $t('Add') }}</button>
                                </div>
                                <p v-if="extraBarcodeMessage" id="product-extra-barcode-message" role="alert" class="text-[11px] font-semibold text-rose-700 mt-1">{{ extraBarcodeMessage }}</p>
                            </div>

                            <p v-if="barcodeError" id="product-barcode-error" role="alert" class="text-[11px] font-semibold text-rose-700 mt-2 leading-relaxed">
                                <span>{{ $t('The product was not saved.') }}</span> <span>{{ barcodeError }}</span>
                            </p>
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Tax (%)') }}</label>
                            <input v-model="productForm.tax_rate" type="number" step="0.01" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums">
                        </div>
                        <div v-if="Number(productForm.tax_rate || 0) === 0">
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('JoFotara tax treatment') }}</label>
                            <select v-model="productForm.jofotara_tax_category" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9">
                                <option value="O">{{ $t('Zero-rated (O)') }}</option>
                                <option value="Z">{{ $t('Tax-exempt (Z)') }}</option>
                            </select>
                        </div>
                        <div v-if="stockEnabled">
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Current Stock') }}</label>
                            <input v-model="productForm.stock" :disabled="stockTracked || stockActivationBusy" type="number" inputmode="decimal" min="0" step="0.000001" :placeholder="$t('Leave empty for unlimited')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9 tabular-nums">
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Status') }}</label>
                            <select v-model.number="productForm.is_active" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9">
                                <option :value="1">{{ $t('Active') }}</option>
                                <option :value="0">{{ $t('Inactive') }}</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Card Background Color') }}</label>
                            <div class="flex gap-2 items-center">
                                <div class="relative flex items-center border border-zinc-300 rounded-lg bg-muted px-2.5 h-9 w-full">
                                    <input type="color" :value="productForm.background_color || '#ffffff'" @input="productForm.background_color = $event.target.value" class="w-6 h-6 border-0 p-0 bg-transparent cursor-pointer rounded">
                                    <input type="text" v-model="productForm.background_color" placeholder="#HEXCOLOR" class="ml-2 bg-transparent text-xs font-semibold text-foreground outline-none w-full placeholder:text-muted-foreground tabular-nums">
                                </div>
                                <button v-if="productForm.background_color" type="button" @click="productForm.background_color = ''" class="px-2.5 h-9 bg-muted border border-zinc-300 hover:bg-zinc-200 text-destructive hover:text-destructive/80 font-bold rounded-lg text-[10px] transition-colors focus:outline-none flex items-center justify-center" :title="$t('Reset to default')">
                                    <i class="fa-solid fa-xmark text-sm"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label for="product-customer-info" class="block text-xs font-semibold text-foreground mb-1.5">{{ $t('Customer information (optional)') }}</label>
                        <textarea id="product-customer-info" v-model="productForm.customer_info" maxlength="1200" rows="3" dir="auto" aria-describedby="product-customer-info-help" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs text-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none" :placeholder="$t('Example: Served with mutabbal, garlic sauce and our beetroot sauce.')"></textarea>
                        <p id="product-customer-info-help" class="text-xs text-muted-foreground mt-1">{{ $t('Describe the dish and included sides for the ordering assistant. Keep prices, availability and paid extras in their normal fields.') }}</p>
                    </div>

                    <div v-if="stockEnabled && productForm.id && !productForm.is_bundle" class="space-y-3">
                        <button type="button" :disabled="stockActivationBusy" :aria-expanded="stockSetupOpen" class="text-xs font-semibold text-primary underline underline-offset-4" @click="stockSetupOpen = !stockSetupOpen">{{ $t(stockTracked ? 'Manage stock movements' : 'Set up stock movements') }}</button>
                        <StockActivationPanel v-if="show && stockSetupOpen" :product-id="productForm.id" :stock-dirty="stockDirty" @state="onStockState" @activated="onStockActivated" @busy="stockActivationBusy = $event" @open-stock="emitOpenStock" />
                    </div>

                    <div class="border-t border-zinc-200 pt-4">
                        <label class="flex items-center gap-2 cursor-pointer select-none">
                            <input type="checkbox" v-model="productForm.price_override_locked" :true-value="1" :false-value="0" class="w-4 h-4 accent-primary">
                            <span class="text-[11px] font-bold text-foreground uppercase tracking-wider">{{ $t('Lock manual price entry for this product') }}</span>
                        </label>
                        <p class="text-[10px] text-muted-foreground mt-1">{{ $t('Users cannot use the Price key for this product, even with price-override permission.') }}</p>
                    </div>

                    <!-- Bundle Product Toggle -->
                    <div class="border-t border-zinc-200 pt-4">
                        <label class="flex items-center gap-2 cursor-pointer select-none">
                            <input type="checkbox" v-model="productForm.is_bundle" :disabled="stockTracked || stockActivationBusy" :true-value="1" :false-value="0" class="w-4 h-4 accent-primary">
                            <span class="text-[11px] font-bold text-foreground uppercase tracking-wider">{{ $t('Bundle Product') }}</span>
                        </label>
                        <p class="text-[10px] text-muted-foreground mt-1">{{ $t('A bundle is sold at one package price and expands into its sub-items.') }}</p>
                    </div>

                    <!-- Bundle Sub-Items Builder -->
                    <div v-if="productForm.is_bundle" class="border border-zinc-200 rounded-lg p-4 space-y-3">
                        <h4 class="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('Bundle Sub-Items') }}</h4>

                        <div class="relative">
                            <input v-model="bundleSearch" @input="onBundleSearch" type="text" :placeholder="$t('Search products to add...')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold h-9 outline-none focus:border-primary">
                            <div v-if="bundleSearchResults.length" class="absolute z-10 mt-1 w-full bg-card border border-zinc-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                                <button v-for="r in bundleSearchResults" :key="r.id" type="button" @click="addBundleItem(r)" class="w-full text-left px-3 py-2 text-xs font-semibold hover:bg-muted">
                                    <span data-no-i18n>{{ r.name }}</span>
                                </button>
                            </div>
                        </div>

                        <div v-if="bundleItems.length === 0" class="text-[11px] text-muted-foreground italic">{{ $t('No sub-items yet.') }}</div>
                        <div v-for="(bi, idx) in bundleItems" :key="bi.product_id" class="flex items-center gap-2">
                            <span class="flex-1 text-xs font-semibold text-foreground" data-no-i18n>{{ bi.name }}</span>
                            <input v-model.number="bi.qty" type="number" min="1" step="1" class="w-16 bg-muted border border-zinc-300 rounded-lg py-1 px-2 text-xs font-semibold h-8 tabular-nums outline-none focus:border-primary">
                            <button type="button" @click="moveBundleItem(idx, -1)" :aria-label="$t('Move up')" :disabled="idx === 0" class="w-7 h-8 text-muted-foreground disabled:opacity-30 hover:text-foreground"><i class="fa-solid fa-arrow-up"></i></button>
                            <button type="button" @click="moveBundleItem(idx, 1)" :aria-label="$t('Move down')" :disabled="idx === bundleItems.length - 1" class="w-7 h-8 text-muted-foreground disabled:opacity-30 hover:text-foreground"><i class="fa-solid fa-arrow-down"></i></button>
                            <button type="button" @click="removeBundleItem(idx)" :aria-label="$t('Remove')" class="w-7 h-8 text-destructive hover:text-destructive/80"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>
                </div>

                <!-- TAB 2: MODIFIERS BUILDER -->
                <div v-show="productModalTab === 'modifiers' && !productForm.is_bundle" class="p-6 space-y-4">
                    <div class="flex justify-between items-center border-b border-zinc-200 pb-3">
                        <h4 class="font-display text-[11px] font-bold text-muted-foreground tracking-tight flex items-center gap-1.5">
                            <i class="fa-solid fa-sliders text-muted-foreground"></i>
                            <span>{{ $t('Option groups') }}</span>
                        </h4>
                        <button type="button" @click="addModGroup(productForm.parsedMods)" class="px-3 py-1.5 bg-muted border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-md text-[10px] transition-all focus:outline-none">
                            {{ $t('+ Add Group') }}
                        </button>
                    </div>

                    <div v-if="!productForm.parsedMods || productForm.parsedMods.length === 0" class="text-center py-10 text-muted-foreground border-2 border-dashed border-zinc-200 rounded-lg bg-card">
                        <i class="fa-solid fa-cubes text-3xl opacity-20 mb-2 block mx-auto"></i>
                        <p class="text-xs font-bold">{{ $t('No modifiers configured.') }}</p>
                        <p class="text-[10px] text-muted-foreground/60 mt-1 max-w-xs mx-auto leading-relaxed">{{ $t('Configure modifiers like sizes, sweetness options, or extra toppings.') }}</p>
                    </div>

                    <div v-for="(group, gIndex) in productForm.parsedMods" :key="gIndex" class="bg-card border border-zinc-200 rounded-lg p-4 relative animate-in fade-in duration-100">
                        <div class="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center mb-4">
                            <input v-model="group.name" :placeholder="$t('Group Name (e.g. Size, Toppings)')" required class="w-full sm:w-60 bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-9">
                            <div class="flex items-center gap-3">
                                <label class="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer"><input type="checkbox" v-model="group.required" class="accent-primary w-4 h-4"> {{ $t('Required') }}</label>
                                <label class="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer"><input type="checkbox" v-model="group.multi_select" class="accent-primary w-4 h-4"> {{ $t('Multi-Select') }}</label>
                                <button type="button" @click="removeModGroup(productForm.parsedMods, gIndex)" :aria-label="$t('Remove')" class="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-rose-100 hover:text-rose-600 transition-colors focus:outline-none"><i class="fa-solid fa-trash text-[10px]"></i></button>
                            </div>
                        </div>

                        <div class="space-y-2 logical-ps-3 logical-border-start-2 border-primary/30 mt-2">
                            <div v-for="(opt, oIndex) in group.options" :key="oIndex" class="flex gap-2 items-center">
                                <input v-model="opt.name" :placeholder="$t('Option Name (e.g. Large, Extra Shot)')" required class="flex-1 bg-muted border border-zinc-300 rounded-lg py-1.5 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-8">
                                <div class="relative w-24 shrink-0">
                                    <span class="absolute logical-start-2 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold text-[10px]">{{ $t('JD') }}</span>
                                    <input v-model.number="opt.price" type="number" step="0.01" class="w-full bg-muted border border-zinc-300 rounded-lg py-1.5 logical-ps-8 pr-2 text-xs font-bold text-foreground focus:bg-card focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none h-8 tabular-nums" placeholder="0.00">
                                </div>
                                <button type="button" @click="removeModOption(group, oIndex)" :aria-label="$t('Remove')" class="text-muted-foreground hover:bg-rose-100 hover:text-rose-600 w-6 h-6 flex items-center justify-center rounded focus:outline-none transition-colors"><i class="fa-solid fa-xmark text-sm"></i></button>
                            </div>
                            <button type="button" @click="addModOption(group)" class="text-[10px] font-bold text-foreground bg-muted border border-zinc-300 hover:bg-zinc-200 px-2 py-1 rounded focus:outline-none flex items-center gap-1 mt-1 transition-colors"><i class="fa-solid fa-plus text-[9px]"></i> {{ $t('Add Option') }}</button>
                        </div>
                    </div>
                </div>

                <div v-show="productModalTab === 'recipe'" class="p-6">
                    <ProductRecipeEditor
                        ref="recipeEditor"
                        :product-id="productForm.id"
                        :price="productForm.price"
                        :is-bundle="Number(productForm.is_bundle) === 1"
                    />
                </div>

                <!-- Modal Actions Footer -->
                <div v-show="productModalTab !== 'recipe'" class="p-4 border-t border-zinc-200 bg-muted flex justify-end gap-3 shrink-0 select-none">
                    <button type="button" @click="requestClose" class="px-4 py-2 h-9 bg-card border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-md transition-all text-xs">{{ $t('Cancel') }}</button>
                    <button type="submit" :disabled="stockActivationBusy" class="px-4 py-2 h-9 bg-primary text-white font-bold rounded-md hover:bg-primary/90 transition-all text-xs">{{ isEditing ? $t('Edit Product') : $t('Save Product') }}</button>
                </div>
            </form>
    </ModalShell>
</template>

<script>
import { fetchJson } from '@/shared/http.js';
import { ref, computed, watch, nextTick } from 'vue';
import { t } from '@/shared/i18n.js';
import ModalShell from './ModalShell.vue';
import ProductRecipeEditor from './ProductRecipeEditor.vue';
import StockActivationPanel from './StockActivationPanel.vue';

const MAX_EXTRA_BARCODES = 20;
const MAX_BARCODE_LENGTH = 50;
const BARCODE_ERROR_CODES = new Set(['PRODUCT_BARCODE_TAKEN', 'PRODUCT_BARCODE_INVALID']);
const sameBarcode = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const sameList = (a = [], b = []) => a.length === b.length && a.every((code, index) => code === b[index]);

export default {
    name: 'ProductModal',
    components: { ModalShell, ProductRecipeEditor, StockActivationPanel },
    props: {
        show: { type: Boolean, default: false },
        product: { type: Object, default: null },
        categoriesTree: { type: Array, default: () => [] },
        stockEnabled: { type: Boolean, default: false },
        recipeLedgerEnabled: { type: Boolean, default: false },
        initialTab: { type: String, default: 'general' }
    },
    emits: ['close', 'saved', 'stock-activated', 'open-stock'],
    setup(props, { emit }) {
        const productForm = ref({
            id: null, name: '', category_id: '', price: '', tax_rate: 0, jofotara_tax_category: 'O', barcode: '', extra_barcodes: [],
            stock: '', is_active: 1, background_color: '', cost_price: '', parsedMods: [],
            is_bundle: 0, price_override_locked: 0, customer_info: '', previous_customer_info: ''
        });
        const productModalTab = ref('general');
        const recipeEditor = ref(null);
        const barcodeInput = ref(null);
        const extraBarcodeField = ref(null);
        const extraBarcodeInput = ref('');
        const extraBarcodeMessage = ref('');
        // The server's barcode refusal (taken by another product, or not valid), shown by the Barcode field.
        const barcodeError = ref('');
        const stockSetupOpen = ref(false);
        const stockActivationBusy = ref(false);
        const stockTracked = ref(false);
        const stockDirty = computed(() => !stockTracked.value && String(productForm.value.stock ?? '') !== String(props.product?.stock ?? ''));
        const onStockState = (state) => {
            stockTracked.value = state.active;
            if (state.active) {
                productForm.value.stock = state.stock ?? '';
                productForm.value.expected_stock_version = state.stock_version;
            }
        };
        const onStockActivated = (state) => emit('stock-activated', state);
        const emitOpenStock = () => { if (!stockActivationBusy.value) emit('open-stock', productForm.value.id); };

        // Bundle state
        const bundleItems = ref([]);
        const bundleSearch = ref('');
        const bundleSearchResults = ref([]);
        let bundleSearchTimer = null;

        const isEditing = computed(() => !!props.product);

        const productMargin = computed(() => {
            const price = Number(productForm.value.price || 0);
            const cost = Number(productForm.value.cost_price || 0);
            if (price <= 0 || cost <= 0) return null;
            return Math.round(((price - cost) / price) * 100);
        });

        // Initialize form when modal opens (async to allow bundle-items fetch)
        watch(() => props.show, async (val) => {
            if (!val) return;
            stockSetupOpen.value = false;
            stockActivationBusy.value = false;
            stockTracked.value = Boolean(props.product?.stock_item_id);
            productModalTab.value = stockTracked.value && props.initialTab === 'recipe' ? 'general' : (props.initialTab || 'general');

            // Reset bundle state on every open
            clearTimeout(bundleSearchTimer);
            bundleItems.value = [];
            bundleSearch.value = '';
            bundleSearchResults.value = [];
            extraBarcodeInput.value = '';
            extraBarcodeMessage.value = '';
            barcodeError.value = '';

            const product = props.product;
            if (product) {
                let parsed = [];
                try {
                    parsed = product.modifiers ? JSON.parse(product.modifiers) : [];
                    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
                } catch (e) {}
                if (!Array.isArray(parsed)) parsed = [];

                const storedRate = parseFloat(product.tax_rate) || 0;
                productForm.value = {
                    id: product.id,
                    name: product.name,
                    customer_info: product.customer_info || '',
                    previous_customer_info: product.customer_info || '',
                    category_id: product.category_id || '',
                    // DB stores pre-tax price; show admin the tax-inclusive (gross) price they originally set
                    price: storedRate > 0
                        ? (Number(product.price) * (1 + storedRate / 100)).toFixed(2)
                        : Number(product.price).toFixed(2),
                    tax_rate: storedRate,
                    jofotara_tax_category: storedRate > 0 ? 'S' : (product.jofotara_tax_category || 'O'),
                    barcode: product.barcode || '',
                    extra_barcodes: Array.isArray(product.extra_barcodes) ? product.extra_barcodes.map(String) : [],
                    expected_stock_version: product.stock_version,
                    stock: product.stock !== null && product.stock !== undefined ? product.stock : '',
                    is_active: product.is_active ?? 1,
                    background_color: product.background_color || '',
                    cost_price: product.cost_price ?? '',
                    parsedMods: parsed,
                    is_bundle: Number(product.is_bundle) || 0,
                    price_override_locked: Number(product.price_override_locked) || 0
                };

                // Load existing sub-items when editing a bundle
                if (Number(product.is_bundle) === 1) {
                    try {
                        const json = await fetchJson(`api/admin/products/${product.id}/bundle-items`);
                        bundleItems.value = (json.items || []).map((it, i) => ({
                            product_id: it.product_id,
                            name: it.name,
                            qty: Number(it.qty) || 1,
                            sort_order: i
                        }));
                    } catch (e) { /* leave empty on failure */ }
                }
            } else {
                productForm.value = {
                    id: null, name: '', category_id: '', price: '', tax_rate: 0.00, jofotara_tax_category: 'O',
                    barcode: '', extra_barcodes: [], stock: '', is_active: 1, background_color: '', cost_price: '',
                    parsedMods: [], is_bundle: 0, price_override_locked: 0, customer_info: '', previous_customer_info: ''
                };
            }
        });

        watch(() => Number(productForm.value.tax_rate || 0), (rate, previousRate) => {
            if (rate > 0) productForm.value.jofotara_tax_category = 'S';
            else if (previousRate > 0) productForm.value.jofotara_tax_category = 'O';
        });

        // --- MODIFIERS ENGINE ---
        const addModGroup = (arr) => {
            arr.push({ name: '', required: false, multi_select: false, options: [{ name: '', price: 0 }] });
        };
        const removeModGroup = (arr, idx) => arr.splice(idx, 1);
        const addModOption = (group) => group.options.push({ name: '', price: 0 });
        const removeModOption = (group, idx) => group.options.splice(idx, 1);

        // --- BUNDLE SEARCH ENGINE ---
        function onBundleSearch() {
            clearTimeout(bundleSearchTimer);
            const q = bundleSearch.value.trim();
            if (!q) { bundleSearchResults.value = []; return; }
            bundleSearchTimer = setTimeout(async () => {
                try {
                    const json = await fetchJson(`api/admin/products?search=${encodeURIComponent(q)}&limit=20`);
                    const chosen = new Set(bundleItems.value.map(b => b.product_id));
                    bundleSearchResults.value = (json.products || [])
                        .filter(p => Number(p.is_bundle) === 0)           // no bundles inside bundles
                        .filter(p => p.id !== productForm.value.id)        // not itself
                        .filter(p => !chosen.has(p.id));                   // no duplicates
                } catch (e) {
                    bundleSearchResults.value = [];
                }
            }, 250);
        }

        function addBundleItem(product) {
            if (bundleItems.value.some(b => b.product_id === product.id)) return;
            bundleItems.value.push({ product_id: product.id, name: product.name, qty: 1, sort_order: bundleItems.value.length });
            bundleSearch.value = '';
            bundleSearchResults.value = [];
        }

        function removeBundleItem(idx) {
            bundleItems.value.splice(idx, 1);
        }

        function moveBundleItem(idx, dir) {
            const target = idx + dir;
            if (target < 0 || target >= bundleItems.value.length) return;
            const arr = bundleItems.value;
            [arr[idx], arr[target]] = [arr[target], arr[idx]];
        }

        // --- EXTRA BARCODES ---
        const showBarcodeArea = () => { productModalTab.value = 'general'; };

        // Adds what is typed in the extra-barcode field; false when it was refused (the reason is shown inline).
        function addExtraBarcode() {
            const code = extraBarcodeInput.value.trim();
            extraBarcodeMessage.value = '';
            if (!code) { extraBarcodeInput.value = ''; return true; }
            const extras = productForm.value.extra_barcodes;
            if (sameBarcode(code, productForm.value.barcode) || extras.some(existing => sameBarcode(existing, code))) {
                extraBarcodeMessage.value = t('This barcode is already on this product.');
            } else if (code.length > MAX_BARCODE_LENGTH) {
                // Refused rather than cut short: a truncated scan would save a code that never matches.
                extraBarcodeMessage.value = t('Barcode cannot exceed 50 characters.');
            } else if (extras.length >= MAX_EXTRA_BARCODES) {
                extraBarcodeMessage.value = t('A product can have at most 20 extra barcodes.');
            } else {
                extras.push(code);
                extraBarcodeInput.value = '';
                barcodeError.value = '';
                return true;
            }
            return false;
        }

        // A scanner types the code and then Enter; Enter must add it, never submit the product form.
        function onExtraBarcodeEnter(event) {
            event.preventDefault();
            addExtraBarcode();
        }

        function removeExtraBarcode(code) {
            productForm.value.extra_barcodes = productForm.value.extra_barcodes.filter(existing => existing !== code);
            extraBarcodeMessage.value = '';
            barcodeError.value = '';
            extraBarcodeField.value?.focus();
        }

        const selectTab = async (tab) => {
            if (stockActivationBusy.value || (tab === 'recipe' && stockTracked.value) || productModalTab.value === tab) return;
            if (productModalTab.value === 'recipe' && recipeEditor.value) {
                const ok = await recipeEditor.value.requestClose();
                if (!ok) return;
            }
            productModalTab.value = tab;
        };

        const requestClose = async () => {
            if (stockActivationBusy.value) return;
            if (productModalTab.value === 'recipe' && recipeEditor.value) {
                const ok = await recipeEditor.value.requestClose();
                if (!ok) return;
            }
            emit('close');
        };

        const saveProduct = async () => {
            if (stockActivationBusy.value) return;
            // A code typed but not yet added is part of the form; a refused one must not be dropped silently.
            if (!addExtraBarcode()) { showBarcodeArea(); return; }
            if (!productForm.value.name || productForm.value.price === undefined || productForm.value.price === null || productForm.value.price === '') {
                await window.showAdminAlert(t('Name and price are required.'));
                return;
            }
            const payload = { ...productForm.value };
            if (isEditing.value && payload.customer_info === payload.previous_customer_info) {
                delete payload.customer_info;
                delete payload.previous_customer_info;
            }
            // Extra barcodes go only when this editor changed them, so a save never replaces a newer list another
            // admin saved meanwhile with the one this editor opened with (omitted means unchanged on the server).
            if (isEditing.value && sameList(payload.extra_barcodes, props.product?.extra_barcodes || [])) delete payload.extra_barcodes;
            if (props.product) {
                const initialStock = props.product.stock == null ? '' : String(props.product.stock);
                const nextStock = payload.stock == null ? '' : String(payload.stock);
                if (stockTracked.value || initialStock === nextStock) delete payload.stock;
                // The version was captured when the modal opened, not read from a live row.
            }
            payload.modifiers = JSON.stringify(payload.parsedMods || []);
            delete payload.parsedMods;

            if (payload.background_color) {
                let color = payload.background_color.trim();
                if (!color.startsWith('#')) {
                    color = '#' + color;
                }
                if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                    payload.background_color = color;
                } else {
                    payload.background_color = null;
                }
            } else {
                payload.background_color = null;
            }

            const editing = isEditing.value;
            try {
                const method = editing ? 'PUT' : 'POST';
                const data = await fetchJson('api/admin/products', {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (data.success) {
                    const savedId = editing ? productForm.value.id : data.id;

                    // Persist bundle sub-items after product save
                    if (productForm.value.is_bundle && savedId) {
                        const items = bundleItems.value.map((b, i) => ({
                            product_id: b.product_id,
                            qty: Number(b.qty) || 1,
                            sort_order: i
                        }));
                        const j = await fetchJson(`api/admin/products/${savedId}/bundle-items`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ items })
                        });
                        if (!j.success) throw new Error(j.message || t('Failed to save bundle items.'));
                    }

                    window.showAdminToast(editing ? t('Product updated successfully.') : t('Product created successfully.'), 'success');
                    emit('saved');
                } else if (BARCODE_ERROR_CODES.has(data.code)) {
                    barcodeError.value = t(data.message || 'Action failed.');
                    showBarcodeArea();
                    await nextTick();
                    barcodeInput.value?.focus();
                } else {
                    await window.showAdminAlert(data.message || t('Action failed.'));
                }
            } catch (e) {
                await window.showAdminAlert(e.message || t('Network error.'));
            }
        };

        return {
            productForm, barcodeInput, extraBarcodeField, extraBarcodeInput, extraBarcodeMessage, barcodeError,
            MAX_EXTRA_BARCODES, addExtraBarcode, onExtraBarcodeEnter, removeExtraBarcode,
            stockSetupOpen, stockActivationBusy, stockTracked, stockDirty, onStockState, onStockActivated, emitOpenStock,
            productModalTab,
            recipeEditor,
            selectTab,
            requestClose,
            isEditing,
            productMargin,
            addModGroup,
            removeModGroup,
            addModOption,
            removeModOption,
            saveProduct,
            bundleItems,
            bundleSearch,
            bundleSearchResults,
            onBundleSearch,
            addBundleItem,
            removeBundleItem,
            moveBundleItem
        };
    }
};
</script>

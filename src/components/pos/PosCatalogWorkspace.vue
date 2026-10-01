<template>
  <div class="flex-1 flex flex-col h-full w-full relative min-w-0">
    <div class="catalog-navigation flex items-center gap-2 px-3 bg-surface-container-lowest border-b border-outline-variant/20 shrink-0 z-40">
      <div class="catalog-brand text-base font-headline font-black text-on-surface tracking-wide flex items-center shrink-0">
        <i class="fa-solid fa-cash-register text-primary me-1.5" aria-hidden="true"></i>
        <span class="hidden sm:inline" translate="no" data-no-i18n>POS</span>
      </div>

      <div class="catalog-search relative flex-1 max-w-[210px]">
        <i class="fa-solid fa-magnifying-glass absolute start-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[10px] pointer-events-none" aria-hidden="true"></i>
        <input v-model="searchQuery" type="search" inputmode="search" enterkeyhint="search" :placeholder="$t('Search items...')"
          :aria-label="$t('Search items...')" autocomplete="off"
          class="catalog-search-input w-full h-8 bg-surface-container-high text-on-surface text-xs font-bold rounded-md py-0 ps-7 pe-2.5 border-none focus:ring-1 focus:ring-primary transition-colors outline-none shadow-inner" />
      </div>

      <button type="button" class="display-control" @click="emit('toggle-fullscreen')"
        :disabled="!props.fullscreenEnabled" :aria-pressed="props.isFullscreen"
        :title="$t(props.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen')"
        :aria-label="$t(props.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen')">
        <i :class="['fa-solid', props.isFullscreen ? 'fa-compress' : 'fa-expand']" aria-hidden="true"></i>
      </button>

      <div v-if="barcodeEnabled && !activeTable" class="catalog-search catalog-barcode relative flex-1 max-w-[170px] hidden sm:block">
        <i class="fa-solid fa-barcode absolute start-2.5 top-1/2 -translate-y-1/2 text-primary text-[10px] pointer-events-none" aria-hidden="true"></i>
        <input ref="barcodeInputRef" v-model="manualBarcode" type="text" inputmode="text" enterkeyhint="done" @keyup.enter="submitManualBarcode"
          @focus="$event.target.select()" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          :placeholder="$t('Scan barcode...')" :aria-label="$t('Scan barcode...')"
          class="catalog-search-input w-full h-8 bg-secondary-fixed text-on-surface text-xs font-bold rounded-md py-0 ps-7 pe-2.5 border-none focus:ring-1 focus:ring-primary transition-colors outline-none shadow-inner" />
      </div>

      <button v-if="tablesEnabled && !activeTable && !isCallCenter" type="button" @click="router.push('/tables')"
        class="catalog-nav-action h-8 flex items-center gap-1.5 px-2.5 bg-surface-container-high text-on-surface border border-outline-variant/30 rounded-md text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-primary-fixed hover:text-primary transition-colors shrink-0"
        :aria-label="$t('Tables')">
        <i class="fa-solid fa-table-cells-large text-primary" aria-hidden="true"></i>
        <span>{{ $t('Tables') }}</span>
      </button>

      <!-- self-stretch so the toolbar's height reaches the button: catalog-icon-action
           sizes itself with min-height:100%, which resolves against this wrapper, and a
           default-centred flex child would collapse it to the icon's own height. -->
      <div class="flex items-center gap-1.5 ms-auto self-stretch">
        <FailedPrintsBell :is-dark-mode="props.isDarkMode" />
      </div>

      <div v-if="activeTable && !isCallCenter" class="catalog-table-session" :aria-label="`${$t('Table')} ${activeTable.table_number}`">
        <span class="catalog-table-number" data-no-i18n>
          <i class="fa-solid fa-utensils" aria-hidden="true"></i>
          #{{ activeTable.table_number }}
        </span>
        <span v-if="tableActionError" class="catalog-table-error" role="alert"
          :title="$t(tableActionError)" :aria-label="$t(tableActionError)">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        </span>
        <button v-if="canPrintCheck" type="button" class="catalog-table-control"
          @click="printGuestCheck"
          :disabled="guestCheckInFlight || cartItems.length === 0 || Boolean(!activeTable.current_order_id && !activeTable.is_split)"
          :title="$t('Print Check')" :aria-label="$t('Print Check')">
          <i class="fa-solid fa-print" aria-hidden="true"></i>
          <span>{{ $t('Print Check') }}</span>
        </button>
        <button type="button" class="catalog-table-control" @click="closeTable"
          :title="$t('Floor Plan')" :aria-label="$t('Floor Plan')">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
          <span>{{ $t('Floor Plan') }}</span>
        </button>
      </div>

      <button type="button" @click="showUserSidebar = !showUserSidebar"
        :title="$t('Settings')" :aria-label="$t('Settings')"
        aria-controls="pos-user-sidebar" :aria-expanded="showUserSidebar"
        class="pos-user-trigger w-8 h-8 rounded-lg bg-surface-container-highest text-primary flex items-center justify-center font-black text-[11px] shadow-sm border border-outline-variant/30 hover:bg-primary hover:text-white transition-colors focus:outline-none shrink-0"
        data-no-i18n>
        {{ userInitials }}
      </button>
    </div>

    <div class="flex-1 flex flex-col lg:flex-row min-h-0 w-full relative">
      <aside id="categories-sidebar" class="category-sidebar w-full lg:w-40 shrink-0 z-10"
        :aria-label="$t('Product categories')">
        <div class="category-rail-scroll premium-scroll hide-scroll">
          <div v-if="hasSidebarFolder" class="category-rail-list">
            <button type="button" class="category-button category-back-row" @click="goBackSidebar()">
              <span aria-hidden="true" data-no-i18n>{{ isRtl ? '→' : '←' }}</span>
              <span>{{ $t('Back') }}</span>
            </button>

            <button type="button" class="category-button category-button--subcategory"
              :class="{ 'is-active': isCurrentSidebarFolderSelected }"
              @click="selectCurrentSidebarFolder($event)">
              <span class="category-button-label">{{ $t('All') }}</span>
            </button>

            <button v-for="sub in currentSubcategories" :key="sub.id" type="button"
              class="category-button category-button--subcategory"
              :class="{ 'is-active': isSelectedCategory(activeSubcategory, sub.id) }"
              @click="selectSubcategory(sub.id, $event)">
              <span :class="['category-button-label', { 'font-arabic': isArabic(sub.name) }]" data-no-i18n>{{ sub.name }}</span>
              <span v-if="categoryParentIds.has(String(sub.id))" class="category-chevron" aria-hidden="true">‹</span>
            </button>
          </div>

          <div v-else key="categories" class="category-rail-list">
            <button v-for="cat in mainCategories" :key="cat.id" type="button"
              class="category-button"
              :class="{ 'is-active': isSelectedCategory(activeCategory, cat.id) }"
              @click="selectMainCategory(cat.id, $event)">
              <span :class="['category-button-label', { 'font-arabic': isArabic(cat.name) }]" data-no-i18n>{{ cat.name }}</span>
              <span v-if="categoryParentIds.has(String(cat.id))" class="category-chevron" aria-hidden="true">‹</span>
            </button>
          </div>
        </div>
      </aside>

      <main class="product-stage flex-1 overflow-y-auto premium-scroll p-3 pb-20 lg:pb-3 relative" :aria-busy="isCatalogLoading">
        <div v-if="catalogLoadError" role="alert"
          class="catalog-load-error flex items-center justify-between gap-3 rounded-md border border-error/30 bg-error-container p-3 mb-3 text-on-error-container">
          <p class="text-sm font-bold">{{ $t(catalogLoadError) }}</p>
          <button type="button" @click="retryCatalogLoad" :disabled="isCatalogLoading"
            class="catalog-retry shrink-0 rounded-md border border-current px-3 py-2 text-xs font-bold disabled:opacity-50">
            {{ $t('Retry') }}
          </button>
        </div>
        <!-- One thin bar for every load: placeholder cards read as another category's products. -->
        <div v-if="isCatalogLoading" role="status" class="catalog-refresh-indicator">
          <span class="sr-only">{{ $t('Loading...') }}</span>
        </div>
        <div v-else-if="filteredProducts.length === 0 && !catalogLoadError"
          class="flex flex-col items-center justify-center h-full text-on-surface-variant">
          <i class="fa-solid fa-boxes-stacked text-4xl mb-3 opacity-40"></i>
          <p class="text-xs font-black uppercase tracking-widest">{{ $t('No products found') }}</p>
        </div>

        <div class="product-grid grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-px pb-2">
          <div v-for="product in filteredProducts" :key="product.id"
            @click="handleProductClick(product)"
            @contextmenu.prevent="handleProductContextMenu(product)"
            @pointerdown="startProductLongPress(product, $event)"
            @pointermove="moveProductLongPress($event)"
            @pointerup="cancelProductLongPress"
            @pointercancel="cancelProductLongPress"
            @pointerleave="cancelProductLongPress"
            :class="[
              'product-card btn-3d relative h-24 p-3 cursor-pointer flex flex-col justify-between items-center text-center transition-all select-none',
              activeTable?.is_split ? 'opacity-60 pointer-events-none' : '',
              cardStyles(product).bgClass,
              !isNoteProduct(product) && !isProductSellable(product) ? 'product-card--sold-out' : '',
              !isNoteProduct(product) && settings?.stock_enabled === '1' && product.stock !== null && product.stock !== '' && (Number(product.stock) - cart.getPendingQtyInCart(product.id)) < 1
                ? 'opacity-50 pointer-events-none grayscale'
                : ''
            ]"
            :style="{
              ...cardStyles(product).style,
              ...(!isNoteProduct(product) && !isProductSellable(product) ? soldOutProductStyle : {})
            }">
            <span v-if="!isNoteProduct(product) && !isProductSellable(product)"
              class="product-sold-out-badge absolute top-1.5 start-1.5 px-1.5 py-0.5 rounded text-[8px] font-black">
              {{ $t('Sold out') }}
            </span>
            <h3 :class="['font-bold text-sm line-clamp-3 mb-1 mt-auto', cardStyles(product).textClass, isArabic(product.name) ? 'font-arabic product-card-name--arabic' : 'leading-tight']">
              <span data-no-i18n>{{ product.name }}</span>
            </h3>
            <p v-if="searchQuery && (product.price_list_root_name || product.category_name)"
              class="text-[8px] leading-tight text-muted-foreground truncate w-full" data-no-i18n>
              {{ product.price_list_root_name || product.category_name }}
            </p>
            <p v-if="!isNoteProduct(product)"
              :class="['font-black text-[10px] sm:text-[11px] mt-0.5 mb-auto', cardStyles(product).priceClass]">
              {{ tilePrice(product) }} JD
            </p>
            <div v-else class="mt-0.5 mb-auto">
              <i class="fa-solid fa-note-sticky opacity-35 text-[10px]"></i>
            </div>
          </div>
        </div>

        <div v-if="hasMoreProducts" class="flex justify-center pt-4 pb-2">
          <button @click="loadMoreProducts" :disabled="isCatalogLoading"
            class="px-5 py-2.5 bg-surface-container-lowest border border-outline-variant/40 rounded-xl text-[10px] font-black uppercase tracking-widest text-on-surface hover:text-primary hover:border-primary/50 hover:bg-primary-fixed transition-colors duration-100 ease-out active:scale-[0.98]">
            <i v-if="isCatalogLoading" class="fa-solid fa-circle-notch fa-spin mr-1"></i>
            {{ $t('Load More') }}
          </button>
        </div>
      </main>
    </div>

    <PosMobileCartSummary />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onDeactivated } from 'vue';
import { currentLanguage, getDirection, t } from '@/shared/i18n.js';
import { isUnansweredRequest } from '@/shared/http.js';
import { useRouter } from 'vue-router';
import { useAuth } from '@/pos/useAuth.js';
import { useCart } from '@/pos/useCart.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { useProducts } from '@/pos/useProducts.js';
import { useTables } from '@/pos/useTables.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { useSocket } from '@/pos/useSocket.js';
import { isArabic } from '@/utils/orderNotesFormat.js';
import { hasNoteProduct, isNoteProduct, toggleNoteProduct } from '@/pos/noteProductSelections.js';
import FailedPrintsBell from '@/components/pos/FailedPrintsBell.vue';
import PosMobileCartSummary from '@/components/pos/PosMobileCartSummary.vue';

const router = useRouter();
const auth = useAuth();
const cart = useCart();
const products = useProducts();
const tables = useTables();
const terminal = useTerminal({ salesContext: products.salesContext });
// Tiles follow the order session profile that checkout charges with (a restored hold keeps
// its own profile): income tax charges no sales tax on the line (cart effectiveLine).
const tilePrice = (product) => {
  const rate = cart.taxRegistrationType?.value === 'income_tax' ? 0 : (parseFloat(product.tax_rate) || 0);
  return (parseFloat(product.price) * (1 + rate / 100)).toFixed(2);
};
const { can } = usePermissions();

const props = defineProps({
  isFullscreen: { type: Boolean, default: false },
  fullscreenEnabled: { type: Boolean, default: true },
  // Forwarded to FailedPrintsBell: its modal teleports to body, escaping the root element
  // that carries pos-theme-dark, so it has to re-apply the theme itself.
  isDarkMode: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle-fullscreen']);

const { showUserSidebar, userInitials, activeUser } = auth;
const {
  categories, settings, isCatalogLoading, catalogLoadError,
  hasMoreProducts, searchQuery, activeCategory, activeSubcategory, currentSidebarFolder,
  mainCategories, currentSubcategories, selectMainCategory, selectSubcategory,
  goBackSidebar, filteredProducts, loadMoreProducts, retryCatalogLoad,
} = products;
const { activeTable, tableActionError, tablesEnabled, closeTable } = tables;
const { barcodeEnabled, manualBarcode, barcodeInputRef, submitManualBarcode, quickNumpadMode } = terminal;
const { isSocketConnected } = useSocket();
const {
  cart: cartItems, selectedCartIndex, addToCart,
  canPrintCheck, printGuestCheck, guestCheckInFlight, quickTargetAmount, cancelQuickAmount,
} = cart;

const sameMapEntries = (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

// Reuse the store's quantity rules once per visible product, across all card
// bindings. The computed tracks the same cart fields as the authoritative read.
const productQuantities = computed((previous) => {
  const next = new Map(filteredProducts.value
    .filter(product => !isNoteProduct(product))
    .map(product => [String(product.id), cart.getQtyInCart(product.id)]));
  return previous && sameMapEntries(previous, next) ? previous : next;
});
const getQtyInCart = productId => productQuantities.value.get(String(productId)) ?? cart.getQtyInCart(productId);

const isRtl = computed(() => getDirection(currentLanguage.value) === 'rtl');
const isCallCenter = computed(() => activeUser.value?.role === 'call_center');
const canManageProductAvailability = computed(() => can('pos.product_availability'));
const hasSidebarFolder = computed(() => currentSidebarFolder.value !== null && currentSubcategories.value.length > 0);
const isSelectedCategory = (selectedId, categoryId) => (
  selectedId !== null && categoryId !== null && String(selectedId) === String(categoryId)
);
const categoryParentIds = computed(() => new Set(categories.value
  .filter(c => c.parent_id && Number(c.parent_id) !== 0)
  .map(c => String(c.parent_id))));
const isCurrentSidebarFolderSelected = computed(() => {
  if (!hasSidebarFolder.value) return false;
  return activeSubcategory.value !== null
    ? isSelectedCategory(activeSubcategory.value, currentSidebarFolder.value)
    : isSelectedCategory(activeCategory.value, currentSidebarFolder.value);
});
const selectCurrentSidebarFolder = (event) => {
  const folder = categories.value.find(category => String(category.id) === String(currentSidebarFolder.value));
  const isMainCategory = !folder?.parent_id || Number(folder.parent_id) === 0;
  selectSubcategory(isMainCategory ? null : folder?.id ?? null, event);
};

const computeProductCardStyles = (bgHex, isInCart) => {
  if (isInCart) {
    return {
      style: { '--shadow-color': '#172b43' },
      textClass: 'text-white product-card-name--on-dark',
      priceClass: 'text-white',
      bgClass: 'bg-primary border border-primary shadow-md text-white',
    };
  }
  if (!bgHex) {
    return {
      style: { '--shadow-color': '#6f7d8e' },
      textClass: 'text-on-surface transition-colors',
      priceClass: 'text-primary',
      bgClass: 'bg-surface-container-lowest hover:bg-primary-fixed/40 hover:border-primary/40 text-on-surface border border-outline/70',
    };
  }
  const cleanHex = bgHex.replace('#', '');
  const red = parseInt(cleanHex.substring(0, 2), 16) || 0;
  const green = parseInt(cleanHex.substring(2, 4), 16) || 0;
  const blue = parseInt(cleanHex.substring(4, 6), 16) || 0;
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
  const shadowColor = `rgb(${Math.max(0, Math.floor(red * 0.7))}, ${Math.max(0, Math.floor(green * 0.7))}, ${Math.max(0, Math.floor(blue * 0.7))})`;
  const useLightText = 1.05 / (luminance + 0.05) >= 3.9;
  return {
    style: { backgroundColor: bgHex, borderColor: shadowColor, '--shadow-color': shadowColor },
    textClass: useLightText ? 'text-white product-card-name--on-dark' : 'text-gray-950',
    priceClass: useLightText ? 'text-white' : 'text-gray-950',
    bgClass: 'border shadow-md',
  };
};

const cardStyleMemo = new Map();
const getProductCardStyles = (bgHex, isInCart) => {
  const key = `${bgHex || ''}|${isInCart ? 1 : 0}`;
  let styles = cardStyleMemo.get(key);
  if (!styles) {
    styles = computeProductCardStyles(bgHex, isInCart);
    cardStyleMemo.set(key, styles);
  }
  return styles;
};

const soldOutProductStyle = {
  backgroundColor: '#d9dee2',
  borderColor: '#aeb7bf',
  '--shadow-color': '#7f8b98',
};
const isProductSellable = product => Number(product?.can_sell ?? product?.is_available ?? 1) === 1;
const bundleHasUnavailableProduct = product => Number(product?.is_bundle) === 1
  && Array.isArray(product.bundleItems)
  && product.bundleItems.some(item => Number(item.is_active) !== 1 || Number(item.is_available) !== 1);
const isNoteActive = (product) => {
  return selectedCartIndex.value !== null
    && isNoteProduct(product)
    && hasNoteProduct(cartItems.value[selectedCartIndex.value], product.id);
};
const productCardStyles = computed((previous) => {
  const next = new Map(filteredProducts.value.map(product => [
    product.id,
    getProductCardStyles(product.background_color, isNoteProduct(product) ? isNoteActive(product) : getQtyInCart(product.id) > 0),
  ]));
  return previous && sameMapEntries(previous, next) ? previous : next;
});
const cardStyles = product => productCardStyles.value.get(product.id);
const isVisibleCatalogProduct = product => filteredProducts.value.some(entry => String(entry.id) === String(product.id));

let productLongPressTimer = null;
let productLongPressStart = null;
let suppressProductClickUntil = 0;
const cancelProductLongPress = () => {
  if (productLongPressTimer) clearTimeout(productLongPressTimer);
  productLongPressTimer = null;
  productLongPressStart = null;
};
const updateProductAvailability = async (product) => {
  if (!isVisibleCatalogProduct(product) || !canManageProductAvailability.value || isNoteProduct(product)) return;
  if (bundleHasUnavailableProduct(product)) {
    await window.showPosAlert(t('This bundle is unavailable because one of its products is sold out.'));
    return;
  }
  const currentlyAvailable = Number(product.is_available ?? 1) === 1;
  const confirmed = await window.showPosConfirm(
    `${t(currentlyAvailable ? 'Stop selling this product?' : 'Return this product to sale?')}\n${product.name}`,
    t('Manage product availability')
  );
  if (!confirmed) return;
  try {
    const { response, data } = await products.setProductAvailability(product.id, !currentlyAvailable);
    if (!response.ok || !data.success) throw new Error(data.message || t('Failed to update product availability.'));
    window.showPosToast?.(t('Product availability updated.'), 'success');
    if (data.product) {
      products.applyProductAvailabilityChanges([{
        product_id: data.product.id,
        is_available: data.product.is_available,
        can_sell: data.product.can_sell ?? data.product.is_available,
      }]);
    }
    if (!isSocketConnected.value) await products.fetchData({ force: true });
  } catch (error) {
    // Setting an absolute value is safe to retry, but the change may have landed.
    await window.showPosAlert(isUnansweredRequest(error)
      ? t('Could not confirm the availability change. Check the product before trying again.')
      : error.message || t('Failed to update product availability.'));
  }
};
const handleProductContextMenu = (product) => {
  if (!canManageProductAvailability.value || isNoteProduct(product)) return;
  suppressProductClickUntil = Date.now() + 800;
  void updateProductAvailability(product);
};
const startProductLongPress = (product, event) => {
  cancelProductLongPress();
  if (!canManageProductAvailability.value || isNoteProduct(product)) return;
  if (!event.isPrimary || !['touch', 'pen'].includes(event.pointerType)) return;
  productLongPressStart = { x: event.clientX, y: event.clientY };
  productLongPressTimer = setTimeout(() => {
    suppressProductClickUntil = Date.now() + 900;
    productLongPressTimer = null;
    productLongPressStart = null;
    void updateProductAvailability(product);
  }, 650);
};
const moveProductLongPress = (event) => {
  if (!productLongPressStart) return;
  if (Math.hypot(event.clientX - productLongPressStart.x, event.clientY - productLongPressStart.y) > 12) {
    cancelProductLongPress();
  }
};
const handleProductClick = async (product) => {
  if (!isVisibleCatalogProduct(product)) return;
  if (activeTable.value?.is_split) return;
  if (Date.now() < suppressProductClickUntil) return;
  if (!isNoteProduct(product)) {
    if (!isProductSellable(product)) {
      if (quickNumpadMode.value) cancelQuickAmount();
      window.showPosToast?.(t('This product is sold out.'), 'warning');
    } else {
      await addToCart(product, { source: 'catalog', useQuickAmount: quickNumpadMode.value });
    }
    return;
  }
  if (quickNumpadMode.value) cancelQuickAmount();
  if (selectedCartIndex.value === null) {
    await window.showPosAlert(t('Please select a cart item first to apply notes.'));
    return;
  }
  if (Number(product.category_is_active) !== 1) {
    window.showPosToast?.(t('A priced note changed or is unavailable. Refresh and re-add it.'), 'warning');
    return;
  }
  const item = cartItems.value[selectedCartIndex.value];
  if (item.order_item_id != null) {
    window.showPosToast?.(t('Saved items cannot be changed. Add a new line instead.'), 'warning');
    return;
  }
  toggleNoteProduct(item, product);
};

onBeforeUnmount(cancelProductLongPress);
onDeactivated(cancelProductLongPress);
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.product-card-name--arabic {
  line-height: 1.5;
  margin-inline: -0.25rem;
  padding-inline: 0.25rem;
}
.product-card--sold-out { filter: saturate(0.35); }
.product-card-name--on-dark { text-shadow: 0 1px 1px rgb(15 23 42 / 65%); }
.product-card--sold-out :deep(h3),
.product-card--sold-out :deep(p) { color: #475569 !important; }
.product-sold-out-badge {
  color: #334155;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(100, 116, 139, 0.35);
}
.catalog-refresh-indicator {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 2px;
  margin-block-end: 2px;
  overflow: hidden;
  background: var(--color-surface-container-highest);
}
.catalog-refresh-indicator::after {
  content: '';
  display: block;
  width: 32%;
  height: 100%;
  background: var(--color-primary);
  animation: catalog-refresh-slide 750ms ease-in-out infinite;
  will-change: transform;
}
@keyframes catalog-refresh-slide {
  from { transform: translateX(-110%); }
  to { transform: translateX(330%); }
}
@media (prefers-reduced-motion: reduce) {
  .catalog-refresh-indicator::after { animation: none; }
}
#categories-sidebar,
#categories-sidebar * { touch-action: auto !important; }
.hide-scroll::-webkit-scrollbar { display: none; }
.hide-scroll {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>

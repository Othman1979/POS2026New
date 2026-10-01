<template>
    <div class="menu-root">

        <!-- ── Ambient Background Orbs ── -->
        <div class="ambient-bg" aria-hidden="true">
            <div class="ambient-orb ambient-orb--1"></div>
            <div class="ambient-orb ambient-orb--2"></div>
            <div class="ambient-orb ambient-orb--3"></div>
        </div>

        <!-- ── Loader Skeleton ── -->
        <div v-if="isLoading" class="menu-skeleton-screen">
            <div class="menu-container">
                <div class="skeleton-hero">
                    <div class="sk-bar sk-bar--sm mb-4" style="width: 9rem;"></div>
                    <div class="sk-bar sk-bar--xl mb-2" style="width: 22rem;"></div>
                    <div class="sk-bar sk-bar--xl mb-6" style="width: 14rem;"></div>
                    <div class="sk-divider"></div>
                </div>
                <div class="skeleton-nav">
                    <div class="sk-bar sk-bar--pill" style="width: 3rem;"></div>
                    <div class="sk-bar sk-bar--pill" style="width: 5rem;"></div>
                    <div class="sk-bar sk-bar--pill" style="width: 4rem;"></div>
                    <div class="sk-bar sk-bar--pill" style="width: 6rem;"></div>
                    <div class="sk-bar sk-bar--pill" style="width: 4.5rem;"></div>
                </div>
                <div class="bento-grid mt-10">
                    <div v-for="n in 6" :key="n" class="sk-card"
                        :class="{ 'product-card--hero': n === 1 }"
                        :style="{ '--sk-index': n }"></div>
                </div>
            </div>
        </div>

        <template v-else>

            <!-- ── Floating Action Bar ── -->
            <div class="fixed top-4 right-4 sm:top-6 sm:right-6 flex gap-2 z-50">
                <button @click="toggleLanguage"
                    class="action-btn font-bold text-xs uppercase tracking-widest">
                    {{ currentLang === 'en' ? 'ع' : 'EN' }}
                </button>
                <button @click="showQrModal = true" class="action-btn">
                    <i class="fa-solid fa-qrcode text-base"></i>
                </button>
            </div>

            <!-- ── Hero Header ── -->
            <header class="menu-hero">
                <div class="menu-container">
                    <p v-if="storeInfo.store_address" class="menu-hero__eyebrow" data-no-i18n>
                        <i class="fa-solid fa-location-dot" style="color:#059669"></i>
                        {{ storeInfo.store_address }}
                    </p>
                    <h1 class="menu-hero__title" data-no-i18n>
                        {{ storeInfo.store_name || $t('Our Menu') }}<span style="color:#059669">.</span>
                    </h1>
                    <div class="menu-hero__divider"></div>
                </div>
            </header>

            <!-- ── Sticky Category Navigation ── -->
            <nav class="menu-nav-wrapper" aria-label="Menu categories">
                <div class="menu-container">
                    <div class="menu-nav-scroll">

                        <!-- Back button when inside a subcategory folder -->
                        <button v-if="currentFolder !== null"
                            @click="goBackToMainCategories"
                            class="nav-back-btn">
                            <i class="fa-solid fa-arrow-left text-[9px]"></i>
                            {{ $t('Back') }}
                        </button>

                        <!-- "All" button -->
                        <button @click="selectLevelAll"
                            :class="['nav-item',
                                ((currentFolder === null && activeCategory === null) ||
                                 (currentFolder !== null && activeSubcategory === null))
                                    ? 'nav-item--active' : '']">
                            {{ $t('All') }}
                        </button>

                        <!-- Main categories -->
                        <template v-if="currentFolder === null">
                            <button v-for="cat in mainCategories" :key="cat.id"
                                @click="selectMainCategory(cat)"
                                :class="['nav-item', activeCategory === cat.id ? 'nav-item--active' : '']">
                                <span :class="{ 'font-arabic': isArabic(cat.name) }" data-no-i18n>{{ cat.name }}</span>
                                <span v-if="hasSubcategories(cat.id)" class="nav-item__arrow">›</span>
                            </button>
                        </template>

                        <!-- Subcategories (when inside a folder) -->
                        <template v-else>
                            <button v-for="sub in getSubcategories(currentFolder)" :key="sub.id"
                                @click="activeSubcategory = sub.id"
                                :class="['nav-item', activeSubcategory === sub.id ? 'nav-item--active' : '']">
                                <span :class="{ 'font-arabic': isArabic(sub.name) }" data-no-i18n>{{ sub.name }}</span>
                            </button>
                        </template>

                    </div>
                </div>
            </nav>

            <!-- ── Main Content Area ── -->
            <main class="flex-1 pb-32">
                <div class="menu-container py-10 sm:py-14">

                    <!-- Empty State -->
                    <transition name="menu-transition">
                        <!-- Empty State -->
                        <div v-if="groupedProducts.length === 0 || (groupedProducts.length === 1 && groupedProducts[0].products.length === 0)"
                            key="empty" class="menu-empty-state">
                            <div class="menu-empty-state__icon">
                                <i class="fa-solid fa-bowl-food text-3xl text-zinc-300"></i>
                            </div>
                            <h3 class="menu-empty-state__text">{{ $t('No offerings in this category') }}</h3>
                        </div>

                        <!-- Product Groups — keyed on renderKey to trigger stagger re-animation -->
                        <div v-else :key="renderKey" class="space-y-16">
                            <section v-for="(group, groupIndex) in groupedProducts" :key="group.id">

                                <!-- Section Heading: only visible in "All" mode (multiple groups) -->
                                <div v-if="groupedProducts.length > 1" class="section-heading">
                                    <span class="section-heading__num">{{ String(groupIndex + 1).padStart(2, '0') }}</span>
                                    <div class="section-heading__body">
                                        <h2 class="section-heading__title"
                                            :class="{ 'font-arabic': isArabic(group.name) }"
                                            data-no-i18n>{{ group.name }}</h2>
                                        <span class="section-heading__count">{{ group.products.length }} {{ $t('items') }}</span>
                                    </div>
                                </div>

                                <!-- Bento Product Grid -->
                                <div class="bento-grid">
                                    <div
                                        v-for="(product, index) in group.products"
                                        :key="product.id"
                                        class="product-card"
                                        :class="{
                                            'product-card--hero': index % 5 === 0,
                                            'product-card--dark-bg': isProductSellable(product) && product.background_color && getContrastYIQ(product.background_color) === 'dark',
                                            'product-card--sold-out': !isProductSellable(product)
                                        }"
                                        :style="{
                                            '--card-index': index,
                                            ...(product.background_color ? { backgroundColor: product.background_color } : {})
                                        }">

                                        <span v-if="!isProductSellable(product)" class="menu-sold-out-badge">{{ $t('Sold out') }}</span>


                                        <!-- Product Info — two-row compact layout -->
                                        <div class="product-card__body">
                                            <!-- Row 1: Name + Price -->
                                            <div class="product-card__top">
                                                <h3
                                                    class="product-card__name"
                                                    :class="[
                                                        { 'font-arabic': isArabic(product.name) },
                                                        { 'product-card__name--hero': index % 5 === 0 }
                                                    ]"
                                                    data-no-i18n>
                                                    {{ product.name }}
                                                </h3>
                                                <div class="product-card__price-wrap">
                                                    <span class="product-card__price">{{ Number(product.price).toFixed(2) }}</span>
                                                    <span class="product-card__currency">JD</span>
                                                </div>
                                            </div>
                                            <!-- Row 2: Category + Cart Controls -->
                                            <div class="product-card__bottom">
                                                <span class="product-card__cat">{{ getCategoryName(product.category_id) }}</span>
                                                <div v-if="tableId" class="shrink-0">
                                                    <div v-if="getItemQty(product.id) > 0" class="qty-control">
                                                        <button @click.stop="updateQty(product.id, -1)" class="qty-btn">
                                                            <i class="fa-solid fa-minus text-[9px]"></i>
                                                        </button>
                                                        <span class="qty-value">{{ getItemQty(product.id) }}</span>
                                                        <button @click.stop="updateQty(product.id, 1)" class="qty-btn"
                                                            :disabled="!isProductSellable(product)">
                                                            <i class="fa-solid fa-plus text-[9px]"></i>
                                                        </button>
                                                    </div>
                                                    <button v-else @click.stop="addToCart(product)" class="add-btn"
                                                        :disabled="!isProductSellable(product)">
                                                        <i class="fa-solid fa-plus text-[9px]"></i>
                                                        {{ $t('Add') }}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                    </div>
                                </div>

                            </section>
                        </div>
                    </transition>

                </div>
            </main>

            <!-- ── Footer ── -->
            <footer class="menu-footer">
                <div class="menu-container">
                    <div class="menu-footer__inner">
                        <span class="menu-footer__brand" data-no-i18n>
                            {{ storeInfo.store_name || $t('Restaurant') }}<span class="text-brand-accent">.</span>
                        </span>
                        <div class="menu-footer__meta">
                            <span v-if="storeInfo.store_address" data-no-i18n>
                                <i class="fa-solid fa-location-dot text-brand-accent me-1.5"></i>{{ storeInfo.store_address }}
                            </span>
                            <span v-if="storeInfo.store_phone" data-no-i18n>
                                <i class="fa-solid fa-phone text-brand-accent me-1.5"></i>{{ storeInfo.store_phone }}
                            </span>
                        </div>
                        <p class="menu-footer__copy">
                            ©
                            <span data-no-i18n>{{ new Date().getFullYear() }} {{ storeInfo.store_name || $t('Restaurant') }}</span>.
                            {{ $t('All rights reserved.') }}
                        </p>
                    </div>
                </div>
            </footer>

            <!-- ── Floating Cart Pill ── -->
            <transition name="cart-pop">
                <div v-if="cart.length > 0" class="cart-pill-wrap">
                    <button @click="showCartDrawer = true" class="cart-pill">
                        <div class="cart-pill__left">
                            <div class="cart-pill__icon">
                                <i class="fa-solid fa-basket-shopping text-sm" style="color:#059669"></i>
                                <span class="cart-pill__badge">{{ cartCount }}</span>
                            </div>
                            <div class="cart-pill__info">
                                <span class="cart-pill__label">{{ $t('Your Order') }}</span>
                                <span v-if="tableId" class="cart-pill__table">{{ $t('Table') }} #{{ tableId }}</span>
                            </div>
                        </div>
                        <div class="cart-pill__right">
                            <span class="cart-pill__total">{{ cartTotal.toFixed(2) }} JD</span>
                            <i class="fa-solid fa-chevron-right text-[10px] text-white/40"></i>
                        </div>
                    </button>
                </div>
            </transition>

            <!-- ── Cart Drawer ── -->
            <transition name="drawer-slide">
                <div v-if="showCartDrawer" class="cart-overlay" @click.self="showCartDrawer = false">
                    <div class="cart-drawer">
                        <div class="cart-drawer__handle"></div>

                        <!-- Drawer Header -->
                        <div class="cart-drawer__header">
                            <div>
                                <h3 class="cart-drawer__title">{{ $t('Your Order') }}</h3>
                                <p v-if="tableId" class="cart-drawer__subtitle">{{ $t('Table') }} #{{ tableId }}</p>
                            </div>
                            <button @click="clearCart" class="cart-clear-btn">
                                <i class="fa-solid fa-trash-can"></i>
                                {{ $t('Clear All') }}
                            </button>
                        </div>

                        <!-- Item List -->
                        <div class="cart-drawer__items">
                            <div v-for="item in cart" :key="item.id" class="cart-item">
                                <div class="cart-item__thumb">
                                    <img v-if="item.image" :src="'uploads/' + item.image" :alt="item.name" class="cart-item__img">
                                    <i v-else class="fa-solid fa-image text-zinc-300 text-sm"></i>
                                </div>
                                <div class="cart-item__info">
                                    <h4 class="cart-item__name" data-no-i18n>{{ item.name }}</h4>
                                    <p class="cart-item__price">{{ Number(item.price).toFixed(2) }} JD</p>
                                </div>
                                <div class="qty-control qty-control--drawer">
                                    <button @click="updateQty(item.id, -1)" class="qty-btn">
                                        <i class="fa-solid fa-minus text-[9px]"></i>
                                    </button>
                                    <span class="qty-value">{{ item.qty }}</span>
                                    <button @click="updateQty(item.id, 1)" class="qty-btn"
                                        :disabled="!isProductSellable(products.find(product => product.id === item.id))">
                                        <i class="fa-solid fa-plus text-[9px]"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Drawer Footer -->
                        <div class="cart-drawer__footer">
                            <div class="cart-total-row">
                                <span class="cart-total-label">{{ $t('Total') }}</span>
                                <span class="cart-total-amount">{{ cartTotal.toFixed(2) }} JD</span>
                            </div>
                            <div class="cart-info-banner">
                                <i class="fa-solid fa-circle-info text-brand shrink-0 mt-0.5"></i>
                                <p v-if="tableId">
                                    {{ $t('Your cart is synchronized in real-time with Table') }} #{{ tableId }}.
                                    {{ $t('Please let the waiter know when you are ready to finalize your order.') }}
                                </p>
                                <p v-else>{{ $t('Please let the waiter know when you are ready to place your order.') }}</p>
                            </div>
                            <button @click="showCartDrawer = false" class="cart-continue-btn">
                                {{ $t('Continue Browsing') }}
                            </button>
                        </div>
                    </div>
                </div>
            </transition>

            <transition name="grid-fade">
                <div v-if="showQrModal"
                    class="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-950/90 px-4"
                    @click.self="showQrModal = false">
                    <div class="bg-white rounded-3xl p-8 max-w-xs w-full shadow-2xl relative border border-zinc-100">
                        <button @click="showQrModal = false"
                            class="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors active:scale-90">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <div class="text-center mb-6 mt-2">
                            <div class="w-14 h-14 mx-auto bg-brand-light text-brand rounded-2xl flex items-center justify-center mb-4 border border-brand/5">
                                <i class="fa-solid fa-share-nodes text-xl"></i>
                            </div>
                            <h3 class="text-2xl font-display font-black text-dark-base mb-1">{{ $t('Share Menu') }}</h3>
                            <p class="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">{{ $t('Scan to view on your device') }}</p>
                        </div>
                        <div class="bg-zinc-50 p-4 rounded-2xl mb-6 mx-auto w-52 h-52 border border-zinc-200/50 flex items-center justify-center">
                            <img v-if="menuQrUrl" :src="menuQrUrl" alt="Share QR Code" class="w-44 h-44 rounded-xl object-contain mix-blend-multiply">
                            <i v-else class="fa-solid fa-circle-notch fa-spin text-3xl text-zinc-400"></i>
                        </div>
                        <a :href="menuQrUrl || '#'" :aria-disabled="!menuQrUrl" download="Digital_Menu_QR.png" target="_blank"
                            :class="['w-full py-4 flex items-center justify-center gap-2 bg-brand text-white font-bold text-[13px] rounded-2xl hover:bg-brand-hover shadow-lg shadow-brand/10 transition-all duration-300 active:scale-95',
                                !menuQrUrl ? 'pointer-events-none opacity-60' : '']">
                            <i class="fa-solid fa-download"></i> {{ $t('Save Image') }}
                        </a>
                    </div>
                </div>
            </transition>

        </template>
    </div>
</template>

<script>
import { io } from 'socket.io-client';
import { fetchJson } from '@/shared/http.js';
import { SOCKET_CLIENT_OPTIONS, applyReconnectPolicy, createRefusalRetry } from '@/shared/socketRefusalRetry.js';
import { ref, computed, onMounted, watch, onUnmounted } from 'vue';
import { setLanguage } from '@/shared/i18n.js';
import { isArabic } from '../utils/orderNotesFormat.js';

export default {
    setup() {
        const isLoading = ref(true);
        const storeInfo = ref({});
        const categories = ref([]);
        const products = ref([]);
        const activeCategory = ref(null);
        const activeSubcategory = ref(null);
        const currentFolder = ref(null);
        const currentLang = ref(localStorage.getItem('pos_admin_language') || 'en');
        const visibleCount = ref(30);
        const renderKey = ref(0); // Bumped on category change to trigger stagger re-animation

        // --- QR Cart Sync State ---
        const tableId = ref(null);
        const cart = ref([]);
        const showCartDrawer = ref(false);
        let socket = null;
        let refusalRetry = null;

        // A deployment replaced the hashed chunk this open tab still points at:
        // reload once (not while offline, not more than once a minute).
        const reloadForReplacedChunk = (err) => {
            if (!/dynamically imported module|Importing a module script failed/i.test(err?.message || '')) return;
            if (navigator.onLine === false) return;
            try {
                const key = 'menu_chunk_reload_attempted_at';
                if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 60_000) return;
                sessionStorage.setItem(key, String(Date.now()));
            } catch (_) { return; }
            flushCartSync();
            window.location.reload();
        };

        // --- QR Share Modal State ---
        const showQrModal = ref(false);
        const menuQrUrl = ref('');
        const generateMenuQrUrl = async () => {
            const { default: QRCode } = await import('qrcode');
            const cleanUrl = window.location.href.split('#')[0];
            menuQrUrl.value = await QRCode.toDataURL(cleanUrl, {
                width: 500,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: {
                    dark: '#047857',
                    light: '#ffffff'
                }
            });
        };

        let qrRequest = null;
        watch(showQrModal, (open) => {
            if (!open || menuQrUrl.value || qrRequest) return;
            qrRequest = generateMenuQrUrl()
                .catch((err) => {
                    console.error('Failed to build the share QR:', err);
                    reloadForReplacedChunk(err);
                })
                .finally(() => { qrRequest = null; });
        });

        // Computed Cart Info
        const cartCount = computed(() => cart.value.reduce((sum, item) => sum + item.qty, 0));
        const cartTotal = computed(() => cart.value.reduce((sum, item) => sum + (item.price * item.qty), 0));

        const getItemQty = (productId) => {
            const item = cart.value.find(i => i.id === productId);
            return item ? item.qty : 0;
        };

        const isProductSellable = (product) => Number(product?.can_sell ?? product?.is_available ?? 1) === 1;

        const addToCart = (product) => {
            if (!isProductSellable(product)) return;
            const existing = cart.value.find(i => i.id === product.id);
            if (existing) {
                existing.qty++;
            } else {
                cart.value.push({
                    id: product.id,
                    name: product.name,
                    price: Number(product.price),
                    qty: 1,
                    image: product.image || null
                });
            }
        };

        const updateQty = (productId, delta) => {
            const existing = cart.value.find(i => i.id === productId);
            if (!existing) return;
            const product = products.value.find(item => item.id === productId);
            if (delta > 0 && !isProductSellable(product)) return;
            existing.qty += delta;
            if (existing.qty <= 0) {
                cart.value = cart.value.filter(i => i.id !== productId);
            }
        };

        const clearCart = () => {
            cart.value = [];
        };



        const getContrastYIQ = (hexColor) => {
            const hex = String(hexColor || '').replace('#', '');
            if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 'light';
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
            return yiq >= 140 ? 'light' : 'dark';
        };

        // Socket connection and real-time table sync
        const initSocket = () => {
            const params = new URLSearchParams(window.location.search);
            const tid = parseInt(params.get('table'));
            const token = params.get('token') || '';
            if (tid && !isNaN(tid)) {
                tableId.value = tid;
                socket = io({
                    ...SOCKET_CLIENT_OPTIONS,
                    auth: {
                        type: 'customer',
                        tableId: tid,
                        token: token
                    }
                });
                refusalRetry = createRefusalRetry(socket);
                applyReconnectPolicy(socket);
                socket.on('connect', () => {
                    refusalRetry.connected();
                    console.log('[Sync] Connected to table room:', tid);
                });
                socket.on('connect_error', (err) => {
                    console.warn('[Sync] Socket connection error:', err.message);
                    // A wrong or missing QR token stays refused; anything else is retried.
                    if (!err.message?.startsWith('Unauthorized:')) refusalRetry.refused();
                });
                socket.on('product_availability_changed', (payload) => {
                    for (const change of payload?.products || []) {
                        const product = products.value.find(item => String(item.id) === String(change.product_id));
                        if (!product) continue;
                        product.is_available = Number(change.is_available);
                        product.can_sell = Number(change.can_sell);
                    }
                });
            }
        };

        // Read after the menu data so the snapshot is as fresh as possible; a failed read is null.
        const requestExistingDraft = () => {
            const params = new URLSearchParams(window.location.search);
            const tid = parseInt(params.get('table'));
            if (!tid || isNaN(tid)) return null;
            const token = params.get('token') || '';
            return fetchJson(`/api/pos/table-draft/${tid}?token=${encodeURIComponent(token)}`).catch((err) => {
                console.error("Failed to load existing table draft cart:", err);
                return null;
            });
        };

        const applyExistingDraft = async (draftRequest) => {
            if (!draftRequest) return;
            try {
                const data = await draftRequest;
                if (data?.success && data.cart && data.cart.length > 0) {
                    // The server already holds this draft; echoing the snapshot back could
                    // overwrite a newer edit made while the menu was still loading.
                    skipHydrationSync = true;
                    cart.value = data.cart.map(item => {
                        const prod = products.value.find(p => p.id === item.product_id);
                        return {
                            id: item.product_id,
                            name: item.name || prod?.name || 'Product',
                            price: Number(item.price || prod?.price || 0),
                            qty: item.qty || 1,
                            image: prod?.image || null
                        };
                    }).filter(Boolean);
                }
            } catch (err) {
                console.error("Failed to load existing table draft cart:", err);
            }
        };

        let syncTimeout = null;
        let skipHydrationSync = false;
        const sendCart = () => {
            syncTimeout = null;
            socket?.emit('customer_cart_updated', {
                tableId: tableId.value,
                cart: cart.value.map(item => ({
                    product_id: item.id,
                    qty: item.qty,
                    price: item.price,
                    name: item.name
                }))
            });
        };
        // Send an edit still waiting out the debounce now (before a reload).
        const flushCartSync = () => {
            if (!syncTimeout) return;
            clearTimeout(syncTimeout);
            sendCart();
        };
        watch(cart, () => {
            if (skipHydrationSync) { skipHydrationSync = false; return; }
            if (!socket) return;
            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(sendCart, 500);
        }, { deep: true });

        const loadMenu = async () => {
            try {
                const data = await fetchJson('public_menu.json');

                if (data.success) {
                    storeInfo.value = data.store;

                    const savedLang = localStorage.getItem('pos_admin_language');
                    const storeDefaultLang = data.store?.admin_language || 'en';
                    const targetLang = savedLang || storeDefaultLang;
                    if (await setLanguage(targetLang)) currentLang.value = targetLang;

                    categories.value = data.categories;
                    products.value = data.products;

                    initSocket();
                    await applyExistingDraft(requestExistingDraft());
                }
            } catch (error) {
                console.error("Network error while fetching menu.");
            } finally {
                isLoading.value = false;
            }
        };

        const handleScroll = () => {
            const bottomOfWindow = document.documentElement.scrollTop + window.innerHeight >= document.documentElement.offsetHeight - 400;
            if (bottomOfWindow && visibleCount.value < filteredProducts.value.length) {
                visibleCount.value += 20;
            }
        };

        onMounted(() => {
            loadMenu();
            window.addEventListener('scroll', handleScroll);
        });

        onUnmounted(() => {
            window.removeEventListener('scroll', handleScroll);
            if (syncTimeout) clearTimeout(syncTimeout);
            refusalRetry?.cancel();
            socket?.disconnect();
        });

        const filteredProducts = computed(() => {
            if (currentFolder.value !== null) {
                if (activeSubcategory.value !== null) {
                    return products.value.filter(p => String(p.category_id) === String(activeSubcategory.value));
                }
                const visibleCategoryIds = [currentFolder.value, ...getSubcategories(currentFolder.value).map(c => c.id)]
                    .map(id => String(id));
                return products.value.filter(p => visibleCategoryIds.includes(String(p.category_id)));
            }

            if (activeCategory.value === null) return products.value;
            return products.value.filter(p => String(p.category_id) === String(activeCategory.value));
        });

        const mainCategories = computed(() => categories.value.filter(c => !c.parent_id || c.parent_id == 0));

        const getSubcategories = (parentId) => {
            return categories.value.filter(c => String(c.parent_id) === String(parentId));
        };

        const hasSubcategories = (categoryId) => {
            return getSubcategories(categoryId).length > 0;
        };

        const selectMainCategory = (category) => {
            activeCategory.value = category.id;
            activeSubcategory.value = null;
            currentFolder.value = hasSubcategories(category.id) ? category.id : null;
        };

        const selectLevelAll = () => {
            if (currentFolder.value !== null) {
                activeSubcategory.value = null;
                activeCategory.value = currentFolder.value;
                return;
            }
            activeCategory.value = null;
            activeSubcategory.value = null;
        };

        const goBackToMainCategories = () => {
            currentFolder.value = null;
            activeSubcategory.value = null;
            activeCategory.value = null;
        };

        const groupedProducts = computed(() => {
            const limit = visibleCount.value;

            if (currentFolder.value !== null || activeCategory.value !== null) {
                const targetId = activeSubcategory.value || activeCategory.value || currentFolder.value;
                const name = getCategoryName(targetId) || '';
                return [{
                    id: targetId,
                    name: name,
                    products: filteredProducts.value.slice(0, limit)
                }];
            }

            const groups = [];
            let addedCount = 0;

            for (const cat of mainCategories.value) {
                if (addedCount >= limit) break;

                const subCatIds = getSubcategories(cat.id).map(c => c.id);
                const allowedIds = [cat.id, ...subCatIds].map(id => String(id));

                const catProducts = products.value.filter(p => allowedIds.includes(String(p.category_id)));
                if (catProducts.length > 0) {
                    const remaining = limit - addedCount;
                    const slicedProducts = catProducts.slice(0, remaining);
                    if (slicedProducts.length > 0) {
                        groups.push({
                            id: cat.id,
                            name: cat.name,
                            products: slicedProducts
                        });
                        addedCount += slicedProducts.length;
                    }
                }
            }
            return groups;
        });

        // Bump renderKey on category change to re-trigger CSS stagger animation
        watch([activeCategory, activeSubcategory, currentFolder], () => {
            visibleCount.value = 30;
            renderKey.value++;
        });

        const getCategoryName = (id) => {
            const cat = categories.value.find(c => c.id === id);
            return cat ? cat.name : '';
        };

        const toggleLanguage = async () => {
            const newLang = currentLang.value === 'en' ? 'ar' : 'en';
            if (await setLanguage(newLang)) currentLang.value = newLang;
        };

        const handleImageError = (e) => {
            e.target.style.opacity = '0';
        };

        return {
            isLoading, storeInfo, categories, products,
            activeCategory, activeSubcategory, currentFolder, mainCategories,
            filteredProducts, groupedProducts, handleImageError,
            showQrModal, menuQrUrl,
            getCategoryName, getSubcategories, hasSubcategories, selectMainCategory,
            selectLevelAll, goBackToMainCategories, getContrastYIQ, isArabic,
            toggleLanguage, currentLang,
            tableId, cart, showCartDrawer, cartCount, cartTotal,
            getItemQty, addToCart, updateQty, clearCart, isProductSellable,
            renderKey
        };
    }
};
</script>

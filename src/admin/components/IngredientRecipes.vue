<template>
    <section class="recipes-workspace">
        <header>
            <button type="button" class="recipe-control" @click="close">{{ $t('Back to ingredients') }}</button>
            <h2>{{ $t('Product recipes') }}</h2>
            <p>{{ $t('Choose a product, then enter the ingredients used to make one portion.') }}</p>
        </header>
        <template v-if="!selected">
            <form class="recipe-search" @submit.prevent="search(1)">
                <label for="recipe-product-search">{{ $t('Find a product') }}</label>
                <div>
                    <input id="recipe-product-search" v-model="query" type="search" :placeholder="$t('Product name or barcode')">
                    <button class="recipe-control" :disabled="loading">{{ $t('Search') }}</button>
                </div>
            </form>
            <p v-if="error" role="alert">{{ $t(error) }} <button class="recipe-control" @click="search(page)">{{ $t('Retry') }}</button></p>
            <p v-if="loading" role="status">{{ $t('Loading products...') }}</p>
            <p v-else-if="!products.length && !error">{{ $t('No products found. Create products in Inventory first.') }}</p>
            <ul v-else class="recipe-products" :aria-label="$t('Products')">
                <li v-for="product in products" :key="product.id">
                    <span data-no-i18n>{{ product.name }}</span>
                    <button class="recipe-control" :disabled="loading" @click="selected = product">{{ $t('Edit recipe') }}<span class="sr-only" data-no-i18n> — {{ product.name }}</span></button>
                </li>
            </ul>
            <nav v-if="pages > 1" class="recipe-pagination" :aria-label="$t('Products')">
                <button class="recipe-control" :disabled="loading || page <= 1" @click="search(page - 1)">{{ $t('Previous') }}</button>
                <span data-no-i18n>{{ page }} / {{ pages }}</span>
                <button class="recipe-control" :disabled="loading || page >= pages" @click="search(page + 1)">{{ $t('Next') }}</button>
            </nav>
        </template>
        <div v-else class="recipe-product-editor">
            <div class="recipe-product-heading">
                <h3 data-no-i18n>{{ selected.name }}</h3>
                <button class="recipe-control" @click="changeProduct">{{ $t('Choose another product') }}</button>
            </div>
            <ProductRecipeEditor ref="editor" :product-id="selected.id" :price="selected.price" :is-bundle="Number(selected.is_bundle) === 1" />
        </div>
    </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { fetchJson } from '@/shared/http.js';
import ProductRecipeEditor from './ProductRecipeEditor.vue';

const emit = defineEmits(['close']);
const query = ref('');
const products = ref([]);
const selected = ref(null);
const editor = ref(null);
const loading = ref(false);
const error = ref('');
const page = ref(1);
const pages = ref(1);
let seq = 0;

async function search(nextPage) {
    const request = ++seq;
    loading.value = true;
    error.value = '';
    const params = new URLSearchParams({ search: query.value.trim(), page: String(nextPage), limit: '12' });
    try {
        const data = await fetchJson(`api/admin/products?${params}`);
        if (request !== seq) return;
        if (!data.success) throw new Error(data.message || 'Load failed.');
        products.value = data.products || [];
        page.value = nextPage;
        pages.value = Number(data.pagination?.total_pages) || 1;
    } catch (caught) {
        if (request === seq) { products.value = []; error.value = caught.message || 'Load failed.'; }
    } finally { if (request === seq) loading.value = false; }
}

const canLeave = async () => !editor.value || await editor.value.requestClose();
async function close() { if (await canLeave()) emit('close'); }
async function changeProduct() { if (await canLeave()) selected.value = null; }
onBeforeRouteLeave(canLeave);
onMounted(() => search(1));
onUnmounted(() => { seq++; });
</script>

<style scoped>
.recipes-workspace { overflow-y: auto; min-height: 0; padding: 0 .25rem 1rem; font-size: .875rem; }
header { margin-bottom: 1.25rem; }
h2, h3 { font-size: 1.125rem; font-weight: 700; margin-block: .75rem .4rem; }
p { color: #52525b; line-height: 1.65; }
.recipe-control { min-height: 44px; padding: .5rem .85rem; border: 1px solid #a1a1aa; background: var(--color-card); color: var(--color-foreground); border-radius: 6px; font-weight: 600; }
.recipe-control:hover:not(:disabled) { background: var(--color-muted); }
.recipe-control:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.recipe-search { max-width: 44rem; margin-bottom: 1rem; }
.recipe-search label { display: block; font-weight: 600; margin-bottom: .4rem; }
.recipe-search > div { display: flex; gap: .5rem; }
.recipe-search input { min-width: 0; flex: 1; border: 1px solid #a1a1aa; border-radius: 6px; padding: .65rem; background: var(--color-card); }
.recipe-search input::placeholder { color: #52525b; }
.recipe-products { max-width: 60rem; border-top: 1px solid var(--color-border); }
.recipe-products li, .recipe-product-heading { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding-block: .65rem; border-bottom: 1px solid var(--color-border); }
.recipe-products li > span { overflow-wrap: anywhere; }
.recipe-products button { flex-shrink: 0; }
.recipe-product-editor { max-width: 60rem; }
.recipe-product-heading { margin-bottom: 1rem; flex-wrap: wrap; }
.recipe-pagination { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
[role="alert"] { color: #b91c1c; }

.recipes-workspace { color: var(--color-foreground); }
.recipes-workspace > header { border-bottom: 1px solid var(--color-border); padding-bottom: 20px; }
.recipes-workspace > header h2 { font-size: 27px; }
.recipe-products > li { border-color: var(--color-border); border-radius: 10px; }
.recipe-control { border-color: var(--color-border); border-radius: 7px; }
.recipe-control.primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
</style>

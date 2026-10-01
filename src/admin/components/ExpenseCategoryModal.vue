<script setup lang="ts">
import { fetchJsonResponse } from '@/shared/http.js';
import { ref, watch } from 'vue'

interface Category {
  id: number
  name: string
  is_active: number
  sort_order: number
}

const props = defineProps<{ open: boolean; categories: Category[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const drafts = ref<Category[]>([])
const newName = ref('')
const savingId = ref<number | 'new' | null>(null)
const error = ref('')

watch(() => [props.open, props.categories] as const, () => {
  drafts.value = props.categories.map(category => ({ ...category }))
  newName.value = ''
  error.value = ''
}, { deep: true })

async function request(url: string, method: string, body: Record<string, unknown>) {
  const { response, data: json } = await fetchJsonResponse(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !json.success) throw new Error(json.message || 'Could not save expense category.')
}

async function addCategory() {
  if (!newName.value.trim()) return
  savingId.value = 'new'
  error.value = ''
  try {
    await request('api/admin/expense-categories', 'POST', {
      name: newName.value.trim(),
      sort_order: drafts.value.length * 10 + 10,
    })
    newName.value = ''
    emit('changed')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not save expense category.'
  } finally {
    savingId.value = null
  }
}

async function saveCategory(category: Category) {
  savingId.value = category.id
  error.value = ''
  try {
    await request(`api/admin/expense-categories/${category.id}`, 'PUT', {
      name: category.name.trim(),
      sort_order: Number(category.sort_order) || 0,
      is_active: Boolean(category.is_active),
    })
    emit('changed')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not save expense category.'
  } finally {
    savingId.value = null
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="category-dialog">
      <div v-if="open" class="category-backdrop" @click.self="emit('close')">
        <section class="category-dialog" role="dialog" aria-modal="true" :aria-label="$t('Manage expense categories')">
          <header>
            <div><h2>{{ $t('Manage expense categories') }}</h2><p>{{ $t('Disabled categories remain visible in previous reports.') }}</p></div>
            <button type="button" :aria-label="$t('Close')" @click="emit('close')">×</button>
          </header>

          <form class="category-add" @submit.prevent="addCategory">
            <input v-model="newName" maxlength="120" :placeholder="$t('New category name')" />
            <button type="submit" :disabled="savingId === 'new' || !newName.trim()">{{ $t('Add category') }}</button>
          </form>

          <div class="category-list">
            <div v-if="drafts.length === 0" class="category-empty">{{ $t('No expense categories yet.') }}</div>
            <div v-for="category in drafts" :key="category.id" class="category-row">
              <input v-model="category.name" maxlength="120" data-no-i18n />
              <label class="category-toggle"><input v-model="category.is_active" :true-value="1" :false-value="0" type="checkbox" /><span>{{ $t('Active') }}</span></label>
              <button type="button" :disabled="savingId === category.id || !category.name.trim()" @click="saveCategory(category)">{{ $t('Save') }}</button>
            </div>
          </div>
          <p v-if="error" class="category-error" role="alert">{{ $t(error) }}</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.category-backdrop { position: fixed; inset: 0; z-index: 180; display: grid; place-items: center; padding: 1rem; background: rgb(15 23 42 / 58%); }
.category-dialog { width: min(46rem, 100%); max-height: min(42rem, 90vh); overflow: hidden; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff; box-shadow: 0 20px 55px rgb(15 23 42 / 24%); }
.category-dialog header { display: flex; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #e2e8f0; padding: 1rem 1.1rem; background: #f8fafc; }
.category-dialog h2 { color: #18181b; font-size: 1rem; font-weight: 800; }.category-dialog header p { margin-top: .25rem; color: #71717a; font-size: .72rem; }
.category-dialog header button { width: 2.5rem; height: 2.5rem; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; font-size: 1.35rem; }
.category-add { display: grid; grid-template-columns: 1fr auto; gap: .6rem; border-bottom: 1px solid #e4e4e7; padding: 1rem; }
.category-add input, .category-row input { min-height: 2.75rem; border: 1px solid #d4d4d8; border-radius: 8px; padding: .55rem .7rem; outline: none; }
.category-add button, .category-row button { min-height: 2.75rem; border-radius: 8px; padding: .55rem .9rem; color: #fff; background: #24405e; font-size: .78rem; font-weight: 800; }
.category-list { max-height: 25rem; overflow-y: auto; padding: .5rem 1rem 1rem; }
.category-row { display: grid; grid-template-columns: minmax(10rem, 1fr) auto auto; gap: .55rem; align-items: center; padding-top: .6rem; }
.category-toggle { display: flex; min-height: 2.75rem; align-items: center; gap: .35rem; color: #52525b; font-size: .75rem; }.category-toggle input { min-height: auto; }
.category-empty { padding: 2rem; color: #71717a; text-align: center; }.category-error { padding: 0 1rem 1rem; color: #be123c; font-size: .75rem; font-weight: 700; }
.category-dialog button:disabled { opacity: .5; }.category-dialog-enter-active,.category-dialog-leave-active { transition: opacity 150ms ease; }.category-dialog-enter-from,.category-dialog-leave-to { opacity: 0; }
@media (max-width: 640px) { .category-backdrop { align-items: end; padding: 0; }.category-dialog { max-height: 92vh; border-radius: 12px 12px 0 0; }.category-row { grid-template-columns: minmax(0, 1fr) auto; }.category-row > input { grid-column: 1/-1; }.category-toggle,.category-row button { width: 100%; }.category-add { grid-template-columns: 1fr; } }
</style>

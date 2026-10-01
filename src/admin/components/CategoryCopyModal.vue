<template>
  <ModalShell :show="show" :title="$t('Copy category')" width-class="max-w-md" @close="$emit('close')">
    <form class="space-y-4 p-5" @submit.prevent="save">
      <div class="rounded-md border border-border bg-muted/60 p-3">
        <p class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('Source category') }}</p>
        <p class="mt-1 text-sm font-bold text-foreground" data-no-i18n>{{ source?.name }}</p>
      </div>
      <p class="text-xs leading-5 text-muted-foreground">
        {{ $t('Products are copied as new items. SKU and barcode are left blank.') }}
      </p>
      <label class="block text-xs font-bold">
        {{ $t('Name') }}
        <input v-model.trim="name" maxlength="50" required class="mt-1 h-11 w-full rounded-md border border-border bg-muted px-3 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15">
      </label>
      <label class="block text-xs font-bold">
        {{ $t('Copy into') }}
        <select v-model="targetParentId" class="mt-1 h-11 w-full rounded-md border border-border bg-muted px-3 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15">
          <option value="">{{ $t('Top level') }}</option>
          <option v-for="category in eligibleParents" :key="category.id" :value="category.id" data-no-i18n>
            {{ category.treeLabel }}
          </option>
        </select>
      </label>
      <div class="grid grid-cols-2 gap-2 pt-1">
        <button type="button" class="h-11 rounded-md border border-border bg-card px-4 text-xs font-bold hover:bg-muted" @click="$emit('close')">
          {{ $t('Cancel') }}
        </button>
        <button class="h-11 rounded-md bg-teal-600 px-4 text-xs font-bold text-white hover:bg-teal-700 disabled:opacity-50" :disabled="saving || !name">
          {{ saving ? $t('Copying...') : $t('Copy') }}
        </button>
      </div>
    </form>
  </ModalShell>
</template>

<script setup>
import { fetchJsonResponse } from '@/shared/http.js';
import { ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import ModalShell from './ModalShell.vue';

const props = defineProps({
  show: Boolean,
  source: Object,
  eligibleParents: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'saved']);
const name = ref('');
const targetParentId = ref('');
const saving = ref(false);

watch(() => props.show, shown => {
  if (!shown) return;
  name.value = props.source?.name || '';
  targetParentId.value = '';
});

async function save() {
  if (!props.source?.id || !name.value) return;
  saving.value = true;
  try {
    const { response, data } = await fetchJsonResponse(`api/admin/categories/${props.source.id}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value, target_parent_id: targetParentId.value || null })
    });
    if (!response.ok || !data.success) throw new Error(data.message);
    window.showAdminToast?.(t('Category copied.'), 'success');
    emit('saved');
  } catch (error) {
    window.showAdminAlert?.(error.message || t('Failed to copy category.'));
  } finally {
    saving.value = false;
  }
}
</script>

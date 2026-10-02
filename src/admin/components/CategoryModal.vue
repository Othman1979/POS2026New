<template>
    <ModalShell :show="show" :title="isEditing ? $t('Edit Category') : $t('New Category')" width-class="max-w-md" @close="$emit('close')">
            <form @submit.prevent="saveCategory" class="flex-1 flex flex-col">
                <div class="p-6 bg-card space-y-4">
                    <div>
                        <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Category Name *') }}</label>
                        <input v-model="categoryForm.name" type="text" required maxlength="50" :placeholder="$t('e.g. Beverages')" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none placeholder:text-muted-foreground">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Parent Category') }}</label>
                        <select v-model="categoryForm.parent_id" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none">
                            <option value="">{{ $t('No parent (top level)') }}</option>
                            <option v-for="cat in eligibleParents" :key="cat.id" :value="cat.id" data-no-i18n>
                                {{ cat.treeLabel }}
                            </option>
                        </select>
                        <p v-if="inheritedPriceListName" class="mt-2 rounded-md border border-teal-500/20 bg-teal-500/10 px-3 py-2 text-[11px] font-semibold text-teal-800">
                            {{ $t('Inherited price list') }}: <span data-no-i18n>{{ inheritedPriceListName }}</span>
                        </p>
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Status') }}</label>
                        <select v-model.number="categoryForm.is_active" class="w-full h-11 bg-muted border border-zinc-300 rounded-md py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none">
                            <option :value="1">{{ $t('Active') }}</option>
                            <option :value="0">{{ $t('Inactive') }}</option>
                        </select>
                    </div>
                    <div class="pt-1">
                        <label class="flex items-center gap-2 cursor-pointer select-none text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            <input v-model="categoryForm.is_notes" type="checkbox" :true-value="1" :false-value="0" class="accent-primary rounded text-primary focus:ring-0 w-4 h-4 cursor-pointer">
                            <span>{{ $t('Notes category') }}</span>
                        </label>
                    </div>
                    <div class="pt-1">
                        <label class="flex items-center gap-2 cursor-pointer select-none text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            <input v-model="categoryForm.hide_in_pos" type="checkbox" :true-value="1" :false-value="0" class="accent-primary rounded text-primary focus:ring-0 w-4 h-4 cursor-pointer">
                            <span>{{ $t('Hide from the POS screen') }}</span>
                        </label>
                        <p class="mt-1 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">{{ $t('Its products still sell by scanning their barcode.') }}</p>
                    </div>
                    <div v-if="!categoryForm.parent_id && !categoryForm.is_notes" class="pt-1">
                        <label class="flex items-center gap-2 cursor-pointer select-none text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            <input v-model="categoryForm.is_price_list_root" type="checkbox" :true-value="true" :false-value="false" class="accent-primary rounded text-primary focus:ring-0 w-4 h-4 cursor-pointer">
                            <span>{{ $t('Use this category as a price list') }}</span>
                        </label>
                        <p class="mt-1 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">{{ $t('Products in this category tree can use their own prices.') }}</p>
                    </div>
                </div>
                <div class="p-4 border-t border-zinc-200 bg-muted flex justify-end gap-3 shrink-0 select-none">
                    <button type="button" @click="$emit('close')" class="px-4 h-11 bg-card border border-zinc-300 hover:bg-zinc-200 text-foreground font-bold rounded-md transition-colors text-xs">{{ $t('Cancel') }}</button>
                    <button type="submit" class="px-4 h-11 bg-teal-600 text-white font-bold rounded-md hover:bg-teal-700 transition-colors text-xs">{{ isEditing ? $t('Edit Category') : $t('Save Category') }}</button>
                </div>
            </form>
    </ModalShell>
</template>

<script>
import { fetchJson } from '@/shared/http.js';
import { ref, computed, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import ModalShell from './ModalShell.vue';

export default {
    name: 'CategoryModal',
    components: { ModalShell },
    props: {
        show: { type: Boolean, default: false },
        category: { type: Object, default: null },
        eligibleParents: { type: Array, default: () => [] }
    },
    emits: ['close', 'saved'],
    setup(props, { emit }) {
        const categoryForm = ref({
            id: null, name: '', parent_id: '', is_active: 1, is_notes: 0, hide_in_pos: 0, is_price_list_root: false
        });

        const isEditing = computed(() => !!props.category);
        const inheritedPriceListName = computed(() => {
            if (!categoryForm.value.parent_id || categoryForm.value.is_notes) return null;
            const parent = props.eligibleParents.find(category => category.id == categoryForm.value.parent_id);
            if (!parent) return null;
            return parent.price_list_root_name || (parent.is_price_list_root ? parent.name : null);
        });

        // Initialize form when modal opens
        watch(() => props.show, (val) => {
            if (!val) return;
            const category = props.category;
            if (category) {
                categoryForm.value = {
                    id: category.id,
                    name: category.name,
                    parent_id: category.parent_id || '',
                    is_active: category.is_active ?? 1,
                    is_notes: category.is_notes ?? 0,
                    hide_in_pos: Number(category.hide_in_pos) === 1 ? 1 : 0,
                    is_price_list_root: Boolean(category.is_price_list_root)
                };
            } else {
                categoryForm.value = {
                    id: null, name: '', parent_id: '', is_active: 1, is_notes: 0, hide_in_pos: 0, is_price_list_root: false
                };
            }
        });

        watch(() => [categoryForm.value.parent_id, categoryForm.value.is_notes], ([parentId, isNotes]) => {
            if (parentId || isNotes) categoryForm.value.is_price_list_root = false;
        });

        const saveCategory = async () => {
            if (!categoryForm.value.name) {
                await window.showAdminAlert(t('Name is required.'));
                return;
            }
            const payload = { ...categoryForm.value };
            const editing = isEditing.value;
            try {
                const method = editing ? 'PUT' : 'POST';
                const data = await fetchJson('api/admin/categories', {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (data.success) {
                    window.showAdminToast(editing ? t('Category updated successfully.') : t('Category created successfully.'), 'success');
                    emit('saved');
                } else {
                    await window.showAdminAlert(data.message || t('Failed to save category.'));
                }
            } catch (e) {
                await window.showAdminAlert(t('Network error.'));
            }
        };

        return {
            categoryForm,
            isEditing,
            inheritedPriceListName,
            saveCategory
        };
    }
};
</script>

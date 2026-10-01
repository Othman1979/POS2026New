<script setup>
import { computed, ref } from 'vue';
import { t, currentLanguage } from '@/shared/i18n.js';
import policy from '@posapp/permission-policy';

const props = defineProps({
    catalog: { type: Array, default: () => [] },
    role: { type: String, required: true },
    tableScope: { type: String, default: 'none' },
    sectionIds: { type: Array, default: () => [] },
});
const selected = defineModel({ type: Array, default: () => [] });
const query = ref('');
const arabic = computed(() => currentLanguage.value === 'ar');
const text = (permission, field) => arabic.value ? permission[field + '_ar'] || permission[field] : permission[field];
const catalogByKey = computed(() => new Map(props.catalog.map(row => [row.perm_key, row])));
const actor = computed(() => ({ role: props.role, permissions: selected.value.filter(key => catalogByKey.value.get(key)?.implemented), table_access_scope: props.tableScope, allowed_sections: props.sectionIds.join(',') }));
const allowed = key => policy.userHas(actor.value, key);
const label = key => text(catalogByKey.value.get(key) || {}, 'label') || key;
const dependency = permission => {
    if (!allowed(permission.perm_key)) return null;
    if (permission.group === 'tables' && permission.perm_key !== 'tables.access' && !allowed('tables.access')) return 'tables.access';
    return policy.evaluateAction(actor.value, permission.action || permission.perm_key, permission.action_context).missingPermissions[0] || null;
};
const groups = [
    { id: 'tables', title: 'Table service', description: 'Choose who can open, save, edit and move table orders.' },
    { id: 'sales', title: 'Sales and receipts', description: 'Taking payment, parking orders and viewing past sales.' },
    { id: 'changes', title: 'Prices, cancellations and refunds', description: 'Control changes to what customers owe and what money is returned.' },
    { id: 'cash', title: 'Cash and shifts', description: 'Opening the till, recording expenses and closing the shift.' },
    { id: 'products', title: 'Products', description: 'Product availability.' },
    { id: 'other', title: 'Other permissions', description: 'Additional actions available to this employee.' },
];
const groupIds = new Set(groups.map(group => group.id));
const relevant = computed(() => props.catalog.filter(row => policy.canAssignPermission(props.role, row.perm_key)));
const grouped = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    const buckets = new Map(groups.map(group => [group.id, []]));
    for (const row of relevant.value) buckets.get(groupIds.has(row.group) ? row.group : 'other').push(row);
    return groups.map(group => {
        const all = buckets.get(group.id);
        const items = all.filter(row => !needle || [text(row,'label'), text(row,'description'), text(row,'example')].some(value => value?.toLocaleLowerCase().includes(needle)));
        return { ...group, all, items };
    }).filter(group => group.items.length);
});
const previewActions = [
    { label: 'Save a new table order', action: 'table.create', table: true },
    { label: 'Edit a saved table order', action: 'table.edit', table: true },
    { label: 'Cancel before bill print', action: 'table.void', table: true },
    { label: 'Cancel after bill print', action: 'table.void', table: true, context: { printed: true } },
    { label: 'Move selected items', action: 'table.transfer_items', table: true },
    { label: 'Take table payments', action: 'checkout', table: true, context: { tablePayment: true } },
    { label: 'Take counter payments', action: 'checkout' },
];
const preview = computed(() => previewActions.map(item => {
    const result = policy.evaluateAction(actor.value, item.action, item.context);
    const scope = policy.getTableSectionIds(actor.value);
    const noSections = item.table && scope !== null && scope.length === 0;
    const noTableAccess = item.table && !allowed('tables.access');
    return { ...item, allowed: result.allowed && !noSections && !noTableAccess,
        reason: noSections ? t('Choose table sections') : noTableAccess ? label('tables.access') : result.missingPermissions.map(label).join(' + ') };
}));
</script>

<template>
    <section class="permission-editor border-t border-border pt-5" :aria-label="t('Permissions')">
        <details class="border-b border-border pb-4 mb-4" open>
            <summary class="text-base font-semibold cursor-pointer min-h-11 flex items-center focus-visible:outline-2 focus-visible:outline-primary">{{ t('Access preview') }}</summary>
            <p class="text-sm text-muted-foreground mb-3">{{ t('Preview for their own tables in the chosen sections. Other employees’ orders and paid invoices have additional rules.') }}</p>
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6" data-testid="permission-preview">
                <div v-for="item in preview" :key="item.label" class="py-2 border-t border-border">
                    <dt class="text-sm font-medium">{{ t(item.label) }}</dt>
                    <dd class="text-sm mt-0.5" :class="item.allowed ? 'text-primary' : 'text-muted-foreground'">
                        {{ item.allowed ? t('Allowed') : t('Not allowed') }}<span v-if="!item.allowed && item.reason"> — {{ item.reason }}</span>
                    </dd>
                </div>
            </dl>
        </details>
        <div class="flex items-baseline justify-between gap-3">
            <h4 class="text-base font-semibold">{{ t('What this employee can do') }}</h4>
            <span class="text-xs text-muted-foreground whitespace-nowrap"><span data-no-i18n>{{ relevant.filter(p=>allowed(p.perm_key)).length }}</span> {{ t('allowed') }}</span>
        </div>
        <p class="text-sm text-muted-foreground mt-1 mb-4">{{ t('Select an action to allow it. Expand a group to see examples and related permissions.') }}</p>
        <label for="permission-search" class="sr-only">{{ t('Find a permission') }}</label>
        <div class="flex gap-2 mb-4">
            <input id="permission-search" v-model="query" type="search" :placeholder="t('Find a permission, e.g. save, refund, discount')" class="w-full min-w-0 h-11 px-3 border border-border rounded-lg bg-card text-sm focus-visible:outline-2 focus-visible:outline-primary" />
            <button v-if="query" type="button" @click="query=''" class="px-3 h-11 text-sm border border-border rounded-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">{{ t('Clear') }}</button>
        </div>
        <div class="divide-y divide-border border-y border-border">
            <details v-for="group in grouped" :key="`${role}-${group.id}`" :open="!!query || group.id==='tables'" class="permission-group py-1">
                <summary class="min-h-12 py-3 cursor-pointer focus-visible:outline-2 focus-visible:outline-primary rounded-sm">
                    <span class="font-semibold text-sm">{{ t(group.title) }}</span>
                    <span class="text-xs text-muted-foreground ms-2"><bdi dir="ltr" data-no-i18n>{{ group.all.filter(p=>allowed(p.perm_key)).length }} / {{ group.all.length }}</bdi> {{ t('allowed') }}</span>
                </summary>
                <p class="text-sm text-muted-foreground pb-3">{{ t(group.description) }}</p>
                <div class="divide-y divide-border">
                    <div v-for="permission in group.items" :key="permission.perm_key" class="permission-row py-3" :data-permission="permission.perm_key">
                        <label class="flex items-start gap-3 cursor-pointer rounded-md focus-within:outline-2 focus-within:outline-primary">
                            <input v-if="role==='waiter' && permission.perm_key==='tables.access'" type="checkbox" checked disabled class="w-5 h-5 mt-0.5 shrink-0 accent-primary" />
                            <input v-else v-model="selected" type="checkbox" :value="permission.perm_key" :disabled="!permission.implemented" :aria-describedby="`help-${permission.perm_key}`" class="w-5 h-5 mt-0.5 shrink-0 accent-primary" />
                            <span class="flex-1 min-w-0">
                                <span class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                    <span class="font-semibold text-sm" data-no-i18n>{{ text(permission,'label') }}</span>
                                    <span class="text-xs" :class="allowed(permission.perm_key) ? 'text-primary font-semibold' : 'text-muted-foreground'">{{ t(role==='waiter' && permission.perm_key==='tables.access' ? 'Included with role' : allowed(permission.perm_key) ? 'Allowed' : 'Not allowed') }}</span>
                                </span>
                                <span class="block text-sm leading-relaxed text-muted-foreground mt-1" data-no-i18n>{{ text(permission,'description') }}</span>
                            </span>
                        </label>
                        <div :id="`help-${permission.perm_key}`" class="ms-8 mt-2 text-xs leading-relaxed">
                            <p v-if="role==='waiter' && permission.perm_key==='waiter.edit_locked'" class="font-semibold mb-1">{{ t('For waiters, this also allows the first table save. Voids remain separate.') }}</p>
                            <p v-if="text(permission,'example')" class="text-foreground" data-no-i18n>{{ text(permission,'example') }}</p>
                            <p v-if="allowed(permission.perm_key) && dependency(permission)" class="mt-1 font-semibold text-amber-800" role="status">{{ t('Also required:') }} <span data-no-i18n>{{ label(dependency(permission)) }}</span></p>
                            <p v-if="!permission.implemented" class="mt-1 text-muted-foreground">{{ t('Coming soon') }}</p>
                        </div>
                    </div>
                </div>
            </details>
        </div>
        <p v-if="!grouped.length" class="py-5 text-sm text-muted-foreground" role="status">{{ t('No permissions match. Try another action or clear the search.') }}</p>
    </section>
</template>

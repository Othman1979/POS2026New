<template>
    <section class="pi-pane pi-editor-pane lg-book ct-book" :aria-busy="starting">
        <div class="lg-toolbar">
            <button type="button" class="lg-btn pi-back" @click="$emit('back')">
                <i class="fa-solid fa-arrow-right pi-flip" aria-hidden="true"></i>{{ $t('Back to list') }}
            </button>
            <span class="lg-state lg-state--draft">{{ $t('New count') }}</span>
        </div>

        <div class="lg-desk">
            <form class="ct-new" @submit.prevent="start">
                <label class="ct-field">
                    <span class="lg-cap">{{ $t('Title (optional)') }}</span>
                    <input v-model="reference" class="lg-fill" type="text" maxlength="60" autocomplete="off" :disabled="starting" :placeholder="$t('For example: Monthly count')">
                </label>
                <label class="ct-field">
                    <span class="lg-cap">{{ $t('Count date') }}</span>
                    <!-- The count is dated on the day it is posted; this is only today's date for reference. -->
                    <bdi class="pi-num ct-val" data-no-i18n>{{ countDate }}</bdi>
                </label>

                <fieldset class="ct-field ct-groups" :disabled="starting">
                    <legend class="lg-cap">{{ $t('What to count') }}</legend>
                    <label class="ct-check"><input v-model="allItems" type="checkbox"><span>{{ $t('All items') }}</span></label>
                    <p v-if="groupsError" class="lg-msg lg-msg--error" role="alert">
                        <span>{{ groupsError }}</span>
                        <button type="button" class="lg-btn lg-btn--sm" @click="loadGroups">{{ $t('Retry') }}</button>
                    </p>
                    <p v-else-if="groupsLoading" class="ct-hint" role="status">{{ $t('Loading...') }}</p>
                    <ul v-if="!allItems && groups.length" class="ct-group-list">
                        <li v-for="group in groups" :key="group.key">
                            <label class="ct-check">
                                <input v-model="picked" type="checkbox" :value="group.key">
                                <span data-no-i18n>{{ groupText(group) }}</span>
                                <small class="pi-num" data-no-i18n>{{ group.item_count }}</small>
                            </label>
                        </li>
                    </ul>
                </fieldset>

                <div v-if="errorText" class="lg-msg lg-msg--error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>{{ errorText }}</span>
                    <button v-if="openId" type="button" class="lg-btn lg-btn--sm" @click="$emit('open', openId)">{{ $t('Open that count') }}</button>
                </div>

                <div class="lg-actions">
                    <span class="lg-grow"></span>
                    <button type="submit" class="lg-btn lg-btn--ink" :disabled="starting || !canStart">{{ $t('Start counting') }}</button>
                </div>
            </form>
        </div>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '@/shared/i18n.js';
import { createRequestId } from '@/shared/requestId.js';
import { groupName } from './countMath.js';
import { currentBusinessDate } from '@/utils/businessDate.js';
import { countsApi, describeError } from './countsApi.js';
import './counts.css';

const emit = defineEmits(['back', 'created', 'open']);

const today = () => {
    try { return currentBusinessDate(); } catch { return new Date().toISOString().slice(0, 10); }
};

const reference = ref('');
const countDate = today();
const allItems = ref(true);
const picked = ref([]);
const groups = ref([]);
const groupsLoading = ref(false);
const groupsError = ref('');
const starting = ref(false);
const errorText = ref('');
const openId = ref(null);

// A retry of the same request reuses its key, so a lost reply cannot create two counts. Changing
// any field makes it a different request with its own key.
let requestKey = createRequestId();
watch([reference, allItems, picked], () => { requestKey = createRequestId(); }, { deep: true });

// Fixed groups (ingredients, other items) are translated by key; categories keep their names.
const groupText = (group) => groupName({ group_key: group.key, group_label: group.label }, t);
const canStart = computed(() => allItems.value || picked.value.length > 0);
let groupSequence = 0;

async function loadGroups() {
    const current = ++groupSequence;
    groupsLoading.value = true;
    groupsError.value = '';
    try {
        const list = await countsApi.listGroups();
        if (current === groupSequence) groups.value = list;
    } catch (error) {
        if (current === groupSequence) groupsError.value = describeError(error);
    } finally {
        if (current === groupSequence) groupsLoading.value = false;
    }
}

async function start() {
    if (!canStart.value || starting.value) return;
    starting.value = true;
    errorText.value = '';
    openId.value = null;
    try {
        const body = {
            groups: allItems.value ? ['all'] : [...picked.value],
            request_key: requestKey,
        };
        if (reference.value.trim()) body.reference = reference.value.trim();
        emit('created', await countsApi.createCount(body));
    } catch (error) {
        errorText.value = describeError(error);
        if (error?.code === 'STOCK_COUNT_ALREADY_OPEN') openId.value = error.data?.open_id ?? null;
    } finally {
        starting.value = false;
    }
}

onMounted(loadGroups);
onBeforeUnmount(() => { groupSequence += 1; });
// A title and group choices are not kept as unsaved work (Back does not ask); a count being created is.
defineExpose({ unsaved: computed(() => starting.value), confirmDiscard: async () => true });
</script>

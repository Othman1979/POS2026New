<template>{{ label }}</template>

<script setup>
import { computed } from 'vue';
import { t } from '@/shared/i18n.js';
import { floorNow } from '@/utils/floorMinuteClock.js';
import { formatTableElapsedTime } from '@/utils/tableFloorPlanPresentation.js';

const props = defineProps({ createdAt: { type: [String, Number, Date], required: true } });
const label = computed(() => formatTableElapsedTime(props.createdAt, floorNow.value, t));
</script>

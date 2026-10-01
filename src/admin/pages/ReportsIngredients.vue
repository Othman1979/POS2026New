<template>
    <IngredientAnalysis>
        <template #stock>
            <IngredientDailyMovements v-if="period.startDate.value === period.endDate.value" :date="period.startDate.value" />
            <p v-else class="stock-period-note" role="status">{{ $t('Choose a single business day above to view its stock movements and opening and closing balances.') }}</p>
        </template>
    </IngredientAnalysis>
</template>
<script setup>
import { inject } from 'vue';
import IngredientAnalysis from '../components/IngredientAnalysis.vue';
import IngredientDailyMovements from './IngredientDailyMovements.vue';
const period = inject('dailyReportPeriod');
</script>
<style scoped>
.stock-period-note { padding: 2rem; text-align: center; color: #66717f; background: #f6f8fa; border-radius: 8px; margin-top: 1rem; }
</style>

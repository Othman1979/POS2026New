<template>
  <div v-if="mismatch || unserved.length" data-testid="station-health-notice">
    <div v-if="mismatch && healing" role="alert" class="mt-3 text-sm text-rose-700">{{ $t('Spooler on station {name} cannot register: its identity belongs to another station. It is fixing this automatically.').replace('{name}', station.name || station.spooler_id) }}</div>
    <div v-else-if="mismatch" role="alert" class="mt-3 text-sm text-rose-700">{{ $t('Spooler on station {name} cannot register: its identity belongs to another station. Set its station name back, or ask support to reset it.').replace('{name}', station.name || station.spooler_id) }}</div>
    <div v-if="unserved.length" class="mt-3 text-[10px] text-muted-foreground">
      <span class="font-semibold">{{ $t('Printers waiting for this station') }}</span>
      <span data-no-i18n> {{ unserved.join(', ') }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ station: { type: Object, required: true } });

const mismatch = computed(() => props.station.station_mismatch === true);
// Only promise a fix when the agent itself says it is retrying. Blocked by unfinished
// work, refused for good, or an agent too old to say anything: a person must act.
const healing = computed(() => props.station.station_mismatch_state === 'healing');
// Printers on a station whose agent is not syncing print nothing; say which ones.
const unserved = computed(() => (props.station.online ? [] : props.station.printers || []));
</script>

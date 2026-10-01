import { ref } from 'vue';

// Shared "now" for the floor's elapsed-time labels. Only the label components
// read it, so a tick re-renders the occupied cards, not the whole floor.
// One timeout, aligned to the next minute boundary because labels show minutes.
export const floorNow = ref(Date.now());
let timer = null;

function tick() {
  floorNow.value = Date.now();
  timer = setTimeout(tick, 60000 - (floorNow.value % 60000));
}

export function setFloorClock(active) {
  if (!active) {
    clearTimeout(timer);
    timer = null;
    return;
  }
  if (timer === null) tick();
}

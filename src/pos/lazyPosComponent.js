import { defineAsyncComponent, onMounted } from 'vue';

export const lazyPosComponent = (loader, onUnavailable) => defineAsyncComponent({
  loader,
  timeout: 15_000,
  errorComponent: {
    setup() {
      // Vue's timeout bypasses the loader's onError hook. Both failures must
      // close the unavailable workflow so it can be opened again safely.
      onMounted(() => onUnavailable?.());
      return () => null;
    },
  },
  onError(error, retry, fail, attempts) {
    if (attempts < 2 && navigator.onLine) {
      retry();
      return;
    }
    fail(error);
  },
});

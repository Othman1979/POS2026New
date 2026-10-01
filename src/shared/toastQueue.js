// One visible toast at a time. A warning or error stays up for its full
// lifetime; toasts that arrive meanwhile wait in a short queue instead of
// replacing it, so money-adjacent warnings cannot flash by unseen.
const LIFETIME_MS = { error: 7000, warning: 6000 };
const DEFAULT_LIFETIME_MS = 3500;
const MAX_PENDING = 3;

const isCritical = type => type === 'error' || type === 'warning';

export function createToastQueue(toast) {
  const pending = [];
  let timer = null;

  const show = ({ message, type }) => {
    toast.value = { show: true, message, type };
    clearTimeout(timer);
    timer = setTimeout(next, LIFETIME_MS[type] ?? DEFAULT_LIFETIME_MS);
  };

  function next() {
    timer = null;
    const item = pending.shift();
    if (item) show(item);
    else toast.value.show = false;
  }

  return (message, type = 'info') => {
    const item = { message, type };
    if (!toast.value.show || !isCritical(toast.value.type)) return show(item);
    if (toast.value.message === message || pending.some(p => p.message === message)) return;
    pending.push(item);
    if (pending.length > MAX_PENDING) {
      const drop = pending.findIndex(p => !isCritical(p.type));
      pending.splice(drop === -1 ? 0 : drop, 1);
    }
  };
}

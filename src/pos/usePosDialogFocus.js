import { getCurrentInstance, nextTick, onBeforeUnmount, toValue, watch } from 'vue';

const FOCUSABLE_SELECTOR = [
  '[data-dialog-initial-focus]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const isVisible = (element) => Boolean(element?.isConnected && element.getClientRects().length);
const canManageDialogFocus = () => (
  typeof document !== 'undefined'
  && typeof document.addEventListener === 'function'
  && typeof document.removeEventListener === 'function'
);
const isFocusable = (element) => (
  isVisible(element)
  && !element.matches?.(':disabled')
  && !element.closest?.('[inert]')
);
const openDialogStack = [];

const unregisterDialog = (dialog) => {
  const index = openDialogStack.lastIndexOf(dialog);
  if (index !== -1) openDialogStack.splice(index, 1);
};

const registerDialog = (dialog) => {
  unregisterDialog(dialog);
  openDialogStack.push(dialog);
};

export const dialogFocusableElements = (dialog) => (
  [...(dialog?.querySelectorAll(FOCUSABLE_SELECTOR) || [])].filter(isFocusable)
);

export const isTopmostPosDialog = (dialog) => {
  if (!dialog || typeof document === 'undefined') return false;
  for (let index = openDialogStack.length - 1; index >= 0; index -= 1) {
    if (isVisible(openDialogStack[index])) return openDialogStack[index] === dialog;
    openDialogStack.splice(index, 1);
  }
  if (typeof document.querySelectorAll !== 'function') return false;
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .filter(isVisible);
  return dialogs.at(-1) === dialog;
};

export const handlePosDialogKeydown = (event, dialog, onEscape) => {
  if (!dialog || !isTopmostPosDialog(dialog)) return;

  if (event.key === 'Escape' && !event.isComposing) {
    if (typeof onEscape !== 'function') return;
    event.preventDefault();
    onEscape();
    return;
  }

  if (event.key !== 'Tab') return;
  const controls = dialogFocusableElements(dialog);
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  const activeIndex = controls.indexOf(active);

  if (!first) {
    event.preventDefault();
    dialog.focus();
  } else if (activeIndex === -1) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

export function usePosDialogFocus({ open, dialog, onEscape = null }) {
  let previousFocus = null;
  let registeredDialog = null;
  let listening = false;

  const onKeydown = (event) => handlePosDialogKeydown(event, dialog.value, onEscape);

  const stopListening = () => {
    if (!listening) return;
    if (!canManageDialogFocus()) {
      listening = false;
      return;
    }
    document.removeEventListener('keydown', onKeydown);
    listening = false;
  };

  const restoreFocus = () => {
    const target = previousFocus;
    previousFocus = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus();
  };

  const stopTrackingDialog = () => {
    if (!registeredDialog) return;
    unregisterDialog(registeredDialog);
    registeredDialog = null;
  };

  const stop = watch(open, async (isOpen) => {
    if (!isOpen) {
      stopTrackingDialog();
      stopListening();
      restoreFocus();
      return;
    }

    if (!canManageDialogFocus()) return;
    previousFocus = document.activeElement;
    if (!listening) {
      document.addEventListener('keydown', onKeydown);
      listening = true;
    }

    await nextTick();
    const panel = dialog.value;
    if (!toValue(open) || !panel) return;
    registeredDialog = panel;
    registerDialog(panel);
    if (!isTopmostPosDialog(panel) || panel.contains(document.activeElement)) return;
    const initialFocus = panel.querySelector('[data-dialog-initial-focus]');
    const preferred = (isFocusable(initialFocus)
      ? initialFocus
      : [...panel.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].find(isFocusable));
    (preferred || dialogFocusableElements(panel)[0] || panel).focus();
  }, { immediate: true });

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      stop();
      stopTrackingDialog();
      stopListening();
      restoreFocus();
    });
  }
}

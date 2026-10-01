import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dialogFocusableElements,
  handlePosDialogKeydown,
  isTopmostPosDialog,
} from './usePosDialogFocus.js';

function element(name, { visible = true, inert = false, disabled = false } = {}) {
  return {
    name,
    isConnected: true,
    getClientRects: () => visible ? [{}] : [],
    matches: selector => selector === ':disabled' && disabled,
    closest: selector => selector === '[inert]' && inert ? { inert: true } : null,
    focus() { document.activeElement = this; },
  };
}

function dialog(name, controls = [], { visible = true } = {}) {
  const panel = element(name, { visible });
  panel.querySelectorAll = () => controls;
  panel.querySelector = () => controls[0] || null;
  panel.contains = candidate => candidate === panel || controls.includes(candidate);
  return panel;
}

function keyEvent(key, { shiftKey = false, isComposing = false } = {}) {
  return {
    key,
    shiftKey,
    isComposing,
    preventDefault: vi.fn(),
  };
}

describe('POS dialog keyboard lifecycle', () => {
  let originalDocument;

  beforeEach(() => {
    originalDocument = globalThis.document;
    globalThis.document = { activeElement: null, querySelectorAll: vi.fn(() => []) };
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  it('keeps only visible connected and interactive controls in the focus order', () => {
    const first = element('first');
    const hidden = element('hidden', { visible: false });
    const detached = element('detached');
    const inert = element('inert', { inert: true });
    const disabled = element('disabled', { disabled: true });
    detached.isConnected = false;
    expect(dialogFocusableElements(dialog('panel', [first, hidden, detached, inert, disabled]))).toEqual([first]);
  });

  it('wraps Tab in both directions and brings outside focus into the dialog', () => {
    const first = element('first');
    const last = element('last');
    const panel = dialog('panel', [first, last]);
    document.querySelectorAll.mockReturnValue([panel]);

    document.activeElement = last;
    const forward = keyEvent('Tab');
    handlePosDialogKeydown(forward, panel);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);

    document.activeElement = first;
    const backward = keyEvent('Tab', { shiftKey: true });
    handlePosDialogKeydown(backward, panel);
    expect(backward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);

    document.activeElement = element('outside');
    const outside = keyEvent('Tab');
    handlePosDialogKeydown(outside, panel);
    expect(document.activeElement).toBe(first);

    document.activeElement = panel;
    const nestedLayerForward = keyEvent('Tab');
    handlePosDialogKeydown(nestedLayerForward, panel);
    expect(nestedLayerForward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);

    document.activeElement = panel;
    const nestedLayerBackward = keyEvent('Tab', { shiftKey: true });
    handlePosDialogKeydown(nestedLayerBackward, panel);
    expect(nestedLayerBackward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
  });

  it('focuses the panel when no controls are available', () => {
    const panel = dialog('empty');
    document.querySelectorAll.mockReturnValue([panel]);
    document.activeElement = element('outside');
    const event = keyEvent('Tab');

    handlePosDialogKeydown(event, panel);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(panel);
  });

  it('lets only the topmost visible modal handle Escape', () => {
    const lower = dialog('lower');
    const upper = dialog('upper');
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    document.querySelectorAll.mockReturnValue([lower, upper]);

    handlePosDialogKeydown(keyEvent('Escape'), lower, lowerClose);
    const event = keyEvent('Escape');
    handlePosDialogKeydown(event, upper, upperClose);

    expect(isTopmostPosDialog(lower)).toBe(false);
    expect(isTopmostPosDialog(upper)).toBe(true);
    expect(lowerClose).not.toHaveBeenCalled();
    expect(upperClose).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('does not close for an IME composition Escape or without a close action', () => {
    const panel = dialog('panel');
    const close = vi.fn();
    document.querySelectorAll.mockReturnValue([panel]);

    handlePosDialogKeydown(keyEvent('Escape', { isComposing: true }), panel, close);
    const noAction = keyEvent('Escape');
    handlePosDialogKeydown(noAction, panel);

    expect(close).not.toHaveBeenCalled();
    expect(noAction.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores partial server-side document shims without event APIs', () => {
    const panel = dialog('panel');
    globalThis.document = { activeElement: null };

    expect(isTopmostPosDialog(panel)).toBe(false);
    expect(() => handlePosDialogKeydown(keyEvent('Tab'), panel)).not.toThrow();
  });
});

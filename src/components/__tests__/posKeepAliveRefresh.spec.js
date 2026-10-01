import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { findButton, mountClient } from '../pos/__tests__/clientTemplateHarness.js';

const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const body = parseScript(source, { sourceType: 'module' }).program.body;

const code = node => source.slice(node.start, node.end);
const hookCall = name => body.find(node =>
  node.type === 'ExpressionStatement' && node.expression?.callee?.name === name);
const hookSource = name => code(hookCall(name));
const declInit = name => code(body.flatMap(node => node.declarations || []).find(d => d.id.name === name).init);

const PASSIVE = [
  ['inventory_changed', 'onInactiveInventoryChanged'],
  ['product_availability_changed', 'onInactiveAvailabilityChanged'],
  ['settings_changed', 'onInactiveSettingsChanged'],
  ['held_orders_changed', 'onInactiveHeldOrdersChanged'],
  ['shifts_changed', 'onInactiveShiftsChanged'],
];
const handlers = Object.fromEntries(PASSIVE.map(([, handler]) => [handler, () => {}]));

// Run real terminal code against a live socket. Every other terminal binding
// it touches resolves to an inert stub, so only socket wiring is observed.
const inert = new Proxy(function () {}, {
  // clearTimeout coerces the stub timer handles to a number.
  get: (target, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : inert),
  apply: () => inert,
});
const terminalScope = (socket, extra = {}) => {
  const bindings = { socket: { value: socket }, initSocket: () => socket, ...handlers, ...extra };
  return new Proxy(bindings, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => (key in target ? target[key] : key === Symbol.unscopables ? undefined : inert),
    set: (target, key, value) => { target[key] = value; return true; },
  });
};
const run = (expression, scope) => new Function('scope', `with (scope) { return (${expression})(); }`)(scope);
const runHook = (name, scope) => run(code(hookCall(name).expression.arguments[0]), scope);

const liveSocket = () => Object.assign(new EventEmitter(), { io: new EventEmitter() });
const passiveListeners = socket => PASSIVE.map(([event, handler]) => socket.listeners(event).filter(listener => listener === handlers[handler]).length);

describe('POS keep-alive refresh tracking', () => {
  it('tracks each event passively once while parked, however often the page is parked', () => {
    const socket = liveSocket();
    const scope = terminalScope(socket);
    runHook('onDeactivated', scope);
    runHook('onDeactivated', scope);
    expect(passiveListeners(socket)).toEqual([1, 1, 1, 1, 1]);
  });

  it.each(['onActivated', 'onUnmounted'])('releases every passive listener on %s', async (hook) => {
    const socket = liveSocket();
    const scope = terminalScope(socket);
    runHook('onDeactivated', scope);
    await runHook(hook, scope);
    expect(passiveListeners(socket)).toEqual([0, 0, 0, 0, 0]);
  });

  it('snapshots the socket generation on deactivate and consumes it on activate', () => {
    expect(hookSource('onDeactivated')).toContain('refreshTracker.deactivate(connectionGeneration.value)');
    expect(hookSource('onActivated')).toContain('refreshTracker.activate(connectionGeneration.value)');
  });
});

describe('POS shift lifecycle listener', () => {
  const shiftTerminal = () => {
    const socket = liveSocket();
    const reconcileOpeningShiftReference = vi.fn();
    const scope = terminalScope(socket, { reconcileOpeningShiftReference });
    scope.onShiftLifecycleChanged = run(`() => ${declInit('onShiftLifecycleChanged')}`, scope);
    const bind = () => run(declInit('bindCatalogSocketListeners'), scope);
    return { socket, scope, bind, reconcileOpeningShiftReference };
  };

  it('reconciles the opening cash reference once per shift open or close, however often listeners are bound', () => {
    const { socket, bind, reconcileOpeningShiftReference } = shiftTerminal();
    bind();
    bind();
    socket.emit('shifts_changed', { action: 'update' });
    expect(reconcileOpeningShiftReference).not.toHaveBeenCalled();
    socket.emit('shifts_changed', { action: 'open' });
    socket.emit('shifts_changed', { action: 'close' });
    expect(reconcileOpeningShiftReference).toHaveBeenCalledTimes(2);
  });

  it.each(['onDeactivated', 'onUnmounted'])('stops reconciling the opening cash reference on %s', (hook) => {
    const { socket, scope, bind, reconcileOpeningShiftReference } = shiftTerminal();
    bind();
    runHook(hook, scope);
    socket.emit('shifts_changed', { action: 'open' });
    expect(reconcileOpeningShiftReference).not.toHaveBeenCalled();
  });
});

describe('POS keep-alive inventory refresh', () => {
  it('lets only unscoped or catalog inventory events refresh the catalog and cart prices', async () => {
    const stockRefresh = { noteNamed: vi.fn(), noteUnscoped: vi.fn() }, refreshCatalogAndCart = vi.fn();
    const scope = terminalScope(liveSocket(), { stockRefresh, refreshCatalogAndCart });
    const onInventoryChanged = run(`() => ${declInit('onInventoryChanged')}`, scope);
    await onInventoryChanged({ scope: 'availability' });
    expect(stockRefresh.noteUnscoped).not.toHaveBeenCalled();
    expect(refreshCatalogAndCart).not.toHaveBeenCalled();
    await onInventoryChanged({ scope: 'stock' });
    expect(stockRefresh.noteUnscoped).toHaveBeenCalledOnce();
    expect(refreshCatalogAndCart).not.toHaveBeenCalled();
    await onInventoryChanged({});
    expect(refreshCatalogAndCart).toHaveBeenCalledOnce();
  });

  it('replays scoped inventory marks through the cheap active paths on activation', () => {
    const activated = hookSource('onActivated');
    expect(source).toContain('refreshTracker.markInventoryChanged(payload)');
    expect(activated).toContain("onInventoryChanged({ scope: 'catalog', productIds: plan.catalogIds }");
    expect(activated).toContain('stockRefresh.noteUnscoped()');
  });
});

describe('POS display controls', () => {
  it('flips the terminal theme class and the stored preference from the rendered drawer toggle', async () => {
    const saved = new Map();
    const localStorage = { setItem: (key, value) => saved.set(key, value) };
    const isPosDark = ref(false);
    const POS_THEME_STORAGE_KEY = new Function(`return ${declInit('POS_THEME_STORAGE_KEY')}`)();
    const togglePosTheme = new Function('isPosDark', 'localStorage', 'POS_THEME_STORAGE_KEY', `return ${declInit('togglePosTheme')}`)(isPosDark, localStorage, POS_THEME_STORAGE_KEY);
    // Mount the real terminal root and its drawer theme button, compiled from PosTerminal.vue.
    const fragment = template => {
      const rootOpen = template.match(/^\s*<div[^>]*pos-theme-dark[^>]*>/)[0];
      const toggle = template.match(/<button type="button" class="drawer-theme-toggle[\s\S]*?<\/button>/)[0];
      return `${rootOpen}${toggle}</div>`;
    };
    const { root, app } = mountClient({ setup: () => ({ isPosDark, togglePosTheme }) }, resolve('src/components/PosTerminal.vue'), fragment);
    const terminal = root.children[0];
    const darkClass = () => /(^|\s)pos-theme-dark(\s|$)/.test(terminal.props.class);
    const button = findButton(root, 'Use dark mode');
    expect(button, 'theme toggle rendered').toBeTruthy();
    expect(darkClass()).toBe(false);
    const click = el => { expect(el.props.onClick, 'theme toggle click handler').toBeTypeOf('function'); el.props.onClick(); };

    click(button);
    await nextTick();
    expect([darkClass(), saved.get('pos_theme')], 'after switching to dark').toEqual([true, 'dark']);
    click(findButton(root, 'Use light mode'));
    await nextTick();
    expect([darkClass(), saved.get('pos_theme')], 'after switching back to light').toEqual([false, 'light']);
    app.unmount();
  });

  it('follows the browser fullscreen state', async () => {
    // A real event target stands in for document: the browser flips fullscreenElement, then fires fullscreenchange.
    const document = Object.assign(new EventTarget(), {
      fullscreenElement: null, documentElement: { requestFullscreen: vi.fn(async () => { document.fullscreenElement = {}; document.dispatchEvent(new Event('fullscreenchange')); }) },
      exitFullscreen: vi.fn(async () => { document.fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); }),
    });
    const isFullscreen = { value: false };
    const scope = terminalScope(liveSocket(), { isFullscreen, document });
    const toggleFullscreen = run(`() => ${declInit('toggleFullscreen')}`, scope);
    scope.syncFullscreenState = run(`() => ${declInit('syncFullscreenState')}`, scope);
    await runHook('onMounted', scope);

    await toggleFullscreen();
    expect(isFullscreen.value, 'fullscreenchange updates the fullscreen state').toBe(true);
    await toggleFullscreen();
    expect(isFullscreen.value).toBe(false);
    runHook('onUnmounted', scope);
    document.fullscreenElement = {};
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(isFullscreen.value, 'fullscreenchange listener released on unmount').toBe(false);
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
  });
});

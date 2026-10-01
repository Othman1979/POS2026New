import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from '@vue/compiler-dom';
import { compileScript, parse } from '@vue/compiler-sfc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
import ReportPrintMenu from '../ReportPrintMenu.vue';

// Tests import SFCs compiled for SSR, which drops event bindings; compile the
// real template for the client so its handlers are wired as in the browser.
const { descriptor } = parse(readFileSync(resolve('src/admin/components/ReportPrintMenu.vue'), 'utf8'));
const { bindings } = compileScript(descriptor, { id: 'report-print-menu' });
const { code } = compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: bindings });
const render = new Function('Vue', code)(Vue);
const ClientMenu = { ...ReportPrintMenu, ssrRender: undefined, render };

const renderer = createRenderer({
    createElement(tag) {
        const el = { tag, props: {}, children: [], parent: null, focus: vi.fn() };
        el.contains = node => node === el || (!!node?.parent && el.contains(node.parent));
        return el;
    },
    createText: text => ({ text, parent: null }), createComment: text => ({ text, parent: null }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
    setText(node, text) { node.text = text; }, setElementText(el, text) { el.text = text; },
    patchProp(el, key, prev, next) { el.props[key] = next; },
    parentNode: node => node.parent, nextSibling: () => null,
});
const findAll = (node, match) => [...(match(node) ? [node] : []), ...(node.children || []).flatMap(child => findAll(child, match))];
const textOf = node => node.text ?? (node.children || []).map(textOf).join('');

let app, host;
beforeEach(() => vi.stubGlobal('document', new EventTarget()));
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

function renderMenu() {
    const onSelect = vi.fn();
    host = { tag: 'host', props: {}, children: [], parent: null };
    app = renderer.createApp({ render: () => h(ClientMenu, { label: 'Print', onSelect }) });
    app.config.globalProperties.$t = key => key;
    app.mount(host);
    const root = host.children[0];
    const trigger = findAll(root, node => node.props?.['aria-haspopup'] === 'menu')[0];
    const items = () => findAll(root, node => node.props?.role === 'menuitem');
    const escape = () => {
        const event = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
        root.props.onKeydown(event);
        return event;
    };
    const pressOn = target => {
        const event = new Event('pointerdown');
        Object.defineProperty(event, 'target', { value: target });
        document.dispatchEvent(event);
    };
    return { trigger, items, escape, pressOn, onSelect };
}

describe('ReportPrintMenu', () => {
    it('opens a menu offering the thermal and A4 layouts from the trigger', async () => {
        const menu = renderMenu();
        expect(menu.trigger.props['aria-expanded']).toBe(false);
        menu.trigger.props.onClick();
        await nextTick();
        expect(menu.trigger.props['aria-expanded']).toBe(true);
        expect(menu.items().map(textOf)).toEqual(['Thermal (80mm)Compact receipt layout', 'Detailed A4Full-page detailed layout']);
    });

    it('emits the chosen layout, closes, and returns focus to the trigger', async () => {
        const menu = renderMenu();
        menu.trigger.props.onClick();
        await nextTick();
        menu.items()[1].props.onClick();
        await nextTick();
        expect(menu.onSelect).toHaveBeenCalledWith('a4');
        expect(menu.items()).toHaveLength(0);
        expect(menu.trigger.focus).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape without letting it reach the surrounding modal', async () => {
        const menu = renderMenu();
        menu.trigger.props.onClick();
        await nextTick();
        const event = menu.escape();
        await nextTick();
        expect(menu.items()).toHaveLength(0);
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(menu.trigger.focus).toHaveBeenCalledTimes(1);
    });

    it('closes on a press outside the menu and stays open for a press inside it', async () => {
        const menu = renderMenu();
        menu.trigger.props.onClick();
        await nextTick();
        menu.pressOn(menu.items()[0]);
        await nextTick();
        expect(menu.items()).toHaveLength(2);
        menu.pressOn(host);
        await nextTick();
        expect(menu.items()).toHaveLength(0);
    });

    // This menu is rendered inside the shift modal, and ModalShell closes on a
    // bubble-phase keydown listener attached to document, so a stopped Escape
    // never reaches it. Escape may only be swallowed while the dropdown is open.
    it('lets Escape reach the surrounding modal when the dropdown is closed', () => {
        const event = renderMenu().escape();
        expect(event.stopPropagation).not.toHaveBeenCalled();
    });
});

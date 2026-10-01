import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer } from 'vue';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

// A minimal in-memory host so a real template mounts and its click handlers run without a browser DOM.
export const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {} });
const detach = child => { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
export const { createApp } = createRenderer({
  createElement: tag => node(tag),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.children = [node('#text', text)]; },
  insert: (child, parent, anchor) => {
    detach(child);
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, child);
    child.parent = parent;
  },
  remove: detach,
  parentNode: el => el.parent,
  nextSibling: el => (el.parent ? el.parent.children[el.parent.children.indexOf(el) + 1] ?? null : null),
  patchProp: (el, key, prev, next) => { el.props[key] = next; },
});
// The test build compiles SFCs for SSR, so compile the real template (or a fragment picked from it) for the client to get live click handlers.
export const clientRender = (path, pickTemplate = template => template) => {
  const { descriptor } = parse(readFileSync(path, 'utf8'));
  const { bindings } = compileScript(descriptor, { id: 'client-template' });
  const { code, errors } = compileTemplate({
    source: pickTemplate(descriptor.template.content), id: 'client-template', filename: path, compilerOptions: { bindingMetadata: bindings },
  });
  expect(errors).toEqual([]);
  const body = code.replace(/import \{([^}]*)\} from "vue"/, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue;`)
    .replace('export function render', 'return function render');
  return new Function('Vue', body)(Vue);
};
// Mount a component with its client-compiled template into an in-memory root.
export const mountClient = (component, path, pickTemplate) => {
  const root = node('root');
  const app = createApp({ ...component, ssrRender: undefined, render: clientRender(path, pickTemplate) });
  app.config.globalProperties.$t = text => text;
  app.mount(root);
  return { root, app };
};
export const textOf = el => (el.tag === '#text' ? el.text : el.children.map(textOf).join(''));
export const findButton = (el, label) => (el.tag === 'button' && (textOf(el).trim() === label || el.props['aria-label'] === label) ? el
  : el.children.map(child => findButton(child, label)).find(Boolean));

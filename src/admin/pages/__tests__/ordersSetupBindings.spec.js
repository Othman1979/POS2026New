import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ordersSource = readFileSync(resolve(__dirname, '../Orders.vue'), 'utf8');
const ordersTemplate = ordersSource.match(/<template>[\s\S]*?<\/template>/)?.[0] || '';

function setupReturnBindings(source) {
    const setupStart = source.indexOf('setup()');
    const returnStart = source.lastIndexOf('return {');
    const returnEnd = source.indexOf('\n        };', returnStart);

    expect(setupStart).toBeGreaterThan(-1);
    expect(returnStart).toBeGreaterThan(setupStart);
    expect(returnEnd).toBeGreaterThan(returnStart);

    return source.slice(returnStart, returnEnd);
}

describe('Orders setup bindings', () => {
    it('exposes discounted-order route state used by the template', () => {
        expect(ordersSource).toContain('v-if="isDiscounted"');
        expect(ordersSource).toContain('const isDiscounted = ref(false)');
        expect(setupReturnBindings(ordersSource)).toMatch(/\bisDiscounted\b/);
    });

    it('exposes every reactive setup binding referenced by the template', () => {
        const returnedBindings = setupReturnBindings(ordersSource);
        const reactiveBindings = [
            ...ordersSource.matchAll(
                /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef|reactive|computed)\s*\(/g
            )
        ].map((match) => match[1]);

        const missingBindings = reactiveBindings.filter((binding) => {
            const bindingPattern = new RegExp(`\\b${binding}\\b`);
            return bindingPattern.test(ordersTemplate) && !bindingPattern.test(returnedBindings);
        });

        expect(missingBindings).toEqual([]);
    });
});

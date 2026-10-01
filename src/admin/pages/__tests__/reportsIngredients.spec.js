import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from '@vue/compiler-dom';
import { compileScript, parse } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { createRenderer, h, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../../components/ReportPrintMenu.vue', () => ({ default: { render: () => null } }));
vi.mock('../../composables/useBrowserReportPrint.js', () => ({ useBrowserReportPrint: () => ({ printReport: () => false, isPrinting: false }) }));
import { fetchJson } from '@/shared/http.js';
import IngredientDailyMovements from '../IngredientDailyMovements.vue';

const read = (file) => readFileSync(resolve(__dirname, file), 'utf8');

// Tests import SFCs compiled for SSR, which drops event bindings and never mounts;
// compile the real template for the client so onMounted loads the report as in the browser.
const { descriptor } = parse(read('../IngredientDailyMovements.vue'));
const { bindings } = compileScript(descriptor, { id: 'ingredient-daily-movements' });
const { code } = compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: bindings });
const ClientPage = { ...IngredientDailyMovements, ssrRender: undefined, render: new Function('Vue', code)(Vue) };

const renderer = createRenderer({
    createElement: tag => ({ tag, props: {}, children: [], parent: null }),
    createText: text => ({ text, parent: null }), createComment: () => ({ text: '', parent: null }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
    setText(node, text) { node.text = text; }, setElementText(el, text) { el.text = text; },
    patchProp(el, key, prev, next) { el.props[key] = next; },
    parentNode: node => node.parent, nextSibling: () => null,
});
const findAll = (node, match) => [...(match(node) ? [node] : []), ...(node.children || []).flatMap(child => findAll(child, match))];
const hasClass = (node, name) => String(node.props?.class ?? '').split(' ').includes(name);
const textOf = node => node.text ?? (node.children || []).map(textOf).join('');

const report = {
    success: true,
    totals: { used_cost: 1234.5, waste_cost: 1.25, sales_total: 3919, food_cost_pct: 0.315, below_par_count: 1 },
    ingredients: [
        { id: 1, name: 'Flour', display_unit: 'kg', opening: 5000, received: 2000, used: 1500, waste: 250, closing_expected: 5250, below_par: false, waste_by_reason: { spoiled: 250 } },
        { id: 2, name: 'Milk', display_unit: 'l', opening: 1000, received: 0, used: 800, waste: 0, closing_expected: 200, below_par: true, waste_by_reason: {} }
    ]
};

describe('Ingredients day report source spec', () => {
    const page = read('../IngredientDailyMovements.vue');
    const payloads = read('../dailyReportPayloads.js');
    const registry = read('../../pageRegistry.js');
    const router = read('../../router.js');
    const layout = read('../../reportPages.js');
    const arabic = JSON.parse(read(resolve(__dirname, '../../../shared/i18n/ar.json')));

    it('fetches the single-day admin ingredients report', () => {
        expect(page).toContain("import { fetchJson } from '@/shared/http.js'");
        expect(page).toContain('api/admin/reports/ingredients?date=');
        expect(page).not.toMatch(/\bfetch\s*\(/);
        expect(page).not.toContain('start_date=');
    });

    it('registers the page, reports tab, and print helper', () => {
        expect(registry).toContain("'reports-ingredients'");
        expect(router).toContain("name: 'reports-ingredients'");
        expect(layout).toContain("value: 'reports-ingredients'");
        expect(layout).toContain("label: 'Ingredient usage and costs'");
        expect(page).toContain('registerDailyReportPrint');
        expect(page).toContain('buildDailyIngredientsPrintPayload');
        expect(payloads).toContain("print_type: 'daily_ingredients_report'");
        expect(arabic['Ingredient cost %']).toBe('نسبة تكلفة المكونات');
        expect(arabic['Below minimum stock']).toBe('دون الحد الأدنى للمخزون');
        expect(arabic['Closing stock']).toBe('رصيد نهاية اليوم');
        expect(arabic['Waste by reason']).toBe('الهدر حسب السبب');
    });
});

describe('Ingredients day report', () => {
    let app, root;
    beforeEach(async () => {
        fetchJson.mockReset().mockResolvedValue(report);
        const host = { tag: 'host', props: {}, children: [], parent: null };
        app = renderer.createApp({ render: () => h(ClientPage, { date: '2026-09-27' }) });
        app.config.globalProperties.$t = key => key;
        app.mount(host);
        root = host.children[0];
        await vi.waitFor(() => expect(findAll(root, node => node.tag === 'tr')).not.toHaveLength(0));
    });
    afterEach(() => { app.unmount(); });

    it('loads the chosen day and shows used cost, waste cost, ingredient cost % and the below-par count', () => {
        expect(fetchJson.mock.calls[0][0]).toBe('api/admin/reports/ingredients?date=2026-09-27');
        const metrics = findAll(root, node => hasClass(node, 'ingredients-report__metrics'));
        expect(metrics.map(section => section.children.map(textOf))).toEqual([[
            'Cost of ingredients used1,234.50 JD',
            'Waste cost1.25 JD',
            'Ingredient cost %31.5%',
            'Below minimum stock1'
        ]]);
    });

    it('lists each ingredient balance in its display unit and marks the one below par', () => {
        const rows = findAll(root, node => node.tag === 'tr').slice(1);
        expect(rows.map(row => row.children.map(textOf))).toEqual([
            ['Flour', 'kg', '5', '2', '1.5', '0.25', '5.25'],
            ['Milk', 'l', '1', '0', '0.8', '0', '0.2']
        ]);
        expect(rows.map(row => row.props.class)).toEqual(['', 'is-below-par']);
    });

    it('switches to waste by reason with a readable reason label', async () => {
        const [wasteView] = findAll(root, node => node.tag === 'button' && textOf(node) === 'Waste by reason');
        expect(wasteView, 'Waste by reason button').toBeDefined();
        wasteView.props.onClick();
        await nextTick();
        const rows = findAll(root, node => node.tag === 'tr').slice(1);
        expect(rows.map(row => row.children.map(textOf))).toEqual([['Flour', 'Spoiled', '0.25 kg']]);
    });
});

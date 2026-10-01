import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, shallowReactive } from 'vue';

// Chart.js loads on demand, so the tests hold the import open and release it themselves.
const chartJs = vi.hoisted(() => ({ release: null, instances: [], failNext: false, unmount: null }));

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onBeforeUnmount: fn => { chartJs.unmount = fn; } }));
const chartFactory = async () => {
    if (chartJs.failNext) {
        chartJs.failNext = false;
        throw new Error('chunk failed');
    }
    await new Promise(resolve => { chartJs.release = resolve; });
    class Chart {
        static register() {}
        constructor() { this.destroyed = false; chartJs.instances.push(this); }
        destroy() { this.destroyed = true; }
    }
    return { Chart };
};

const points = [{ elapsed_minute: 0, today: 1, typical: 2 }];
let scope;

async function mountChart() {
    const { default: Component } = await import('./DashboardPaceChart.vue');
    const props = shallowReactive({ points });
    let state;
    scope = effectScope();
    scope.run(() => { state = Component.setup(props, { expose() {}, emit() {} }); });
    state.canvas.value = {};
    return { props, state };
}
const live = () => chartJs.instances.filter(chart => !chart.destroyed);
const flush = async () => {
    for (let i = 0; i < 5; i++) await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
};

beforeEach(() => {
    vi.resetModules();
    vi.doMock('./paceChartJs', chartFactory);
    chartJs.instances = [];
    chartJs.release = null;
    chartJs.failNext = false;
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
});
afterEach(() => { scope?.stop(); vi.unstubAllGlobals(); });

describe('DashboardPaceChart lazy Chart.js', () => {
    it('draws one chart after the import resolves', async () => {
        await mountChart();
        await flush();
        expect(chartJs.instances).toHaveLength(0);
        chartJs.release();
        await flush();
        expect(live()).toHaveLength(1);
    });

    it('creates no chart when unmounted before the import resolves', async () => {
        await mountChart();
        await flush();
        chartJs.unmount();
        chartJs.release();
        await flush();
        expect(chartJs.instances).toHaveLength(0);
    });

    it('leaves exactly one chart when two updates land before the import resolves', async () => {
        const { props } = await mountChart();
        await flush();
        props.points = [...points];
        await flush();
        props.points = [...points];
        await flush();
        chartJs.release();
        await flush();
        expect(live()).toHaveLength(1);
    });

    it('does not throw when the import fails and draws on the next update', async () => {
        chartJs.failNext = true;
        const { props } = await mountChart();
        await flush();
        expect(chartJs.instances).toHaveLength(0);
        props.points = [...points];
        await flush();
        chartJs.release();
        await flush();
        expect(live()).toHaveLength(1);
    });
});

// Only two artifact paths remain: Typst documents and the raw drawer pulse.
function createRendererRouter({ createTypst, createRaw }) {
    let typst;
    let raw;
    let rendered = 0;
    async function render(job) {
        if (job?.print_type === 'cash_drawer') {
            raw ||= createRaw();
            return raw.render(job);
        }
        typst ||= createTypst();
        const artifact = await typst.render(job);
        rendered++;
        return artifact;
    }
    // The drawer pulse needs no compiler; only Typst has a cold start worth hiding.
    function warm() {
        typst ||= createTypst();
        return typst.warm?.();
    }
    async function close() {
        await Promise.allSettled([typst?.close?.(), raw?.close?.()]);
    }
    function health() {
        const status = typst?.health?.() || { state: 'cold' };
        return { ...status, mode: 'typst-only', counters: { typst_rendered: rendered } };
    }
    return { render, warm, close, health };
}
module.exports = { createRendererRouter };

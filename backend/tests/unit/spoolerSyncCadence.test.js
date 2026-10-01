const {
    SYNC_MAX,
    SYNC_WINDOW_MS,
    V2_THROTTLE_SYNC_MS,
    V2_SYNC_WAIT_MAX_MS,
    V2_POST_HOLD_SYNC_MS,
    V2_SYNC_RESPONSE_BUDGET_MS,
    V2_SECOND_SYNC_RESERVE_MS
} = require('../../routes/spoolerV2');
const { V2_NEXT_SYNC_MS } = require('../../services/spoolerSync');

describe('spooler v2 sync cadence policy', () => {
    it('advertises a cadence the agent clamp will honour', () => {
        expect(V2_NEXT_SYNC_MS).toBeGreaterThanOrEqual(500);
        expect(V2_NEXT_SYNC_MS).toBeLessThanOrEqual(5000);
    });

    it('leaves burst headroom above steady-state cost', () => {
        const steadyState = SYNC_WINDOW_MS / V2_NEXT_SYNC_MS;
        expect(SYNC_MAX).toBeGreaterThanOrEqual(steadyState * 4);
    });

    it('never answers too-fast traffic with a faster cadence', () => {
        expect(V2_THROTTLE_SYNC_MS).toBeGreaterThanOrEqual(V2_NEXT_SYNC_MS);
    });

    it('keeps the held request inside the client and shutdown budgets', () => {
        expect(V2_SYNC_WAIT_MAX_MS).toBeLessThan(V2_SYNC_RESPONSE_BUDGET_MS);
        expect(V2_SYNC_RESPONSE_BUDGET_MS).toBeLessThan(10000);
        expect(V2_SECOND_SYNC_RESERVE_MS).toBeGreaterThan(0);
        expect(V2_SYNC_WAIT_MAX_MS + V2_SECOND_SYNC_RESERVE_MS).toBeLessThan(V2_SYNC_RESPONSE_BUDGET_MS);
        expect(V2_POST_HOLD_SYNC_MS).toBe(500);
    });

    it('keeps enough rate-limit headroom for the busy 500ms path', () => {
        const busyRequestsPerWindow = SYNC_WINDOW_MS / V2_POST_HOLD_SYNC_MS;
        expect(SYNC_MAX).toBeGreaterThanOrEqual(busyRequestsPerWindow * 4);
    });
});

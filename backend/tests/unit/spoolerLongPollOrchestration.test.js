const {
    orchestrateAgentSync,
    boundedWaitMs,
    V2_POST_HOLD_SYNC_MS,
    V2_SYNC_WAIT_MAX_MS
} = require('../../routes/spoolerV2');
const { createSpoolerSyncWakeHub } = require('../../services/spoolerSyncWake');

function emptyResult(overrides = {}) {
    return {
        agentStatus: 'active',
        confirmedAccepted: [],
        confirmedResults: [],
        cancelRequested: [],
        healthWarnings: [],
        jobs: [],
        nextSyncMs: 500,
        queueStateChanged: false,
        ...overrides
    };
}

function body(overrides = {}) {
    return {
        waitMs: V2_SYNC_WAIT_MAX_MS,
        accepted: [],
        results: [],
        health: { local_queue_depth: 0, worker_active: 0 },
        capacity: 5,
        kitchenCapacity: 5,
        ...overrides
    };
}

describe('spooler V2 long-poll orchestration', () => {
    it('captures generation before the first sync and closes the lost-wakeup race', async () => {
        const hub = createSpoolerSyncWakeHub();
        const calls = [];
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body({ health: { local_queue_depth: 0, worker_active: 0, blocked_printer_ids: [42] } }),
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: hub,
            syncFn: async (_agent, input) => {
                calls.push(input);
                if (calls.length === 1) {
                    hub.publish();
                    return emptyResult();
                }
                return emptyResult({ jobs: [{ queue_id: 7 }] });
            }
        });

        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ accepted: [], results: [], health: null, capacity: 5, kitchenCapacity: 5, blockedPrinterIds: [42] });
        expect(result.result.jobs).toEqual([{ queue_id: 7 }]);
        expect(result.result.nextSyncMs).toBe(V2_POST_HOLD_SYNC_MS);
        expect(result.held).toBe(true);
    });

    it.each([
        ['missing capability', body({ waitMs: 0 })],
        ['zero capacity', body({ capacity: 0, kitchenCapacity: 0 })],
        ['submitted acceptance', body({ accepted: [{ queue_id: 1 }] })],
        ['local queue', body({ health: { local_queue_depth: 1, worker_active: 0 } })]
    ])('returns immediately for %s', async (_label, syncBody) => {
        let waits = 0;
        let calls = 0;
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody,
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: {
                generation: () => 0,
                waitForChange: async () => { waits += 1; return 'timeout'; }
            },
            syncFn: async () => { calls += 1; return emptyResult(); }
        });
        expect(calls).toBe(1);
        expect(waits).toBe(0);
        expect(result.held).toBe(false);
    });

    it('waits for urgent work while only reserved kitchen capacity remains', async () => {
        let calls = 0;
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body({ capacity: 0, kitchenCapacity: 5 }),
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: { generation: () => 0, waitForChange: async () => 'timeout' },
            syncFn: async (_agent, input) => {
                calls += 1;
                expect(input).toMatchObject({ capacity: 0, kitchenCapacity: 5 });
                return emptyResult();
            }
        });
        expect(calls).toBe(1);
        expect(result.held).toBe(true);
    });

    it('returns the first response at the fixed recovery cadence after timeout', async () => {
        let calls = 0;
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: { generation: () => 0, waitForChange: async () => 'timeout' },
            syncFn: async () => { calls += 1; return emptyResult({ nextSyncMs: 5000 }); }
        });
        expect(calls).toBe(1);
        expect(result.held).toBe(true);
        expect(result.result.nextSyncMs).toBe(V2_POST_HOLD_SYNC_MS);
    });

    it('flags a full idle hold so agents re-poll at once, and not a woken one', async () => {
        const run = reason => orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: { generation: () => 0, waitForChange: async () => reason },
            syncFn: async () => emptyResult()
        });
        expect((await run('timeout')).result.idleHeld).toBe(true);
        expect((await run('changed')).result.idleHeld).not.toBe(true);
    });

    it('clamps the requested wait to 6 s and leaves the legacy 1.5 s request unchanged', () => {
        expect(V2_SYNC_WAIT_MAX_MS).toBe(6000);
        expect(boundedWaitMs(6000)).toBe(6000);
        expect(boundedWaitMs(99999)).toBe(6000);
        expect(boundedWaitMs(1500)).toBe(1500);
    });

    it('shrinks the hold to fit the response budget when the first pass was slow', async () => {
        let held = null;
        await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body({ waitMs: 6000 }),
            signal: new AbortController().signal,
            elapsedMs: () => 2500,
            wakeHub: { generation: () => 0, waitForChange: async (_id, _since, { timeoutMs }) => { held = timeoutMs; return 'timeout'; } },
            syncFn: async () => emptyResult()
        });
        expect(held).toBe(4500);
    });

    it('does not start a second sync when the request aborts after wake', async () => {
        const controller = new AbortController();
        let calls = 0;
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: controller.signal,
            elapsedMs: () => 10,
            wakeHub: {
                generation: () => 0,
                waitForChange: async () => {
                    controller.abort();
                    return 'changed';
                }
            },
            syncFn: async () => { calls += 1; return emptyResult(); }
        });
        expect(calls).toBe(1);
        expect(result.aborted).toBe(true);
    });

    it('does not retain a waiter or write again when the first sync finishes after abort', async () => {
        const controller = new AbortController();
        const hub = createSpoolerSyncWakeHub();
        const claimed = emptyResult({ jobs: [{ queue_id: 41, agent_id: 'agent-a' }] });
        let calls = 0;
        const first = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: controller.signal,
            elapsedMs: () => 10,
            wakeHub: hub,
            syncFn: async () => {
                calls += 1;
                controller.abort();
                return claimed;
            }
        });

        expect(first.aborted).toBe(true);
        expect(calls).toBe(1);
        expect(hub.snapshot().waiters).toBe(0);

        const replay = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body({ waitMs: 0 }),
            signal: new AbortController().signal,
            elapsedMs: () => 10,
            wakeHub: hub,
            syncFn: async () => claimed
        });
        expect(replay.result.jobs).toEqual([{ queue_id: 41, agent_id: 'agent-a' }]);
    });

    it('preserves a committed first-sync result when the HTTP request aborts', async () => {
        const controller = new AbortController();
        const committed = emptyResult({
            queueStateChanged: true,
            confirmedResults: [73]
        });
        const outcome = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: controller.signal,
            elapsedMs: () => 10,
            wakeHub: createSpoolerSyncWakeHub(),
            syncFn: async () => {
                controller.abort();
                return committed;
            }
        });

        expect(outcome).toMatchObject({
            aborted: true,
            held: false,
            result: committed
        });
    });

    it('does not wait after the response budget loses its second-sync reserve', async () => {
        let waits = 0;
        const result = await orchestrateAgentSync({
            agent: { agent_id: 'agent-a' },
            syncBody: body(),
            signal: new AbortController().signal,
            elapsedMs: () => 8000,
            wakeHub: {
                generation: () => 0,
                waitForChange: async () => { waits += 1; return 'timeout'; }
            },
            syncFn: async () => emptyResult()
        });
        expect(waits).toBe(0);
        expect(result.held).toBe(false);
    });
});

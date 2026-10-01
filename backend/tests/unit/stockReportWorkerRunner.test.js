import { describe, expect, it, vi } from 'vitest';
import { createStockReportWorkerRunner } from '../../services/StockReportWorkerRunner.js';

describe('Stock report worker runner', () => {
    it('covers uninitialized days once, then polls pending work, and stops without leaking timers', async () => {
        vi.useFakeTimers();
        const coverage = vi.fn(async () => ({ inserted: 32, days: ['2026-09-08'] }));
        const runOne = vi.fn()
            .mockResolvedValueOnce({ status: 'published' })
            .mockResolvedValueOnce({ status: 'idle' })
            .mockResolvedValue({ status: 'idle' });
        const runner = createStockReportWorkerRunner({backfillNeeded:async()=>false,
            isEnabled:async()=>true, pool: {}, backfillBalances:async()=>({complete:true}),
            logger: { warn() {} },
            ensureCoverage: coverage,
            runOne,
            pendingMs: 500,
            idleMs: 10_000
        });
        await runner.start();
        expect(coverage).toHaveBeenCalledTimes(1);
        expect(runOne).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(runOne).toHaveBeenCalledTimes(2);
        expect(coverage).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(coverage).toHaveBeenCalledTimes(1);
        await runner.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(runOne).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
    });
    it('yields before acquiring database work while source transactions are active', async () => {
        vi.useFakeTimers();
        let busy=true;
        const ensureCoverage=vi.fn(async()=>({complete:true})),runOne=vi.fn(async()=>({status:'idle'}));
        const runner=createStockReportWorkerRunner({backfillNeeded:async()=>false,isEnabled:async()=>true,pool:{},backfillBalances:async()=>({complete:true}),logger:{warn(){}},sourcePressure:()=>busy,ensureCoverage,runOne});
        expect(await runner.start()).toEqual({status:'deferred'});
        expect(ensureCoverage).not.toHaveBeenCalled();expect(runOne).not.toHaveBeenCalled();
        busy=false;await vi.advanceTimersByTimeAsync(500);
        expect(runOne).toHaveBeenCalledTimes(1);
        await runner.stop();vi.useRealTimers();
    });
    it('continues durable backfill pages before publishing partial historical coverage',async()=>{
        vi.useFakeTimers();
        const ensureCoverage=vi.fn().mockResolvedValueOnce({complete:false}).mockResolvedValue({complete:true});
        const runOne=vi.fn(async()=>({status:'idle'}));
        const runner=createStockReportWorkerRunner({backfillNeeded:async()=>false,isEnabled:async()=>true,pool:{},backfillBalances:async()=>({complete:true}),logger:{warn(){}},ensureCoverage,runOne});
        expect(await runner.start()).toEqual({status:'backfill'});expect(runOne).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);expect(ensureCoverage).toHaveBeenCalledTimes(2);expect(runOne).toHaveBeenCalledTimes(1);
        await runner.stop();vi.useRealTimers();
    });

    it('keeps the ingredient identity cursor across backfill and idle polls',async()=>{
        vi.useFakeTimers();
        const backfillBalances=vi.fn().mockResolvedValueOnce({complete:false,after_id:16})
            .mockResolvedValueOnce({complete:true,after_id:19}).mockResolvedValue({complete:true,after_id:19});
        const runner=createStockReportWorkerRunner({backfillNeeded:async()=>false,isEnabled:async()=>true,pool:{},logger:{warn(){}},backfillBalances,
            ensureCoverage:async()=>({complete:true}),runOne:async()=>({status:'idle'})});
        try {
            expect(await runner.start()).toEqual({status:'backfill'});
            await vi.advanceTimersByTimeAsync(500);
            await vi.advanceTimersByTimeAsync(10000);
            expect(backfillBalances.mock.calls.map(call=>call[1])).toEqual([0,16]);
        } finally {await runner.stop();vi.useRealTimers();}
    });

    it('skips historical scans while both inventory features are off and resumes automatically', async () => {
        vi.useFakeTimers();
        let enabled = false;
        const ensureCoverage = vi.fn(async () => ({complete:true}));
        const backfillBalances = vi.fn(async () => ({complete:true}));
        const runOne = vi.fn(async () => ({status:'idle'}));
        const runner = createStockReportWorkerRunner({backfillNeeded:async()=>false,pool:{},logger:{warn(){}},isEnabled:async()=>enabled,ensureCoverage,backfillBalances,runOne});
        try {
            expect(await runner.start()).toEqual({status:'disabled'});
            await vi.advanceTimersByTimeAsync(10000);
            expect(ensureCoverage).not.toHaveBeenCalled();
            expect(backfillBalances).not.toHaveBeenCalled();
            expect(runOne).not.toHaveBeenCalled();
            enabled = true;
            await vi.advanceTimersByTimeAsync(10000);
            expect(runOne).toHaveBeenCalledTimes(1);
        } finally { await runner.stop(); vi.useRealTimers(); }
    });

    it('rechecks missing balances without delaying dirty reports or repeating completed backfill',async()=>{
        vi.useFakeTimers();let needed=false;
        const backfillBalances=vi.fn(async()=>({complete:true,after_id:19}));
        const ensureCoverage=vi.fn(async()=>({complete:true}));
        const runOne=vi.fn(async()=>({status:'idle'}));
        const runner=createStockReportWorkerRunner({pool:{},logger:{warn(){}},isEnabled:async()=>true,
            backfillNeeded:async()=>needed,backfillBalances,ensureCoverage,runOne});
        try {
            await runner.start();await vi.advanceTimersByTimeAsync(50000);
            expect(runOne).toHaveBeenCalledTimes(6);expect(backfillBalances).toHaveBeenCalledTimes(1);
            needed=true;await vi.advanceTimersByTimeAsync(10000);
            expect(backfillBalances.mock.calls.map(call=>call[1])).toEqual([0,0]);
            expect(ensureCoverage).toHaveBeenCalledTimes(2);
        }finally{await runner.stop();vi.useRealTimers();}
    });

    it('restarts balance discovery after disabling tracking or restarting the runner',async()=>{
        vi.useFakeTimers();let enabled=true;
        const backfillBalances=vi.fn(async()=>({complete:true,after_id:19}));
        const runner=createStockReportWorkerRunner({pool:{},logger:{warn(){}},isEnabled:async()=>enabled,
            backfillNeeded:async()=>false,backfillBalances,ensureCoverage:async()=>({complete:true}),runOne:async()=>({status:'idle'})});
        try {
            await runner.start();enabled=false;await vi.advanceTimersByTimeAsync(10000);
            enabled=true;await vi.advanceTimersByTimeAsync(10000);
            await runner.stop();await runner.start();
            expect(backfillBalances.mock.calls.map(call=>call[1])).toEqual([0,0,0]);
        }finally{await runner.stop();vi.useRealTimers();}
    });

});

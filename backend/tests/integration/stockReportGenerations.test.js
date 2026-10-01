const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const reports = require('../../services/StockReportGenerationService');

describe('Stock report publication generations', () => {
    const day = '2026-09-08';
    beforeEach(async () => { await seedDatabase(); });
    afterAll(() => pool.end());
    async function mark(scope = 1, connection = pool) { await reports.markDirty(connection, [{ day, scope_id: scope }]); }
    async function status(scope = 1) {
        return (await reports.status(pool, { startDate: day, endDate: day })).find(row => row.scope_id === scope);
    }
    test('does not allocate a worker lease or open a metadata transaction while idle', async () => {
        const calls=[];
        const idlePool={query(sql,args){calls.push(sql);return pool.query(sql,args);},getConnection(){throw new Error('Unexpected idle transaction');}};
        expect(await reports.claim(idlePool)).toBeNull();
        expect(calls).toHaveLength(1);
        expect((await pool.query('SELECT * FROM stock_report_worker'))[0]).toEqual([]);
    });
    test('publishes only a complete claimed generation and exposes later changes as stale', async () => {
        await mark();
        const claim = await reports.claim(pool);
        expect(claim).toMatchObject({ day, scope_id: 1, generation: '1' });
        expect(await status()).toMatchObject({ pending: true, published_build_id: null });
        expect(await reports.publish(pool, claim)).toBe(true);
        expect(await status()).toMatchObject({ pending: false, published_build_id: claim.build_id, published_generation: '1' });
        await mark();
        expect(await status()).toMatchObject({ pending: true, published_build_id: claim.build_id, generation: '2' });
    });
    test('rejects a stale build and keeps the previous published generation visible', async () => {
        await mark(); const first = await reports.claim(pool); await reports.publish(pool, first);
        await mark(); const stale = await reports.claim(pool);
        await mark();
        expect(await reports.publish(pool, stale)).toBe(false);
        expect(await status()).toMatchObject({ pending: true, published_build_id: first.build_id, generation: '3' });
        const fresh = await reports.claim(pool);
        expect(fresh.generation).toBe('3');
        expect(await reports.publish(pool, fresh)).toBe(true);
    });
    test('allows only one active build per installation and recovers an expired lease', async () => {
        await reports.markDirty(pool, [{ day, scope_id: 2 }, { day, scope_id: 1 }]);
        const claims = await Promise.all([reports.claim(pool), reports.claim(pool)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const old = claims.find(Boolean);
        await pool.query('UPDATE stock_report_worker SET lease_until=DATE_SUB(NOW(6),INTERVAL 1 SECOND)');
        await pool.query('UPDATE stock_report_dirty SET lease_until=DATE_SUB(NOW(6),INTERVAL 1 SECOND)');
        const recovered = await reports.claim(pool);
        expect(recovered.build_id).not.toBe(old.build_id);
        expect(await reports.renew(pool, old)).toBe(false);
        expect(await reports.publish(pool, old)).toBe(false);
        expect(await reports.renew(pool, recovered)).toBe(true);
        expect(await reports.publish(pool, recovered)).toBe(true);
        expect(await reports.claim(pool)).not.toBeNull();
    });
    test('rollback does not dirty reports and a lower-ID late commit invalidates a started build', async () => {
        await mark();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await mark(1, conn);
            await conn.rollback();
            expect((await status()).generation).toBe('1');
            // Allocate the lower source ID first, without committing its source
            // transaction. Publication must rely on generations, not MAX(id).
            await conn.beginTransaction();
            const [lower] = await conn.query("INSERT INTO stock_operations(request_key,payload_hash,kind) VALUES ('late-low-id',REPEAT('a',64),'receipt')");
            const [higher] = await pool.query("INSERT INTO stock_operations(request_key,payload_hash,kind) VALUES ('early-high-id',REPEAT('b',64),'receipt')");
            expect(lower.insertId).toBeLessThan(higher.insertId);
            await mark();
            const build = await reports.claim(pool);
            await mark(1, conn); await conn.commit();
            expect(await reports.publish(pool, build)).toBe(false);
        } finally { await conn.rollback(); conn.release(); }
    });
    test('coalesces sorted scopes in one writer statement and hashes source identities into 32 partitions', async () => {
        const calls = [];
        await reports.markDirty({ query(sql, args) { calls.push({ sql, args }); return pool.query(sql, args); } },
            [{day,scope_id:5},{day,scope_id:2},{day,scope_id:5}]);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0].map(row=>row[1])).toEqual([2,5]);
        const scopes = Array.from({length:1000},(_,i)=>reports.scopeFor('invoice', String(i+1)));
        expect(new Set(scopes).size).toBe(32);
        expect(reports.scopeFor('invoice','123')).toBe(reports.scopeFor('invoice','123'));
        expect(()=>reports.scopeFor('invoice',9007199254740992)).toThrow('exact integers');
        await expect(reports.markDirty(pool,[{day:'2026-02-30',scope_id:1}])).rejects.toThrow();
        await expect(reports.markDirty(pool,[{day,scope_id:32}])).rejects.toThrow();
    });
    test('a publication failure rolls back the pointer and can retry with the same claim', async () => {
        await mark(); const build = await reports.claim(pool);
        const failingPool = { async getConnection() {
            const conn = await pool.getConnection();
            return {
                beginTransaction:()=>conn.beginTransaction(), commit:()=>conn.commit(), rollback:()=>conn.rollback(), release:()=>conn.release(),
                query(sql,args) {
                    if (sql.includes("SET state='published'")) throw new Error('interrupted publication');
                    return conn.query(sql,args);
                }
            };
        } };
        await expect(reports.publish(failingPool,build)).rejects.toThrow('interrupted publication');
        expect(await status()).toMatchObject({ pending:true,published_build_id:null });
        expect(await reports.publish(pool,build)).toBe(true);
        await reports.abandon(pool,build);
        expect(await status()).toMatchObject({ pending:false,published_build_id:build.build_id });
    });
    test('renewal stops superseded work immediately and metadata calls release their only connection', async () => {
        let retained = 0, peak = 0;
        const trackedPool = {async query(...args){retained++;peak=Math.max(peak,retained);try{return await pool.query(...args);}finally{retained--;}}, async getConnection() {
            const conn = await pool.getConnection(); retained++; peak=Math.max(peak,retained);
            return {beginTransaction:()=>conn.beginTransaction(),commit:()=>conn.commit(),rollback:()=>conn.rollback(),
                query:(...args)=>conn.query(...args),release:()=>{retained--;conn.release();}};
        } };
        await mark(); const build = await reports.claim(trackedPool);
        expect(retained).toBe(0);
        await mark();
        expect(await reports.renew(trackedPool,build)).toBe(false);
        const replacement=await reports.claim(trackedPool);
        expect(replacement.generation).toBe('2');
        await reports.abandon(trackedPool,replacement);
        expect(retained).toBe(0); expect(peak).toBe(1);
        expect((await status()).pending).toBe(true);
    });
    test('preserves build IDs and generations beyond JavaScript safe integers', async () => {
        await mark();
        await pool.query('ALTER TABLE stock_report_builds AUTO_INCREMENT=9007199254740993');
        await pool.query("UPDATE stock_report_dirty SET generation='9007199254740993'");
        const claim=await reports.claim(pool);
        expect(claim).toMatchObject({build_id:'9007199254740993',generation:'9007199254740993'});
        expect(await reports.publish(pool,claim)).toBe(true);
        expect(await status()).toMatchObject({published_build_id:'9007199254740993',published_generation:'9007199254740993'});
    });
});

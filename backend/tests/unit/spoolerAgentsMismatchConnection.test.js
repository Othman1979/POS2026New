const { registerAgent } = require('../../services/spoolerAgents');

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'a'.repeat(64);

// A register-time station mismatch counts the identity's unfinished server work while
// the registration connection is still held. With a one-connection pool, a count run
// through the pool would wait for that connection forever and the agent would never
// receive the count that lets it heal.
describe('register-time station mismatch count', () => {
    it('runs the unfinished-work count on the connection it already holds', async () => {
        const conn = {
            calls: [],
            beginTransaction: async () => {},
            rollback: async () => {},
            release: vi.fn(),
            query: async sql => {
                conn.calls.push(String(sql));
                if (/FROM spooler_agents WHERE agent_id/.test(sql)) return [[{ agent_id: AGENT, spooler_id: 'old-station', token_hash: HASH, status: 'active', last_error: null }]];
                if (/COUNT\(\*\) AS unfinished/.test(sql)) return [[{ unfinished: 3 }]];
                return [[]];
            }
        };
        const db = {
            getConnection: async () => conn,
            query: async () => { throw new Error('pool used while the registration connection is held'); }
        };
        await expect(registerAgent(db, { agentId: AGENT, spoolerId: 'new-station', tokenHash: HASH }))
            .rejects.toMatchObject({ statusCode: 409, code: 'station_mismatch', serverUnfinished: 3 });
        expect(conn.calls.some(sql => /COUNT\(\*\) AS unfinished/.test(sql))).toBe(true);
        expect(conn.release).toHaveBeenCalledTimes(1);
    });
});

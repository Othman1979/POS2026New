// backend/tests/unit/orderSequence.test.js
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { reserveDailyOrderId, scopeKeyFor } = require('../../utils/orderSequence');

async function captureQueries(conn, operation) {
  const originalQuery = conn.query;
  const statements = [];
  conn.query = async function capturedQuery(sql, ...args) {
    statements.push(String(sql).replace(/\s+/g, ' ').trim());
    return originalQuery.call(this, sql, ...args);
  };
  try {
    return { value: await operation(), statements };
  } finally {
    conn.query = originalQuery;
  }
}

describe('scopeKeyFor', () => {
  it('shared mode → date:<businessDate>', () => {
    expect(scopeKeyFor({ businessDate: '2026-06-30' })).toBe('date:2026-06-30');
  });

  it('obsolete mode and shift cannot change the date scope', () => {
    expect(scopeKeyFor({ sharedMode: false, shiftId: 42, businessDate: '2026-06-30' })).toBe('date:2026-06-30');
  });
});

describe('reserveDailyOrderId', () => {
  beforeEach(async () => { await seedDatabase(); });
  afterAll(async () => { await pool.end(); });

  it('shared mode increments a per-date counter', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const a = await reserveDailyOrderId(conn, { businessDate: '2026-06-30' });
      const b = await reserveDailyOrderId(conn, { businessDate: '2026-06-30' });
      await conn.commit();
      expect(a).toBe(1);
      expect(b).toBe(2);
    } finally { conn.release(); }
  });

  it('continues the existing daily counter across shifts and starts a new day at one', async () => {
    await pool.query("INSERT INTO daily_sequences(sequence_date,current_value) VALUES('2026-06-30',70)");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      expect(await reserveDailyOrderId(conn, {businessDate:'2026-06-30', sharedMode:false, shiftId:1})).toBe(71);
      expect(await reserveDailyOrderId(conn, {businessDate:'2026-06-30', sharedMode:false, shiftId:2})).toBe(72);
      expect(await reserveDailyOrderId(conn, {businessDate:'2026-07-01', sharedMode:false, shiftId:2})).toBe(1);
      await conn.commit();
    } finally { await conn.rollback(); conn.release(); }
  });

  it('returns the shared counter value from its single DML statement', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const captured = await captureQueries(conn, () => reserveDailyOrderId(conn, {
        businessDate: '2026-06-30'
      }));
      await conn.commit();

      expect(captured.value).toBe(1);
      expect(captured.statements).toHaveLength(1);
      expect(captured.statements[0]).toContain('LAST_INSERT_ID');
      expect(captured.statements).not.toContain('SELECT LAST_INSERT_ID() AS order_id');
    } finally { conn.release(); }
  });

  it('returns the shared duplicate-key increment from its single DML statement', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await reserveDailyOrderId(conn, { businessDate: '2026-06-30' });
      const captured = await captureQueries(conn, () => reserveDailyOrderId(conn, {
        businessDate: '2026-06-30'
      }));
      await conn.commit();

      expect(captured.value).toBe(2);
      expect(captured.statements).toHaveLength(1);
      expect(captured.statements[0]).toContain('ON DUPLICATE KEY UPDATE');
    } finally { conn.release(); }
  });

  it('serializes concurrent shared counter reservations', async () => {
    const first = await pool.getConnection();
    const second = await pool.getConnection();
    try {
      await first.beginTransaction();
      await second.beginTransaction();
      const firstValue = await reserveDailyOrderId(first, {
        businessDate: '2026-06-30'
      });
      let secondFinished = false;
      const secondReservation = reserveDailyOrderId(second, {
        businessDate: '2026-06-30'
      }).then(value => {
        secondFinished = true;
        return value;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(secondFinished).toBe(false);
      await first.commit();
      const secondValue = await secondReservation;
      await second.commit();

      expect([firstValue, secondValue]).toEqual([1, 2]);
    } finally {
      await first.rollback().catch(() => {});
      await second.rollback().catch(() => {});
      first.release();
      second.release();
    }
  });

  it('rollback un-burns the reserved number', async () => {
    const c1 = await pool.getConnection();
    try {
      await c1.beginTransaction();
      const n1 = await reserveDailyOrderId(c1, { businessDate: '2026-06-30' });
      expect(n1).toBe(1);
      await c1.rollback();
    } finally { c1.release(); }
    const c2 = await pool.getConnection();
    try {
      await c2.beginTransaction();
      const n2 = await reserveDailyOrderId(c2, { businessDate: '2026-06-30' });
      await c2.commit();
      expect(n2).toBe(1);
    } finally { c2.release(); }
  });

  it('rejects a missing business date', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await expect(reserveDailyOrderId(conn, {}))
        .rejects.toThrow();
      await conn.rollback();
    } finally { conn.release(); }
  });
});

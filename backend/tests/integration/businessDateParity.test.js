const pool = require('../../config/db');
const { businessLocalDateSql, getBusinessDate } = require('../../utils/businessDate');

const INSTANTS = [
    '2026-06-30T23:30:00Z',
    '2026-07-01T02:59:59Z',
    '2026-07-01T03:00:00Z',
    '2026-07-01T20:30:00Z',
];

describe('JS/SQL business-date parity', () => {
    it.each(INSTANTS)('agrees for %s', async (iso) => {
        const dbTimestamp = iso.slice(0, 19).replace('T', ' ');
        const [[row]] = await pool.query(
            `SELECT ${businessLocalDateSql('?')} AS business_date`,
            [dbTimestamp]
        );

        expect(row.business_date).toBe(getBusinessDate(new Date(iso)));
    });

    afterAll(async () => {
        await pool.end();
    });
});

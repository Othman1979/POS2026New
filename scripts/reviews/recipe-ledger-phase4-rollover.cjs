// Move only the named acceptance ingredients' test history to yesterday so the
// real server/browser can verify next-day opening without changing machine time.
require('./recipe-ledger-phase1-preload.cjs');
const pool = require('../../backend/config/db');
const { getBusinessDate } = require('../../backend/utils/businessDate');
const selected = JSON.parse(process.argv[2]);
(async () => {
    if (!Array.isArray(selected) || selected.length !== 2) throw new Error('Expected two acceptance ingredients.');
    for (const item of selected) {
        const [[stored]] = await pool.query('SELECT name FROM ingredients WHERE id=?', [item.id]);
        if (!stored || stored.name !== item.name || !/^(Chicken|Pepsi) (en|ar) [a-f0-9]{5}$/.test(stored.name)) {
            throw new Error('Acceptance ingredient identity mismatch.');
        }
    }
    const [result] = await pool.query(`UPDATE ingredient_movements
        SET business_date=DATE_SUB(?, INTERVAL 1 DAY), occurred_at=DATE_SUB(occurred_at, INTERVAL 1 DAY)
        WHERE ingredient_id IN (?)`, [getBusinessDate(), selected.map(item => item.id)]);
    console.log(JSON.stringify({ shiftedRows: result.affectedRows, currentBusinessDate: getBusinessDate() }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());

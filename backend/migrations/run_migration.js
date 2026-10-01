const pool = require('../config/db');

async function run() {
    const conn = await pool.getConnection();
    try {
        console.log("⚙️ Creating daily_sequences table...");
        await conn.query(`
            CREATE TABLE IF NOT EXISTS daily_sequences (
                sequence_date DATE NOT NULL,
                current_value INT NOT NULL DEFAULT 0,
                PRIMARY KEY (sequence_date)
            ) ENGINE=InnoDB;
        `);
        console.log("✅ daily_sequences table created / verified.");

        console.log("⚙️ Initializing today's sequence counter...");
        
        // Use the exact same date calculation as pos.js checkout route
        const dateOnly = new Date().toISOString().split('T')[0];
        console.log(`Checking existing orders for: ${dateOnly}`);
        
        const [maxOrderRows] = await conn.query(
            "SELECT MAX(order_id) as maxOrder FROM orders WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)",
            [dateOnly, dateOnly]
        );
        const maxOrder = maxOrderRows[0]?.maxOrder || 0;
        console.log(`Highest order_id found for today: ${maxOrder}`);

        await conn.query(`
            INSERT INTO daily_sequences (sequence_date, current_value)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, ?)
        `, [dateOnly, maxOrder, maxOrder]);
        
        console.log(`🎉 Sequence table successfully seeded for today (${dateOnly}) with current value: ${maxOrder}`);
    } catch (e) {
        console.error("❌ Migration failed:", e);
        process.exit(1);
    } finally {
        conn.release();
        await pool.end();
    }
}

run();

const pool = require('../config/db');
const logger = require('../config/logger');

async function run() {
    const conn = await pool.getConnection();
    try {
        console.log("Starting database migration: Add tax_rate to order_items...");
        
        // 1. Check if column already exists
        const [columns] = await conn.query("SHOW COLUMNS FROM order_items LIKE 'tax_rate'");
        if (columns.length > 0) {
            console.log("Column 'tax_rate' already exists in 'order_items'. Skipping ALTER TABLE.");
        } else {
            // Add column
            console.log("Adding column 'tax_rate' to 'order_items'...");
            await conn.query("ALTER TABLE order_items ADD COLUMN tax_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER price_at_sale");
            console.log("Column 'tax_rate' added successfully.");
        }

        // 2. Backfill existing records from products table
        console.log("Backfilling 'tax_rate' in 'order_items' using historical data from 'products'...");
        const [result] = await conn.query(`
            UPDATE order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            SET oi.tax_rate = COALESCE(p.tax_rate, 0.00)
            WHERE oi.tax_rate = 0.00 OR oi.tax_rate IS NULL
        `);
        console.log(`Backfill complete. Affected rows: ${result.affectedRows}`);
        console.log("Migration finished successfully.");
        process.exit(0);
    } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
    } finally {
        conn.release();
    }
}

run();

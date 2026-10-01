const fsPromises = require('fs').promises;

const path = require('path');
const db = require('./db');
const logger = require('./logger');
const { getSettings } = require('./settingsHelper');

let generation = null;
let pendingRebuild = false;

function generateStaticMenu() {
    if (generation) {
        pendingRebuild = true;
        return generation;
    }
    generation = (async () => {
        do {
            pendingRebuild = false;
            await rebuildStaticMenu();
        } while (pendingRebuild);
    })().finally(() => { generation = null; });
    return generation;
}

async function rebuildStaticMenu() {
    let temporaryPath;
    try {
        logger.info('Static digital menu cache regeneration started.');
        
        // 1. Get settings
        const storeInfo = await getSettings(db, ['store_name', 'store_address', 'store_phone', 'admin_language']);
        storeInfo.admin_language = ['en', 'ar'].includes(storeInfo.admin_language) ? storeInfo.admin_language : 'en';

        // 2. Get active categories
        const [categories] = await db.query(
            "SELECT id, name, parent_id FROM categories WHERE is_active = 1 AND price_list_root_id IS NULL"
        );

        // 3. Get active products
        const [products] = await db.query(
            `SELECT p.id, p.category_id, p.name, p.price, COALESCE(p.image, '') AS image,
                    p.background_color, p.is_available,
                    CASE
                      WHEN p.is_available = 1
                       AND (p.is_bundle = 0 OR NOT EXISTS (
                         SELECT 1
                         FROM product_bundle_items pbi
                         JOIN products child ON child.id = pbi.product_id
                         WHERE pbi.bundle_id = p.id
                           AND (child.is_active <> 1 OR child.is_available <> 1)
                       ))
                      THEN 1 ELSE 0
                    END AS can_sell
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.is_active = 1
               AND (p.category_id IS NULL OR c.price_list_root_id IS NULL)`
        );

        const payload = {
            success: true,
            store: storeInfo,
            categories,
            products
        };

        const distDir = path.join(__dirname, '..', '..', 'dist');
        await fsPromises.mkdir(distDir, { recursive: true });

        // Readers keep the previous complete JSON until the replacement is ready.
        const distPath = path.join(distDir, 'public_menu.json');
        temporaryPath = `${distPath}.${process.pid}.tmp`;
        await fsPromises.writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
        await fsPromises.rename(temporaryPath, distPath);

        logger.info({
            distPath,
            categoryCount: categories.length,
            productCount: products.length
        }, 'Static digital menu cache updated successfully.');
    } catch (error) {
        logger.error({ err: error }, 'Static digital menu cache generation failed.');
    } finally {
        if (temporaryPath) await fsPromises.unlink(temporaryPath).catch(() => {});
    }
}

// Wrapper to run it in background without blocking route response
function triggerStaticMenuGeneration() {
    generateStaticMenu().catch(err => {
        logger.error({ err }, 'Background static menu generation failed.');
    });
}

module.exports = {
    generateStaticMenu,
    triggerStaticMenuGeneration
};

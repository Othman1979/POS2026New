const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const logger = require('../config/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { triggerStaticMenuGeneration } = require('../config/menuCache');
const { invalidateCatalogCache, invalidateDashboardCache } = require('../config/cache');
const { getSettings, POS_CATALOG_SETTING_KEYS } = require('../config/settingsHelper');
const { validateCashAmount } = require('../services/CashValidation');
const { lockJofotaraPolicy, validateJofotaraCatalogRates } = require('../services/JofotaraService');
const { normalizeJofotaraTaxCategory } = require('../config/taxRegistration');
const { appendAuditEvent } = require('../services/auditEvents');

const uploadDir = process.env.POSAPP_UPLOAD_DIR || path.join(__dirname, '../../uploads');
const backupDir = process.env.POSAPP_BACKUP_DIR || path.join(__dirname, '../../backup');

const sendError = (res, status, message) => {
    let msg = message;
    const isDbMessage = typeof msg === 'string' && (
        msg.includes('ER_') ||
        msg.includes('SQLSTATE') ||
        msg.includes('mysql') ||
        msg.includes('SQL Error') ||
        (msg.includes('Table') && msg.includes('exist')) ||
        (msg.includes('table') && msg.includes('exist'))
    );
    if ((status === 500 && process.env.NODE_ENV === 'production') || isDbMessage) {
        msg = "An internal server error occurred.";
    }
    return res.status(status).json({ success: false, message: msg });
};
const sendSuccess = (res, data) => res.status(200).json({ success: true, ...data });
const logSystemRouteError = (req, err, message) => {
    logger.error({
        err,
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role
    }, message);
};

// GET /api/system/settings
router.get('/settings', requireAuth, async (req, res) => {
    try {
        const settingsData = await getSettings(pool);
        // Non-sensitive settings every POS role needs (catalog, stock and service-charge rules).
        const posSettings = {
            tables_enabled: settingsData['tables_enabled'] ?? '0',
            stock_enabled: settingsData['stock_enabled'] ?? '0',
            recipe_ledger_enabled: settingsData['recipe_ledger_enabled'] ?? '0',
            service_charge_enabled: settingsData['service_charge_enabled'] ?? '0',
            service_charge_percentage: settingsData['service_charge_percentage'] ?? '10',
            auto_apply_service_charge: settingsData['auto_apply_service_charge'] ?? '0'
        };
        if (req.user.role === 'call_center') {
            return sendSuccess(res, {
                store_name: settingsData['store_name'] ?? 'POS',
                store_icon: settingsData['store_icon'] ?? null,
                admin_language: settingsData['admin_language'] ?? 'en',
                ...posSettings
            });
        }
        const client_ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '').trim();

        return sendSuccess(res, {
            client_ip,
            ...posSettings,
            barcode_enabled: settingsData['barcode_enabled'] ?? '0',
            print_method: settingsData['print_method'] ?? 'backend',
            store_name: settingsData['store_name'] ?? 'POS',
            store_address: settingsData['store_address'] ?? '123 Main Street',
            store_phone: settingsData['store_phone'] ?? '+1 234 567 8900',
            jofotara_enabled: settingsData['jofotara_enabled'] ?? '0',
            tax_inclusive_pricing: settingsData['tax_inclusive_pricing'] ?? '0',
            tax_registration_type: settingsData['tax_registration_type'] ?? 'sales_tax',
            jofotara_sales_tax_seller_tax_number: settingsData['jofotara_sales_tax_seller_tax_number'] ?? '',
            jofotara_income_tax_seller_tax_number: settingsData['jofotara_income_tax_seller_tax_number'] ?? '',
            table_mode: settingsData['table_mode'] ?? 'fixed',
            receipt_config: settingsData['receipt_config'] ?? null,
            use_invoice_no_only: settingsData['use_invoice_no_only'] ?? '0',
            order_type_numbering: settingsData['order_type_numbering'] ?? '0',
            admin_language: settingsData['admin_language'] ?? 'en',
            spooler_address: settingsData['spooler_address'] ?? 'http://127.0.0.1:8080',
            low_stock_threshold: settingsData['low_stock_threshold'] ?? '3',
            service_charge_tax_rate: settingsData['service_charge_tax_rate'] ?? '0',
            service_charge_jofotara_tax_category: settingsData['service_charge_jofotara_tax_category'] ?? 'O',
            default_order_type_id: settingsData['default_order_type_id'] ?? '',
            y_order_type_id: settingsData['y_order_type_id'] ?? '',
            store_icon: settingsData['store_icon'] ?? null,
            duplicate_customer_receipt: settingsData['duplicate_customer_receipt'] ?? '0',
            first_shift_starting_cash: settingsData['first_shift_starting_cash'] ?? '0',
            quick_numpad_mode: settingsData['quick_numpad_mode'] ?? '0',
            quantity_presets_enabled: settingsData['quantity_presets_enabled'] ?? '1'
        });
    } catch (e) {
        logSystemRouteError(req, e, 'System settings fetch failed.');
        sendError(res, 500, e.message);
    }
});

// POST /api/system/settings
router.post('/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = req.body;
        if (!data) return sendError(res, 400, "Invalid payload received.");
        if (data.order_type_numbering !== undefined && !['0', '1'].includes(data.order_type_numbering)) {
            return sendError(res, 400, 'Invalid order type numbering value.');
        }
        const securityOwnedKeys = ['staff_device_auth_mode', 'webauthn_bootstrap_consumed'];
        if (securityOwnedKeys.some((key) => Object.prototype.hasOwnProperty.call(data, key))) {
            return sendError(res, 400, 'Device access settings must be changed from Device access.');
        }
        if (data.admin_language !== undefined && !['en', 'ar'].includes(data.admin_language)) {
            data.admin_language = 'en';
        }
        if (data.duplicate_customer_receipt !== undefined && !['0', '1'].includes(data.duplicate_customer_receipt)) {
            data.duplicate_customer_receipt = '0';
        }
        if (data.quick_numpad_mode !== undefined && !['0', '1'].includes(data.quick_numpad_mode)) {
            return sendError(res, 400, 'Invalid quick numpad mode value.');
        }
        if (data.quantity_presets_enabled !== undefined && !['0', '1'].includes(data.quantity_presets_enabled)) {
            return sendError(res, 400, 'Invalid quantity presets value.');
        }
        if (data.stock_enabled !== undefined && !['0', '1'].includes(data.stock_enabled)) {
            return sendError(res, 400, 'Invalid stock tracking value.');
        }
        if (data.recipe_ledger_enabled !== undefined && !['0', '1'].includes(data.recipe_ledger_enabled)) {
            return sendError(res, 400, 'Invalid recipe ledger value.');
        }
        if (data.first_shift_starting_cash !== undefined) {
            const cash = validateCashAmount(data.first_shift_starting_cash);
            if (!cash.valid) return sendError(res, 400, cash.message);
            data.first_shift_starting_cash = String(cash.value);
        }
        if (data.auto_apply_service_charge !== undefined && !['0', '1'].includes(data.auto_apply_service_charge)) {
            return sendError(res, 400, "Invalid automatic table service-charge value.");
        }
        if (data.service_charge_enabled === '0' || data.tables_enabled === '0') {
            data.auto_apply_service_charge = '0';
        }
        if (data.default_order_type_id !== undefined) {
            const rawDefaultId = data.default_order_type_id;
            if (rawDefaultId === '' || rawDefaultId === null) {
                data.default_order_type_id = '';
            } else {
                const defaultId = Number(rawDefaultId);
                if (!Number.isInteger(defaultId) || defaultId <= 0) {
                    return sendError(res, 400, "Invalid default order type.");
                }
                const [[orderType]] = await pool.query(
                    "SELECT id FROM order_types WHERE id = ? AND is_active = 1 LIMIT 1",
                    [defaultId]
                );
                if (!orderType) return sendError(res, 400, "Default order type is not available.");
                data.default_order_type_id = String(defaultId);
            }
        }
        if (data.y_order_type_id !== undefined) {
            const rawYId = data.y_order_type_id;
            if (rawYId === '' || rawYId === null) {
                data.y_order_type_id = '';
            } else {
                const yId = Number(rawYId);
                if (!Number.isInteger(yId) || yId <= 0) {
                    return sendError(res, 400, 'Invalid Y order type.');
                }
                const [[orderType]] = await pool.query(
                    'SELECT id FROM order_types WHERE id = ? AND is_active = 1 LIMIT 1',
                    [yId]
                );
                if (!orderType) return sendError(res, 400, 'Y order type is not available.');
                data.y_order_type_id = String(yId);
            }
        }
        if (data.default_order_type_id !== undefined || data.y_order_type_id !== undefined) {
            const currentTypes = await getSettings(pool, ['default_order_type_id', 'y_order_type_id']);
            const effectiveDefault = data.default_order_type_id !== undefined
                ? data.default_order_type_id
                : (currentTypes.default_order_type_id || '');
            const effectiveY = data.y_order_type_id !== undefined
                ? data.y_order_type_id
                : (currentTypes.y_order_type_id || '');
            if (effectiveDefault && effectiveY && String(effectiveDefault) === String(effectiveY)) {
                return sendError(res, 400, 'The default and Y order types must be different.');
            }
        }

        const numInRange = (v, lo, hi) => {
            if (v === undefined) return true;            // key not sent -> untouched
            const n = Number(v);
            return Number.isFinite(n) && n >= lo && n <= hi;
        };
        const decimalPlaces = value => {
            const match = String(value).trim().match(/^[-+]?\d+(?:\.(\d+))?$/);
            return match ? (match[1]?.length || 0) : Infinity;
        };
        if (!numInRange(data.service_charge_percentage, 0, 100)) return sendError(res, 400, "Invalid service charge percentage.");
        if (!numInRange(data.service_charge_tax_rate, 0, 100)) return sendError(res, 400, "Invalid service charge tax rate.");
        if (data.service_charge_percentage !== undefined && decimalPlaces(data.service_charge_percentage) > 4) {
            return sendError(res, 400, "Service charge percentage supports at most 4 decimal places.");
        }
        if (data.service_charge_tax_rate !== undefined && decimalPlaces(data.service_charge_tax_rate) > 2) {
            return sendError(res, 400, "Service charge tax rate supports at most 2 decimal places.");
        }
        if (data.service_charge_tax_rate !== undefined || data.service_charge_jofotara_tax_category !== undefined) {
            const currentServiceTax = await getSettings(pool, ['service_charge_tax_rate', 'service_charge_jofotara_tax_category']);
            const rate = data.service_charge_tax_rate !== undefined
                ? Number(data.service_charge_tax_rate)
                : Number(currentServiceTax.service_charge_tax_rate || 0);
            try {
                data.service_charge_jofotara_tax_category = data.service_charge_jofotara_tax_category !== undefined
                    ? normalizeJofotaraTaxCategory(data.service_charge_jofotara_tax_category, rate)
                    : normalizeJofotaraTaxCategory(undefined, rate);
            } catch (error) {
                return sendError(res, 400, error.message);
            }
        }
        if (!numInRange(data.low_stock_threshold, 0, 1000000)) return sendError(res, 400, "Invalid low stock threshold.");
        if (data.table_mode !== undefined && !['fixed', 'dynamic'].includes(data.table_mode)) return sendError(res, 400, "Invalid table mode.");
        if (data.print_method !== undefined && !['browser', 'backend'].includes(data.print_method)) return sendError(res, 400, "Invalid print method.");

        const allowed_keys = [
            'barcode_enabled', 'print_method', 'store_name', 'store_address',
            'store_phone', 'tables_enabled', 'stock_enabled', 'recipe_ledger_enabled', 'table_mode',
            'tax_inclusive_pricing', 'receipt_config', 'use_invoice_no_only', 'order_type_numbering', 'spooler_address',
            'admin_language', 'low_stock_threshold', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate', 'service_charge_jofotara_tax_category', 'auto_apply_service_charge',
            'duplicate_customer_receipt', 'default_order_type_id', 'y_order_type_id', 'first_shift_starting_cash', 'quick_numpad_mode',
            'quantity_presets_enabled'
        ];
        const changedKeys = [];
        const batchValues = [];
        const batchParams = [];

        for (const key of allowed_keys) {
            if (data[key] !== undefined) {
                batchValues.push('(?, ?)');
                batchParams.push(key, data[key]);
                changedKeys.push(key);
            }
        }

        if (batchValues.length > 0) {
            const servicePolicyChanged = changedKeys.includes('service_charge_enabled') || changedKeys.includes('service_charge_tax_rate') || changedKeys.includes('service_charge_jofotara_tax_category');
            const recipeLedgerChanged = changedKeys.includes('recipe_ledger_enabled');
            const stockPolicyChanged = changedKeys.includes('stock_enabled');
            if (servicePolicyChanged || recipeLedgerChanged || stockPolicyChanged) {
                const conn = await pool.getConnection();
                try {
                    await conn.beginTransaction();
                    // Settings changes are rare. Serialize their policy rows in
                    // one order before touching balances or product identities.
                    await conn.query('SELECT setting_key FROM settings ORDER BY setting_key FOR UPDATE');
                    if (stockPolicyChanged) {
                        const [policy] = await conn.query("SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('stock_enabled','stock_tracking_paused')");
                        const previous = Object.fromEntries(policy.map(row => [row.setting_key,row.setting_value]));
                        const pausing = previous.stock_enabled === '1' && data.stock_enabled === '0';
                        const resuming = previous.stock_tracking_paused === '1' && data.stock_enabled === '1';
                        if (pausing || resuming) {
                            // A pause cannot leave a known balance that silently
                            // ignores subsequent untracked sales. Keep history and
                            // mappings; a later physical count restores certainty.
                            await conn.query('SELECT id FROM products ORDER BY id FOR UPDATE');
                            await conn.query('UPDATE products SET stock=NULL,stock_version=stock_version+1');
                            await conn.query(`UPDATE stock_balances b JOIN product_stock_links l ON l.stock_item_id=b.stock_item_id
                                SET b.quantity_known=0,b.version=b.version+1`);
                            await conn.query(`UPDATE stock_items s JOIN product_stock_links l ON l.stock_item_id=s.id SET s.attention=IF(s.is_active=1,'unknown','inactive')`);
                            await conn.query("INSERT INTO settings(setting_key,setting_value) VALUES ('stock_tracking_paused',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [pausing?'1':'0']);
                        }
                    }
                    if (servicePolicyChanged) {
                        const currentPolicy = await lockJofotaraPolicy(conn);
                        const changes = Object.fromEntries(batchParams.reduce((pairs, value, index) => {
                            if (index % 2 === 1) pairs.push([batchParams[index - 1], value]);
                            return pairs;
                        }, []));
                        const nextPolicy = { ...currentPolicy, ...changes };
                        await validateJofotaraCatalogRates(conn, nextPolicy);
                    }
                    let previousLedgerValue;
                    if (recipeLedgerChanged) {
                        const [[current]] = await conn.query(
                            "SELECT setting_value FROM settings WHERE setting_key='recipe_ledger_enabled' FOR UPDATE"
                        );
                        previousLedgerValue = current?.setting_value ?? '0';
                        const [[pauseState]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key='recipe_tracking_paused'");
                        const pausing = previousLedgerValue === '1' && data.recipe_ledger_enabled === '0';
                        const resuming = pauseState?.setting_value === '1' && data.recipe_ledger_enabled === '1';
                        if (pausing || resuming) {
                            // Shared recipe stock also invalidates product count forms.
                            await conn.query('SELECT id FROM products ORDER BY id FOR UPDATE');
                            await conn.query('SELECT id FROM ingredients ORDER BY id FOR UPDATE');
                            await conn.query(`UPDATE products p JOIN product_stock_links pl ON pl.product_id=p.id
                                JOIN ingredients il ON il.stock_item_id=pl.stock_item_id
                                SET p.stock=NULL,p.stock_version=p.stock_version+1`);
                            await conn.query('UPDATE ingredients SET working_quantity_known=0,working_initialized=1,updated_at=updated_at');
                            await conn.query(`UPDATE stock_balances b JOIN ingredients l ON l.stock_item_id=b.stock_item_id
                                SET b.quantity_known=0,b.version=b.version+1`);
                            await conn.query(`UPDATE stock_items s JOIN ingredients l ON l.stock_item_id=s.id SET s.attention=IF(s.is_active=1,'unknown','inactive')`);
                            await conn.query("INSERT INTO settings(setting_key,setting_value) VALUES ('recipe_tracking_paused',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [pausing?'1':'0']);
                        }
                    }
                    await conn.query(
                        `INSERT INTO settings (setting_key, setting_value) VALUES ${batchValues.join(', ')}
                         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                        batchParams
                    );
                    if (recipeLedgerChanged && previousLedgerValue !== data.recipe_ledger_enabled) {
                        await appendAuditEvent(conn, {
                            eventType: 'recipe_ledger_toggled',
                            userId: req.user?.id || null,
                            entityType: 'setting',
                            oldValue: { enabled: previousLedgerValue },
                            newValue: { enabled: data.recipe_ledger_enabled },
                            ipAddress: req.ip || null
                        });
                    }
                    await conn.commit();
                } catch (error) {
                    await conn.rollback();
                    throw error;
                } finally {
                    conn.release();
                }
            } else {
                // Single atomic batch: inserts new keys, updates existing ones.
                // Eliminates the N×(SELECT + UPDATE/INSERT) loop and closes the
                // check-then-act race if two admin tabs save settings simultaneously.
                await pool.query(
                    `INSERT INTO settings (setting_key, setting_value) VALUES ${batchValues.join(', ')}
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                    batchParams
                );
            }
        }

        // Recipe pause/resume changes shared product balances even though the
        // recipe flag itself is not projected into catalog settings.
        if (changedKeys.some(key => key === 'recipe_ledger_enabled' || POS_CATALOG_SETTING_KEYS.includes(key))) invalidateCatalogCache();
        if (changedKeys.some(key => ['tables_enabled', 'stock_enabled', 'recipe_ledger_enabled', 'low_stock_threshold'].includes(key))) invalidateDashboardCache();
        if (changedKeys.some(key => ['store_name', 'store_address', 'store_phone', 'admin_language'].includes(key))) triggerStaticMenuGeneration();
        if (req.io && changedKeys.length > 0) {
            req.io.to('staff').emit('settings_changed', { keys: changedKeys });
            logger.info({
                userId: req.user?.id,
                role: req.user?.role,
                keys: changedKeys
            }, 'System settings changed; notified connected clients.');
        }
        return sendSuccess(res, { message: "Settings saved successfully." });
    } catch (e) {
        if (e.statusCode) return sendError(res, e.statusCode, e.message, e.publicCode);
        logSystemRouteError(req, e, 'System settings update failed.');
        sendError(res, 500, e.message);
    }
});

// GET /api/system/public_preferences
router.get('/public_preferences', async (req, res) => {
    try {
        const settingsData = await getSettings(pool, ['admin_language', 'store_name', 'store_icon']);

        return sendSuccess(res, {
            admin_language: ['en', 'ar'].includes(settingsData.admin_language) ? settingsData.admin_language : 'en',
            store_name: settingsData.store_name ?? 'POS',
            store_icon: settingsData.store_icon ?? null
        });
    } catch (e) {
        logSystemRouteError(req, e, 'Public preferences fetch failed.');
        return sendError(res, 500, "Public preferences temporarily unavailable.");
    }
});


// GET /api/system/backup-status (requireAdmin)
router.get('/backup-status', requireAuth, requireAdmin, async (req, res) => {
    const statusPath = path.join(backupDir, 'last_status.json');
    try {
        let raw;
        try {
            raw = await fs.promises.readFile(statusPath, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return sendSuccess(res, { configured: false, message: 'No backup has run yet.' });
            }
            throw e;
        }
        const status = JSON.parse(raw);

        // Calculate hours since last backup
        const hoursSince = status.timestamp
            ? Math.round((Date.now() - new Date(status.timestamp).getTime()) / 3600000)
            : null;

        return sendSuccess(res, { configured: true, ...status, hours_since_backup: hoursSince });
    } catch (e) {
        logSystemRouteError(req, e, 'Failed to read backup status file.');
        return sendError(res, 500, e.message);
    }
});

const multer = require('multer');

// Helper to delete any old store_icon.* files to avoid extension mismatch duplicates
async function deleteExistingIcons() {
    const dir = uploadDir;
    let files;
    try {
        files = await fs.promises.readdir(dir);
    } catch (e) {
        if (e.code === 'ENOENT') {
            await fs.promises.mkdir(dir, { recursive: true });
            return;
        }
        throw e;
    }
    await Promise.all(
        files
            .filter(f => f.startsWith('store_icon.'))
            .map(f => fs.promises.unlink(path.join(dir, f)).catch(err =>
                logger.error({ err, file: f }, 'Failed to delete existing icon file.')
            ))
    );
}

// In-memory upload so we can sniff real bytes before touching disk/DB.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 } // 1 MB
}).single('icon');

// Map sniffed magic bytes -> canonical, safe extension. Extension is NEVER
// taken from the client filename (kills path-traversal + .php/.svg RCE/XSS).
function sniffImageExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null; // GIF/SVG/PHP/HTML/anything else -> rejected
}

// POST /api/system/brand-icon (requireAuth, requireAdmin)
router.post('/brand-icon', requireAuth, requireAdmin, async (req, res) => {
    const uploadErr = await new Promise(resolve => upload(req, res, resolve));
    if (uploadErr) return sendError(res, 400, uploadErr.message);
    if (!req.file) return sendError(res, 400, 'No file uploaded.');

    const ext = sniffImageExt(req.file.buffer);
    if (!ext) return sendError(res, 400, 'Only PNG, JPG, ICO, and WEBP image files are allowed.');

    // Validate passed — now (and only now) remove old icons and write the new one.
    try {
        await deleteExistingIcons();
    } catch (err) {
        logSystemRouteError(req, err, 'Error cleaning old icons');
    }

    const filename = `store_icon.${ext}`;
    const relativePath = `/uploads/${filename}`;
    try {
        const dir = uploadDir;
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, filename), req.file.buffer);

        await pool.query(
            `INSERT INTO settings (setting_key, setting_value) VALUES ('store_icon', ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [relativePath]
        );

        invalidateCatalogCache();
        invalidateDashboardCache();
        triggerStaticMenuGeneration();
        if (req.io) req.io.to('staff').emit('settings_changed', { keys: ['store_icon'] });

        return sendSuccess(res, { store_icon: relativePath });
    } catch (dbErr) {
        logSystemRouteError(req, dbErr, 'Failed to save store icon.');
        return sendError(res, 500, dbErr.message);
    }
});

// DELETE /api/system/brand-icon (requireAuth, requireAdmin)
router.delete('/brand-icon', requireAuth, requireAdmin, async (req, res) => {
    try {
        await deleteExistingIcons();

        await pool.query("DELETE FROM settings WHERE setting_key = 'store_icon'");

        invalidateCatalogCache();
        invalidateDashboardCache();
        triggerStaticMenuGeneration();

        if (req.io) {
            req.io.to('staff').emit('settings_changed', { keys: ['store_icon'] });
        }

        return sendSuccess(res, { message: "Icon removed successfully." });
    } catch (e) {
        logSystemRouteError(req, e, 'Failed to remove store icon.');
        return sendError(res, 500, e.message);
    }
});

module.exports = router;

const net = require('net');
const express = require('express');
const router = express.Router();
const { 
    pool, 
    sendSuccess, 
    sendError, 
    logAdminRouteError 
} = require('./helpers');
const { normalizePrinterCapability, removeStaffPrinterStatus } = require('../../services/printerStatus');
const { requestAgentDrain, replaceAgent } = require('../../services/spoolerAgents');
const { withPrinterConfiguration, validatePrinterOwnership } = require('../../services/printerOwnership');

function normalizeSpoolerId(value) {
    const spoolerId = String(value || 'primary').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(spoolerId) ? spoolerId : null;
}

// ALL /api/admin/order_types
router.all('/order_types', async (req, res) => {
    try {
        if (req.method === 'GET') {
            const [data] = await pool.query(`
                SELECT ot.*,
                    CASE WHEN ot.id = CAST(s.setting_value AS UNSIGNED) THEN 1 ELSE 0 END AS is_default
                FROM order_types ot
                LEFT JOIN settings s ON s.setting_key = 'default_order_type_id'
                ORDER BY ot.id ASC
            `);
            return sendSuccess(res, { data });
        } else if (req.method === 'POST') {
            const name = (req.body.name || '').trim();
            if (!name) return sendError(res, 400, "Order type name is required.");
            const requires_hash = req.body.requires_hash ? 1 : 0;
            const is_deferred_settlement = req.body.is_deferred_settlement ? 1 : 0;
            await pool.query("INSERT INTO order_types (name, requires_hash, is_deferred_settlement) VALUES (?, ?, ?)", [name, requires_hash, is_deferred_settlement]);
            req.io?.to('staff').emit('settings_changed', { keys: ['order_types'] });
            return sendSuccess(res, { message: "Order Type added." });
        } else if (req.method === 'PUT') {
            const name = (req.body.name || '').trim();
            if (!name) return sendError(res, 400, "Order type name is required.");
            if (!req.body.id) return sendError(res, 400, "Order type id is required.");
            const requires_hash = req.body.requires_hash ? 1 : 0;
            const is_deferred_settlement = req.body.is_deferred_settlement ? 1 : 0;
            await pool.query("UPDATE order_types SET name=?, requires_hash=?, is_deferred_settlement=? WHERE id=?", [name, requires_hash, is_deferred_settlement, req.body.id]);
            req.io?.to('staff').emit('settings_changed', { keys: ['order_types'] });
            return sendSuccess(res, { message: "Order Type updated." });
        } else if (req.method === 'DELETE') {
            if (!req.body.id) return sendError(res, 400, "Order type id is required.");
            const [[history]] = await pool.query(`
                SELECT
                    EXISTS(
                        SELECT 1
                          FROM orders
                         WHERE order_type_id = ?
                    ) AS has_orders,
                    EXISTS(
                        SELECT 1
                          FROM platform_remittances
                         WHERE order_type_id = ?
                    ) AS has_platform_remittances
            `, [req.body.id, req.body.id]);
            if (Number(history.has_orders) === 1 || Number(history.has_platform_remittances) === 1) {
                return sendError(
                    res,
                    409,
                    "This order type has historical orders or reconciliation records and cannot be deleted. Deactivate it instead.",
                    'ORDER_TYPE_HAS_HISTORY'
                );
            }
            await pool.query("DELETE FROM order_types WHERE id = ?", [req.body.id]);
            await pool.query(
                "UPDATE settings SET setting_value = '' WHERE setting_key IN ('default_order_type_id', 'y_order_type_id') AND setting_value = ?",
                [String(req.body.id)]
            );
            req.io?.to('staff').emit('settings_changed', { keys: ['order_types'] });
            return sendSuccess(res, { message: "Order Type deleted." });
        } else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

// ALL /api/admin/printers
router.all('/printers', async (req, res) => {
    try {
        if (req.method === 'GET') {
            const [printers] = await pool.query("SELECT * FROM printers ORDER BY role ASC, name ASC");
            if (printers.length > 0) {
                const printerIds = printers.map(p => p.id);
                const [cats] = await pool.query(
                    `SELECT printer_id, category_id FROM printer_categories WHERE printer_id IN (${printerIds.map(() => '?').join(',')})`,
                    printerIds
                );
                const categoriesMap = {};
                for (const cat of cats) {
                    if (!categoriesMap[cat.printer_id]) {
                        categoriesMap[cat.printer_id] = [];
                    }
                    categoriesMap[cat.printer_id].push(cat.category_id);
                }
                for (const p of printers) {
                    p.categories = categoriesMap[p.id] || [];
                }
            }
            return sendSuccess(res, { data: printers });
        } else if (req.method === 'POST') {
            const name = (req.body.name || '').trim();
            if (!name) return sendError(res, 400, "Printer name is required.");
            if (!['receipt', 'kitchen'].includes(req.body.role)) return sendError(res, 400, "Invalid printer role.");
            if (!['windows', 'network'].includes(req.body.type)) return sendError(res, 400, "Invalid connection type.");
            const networkIp = req.body.type === 'network' ? String(req.body.network_ip || '').trim() : null;
            const networkPort = req.body.type === 'network' ? Number(req.body.network_port) : null;
            if (req.body.type === 'network') {
                if (!networkIp) return sendError(res, 400, "Network IP is required.");
                if (net.isIP(networkIp) === 0) return sendError(res, 400, "Invalid network printer IP address.");
                const port = Number(req.body.network_port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "Invalid network port.");
            }
            if (req.body.type === 'windows' && !req.body.windows_name) return sendError(res, 400, "Windows printer name is required.");

            const spoolerId = normalizeSpoolerId(req.body.spooler_id);
            if (!spoolerId) return sendError(res, 400, "Invalid print station id.");
            const statusCapability = normalizePrinterCapability(req.body.status_capability);
            await withPrinterConfiguration(pool, async conn => {
                await validatePrinterOwnership(conn, { ...req.body, network_ip: networkIp, network_port: networkPort, spooler_id: spoolerId });
                const [result] = await conn.query(
                    "INSERT INTO printers (name, role, type, network_ip, network_port, windows_name, assigned_ips, spooler_id, status_capability) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                    [name, req.body.role, req.body.type, networkIp, networkPort, req.body.windows_name ?? null, spoolerId, statusCapability]
                );
                const printer_id = result.insertId;
                if (req.body.role === 'kitchen' && req.body.categories && req.body.categories.length) {
                    const catValues = req.body.categories.map(cat_id => [printer_id, cat_id]);
                    await conn.query("INSERT INTO printer_categories (printer_id, category_id) VALUES ?", [catValues]);
                }
            });
            return sendSuccess(res, { message: "Printer added." });
        } else if (req.method === 'PUT') {
            const name = (req.body.name || '').trim();
            if (!name) return sendError(res, 400, "Printer name is required.");
            if (!['receipt', 'kitchen'].includes(req.body.role)) return sendError(res, 400, "Invalid printer role.");
            if (!['windows', 'network'].includes(req.body.type)) return sendError(res, 400, "Invalid connection type.");
            const networkIp = req.body.type === 'network' ? String(req.body.network_ip || '').trim() : null;
            const networkPort = req.body.type === 'network' ? Number(req.body.network_port) : null;
            if (req.body.type === 'network') {
                if (!networkIp) return sendError(res, 400, "Network IP is required.");
                if (net.isIP(networkIp) === 0) return sendError(res, 400, "Invalid network printer IP address.");
                const port = Number(req.body.network_port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "Invalid network port.");
            }
            if (req.body.type === 'windows' && !req.body.windows_name) return sendError(res, 400, "Windows printer name is required.");
            if (!req.body.id) return sendError(res, 400, "Printer id is required.");

            const spoolerId = normalizeSpoolerId(req.body.spooler_id);
            if (!spoolerId) return sendError(res, 400, "Invalid print station id.");
            const statusCapability = normalizePrinterCapability(req.body.status_capability);
            await withPrinterConfiguration(pool, async conn => {
                await validatePrinterOwnership(conn, { ...req.body, network_ip: networkIp, network_port: networkPort, spooler_id: spoolerId }, req.body.id);
                await conn.query(
                    // last_printed_at is assigned first, against the old endpoint columns: a printer moved
                    // to another device or station has not printed there yet.
                    `UPDATE printers
                        SET last_printed_at = IF(type <=> ? AND INET6_ATON(network_ip) <=> INET6_ATON(?) AND network_port <=> ? AND windows_name <=> ? AND spooler_id <=> ?, last_printed_at, NULL),
                            name=?, role=?, type=?, network_ip=?, network_port=?, windows_name=?, assigned_ips=NULL, spooler_id=?, status_capability=?
                      WHERE id=?`,
                    [req.body.type, networkIp, networkPort, req.body.windows_name ?? null, spoolerId,
                        name, req.body.role, req.body.type, networkIp, networkPort, req.body.windows_name ?? null, spoolerId, statusCapability, req.body.id]
                );
                await conn.query("DELETE FROM printer_categories WHERE printer_id = ?", [req.body.id]);
                if (req.body.role === 'kitchen' && req.body.categories && req.body.categories.length) {
                    const catValues = req.body.categories.map(cat_id => [req.body.id, cat_id]);
                    await conn.query("INSERT INTO printer_categories (printer_id, category_id) VALUES ?", [catValues]);
                }
            });
            removeStaffPrinterStatus(req.body.id);
            // Other admin screens show this printer's endpoint and last printed time.
            try { req.io?.to('staff').emit('print_queue_updated', { source: 'printer_config' }); } catch (_) {}
            return sendSuccess(res, { message: "Printer updated." });
        } else if (req.method === 'DELETE') {
            if (!req.body.id) return sendError(res, 400, "Printer id is required.");
            await withPrinterConfiguration(pool, async conn => {
                await validatePrinterOwnership(conn, null, req.body.id);
                await conn.query("DELETE FROM printer_categories WHERE printer_id = ?", [req.body.id]);
                await conn.query("DELETE FROM printers WHERE id = ?", [req.body.id]);
            });
            removeStaffPrinterStatus(req.body.id);
            return sendSuccess(res, { message: "Printer deleted." });
        } else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        logAdminRouteError(req, e);
        if (e.statusCode === 409) return sendError(res, 409, e.message, e.code);
        if (e.code === 'ER_DUP_ENTRY') {
            return sendError(res, 409, "This physical printer is already configured for this role.");
        }
        sendError(res, 500, e.message);
    }
});

router.post('/spooler-agents/:spoolerId/drain', async (req, res, next) => {
    try {
        const result = await requestAgentDrain(pool, {
            spoolerId: req.params.spoolerId,
            actorUserId: req.user?.id ?? null
        });
        res.json({ success: true, agent_id: result.agentId, status: result.status });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
        }
        next(error);
    }
});

router.post('/spooler-agents/:spoolerId/replace', async (req, res, next) => {
    try {
        if (req.body?.force === true && req.body?.confirm_old_terminal_stopped !== true) {
            return res.status(400).json({
                success: false,
                code: 'confirmation_required',
                message: 'Forced replacement requires confirmation that the old terminal is stopped.'
            });
        }
        const result = await replaceAgent(pool, {
            spoolerId: req.params.spoolerId,
            force: req.body?.force === true,
            actorUserId: req.user?.id ?? null
        });
        res.json({
            success: true,
            revoked_agent_id: result.revokedAgentId,
            terminalized_count: result.terminalizedCount
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
        }
        next(error);
    }
});

module.exports = router;

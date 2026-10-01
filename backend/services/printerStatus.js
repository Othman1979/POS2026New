const CAPABILITY_VALUES = new Set(['write_only', 'escpos_status', 'snmp_status']);
const DEVICE_STATUS_VALUES = new Set([
    'unknown',
    'ok',
    'offline',
    'paper_low',
    'paper_out',
    'cover_open',
    'jammed',
    'error'
]);
const MAX_HEALTH_PRINTERS = 64;

function normalizePrinterCapability(value) {
    return CAPABILITY_VALUES.has(value) ? value : 'write_only';
}

function normalizeDeviceStatus(value) {
    return DEVICE_STATUS_VALUES.has(value) ? value : 'unknown';
}

function normalizeStatusSource(value, fallback = 'spooler') {
    const source = String(value || fallback).trim().slice(0, 32);
    return source || fallback;
}

function addWarning(warnings, code) {
    if (!warnings.includes(code)) warnings.push(code);
}

const staffPrinterStatuses = Object.create(null);
let staffPrinterHealthListener = null;

function getStaffPrinterStatuses() {
    const snapshot = Object.create(null);
    for (const [id, value] of Object.entries(staffPrinterStatuses)) {
        snapshot[id] = { ...value };
    }
    return snapshot;
}

function setStaffPrinterHealthListener(listener) {
    staffPrinterHealthListener = typeof listener === 'function' ? listener : null;
}

function notifyStaffPrinterHealth() {
    try {
        staffPrinterHealthListener?.(getStaffPrinterStatuses());
    } catch (_) {
        // Health publication must never turn a committed printer update into an API failure.
    }
}

function applyStaffPrinterStatus(entry) {
    const id = Number(entry?.id ?? entry?.printer_id);
    if (!Number.isInteger(id) || id < 1) return null;
    const deviceStatus = normalizeDeviceStatus(entry.device_status || (entry.online ? 'ok' : 'offline'));
    const current = staffPrinterStatuses[id];
    staffPrinterStatuses[id] = {
        id,
        name: String(entry.name || current?.name || ''),
        online: entry.online != null ? !!entry.online : deviceStatus !== 'offline',
        device_status: deviceStatus,
        details: entry.details != null ? String(entry.details) : (current?.details || ''),
        lastChecked: new Date()
    };
    return staffPrinterStatuses[id];
}

function publishAcceptedStaffPrinterHealth(entries) {
    const accepted = Array.isArray(entries) ? entries : [];
    if (accepted.length === 0) return;
    for (const entry of accepted) applyStaffPrinterStatus(entry);
    notifyStaffPrinterHealth();
}

function removeStaffPrinterStatus(printerId) {
    const id = Number(printerId);
    if (!Number.isInteger(id) || id < 1 || !staffPrinterStatuses[id]) return false;
    delete staffPrinterStatuses[id];
    notifyStaffPrinterHealth();
    return true;
}

/**
 * Apply one agent's bounded printer snapshot without allowing cross-station writes.
 * The ownership read and CASE update are deliberately the only database statements.
 */
async function updatePrinterDeviceStatusesForStation(db, { spoolerId, statuses, source = 'agent' } = {}) {
    const warnings = [];
    const station = String(spoolerId || '').trim();
    const input = Array.isArray(statuses) ? statuses : [];
    if (!Array.isArray(statuses) && statuses != null) addWarning(warnings, 'PRINTER_STATUS_INVALID_BATCH');
    if (input.length > MAX_HEALTH_PRINTERS) addWarning(warnings, 'PRINTER_STATUS_BATCH_TRUNCATED');

    const deduped = new Map();
    for (const item of input.slice(0, MAX_HEALTH_PRINTERS)) {
        const printerId = Number(item?.printer_id ?? item?.id);
        if (!Number.isInteger(printerId) || printerId < 1) {
            addWarning(warnings, 'PRINTER_STATUS_INVALID_ID');
            continue;
        }
        if (!DEVICE_STATUS_VALUES.has(item?.device_status)) {
            addWarning(warnings, 'PRINTER_STATUS_INVALID_VALUE');
            continue;
        }
        deduped.set(printerId, {
            printer_id: printerId,
            device_status: item.device_status,
            status_source: normalizeStatusSource(item.status_source, source)
        });
    }
    if (deduped.size === 0) return { updated: 0, warnings };

    const ids = [...deduped.keys()];
    const [ownedRows] = await db.query(
        'SELECT id, name, spooler_id, device_status, status_source FROM printers WHERE is_active = 1 AND id IN (?) FOR UPDATE',
        [ids]
    );
    const owned = new Map();
    for (const row of ownedRows) {
        if (String(row.spooler_id) !== station) {
            addWarning(warnings, 'PRINTER_STATUS_STATION_MISMATCH');
            continue;
        }
        owned.set(Number(row.id), row);
    }
    for (const id of ids) {
        if (!owned.has(id)) addWarning(warnings, 'PRINTER_STATUS_NOT_FOUND');
    }

    const changed = [...deduped.values()].filter(item => {
        const current = owned.get(item.printer_id);
        return current && (current.device_status !== item.device_status || normalizeStatusSource(current.status_source, '') !== item.status_source);
    });
    const accepted = [...deduped.values()]
        .filter(item => owned.has(item.printer_id))
        .map(item => ({
            id: item.printer_id,
            name: owned.get(item.printer_id).name,
            device_status: item.device_status,
            details: ''
        }));
    if (changed.length === 0) return { updated: 0, warnings, accepted };

    const deviceCase = changed.map(item => 'WHEN ? THEN ?').join(' ');
    const sourceCase = changed.map(item => 'WHEN ? THEN ?').join(' ');
    const updateParams = [];
    for (const item of changed) updateParams.push(item.printer_id, item.device_status);
    for (const item of changed) updateParams.push(item.printer_id, item.status_source);
    updateParams.push(changed.map(item => item.printer_id), station);
    const [result] = await db.query(
        `UPDATE printers
            SET device_status = CASE id ${deviceCase} ELSE device_status END,
                status_source = CASE id ${sourceCase} ELSE status_source END,
                status_checked_at = UTC_TIMESTAMP()
          WHERE id IN (?) AND spooler_id = ? AND is_active = 1`,
        updateParams
    );
    return { updated: Number(result.affectedRows || 0), warnings, accepted };
}

async function listPrinterStatuses(db) {
    const [rows] = await db.query(
        `SELECT id, name, role, type, network_ip, network_port, windows_name,
                spooler_id, status_capability, device_status,
                status_checked_at, status_source
           FROM printers
          ORDER BY role ASC, name ASC`
    );
    return rows.map(row => ({
        ...row,
        status_capability: normalizePrinterCapability(row.status_capability),
        device_status: normalizeDeviceStatus(row.device_status)
    }));
}

module.exports = {
    listPrinterStatuses,
    normalizeDeviceStatus,
    normalizePrinterCapability,
    updatePrinterDeviceStatusesForStation,
    getStaffPrinterStatuses,
    setStaffPrinterHealthListener,
    applyStaffPrinterStatus,
    publishAcceptedStaffPrinterHealth,
    removeStaffPrinterStatus,
    MAX_HEALTH_PRINTERS
};

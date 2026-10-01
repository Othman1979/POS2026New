const express = require('express');
const router = express.Router();
const { 
    pool, 
    sendSuccess, 
    sendError, 
    logAdminRouteError,
    invalidateUserSessions
} = require('./helpers');
const { getCatalog, isCurrentPermission } = require('../../services/PermissionService');
const { canAssignPermission } = require('../../config/permissionPolicy.cjs');
const { hashPin } = require('../../middleware/auth');
const { revokeUserSessions: revokeDurableUserSessions } = require('../../services/staffSessions');
const { maxCredentialsForRole } = require('../../services/webauthn/policy');
const { appendSecurityAuditEvent } = require('../../services/auditEvents');
const { userEditVersion, userAccessSnapshot, presentUserProfile } = require('../../services/userAccessProfile');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');
const { emitDeviceAccessChanged } = require('../../services/deviceAccessEvents');

// user_number is a login PIN stored as a string (varchar) so leading zeros
// survive; login (auth.js) matches it as a string. Reject non-digits and cap at
// 8 to match the login pad. NEVER parseInt a user_number — it strips leading zeros.
function normalizeUserNumber(raw) {
    const s = String(raw ?? '').trim();
    return /^[0-9]{1,8}$/.test(s) ? s : null;
}

// Roles this admin route may assign. `programmer` and `table_manager` are
// intentionally excluded — they are only mintable via seed/migration, and a
// `programmer` created here would be god-mode AND hidden from the list queries.
const ALLOWED_ROLES = ['cashier', 'waiter', 'call_center', 'admin'];

function callCenterPayloadHasAuthority(data = {}) {
    return (Array.isArray(data.permissions) && data.permissions.length > 0)
        || String(data.allowed_sections ?? '').trim().length > 0
        || (data.table_access_scope != null && data.table_access_scope !== 'none');
}

function disconnectUserSockets(io, userId) {
    io?.in?.(`user:${userId}`).disconnectSockets(true);
}

// Keep only well-formed, existing section ids from a client CSV.
// Returns a CSV string, or null (nothing valid), or false (a token was non-numeric -> 400).
async function sanitizeAllowedSections(raw) {
    const text = String(raw ?? '');
    if (text.length > 255) return false;
    const tokens = text.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.some(t => !/^[0-9]+$/.test(t))) return false;
    const ids = [...new Set(tokens.map(Number))];
    const [rows] = await pool.query("SELECT id FROM sections WHERE id IN (?)", [ids]);
    const valid = new Set(rows.map(r => r.id));
    const kept = ids.filter(n => valid.has(n));
    return kept.length ? kept.join(',') : null;
}

async function normalizeTableScope(data, role, requireExplicit = false) {
    if (role === 'call_center') return { scope: 'none', sections: null };
    if (role === 'admin') return { scope: 'all', sections: null };
    const scope = data.table_access_scope;
    if (requireExplicit && scope == null) return { error: 'Choose table section access before saving.' };
    if (scope != null && !['all', 'selected', 'none'].includes(scope)) return { error: 'Invalid table section scope.' };
    if (scope === 'all' || scope === 'none') return { scope, sections: null };
    const sections = await sanitizeAllowedSections(data.allowed_sections);
    if (sections === false) return { error: 'Invalid section selection.' };
    if (scope === 'selected' && !sections) return { error: 'Select at least one existing section.' };
    // Older create clients retain role defaults. Updates must choose explicitly
    // so an older form can never reinterpret an existing employee's scope.
    const inferred = sections ? 'selected' : (String(data.allowed_sections ?? '').trim() || role === 'waiter' ? 'none' : 'all');
    return { scope: scope || inferred, sections };
}

// GET /api/admin/permissions — the permission catalog for the Users page UI.
router.get('/permissions', async (req, res) => {
    try {
        const catalog = await getCatalog();
        return sendSuccess(res, { catalog });
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, "An unexpected error occurred.");
    }
});

// ALL /api/admin/users
router.all('/users', async (req, res) => {
    try {
        if (req.method === 'GET') {
            if (req.query.lightweight === 'true') {
                const [users] = await pool.query("SELECT id, name FROM users WHERE is_active = 1 AND role != 'programmer' ORDER BY name ASC");
                return sendSuccess(res, { users });
            }
            const [users] = await pool.query("SELECT id, name, user_number, role, allowed_sections, table_access_scope, is_active, admin_pin FROM users WHERE is_active = 1 AND role != 'programmer' ORDER BY role DESC, name ASC");
            const [sections] = await pool.query("SELECT id, name FROM sections ORDER BY id ASC");
            const userIds = users.map(u => u.id);
            let grantsByUser = {};
            if (userIds.length > 0) {
                const [grants] = await pool.query(
                    "SELECT user_id, perm_key FROM user_permissions WHERE user_id IN (?)",
                    [userIds]
                );
                for (const g of grants) {
                    (grantsByUser[g.user_id] = grantsByUser[g.user_id] || []).push(g.perm_key);
                }
            }
            return sendSuccess(res, { users: users.map(user => presentUserProfile(user, grantsByUser[user.id] || [])), sections });
        }
        else if (req.method === 'POST') {
            const data = req.body;
            const userNumber = normalizeUserNumber(data.user_number);
            if (!userNumber) {
                return sendError(res, 400, "User number must be 1-8 digits (leading zeros allowed).");
            }
            const name = String(data.name ?? '').trim();
            if (name.length === 0 || name.length > 100) {
                return sendError(res, 400, "Name must be between 1 and 100 characters.");
            }
            const [check] = await pool.query("SELECT id FROM users WHERE user_number = ?", [userNumber]);
            if (check.length > 0) return sendError(res, 400, "User number already exists.");

            let role = data.role ? String(data.role).trim() : 'cashier';
            if (!ALLOWED_ROLES.includes(role)) {
                return sendError(res, 400, "Invalid role.");
            }
            if (role === 'call_center' && callCenterPayloadHasAuthority(data)) {
                return sendError(res, 400, "Call center users cannot have permissions or section access.");
            }
            const { scope: table_access_scope, sections: allowed_sections, error: scopeError } = await normalizeTableScope(data, role, req.method === 'PUT');
            if (scopeError) return sendError(res, 400, scopeError);

            let adminPinHash = null;
            if (role === 'admin') {
                const rawPin = String(data.admin_override_pin ?? '').trim();
                if (rawPin.length > 0) {
                    if (!/^[0-9]{4,8}$/.test(rawPin)) {
                        return sendError(res, 400, "Manager override PIN must be 4-8 digits.");
                    }
                    adminPinHash = await hashPin(rawPin);
                }
            }

            const conn = await pool.getConnection();
            let result;
            let savedProfile;
            try {
                await conn.beginTransaction();
                [result] = await conn.query(
                    "INSERT INTO users (name, user_number, role, allowed_sections, table_access_scope, admin_pin) VALUES (?, ?, ?, ?, ?, ?)",
                    [name, userNumber, role, allowed_sections, table_access_scope, adminPinHash]
                );
                const grants = await validatedGrants(conn, data.permissions, role);
                await replaceUserGrants(conn, result.insertId, grants);
                const createdUser = { id: result.insertId, name, user_number: userNumber, role, allowed_sections, table_access_scope, admin_pin: adminPinHash, is_active: 1 };
                savedProfile = presentUserProfile(createdUser, grants);
                await appendSecurityAuditEvent(conn, {
                    eventType: 'user_access_created', userId: req.user.id, entityType: 'user', entityId: result.insertId,
                    newValue: { ...userAccessSnapshot(createdUser, grants), login_pin_set: true, manager_pin_set: !!adminPinHash }, ipAddress: req.ip || null,
                });
                await conn.commit();
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            } finally {
                conn.release();
            }
            emitDeviceAccessChanged(req);
            return sendSuccess(res, { message: "User created successfully.", id: result.insertId, edit_version: savedProfile.edit_version, user: savedProfile });
        }
        else if (req.method === 'PUT') {
            const data = req.body;
            const userId = parseInt(data.id, 10);
            if (isNaN(userId) || userId < 1) {
                return sendError(res, 400, "Valid user id is required.");
            }
            const userNumber = normalizeUserNumber(data.user_number);
            if (!userNumber) {
                return sendError(res, 400, "User number must be 1-8 digits (leading zeros allowed).");
            }
            const name = String(data.name ?? '').trim();
            if (name.length === 0 || name.length > 100) {
                return sendError(res, 400, "Name must be between 1 and 100 characters.");
            }
            const [check] = await pool.query("SELECT id FROM users WHERE user_number = ? AND id != ?", [userNumber, userId]);
            if (check.length > 0) return sendError(res, 400, "User number already in use by another account.");

            let role = data.role ? String(data.role).trim() : 'cashier';
            if (!ALLOWED_ROLES.includes(role)) {
                return sendError(res, 400, "Invalid role.");
            }
            if (role === 'call_center' && callCenterPayloadHasAuthority(data)) {
                return sendError(res, 400, "Call center users cannot have permissions or section access.");
            }
            const { scope: table_access_scope, sections: allowed_sections, error: scopeError } = await normalizeTableScope(data, role, req.method === 'PUT');
            if (scopeError) return sendError(res, 400, scopeError);

            let adminPinHash = null;
            if (role === 'admin') {
                const rawPin = String(data.admin_override_pin ?? '').trim();
                if (rawPin.length > 0) {
                    if (!/^[0-9]{4,8}$/.test(rawPin)) {
                        return sendError(res, 400, "Manager override PIN must be 4-8 digits.");
                    }
                    adminPinHash = await hashPin(rawPin);
                }
            }

            // Release the editing lease and change the user in one transaction. A
            // role/session transition can therefore never leave a stale terminal
            // holding a claim against the new user state.
            const conn = await pool.getConnection();
            let savedProfile;
            try {
                await conn.beginTransaction();
                const [targets] = await conn.query(
                    'SELECT id, name, user_number, role, allowed_sections, table_access_scope, is_active, admin_pin FROM users WHERE id=? FOR UPDATE',
                    [userId]
                );
                if (targets.length === 0) {
                    await conn.rollback();
                    return sendError(res, 404, "User not found.");
                }
                if (targets[0].role === 'programmer' || !targets[0].is_active) {
                    await conn.rollback();
                    return sendError(res, 404, "User not found.");
                }
                const [currentGrantRows] = await conn.query(
                    'SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key FOR UPDATE',
                    [userId]
                );
                const currentGrantKeys = currentGrantRows.map(row => row.perm_key).sort();
                if (data.edit_version !== userEditVersion(targets[0], currentGrantKeys)) {
                    await conn.rollback();
                    return sendError(res, 409, 'This user was changed elsewhere. Reload the user before saving again.', 'USER_EDIT_CONFLICT');
                }
                if (role === 'call_center') {
                    const [openShifts] = await conn.query(
                        "SELECT id FROM shifts WHERE user_id=? AND status='open' FOR UPDATE",
                        [userId]
                    );
                    if (openShifts.length > 0) {
                        await conn.rollback();
                        return sendError(res, 409, "Close this user's open shift before changing the role to call center.");
                    }
                }
                const nextDeviceLimit = maxCredentialsForRole(role);
                const [[activeDeviceCount]] = await conn.query(
                    `SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id=? AND status='active' FOR UPDATE`,
                    [userId]
                );
                if (Number(activeDeviceCount?.count || 0) > nextDeviceLimit) {
                    await conn.rollback();
                    return sendError(res, 409, 'Select and revoke the extra registered device before downgrading this role.', 'DEVICE_LIMIT_EXCEEDED');
                }
                const requestedGrantKeys = await validatedGrants(conn, data.permissions, role);
                const losesHoldAuthority = currentGrantKeys.includes('pos.hold_orders')
                    && !requestedGrantKeys.includes('pos.hold_orders');
                const releasedClaims = (role !== targets[0].role || losesHoldAuthority)
                    ? await releaseActiveHeldClaims(userId, conn)
                    : 0;
                const nextAdminPin = role === 'admin' ? adminPinHash || targets[0].admin_pin : null;
                const managerPinChanged = nextAdminPin !== targets[0].admin_pin;
                await conn.query(
                    "UPDATE users SET name = ?, user_number = ?, role = ?, allowed_sections = ?, table_access_scope = ?, admin_pin = ? WHERE id = ?",
                    [name, userNumber, role, allowed_sections, table_access_scope, nextAdminPin, userId]
                );
                await replaceUserGrants(conn, userId, requestedGrantKeys, currentGrantKeys);
                const updatedUser = { ...targets[0], name, user_number: userNumber, role, allowed_sections, table_access_scope, admin_pin: nextAdminPin };
                savedProfile = presentUserProfile(updatedUser, requestedGrantKeys);
                const before = userAccessSnapshot(targets[0], currentGrantKeys);
                const after = userAccessSnapshot(updatedUser, requestedGrantKeys);
                if (JSON.stringify(before) !== JSON.stringify(after) || targets[0].user_number !== userNumber || managerPinChanged) {
                    await appendSecurityAuditEvent(conn, {
                        eventType: 'user_access_changed', userId: req.user.id, entityType: 'user', entityId: userId,
                        oldValue: before,
                        newValue: { ...after, login_pin_changed: targets[0].user_number !== userNumber, manager_pin_changed: managerPinChanged },
                        ipAddress: req.ip || null,
                    });
                }
                await revokeDurableUserSessions(userId, 'user_security_change', conn);
                await conn.commit();
                if (releasedClaims > 0) emitHeldOrdersChanged(req.io, 'cleared');
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            } finally {
                conn.release();
            }
            invalidateUserSessions(userId);
            disconnectUserSockets(req.io, userId);
            emitDeviceAccessChanged(req);
            return sendSuccess(res, { message: "User profile and security updated.", edit_version: savedProfile.edit_version, user: savedProfile });
        }
        else if (req.method === 'DELETE') {
            const userId = parseInt(req.body?.id, 10);
            if (isNaN(userId) || userId < 1) {
                return sendError(res, 400, "Valid user id is required.");
            }
            if (userId === 1 || userId === req.user.id) {
                return sendError(res, 403, "Cannot delete primary admin or your own account.");
            }
            const conn = await pool.getConnection();
            let result;
            try {
                await conn.beginTransaction();
                const [targets] = await conn.query(
                    'SELECT role FROM users WHERE id=? AND is_active=1 FOR UPDATE',
                    [userId]
                );
                if (targets.length === 0 || targets[0].role === 'programmer') {
                    await conn.rollback();
                    return sendError(res, 404, "User not found.");
                }
                const releasedClaims = await releaseActiveHeldClaims(userId, conn);
                await revokeDurableUserSessions(userId, 'user_deactivated', conn);
                await conn.query(
                    `UPDATE webauthn_credentials
                        SET status='revoked', revoked_at=COALESCE(revoked_at, CURRENT_TIMESTAMP),
                            revoked_by_user_id=?, revoke_reason=COALESCE(revoke_reason, 'user_deactivated')
                      WHERE user_id=? AND status='active'`,
                    [req.user.id, userId]
                );
                await appendSecurityAuditEvent(conn, {
                    eventType: 'device_credential_revoked',
                    userId: req.user.id,
                    entityType: 'user',
                    entityId: userId,
                    newValue: { reason: 'user_deactivated' },
                    ipAddress: req.ip || null,
                });
                [result] = await conn.query("UPDATE users SET is_active = 0 WHERE id = ?", [userId]);
                await conn.commit();
                if (releasedClaims > 0) emitHeldOrdersChanged(req.io, 'cleared');
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            } finally {
                conn.release();
            }
            if (result.affectedRows === 0) {
                return sendError(res, 404, "User not found.");
            }
            invalidateUserSessions(userId);
            disconnectUserSockets(req.io, userId);
            emitDeviceAccessChanged(req);
            return sendSuccess(res, { message: "User deactivated." });
        }
        else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, "An unexpected error occurred.");
    }
});

// Replace a user's permission grants atomically. Admin/programmer get no rows (role bypass).
async function validatedGrants(db, permissions, role) {
    if (['admin', 'programmer', 'call_center'].includes(role) || !Array.isArray(permissions) || !permissions.length) return [];
    const [valid] = await db.query('SELECT perm_key FROM permissions WHERE implemented = 1');
    const validSet = new Set(valid.map(row => row.perm_key).filter(isCurrentPermission));
    return [...new Set(permissions.filter(key => validSet.has(key) && canAssignPermission(role, key)))].sort();
}

async function replaceUserGrants(db, userId, next, previous = []) {
    const nextSet = new Set(next), previousSet = new Set(previous);
    const removed = previous.filter(key => !nextSet.has(key));
    const added = next.filter(key => !previousSet.has(key));
    if (removed.length) await db.query('DELETE FROM user_permissions WHERE user_id=? AND perm_key IN (?)', [userId, removed]);
    if (added.length) await db.query('INSERT INTO user_permissions (user_id, perm_key) VALUES ?', [added.map(key => [userId, key])]);
}

async function releaseActiveHeldClaims(userId, db = pool) {
    const [result] = await db.query(`
        UPDATE held_orders
           SET claimed_by_user_id=NULL,
               claim_token_hash=NULL,
               claim_expires_at=NULL,
               version=version+1,
               updated_at=NOW()
         WHERE claimed_by_user_id=?
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at > NOW()
    `, [userId]);
    return Number(result?.affectedRows || 0);
}

module.exports = router;

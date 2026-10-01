const { createHash } = require('node:crypto');
const { isAdminRole, isCallCenterRole, canAssignPermission } = require('../config/permissionPolicy.cjs');

// A concurrency stamp over persisted values, not an authorization credential.
// Include the manager PIN hash in the stamp but never return or audit that hash.
function userEditVersion(user, grants) {
    return createHash('sha256').update(JSON.stringify([
        Number(user.id), user.name, user.user_number, user.role,
        user.table_access_scope, user.allowed_sections || '', Number(user.is_active), user.admin_pin || '',
        [...new Set(grants)].sort(),
    ])).digest('hex');
}

function userAccessSnapshot(user, grants) {
    return {
        role: user.role,
        table_access_scope: user.table_access_scope,
        allowed_sections: user.allowed_sections || '',
        permissions: [...new Set(grants)].sort(),
    };
}

function presentUserProfile(user, grants) {
    const fixed = isAdminRole(user) || isCallCenterRole(user);
    return {
        id: user.id, name: user.name, user_number: user.user_number, role: user.role,
        is_active: user.is_active,
        table_access_scope: isCallCenterRole(user) ? 'none' : isAdminRole(user) ? 'all' : user.table_access_scope,
        allowed_sections: isCallCenterRole(user) ? null : user.allowed_sections,
        permissions: fixed ? [] : grants.filter(key => canAssignPermission(user.role, key)),
        edit_version: userEditVersion(user, grants),
    };
}

module.exports = { userEditVersion, userAccessSnapshot, presentUserProfile };

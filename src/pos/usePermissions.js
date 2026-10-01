import { useAuth } from './useAuth.js';
import policy from '@posapp/permission-policy';

// Frontend permission check. Mirrors backend PermissionService.userHas:
// admin/programmer bypass; everyone else needs the granted key.
// Server-side enforcement is authoritative — this only drives UI visibility.
export function usePermissions() {
    const auth = useAuth();

    const hasDirect = key => policy.userHas(auth.activeUser?.value, key);

    const can = (key) => {
        if (!policy.isCurrentPermission(key) || auth.activeUser?.value?.role === 'call_center') return false;
        if (hasDirect(key)) return true;
        return auth.isTempAdmin?.value === true
            && policy.TEMPORARY_CHECKOUT_PERMISSIONS.includes(key)
            && Array.isArray(auth.temporaryPermissions?.value)
            && auth.temporaryPermissions.value.includes(key);
    };

    const decision = (action, context) => policy.evaluateAction(auth.activeUser?.value, action, context);
    const canAction = (action, context) => decision(action, context).allowed;
    return { can, hasDirect, canAction, decision };
}

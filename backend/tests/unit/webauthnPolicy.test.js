const {
    maxCredentialsForRole,
    isPrivilegedRole,
    credentialLookup,
    normalizeDeviceLabel,
    assertRoleCapacity,
    safeCredentialSummary,
} = require('../../services/webauthn/policy');

describe('registered-browser device policy', () => {
    it('keeps programmer PIN-only while capping admin at two and staff at one', () => {
        expect(maxCredentialsForRole('admin')).toBe(2);
        expect(maxCredentialsForRole('programmer')).toBe(0);
        expect(maxCredentialsForRole('cashier')).toBe(1);
        expect(maxCredentialsForRole('call_center')).toBe(1);
        expect(isPrivilegedRole('admin')).toBe(true);
        expect(isPrivilegedRole('cashier')).toBe(false);
    });

    it('hashes the raw credential ID for indexed lookup without losing bytes', () => {
        const parsed = credentialLookup('AQID');
        expect(parsed.value).toEqual(Buffer.from([1, 2, 3]));
        expect(parsed.lookup).toHaveLength(32);
        expect(parsed.encoded).toBe('AQID');
    });

    it('enforces labels and role capacity transactionally', () => {
        expect(normalizeDeviceLabel(' Front desk laptop ')).toBe('Front desk laptop');
        expect(() => normalizeDeviceLabel('')).toThrow();
        expect(assertRoleCapacity('admin', 1)).toBe(2);
        expect(() => assertRoleCapacity('cashier', 1)).toThrow(/slot/i);
        expect(assertRoleCapacity('cashier', 1, true)).toBe(1);
        expect(() => assertRoleCapacity('programmer', 0)).toThrow(expect.objectContaining({ publicCode: 'WEBAUTHN_ROLE_UNSUPPORTED' }));
    });

    it('normalizes database boolean values without treating string zero as true', () => {
        expect(safeCredentialSummary({ id: 1, backed_up: '0', status: 'active', device_type: 'singleDevice', device_label: 'Desk' }).backed_up).toBe(false);
        expect(safeCredentialSummary({ id: 2, backed_up: '1', status: 'active', device_type: 'singleDevice', device_label: 'Phone' }).backed_up).toBe(true);
    });
});

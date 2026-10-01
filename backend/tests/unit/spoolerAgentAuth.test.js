describe('spooler agent identity validation', () => {
    it('accepts a v4 UUID and rejects everything else', () => {
        const { isValidAgentId } = require('../../services/spoolerAgents');
        expect(isValidAgentId('11111111-1111-4111-8111-111111111111')).toBe(true);
        expect(isValidAgentId('11111111111141118111111111111111')).toBe(false);
        expect(isValidAgentId('')).toBe(false);
    });

    it('reuses the V1 station id grammar', () => {
        const { isValidStationId } = require('../../services/spoolerAgents');
        expect(isValidStationId('kitchen-2')).toBe(true);
        expect(isValidStationId('.leading-dot')).toBe(false);
        expect(isValidStationId('x'.repeat(97))).toBe(false);
    });

    it('accepts only lowercase SHA-256 token hashes and compares raw tokens constant-time', () => {
        const crypto = require('crypto');
        const { isValidTokenHash, tokenMatchesHash } = require('../../services/spoolerAgents');
        const expected = crypto.createHash('sha256').update('secret-token-a').digest('hex');
        expect(isValidTokenHash('a'.repeat(64))).toBe(true);
        expect(isValidTokenHash('A'.repeat(64))).toBe(false);
        expect(tokenMatchesHash('secret-token-a', expected)).toBe(true);
        expect(tokenMatchesHash('secret-token-b', 'a'.repeat(64))).toBe(false);
    });
});

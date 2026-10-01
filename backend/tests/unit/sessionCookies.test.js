const { setSessionCookie, clearSessionCookie } = require('../../services/sessionCookies');

function response() {
    const headers = new Map();
    return {
        getHeader: (name) => headers.get(name),
        setHeader: (name, value) => headers.set(name, value),
        headers,
    };
}

describe('staff session cookies', () => {
    it('marks the cookie Secure from deployment policy behind TLS termination', () => {
        const res = response();
        setSessionCookie(res, 'opaque-token', { secure: false }, { enforceHttps: true });
        expect(res.getHeader('Set-Cookie')).toEqual([
            'pos_token=opaque-token; HttpOnly; Secure; SameSite=Strict; Path=/',
        ]);
    });

    it('keeps the session cookie first while preserving existing cookies', () => {
        const res = response();
        res.setHeader('Set-Cookie', ['language=ar']);
        setSessionCookie(res, 'opaque-token', { secure: true }, { enforceHttps: true });
        expect(res.getHeader('Set-Cookie')).toEqual([
            'pos_token=opaque-token; HttpOnly; Secure; SameSite=Strict; Path=/',
            'language=ar',
        ]);
    });

    it('clears the same cookie attributes without exposing the token', () => {
        const res = response();
        clearSessionCookie(res, { secure: false }, { enforceHttps: false });
        expect(res.getHeader('Set-Cookie')).toBe('pos_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    });
});

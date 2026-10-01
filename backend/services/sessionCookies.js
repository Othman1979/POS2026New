const COOKIE_NAME = 'pos_token';

function secureFor(_req, options) {
    return options?.enforceHttps ?? process.env.ENFORCE_HTTPS === 'true';
}

function setSessionCookie(res, token, req, options) {
    const parts = [`${COOKIE_NAME}=${token}`, 'HttpOnly'];
    if (secureFor(req, options)) parts.push('Secure');
    parts.push('SameSite=Strict', 'Path=/');
    const existing = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [parts.join('; '), ...[].concat(existing)]);
}

function clearSessionCookie(res, req, options) {
    const parts = [`${COOKIE_NAME}=`, 'HttpOnly'];
    if (secureFor(req, options)) parts.push('Secure');
    parts.push('SameSite=Strict', 'Path=/', 'Max-Age=0');
    res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = { COOKIE_NAME, setSessionCookie, clearSessionCookie };

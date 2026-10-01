import { clearPosOrderSession } from '@/pos/stores/orderSession/orderSessionPersistence.js';

// Global Fetch Interceptor for cookie-backed browser sessions.
const originalFetch = window.fetch;

function removeLegacyReadableToken() {
    try { sessionStorage.removeItem('pos_token'); } catch (_) {}
    try { localStorage.removeItem('pos_token'); } catch (_) {}
}

removeLegacyReadableToken();

window.fetch = async function () {
    let [resource, config] = arguments;
    const resourceUrl = typeof resource === 'string' ? resource : (resource?.url || String(resource));
    
    // Check if the URL is strictly an internal local API route on the same host
    // Matches relative endpoints (api/ or /api/) and absolute endpoints matching window.location.origin
    const isRelativeApi = (resourceUrl.startsWith('api/') || resourceUrl.startsWith('/api/')) && 
                          !resourceUrl.startsWith('http://') && 
                          !resourceUrl.startsWith('https://');
                          
    const isAbsoluteLocalApi = resourceUrl.startsWith(window.location.origin + '/api/') || 
                               resourceUrl.startsWith(window.location.origin + 'api/');
                               
    const isInternalApi = isRelativeApi || isAbsoluteLocalApi;

    if (isInternalApi) {
        config = config || {};
        config.credentials = 'same-origin';
    }
    
    const response = await originalFetch(resource, config);
    
    // Only a failed cookie session means "expired". Other 401s are domain
    // failures (wrong manager PIN, unregistered browser, failed device proof)
    // and must reach the caller so it can show the correct action.
    let sessionFailure = false;
    if (response.status === 401 && isInternalApi) {
        try {
            const data = await response.clone().json();
            sessionFailure = ['SESSION_REQUIRED', 'SESSION_INVALID'].includes(data?.code);
        } catch (_) {}
    }
    if (sessionFailure) {
        let expiredUser = null;
        try { expiredUser = JSON.parse(sessionStorage.getItem('pos_user') || 'null'); } catch (_) {}
        if (expiredUser?.role === 'call_center') clearPosOrderSession(localStorage);
        sessionStorage.removeItem('pos_user');
        // Keeps the index.html boot shell neutral on the next visit (see backend/config/posBootHint.js).
        try { localStorage.removeItem('pos_active_user_id'); } catch (_) {}
        removeLegacyReadableToken();
        window.location.href = '/login?reason=expired';
    }
    
    return response;
};

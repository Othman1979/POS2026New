/**
 * faviconInjector.js
 * Fetches public preferences once per page (shared with the login page) and
 * injects/updates a <link rel="icon"> inside the head.
 */
let preferencesPromise = null;

export function getPublicPreferences() {
    preferencesPromise ||= fetch('/api/system/public_preferences')
        .then(res => {
            if (!res.ok) throw new Error(`public_preferences ${res.status}`);
            return res.json();
        })
        .catch(error => { preferencesPromise = null; throw error; });
    return preferencesPromise;
}

export async function injectStoreFavicon() {
    try {
        const data = await getPublicPreferences();

        let link = document.querySelector("link[rel~='icon']");
        if (data.store_icon) {
            if (!link) {
                link = document.createElement('link');
                link.rel = 'icon';
                document.head.appendChild(link);
            }
            // Stable URL: /uploads is served with max-age=0 + ETag, so the browser
            // revalidates (304) and picks up a re-upload without re-downloading every boot.
            link.href = data.store_icon;
        } else if (link) {
            // Revert back to default favicon if setting deleted
            link.href = '/favicon.ico';
        }
    } catch (_) {
        // Fail silently - favicon is a non-critical progressive enhancement
    }
}

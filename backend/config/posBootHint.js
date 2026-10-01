'use strict';

const crypto = require('crypto');

// index.html paints the POS loading skeleton before any bundle runs. A signed-out visitor to /
// would see it until the session check redirects to /login, so this one inline script picks the
// neutral shell when no user is signed in on this browser (pos_active_user_id is set at login and
// session restore, cleared at logout and idle sign-out). It is allowed by hash, not 'unsafe-inline'.
// index.html must contain this exact text (backend/tests/unit/posBootHint.test.js).
const POS_BOOT_HINT_SCRIPT = "try{if(!localStorage.getItem('pos_active_user_id'))document.documentElement.classList.add('pos-boot-signed-out')}catch(e){}";
const POS_BOOT_HINT_SCRIPT_HASH = `'sha256-${crypto.createHash('sha256').update(POS_BOOT_HINT_SCRIPT, 'utf8').digest('base64')}'`;

module.exports = { POS_BOOT_HINT_SCRIPT, POS_BOOT_HINT_SCRIPT_HASH };

const request = require('supertest');

// Legacy workflow tests edit a freshly loaded user. Concurrency tests retain
// their original versions explicitly instead of using this convenience helper.
async function withUserEditVersion(app, cookie, payload) {
    const response = await request(app).get('/api/admin/users').set('Cookie', cookie);
    if (response.status !== 200) throw new Error(`Cannot load user edit version: ${response.status}`);
    const current = response.body.users.find(user => user.id === payload.id);
    const scope = payload.role === 'call_center' ? 'none' : payload.role === 'admin' ? 'all'
        : String(payload.allowed_sections || '').trim() ? 'selected' : current?.table_access_scope || 'all';
    return { ...payload, table_access_scope: payload.table_access_scope || scope, edit_version: current?.edit_version };
}

module.exports = { withUserEditVersion };

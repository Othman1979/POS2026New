const { SEED } = require('../fixtures/seed');

async function loginAs(request, app, user) {
    const res = await request(app)
        .post('/api/auth/login')
        .send({ user_number: user.user_number });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
    return res.headers['set-cookie'][0];
}

async function loginSeedUser(request, app, userKey) {
    const user = SEED[userKey];
    if (!user) throw new Error(`Unknown seed user: ${userKey}`);
    return loginAs(request, app, user);
}

module.exports = {
    loginAs,
    loginSeedUser,
};

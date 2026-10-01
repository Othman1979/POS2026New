// Isolated browser review server. Requires a fresh POSAPP_REVIEW_DB name.
require('./recipe-ledger-phase1-preload.cjs');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
seedDatabase().then(() => {
    const { server } = require('../../server');
    server.listen(3013, '127.0.0.1', () => console.log('Recipe Phase 3 review ready at http://127.0.0.1:3013'));
}).catch(error => { console.error(error); process.exitCode = 1; });

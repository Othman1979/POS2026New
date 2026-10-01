// setup.js — runs before each test FILE (not each test).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.test'), override: true });
// Injects and resets the Socket.IO test double used by integration routes.
// Vitest's default file isolation owns module-cache separation between files.

// globals are used directly since globals: true is enabled in vitest config

// ─── Stub req.io ─────────────────────────────────────────────────────────────
// Routes attach io to every request in server.js: `req.io = io;`
// In tests we use Supertest which bypasses that middleware, so we need to
// inject a mock. We do this by monkey-patching the Express app after import.
//
// The mock: io.to(room).emit(event, data) — returns itself so chains work.
const mockEmit = vi.fn();
const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
const mockIo = { to: mockTo, emit: mockEmit, sockets: { adapter: { rooms: new Map() } } };

// Export so individual test files can inspect emit calls
global.__mockIo__ = mockIo;
global.__mockEmit__ = mockEmit;
global.__mockTo__ = mockTo;

// Spy on the real Socket.IO server exported from server.js
const { io } = require('../../server');
vi.spyOn(io, 'to').mockImplementation(room => {
    mockTo(room);
    return io;
});
vi.spyOn(io, 'emit').mockImplementation((event, ...args) => {
    mockEmit(event, ...args);
    return io;
});

// ─── Reset Socket.IO Mocks Between Tests ─────────────────────────────────────
afterEach(() => {
    // Reset Socket.IO mock state
    mockEmit.mockClear();
    mockTo.mockClear();
});

// ─── Suppress Pino Logs in Tests ─────────────────────────────────────────────
// Pino output clutters test results. Silence it by setting LOG_LEVEL=silent
// (already done in globalSetup.mjs, but set here as belt-and-suspenders).
process.env.LOG_LEVEL = 'silent';

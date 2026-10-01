const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadReleaseIdentity() {
    const fallback = { version: require('./package.json').version, commit: 'development', schemaVersion: null };
    const releasePath = path.join(__dirname, 'release.json');
    if (!fs.existsSync(releasePath)) return Object.freeze(fallback);
    try {
        const value = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
        return Object.freeze({
            version: String(value.version || fallback.version),
            commit: String(value.commit || fallback.commit),
            schemaVersion: value.schemaVersion == null ? null : String(value.schemaVersion),
            spoolerVersion: value.spoolerVersion == null ? undefined : String(value.spoolerVersion)
        });
    } catch (error) {
        throw new Error(`Invalid release metadata: ${error.message}`);
    }
}

if (process.env.NODE_ENV === 'test') {
    dotenv.config({ path: path.resolve(__dirname, '.env.test'), override: true });
} else if (process.env.POSAPP_ENV_FILE) {
    if (!fs.existsSync(process.env.POSAPP_ENV_FILE)) {
        throw new Error(`POSAPP_ENV_FILE does not exist: ${process.env.POSAPP_ENV_FILE}`);
    }
    dotenv.config({ path: process.env.POSAPP_ENV_FILE });
} else {
    dotenv.config();
}
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createCorsPolicy } = require('./backend/config/corsPolicy');
const db = require('./backend/config/db');
const logger = require('./backend/config/logger');
const { spoolerSyncWakeHub } = require('./backend/services/spoolerSyncWake');
const { generateStaticMenu } = require('./backend/config/menuCache');
const { getCatalogGenerationToken } = require('./backend/config/cache');
const {
    getLatestFailedPrintJobsCount,
    refreshFailedPrintJobsCount
} = require('./backend/services/printQueueWatchdog');
const { createPrintQueueWatchdogRunner } = require('./backend/services/printQueueWatchdogRunner');
const {
    getStaffPrinterStatuses,
    setStaffPrinterHealthListener
} = require('./backend/services/printerStatus');
const { migrateAndValidate } = require('./backend/services/migrateAndValidate');
const { createGlobalPreAuthGate } = require('./backend/middleware/rateLimit');
const { cleanupExpiredYHeldReportArchives } = require('./backend/services/yHeldItemsReportBuilder');
const { markStaleSubmissionsUnknown, processJofotaraOperations } = require('./backend/services/JofotaraService');
const { createJofotaraOperationsRunner } = require('./backend/services/JofotaraOperationsRunner');
const { createStockReportWorkerRunner } = require('./backend/services/StockReportWorkerRunner');
const { createPrintQueuePurge } = require('./backend/services/printQueuePurge');
// Import shared auth helpers — verifyToken is used by both HTTP and WebSocket auth
const { verifyToken, getCachedSessionBinding, parseCookies } = require('./backend/middleware/auth');
const { findActiveSession } = require('./backend/services/staffSessions');
const { watchSessionDeadline } = require('./backend/services/socketSessionDeadline');
const { staffTableRooms, broadcastTableDraftChanged } = require('./backend/services/TableRealtime');
const { createCustomerCartWriter } = require('./backend/services/customerCartWriter');
const { pruneExpiredCeremonies } = require('./backend/services/webauthn/ceremonies');
const release = loadReleaseIdentity();
const printQueuePurge = createPrintQueuePurge({ db, logger });
const corsPolicy = createCorsPolicy(process.env.CORS_ORIGIN);

if (corsPolicy.origins.length === 0) {
    logger.info('CORS_ORIGIN not set. Cross-origin browser access is disabled; same-origin HTTP and Socket.IO remain available.');
}

setInterval(() => {
    pruneExpiredCeremonies().catch((error) => logger.warn({ err: error }, 'WebAuthn ceremony pruning failed.'));
}, 5 * 60 * 1000).unref();

const app = express();
const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === 'true';
const PORT = process.env.PORT || 3000;
let startupStatus = process.env.NODE_ENV === 'test' ? 'ready' : 'starting';
const helmet = require('helmet');
const { POS_BOOT_HINT_SCRIPT_HASH } = require('./backend/config/posBootHint');

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            "default-src": ["'self'"],
            "base-uri": ["'self'"],
            "object-src": ["'none'"],
            "script-src": ["'self'", POS_BOOT_HINT_SCRIPT_HASH],
            "script-src-elem": ["'self'", POS_BOOT_HINT_SCRIPT_HASH],
            "style-src": ["'self'", "'unsafe-inline'"],
            "style-src-elem": ["'self'", "'unsafe-inline'"],
            "style-src-attr": ["'unsafe-inline'"],
            "font-src": ["'self'", "data:"],
            "img-src": ["'self'", "data:", "blob:"],
            "connect-src": ["'self'", "ws:", "wss:"],
            "frame-ancestors": ["'none'"],
            "form-action": ["'self'"],
            "manifest-src": ["'self'"],
            "worker-src": ["'self'"],
        }
    },
    hidePoweredBy: true,
}));

const server = http.createServer(app);
let startupListenPromise = null;
if (process.env.NODE_ENV !== 'test') {
    startupListenPromise = listenForStartup();
}

const CUSTOMER_CART_MAX_LINES = 100;

const io = new Server(server, {
    cors: corsPolicy.httpOptions,
    allowRequest: corsPolicy.allowSocketRequest,
    // Staff and customer sockets only ever send small JSON events.
    maxHttpBufferSize: 1e5
});
app.set('io', io);
setStaffPrinterHealthListener(snapshot => {
    io.to('staff').emit('printer_status_changed', Object.values(snapshot));
});

// ─── Socket.IO Authorization Middleware ────────────────────────────────────────
// Every socket connection (POS terminal, Admin dashboard, waiter tablet)
// must supply a valid session before being allowed to receive real-time events.
io.use(async (socket, next) => {
    if (startupStatus !== 'ready') return next(new Error('Server is starting.'));

    const isCustomer = socket.handshake.auth?.type === 'customer';
    if (isCustomer) {
        const tableId = parseInt(socket.handshake.auth?.tableId);
        const token = socket.handshake.auth?.token || null;
        if (!tableId || isNaN(tableId)) {
            logger.warn({ socketId: socket.id }, 'Socket.IO: Rejected customer connection — missing or invalid tableId.');
            return next(new Error('Unauthorized: Valid tableId is required.'));
        }
        if (!token) {
            logger.warn({ socketId: socket.id, tableId }, 'Socket.IO: Rejected customer connection — missing qr_code_token.');
            return next(new Error('Unauthorized: Valid qr_code_token is required.'));
        }
        try {
            const [tables] = await db.query("SELECT id, qr_code_token FROM restaurant_tables WHERE id = ?", [tableId]);
            if (tables.length === 0) {
                logger.warn({ socketId: socket.id, tableId }, 'Socket.IO: Rejected customer connection — table does not exist.');
                return next(new Error('Unauthorized: Table does not exist.'));
            }
            if (tables[0].qr_code_token !== token) {
                logger.warn({ socketId: socket.id, tableId }, 'Socket.IO: Rejected customer connection — invalid qr_code_token.');
                return next(new Error('Unauthorized: Invalid qr_code_token.'));
            }
            socket.isCustomer = true;
            socket.tableId = tableId;
            return next();
        } catch (e) {
            logger.error({ err: e, tableId }, 'Socket.IO: Database error during customer table verification; refusing the connection as retryable.');
            return next(new Error('Service unavailable.'));
        }
    }

    // Regular staff browser clients (POS, Admin, tablet) authenticate only via
    // the httpOnly cookie automatically sent with the WebSocket upgrade request.
    const cookies = parseCookies(socket.handshake.headers.cookie || '');
    const rawToken = cookies['pos_token'] || null;

    if (!rawToken) {
        logger.warn({ socketId: socket.id }, 'Socket.IO: Rejected connection — no credentials provided.');
        return next(new Error('Unauthorized: No session token.'));
    }

    // socket.io does not await middleware: a rejection here would hang the
    // handshake and reach the process crash handler. A database failure is
    // refused as retryable; clients log out only on "Unauthorized:".
    let user, authSession;
    try {
        user = await verifyToken(rawToken);
        authSession = user ? (getCachedSessionBinding(rawToken) || await findActiveSession(rawToken)) : null;
    } catch (error) {
        logger.error({ err: error, socketId: socket.id }, 'Socket.IO: Session check failed; refusing the connection as retryable.');
        return next(new Error('Service unavailable.'));
    }
    if (!user) {
        logger.warn({ socketId: socket.id }, 'Socket.IO: Rejected connection — invalid or expired session token.');
        return next(new Error('Unauthorized: Invalid or expired session.'));
    }
    if (!authSession) {
        logger.warn({ socketId: socket.id }, 'Socket.IO: Rejected connection — durable session is no longer active.');
        return next(new Error('Unauthorized: Invalid or expired session token.'));
    }

    // Attach verified user to socket for use in event handlers
    socket.user = user;
    socket.authSession = authSession;
    socket.rawSessionToken = rawToken;
    socket.isSpooler = false;
    return next();
});

// ─── HTTP Middleware ────────────────────────────────────────────────────────────

if (ENFORCE_HTTPS) {
    app.use((req, res, next) => {
        const host = req.headers.host || '';
        // Redirect only on positive evidence of plaintext. The framework's derived
        // protocol always reports HTTP behind TLS termination and would redirect-loop.
        // Missing forwarded protocol is ambiguous, so it must pass through unchanged.
        const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
        const knownPlaintext = !req.secure && forwardedProto === 'http';
        if (knownPlaintext) return res.redirect(301, `https://${host}${req.originalUrl}`);
        return next();
    });
}
app.use(cors(corsPolicy.httpOptions));
app.use((req, res, next) => {
    if (startupStatus === 'ready' || req.path === '/health' || req.path === '/api/health') return next();
    res.set('Retry-After', '2');
    return res.status(503).json({
        success: false,
        status: startupStatus === 'failed' ? 'DOWN' : 'STARTING',
        message: startupStatus === 'failed'
            ? 'POS server startup failed. Check the server logs.'
            : 'POS server is starting. Please retry shortly.'
    });
});
const PRE_AUTH_ROUTES = new Set([
    'POST /api/auth/login',
    'GET /api/auth/login-policy',
    'POST /api/auth/webauthn/login/options',
    'POST /api/auth/webauthn/login/verify',
    'GET /api/auth/webauthn/status',
    'POST /api/auth/webauthn/enroll/options',
    'POST /api/auth/webauthn/enroll/verify',
    'GET /api/system/public_preferences',
    'GET /public_menu.json',
]);
const normalizePreAuthPath = value => {
    const pathValue = String(value || '/').toLowerCase();
    return pathValue.length > 1 ? pathValue.replace(/\/+$/, '') : pathValue;
};
const preAuthRouteKey = req => {
    const method = req.method === 'HEAD' ? 'GET' : String(req.method || '').toUpperCase();
    return `${method} ${normalizePreAuthPath(req.path)}`;
};
const isPreAuthRoute = req => PRE_AUTH_ROUTES.has(preAuthRouteKey(req));
const isOrderIntakeRoute = req => normalizePreAuthPath(req.path).startsWith('/api/order-intake/v1/');
// Shared-fate by design: all covered routes share 600 admissions/minute and
// dynamic routes share six truthful leases. No identity gets an observable exemption.
const preAuthGate = createGlobalPreAuthGate({
    trackConcurrency: req => normalizePreAuthPath(req.path) !== '/public_menu.json',
});
const orderIntakePreAuthGate = createGlobalPreAuthGate({ max: 300, maxConcurrent: 8 });
const tightPreAuthJson = express.json({ limit: '16kb' });
const tightPreAuthForm = express.urlencoded({ extended: true, limit: '16kb' });
const orderIntakeJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (isOrderIntakeRoute(req) ? orderIntakePreAuthGate(req, res, next) : next()));
app.use((req, res, next) => (isOrderIntakeRoute(req) ? orderIntakeJson(req, res, next) : next()));
app.use((req, res, next) => (isPreAuthRoute(req) ? tightPreAuthJson(req, res, next) : next()));
app.use((req, res, next) => (isPreAuthRoute(req) ? tightPreAuthForm(req, res, next) : next()));
app.use((req, res, next) => {
    if (String(req.method || '').toUpperCase() === 'POST'
        && normalizePreAuthPath(req.path) === '/api/spooler/v2/sync') {
        req.spoolerSyncStartedAt = performance.now();
        res.set('Cache-Control', 'no-store');
    }
    next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
app.use((req, res, next) => (isPreAuthRoute(req) ? preAuthGate(req, res, next) : next()));

// Attach Socket.io to request objects so route handlers can broadcast events
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Table-scoped QR cart writer (see backend/services/customerCartWriter.js). Routes reach it
// through req.app.locals so a draft read or a token revoke sees the same pending cart.
const customerCartWriter = createCustomerCartWriter({ db, io, logger, broadcastTableDraftChanged });
app.locals.customerCartWriter = customerCartWriter;

// ─── Socket.IO Connection Handlers ─────────────────────────────────────────────
// By this point all connections have passed the io.use() authorization middleware.
io.on('connection', (socket) => {
    if (socket.isCustomer) {
        // Public customer device (QR Table Menu)
        const tableRoom = `table_room_${socket.tableId}`;
        socket.join(tableRoom);
        logger.info({ socketId: socket.id, tableId: socket.tableId }, 'Customer connected via QR menu.');

        socket.on('customer_cart_updated', (payload) => {
            const { tableId, cart } = payload || {};

            // Security Gate: Assert tableId matches socket authorization to prevent cross-table hijacking
            if (parseInt(tableId) !== socket.tableId) {
                logger.warn({
                    socketId: socket.id,
                    socketTableId: socket.tableId,
                    payloadTableId: tableId
                }, 'Security Warning: Customer cart update tableId mismatch (hijack attempt blocked).');
                return;
            }
            if (!Array.isArray(cart) || cart.length > CUSTOMER_CART_MAX_LINES
                || cart.some(line => !line || typeof line !== 'object' || Array.isArray(line))) {
                logger.warn({ socketId: socket.id, tableId: socket.tableId }, 'Customer cart update rejected: not a valid cart.');
                return;
            }
            customerCartWriter.queue(socket.tableId, cart);
        });

        socket.on('disconnect', (reason) => {
            logger.info({ socketId: socket.id, tableId: socket.tableId, reason }, 'Customer disconnected.');
        });
    } else {
        // Authenticated browser client (POS terminal, Admin dashboard, waiter tablet)
        logger.info({ socketId: socket.id, userId: socket.user?.id, role: socket.user?.role }, 'Client connected.');
        socket.join(`user:${socket.user.id}`);
        socket.join(`session:${socket.authSession.session_id}`);
        if (socket.authSession.credential_id) socket.join(`credential:${socket.authSession.credential_id}`);
        // A revocation between the handshake check and the joins above missed this socket's
        // rooms. Every revocation clears the in-memory binding, so this read costs no query.
        if (getCachedSessionBinding(socket.rawSessionToken)?.session_id !== socket.authSession.session_id) {
            socket.disconnect(true);
            return;
        }
        watchSessionDeadline(socket, {
            findSession: findActiveSession,
            onError: (error) => logger.error({ err: error, socketId: socket.id }, 'Socket.IO: Session revalidation failed.'),
        });
        if (socket.user?.role === 'call_center') {
            socket.on('disconnect', (reason) => {
                logger.info({ socketId: socket.id, userId: socket.user?.id, reason }, 'Call-center client disconnected.');
            });
            return;
        }
        socket.join('staff');
        socket.join(staffTableRooms(socket.user));

        // Immediately send the current cached printer statuses to this newly connected client
        socket.emit('printer_status_changed', Object.values(getStaffPrinterStatuses()));

        // Immediately send the current count of failed print jobs
        // Answered from memory. The watchdog and spooler sync keep both current and
        // broadcast changes; if startup has not produced a value yet, it is computed
        // once for the whole staff room, not per socket.
        const failedCount = getLatestFailedPrintJobsCount();
        if (failedCount === null) void broadcastFailedPrintJobsCount();
        else socket.emit('failed_print_jobs_count', failedCount);
        if (latestStaleStations) socket.emit('stale_print_stations', { stations: latestStaleStations });

        // Answered after this socket joined 'staff': a later catalog change reaches
        // it as an event, so an equal token proves the client's snapshot is current.
        socket.on('catalog_generation', (ack) => {
            if (typeof ack === 'function') ack(getCatalogGenerationToken());
        });

        socket.on('disconnect', (reason) => {
            logger.info({ socketId: socket.id, userId: socket.user?.id, reason }, 'Client disconnected.');
        });
    }
});

// ─── Failed Print Queue Registry ────────────────────────────────────────────────
let latestStaleStations = null;
let failedCountRefresh = null;
function publishFailedPrintJobsCount(count) {
    io.to('staff').emit('failed_print_jobs_count', count);
}
// One in-flight read serves every caller that needs the count at the same time.
function coalescedFailedCountRefresh() {
    failedCountRefresh ||= refreshFailedPrintJobsCount(db, publishFailedPrintJobsCount)
        .finally(() => { failedCountRefresh = null; });
    return failedCountRefresh;
}
async function broadcastFailedPrintJobsCount() {
    try {
        await coalescedFailedCountRefresh();
    } catch (e) {
        logger.error({ err: e }, 'Failed to broadcast failed print jobs count.');
    }
}

const printQueueWatchdog = createPrintQueueWatchdogRunner({
    db,
    logger,
    wakeHub: spoolerSyncWakeHub,
    emitStale: payload => {
        latestStaleStations = payload.stations;
        io.to('staff').emit('stale_print_stations', payload);
    },
    emitLiveness: () => io.to('staff').emit('print_queue_updated', { source: 'station_liveness' }),
    onFailedCount: publishFailedPrintJobsCount
});
app.set('printQueueWatchdog', printQueueWatchdog);
// A committed enqueue or cancel request changes what the admin print-queue view shows.
// The wake hub is already published after every such commit; the admin view coalesces the events.
spoolerSyncWakeHub.subscribe(() => io.to('staff').emit('print_queue_updated', { source: 'enqueue' }));
const jofotaraOperationsRunner = createJofotaraOperationsRunner({
    processOperations: () => processJofotaraOperations(),
    recoverStale: () => markStaleSubmissionsUnknown(),
    publish: result => io.to('staff').emit('jofotara_operations_changed', result),
    logger
});
app.set('jofotaraOperationsRunner', jofotaraOperationsRunner);
const stockReportWorker = createStockReportWorkerRunner({ pool: db, logger });
app.set('stockReportWorker', stockReportWorker);

// ─── API Routes ─────────────────────────────────────────────────────────────────
const authRoutes = require('./backend/routes/auth');
const posRoutes = require('./backend/routes/pos');
const adminRoutes = require('./backend/routes/admin');
const systemRoutes = require('./backend/routes/system');
const printRoutes = require('./backend/routes/print');
const configRoutes = require('./backend/routes/config');
const spoolerV2Routes = require('./backend/routes/spoolerV2');
const orderIntakeRoutes = require('./backend/routes/orderIntake');

// No API path rewriting happens after this point. The pre-auth gate and the tight
// body parsers match on req.path, so any middleware that rewrites req.url below them
// silently creates an ungated alias for a covered route. A legacy `.php` normalizer
// lived here and did exactly that: /api/auth/login.php reached the login handler with
// no rate limit, no concurrency lease and the 1 MB parser. Nothing in this codebase
// has ever called a .php API route, so it was removed rather than reordered.

// GET /api/health
app.get('/api/health', async (req, res) => {
    if (startupStatus !== 'ready') {
        return res.status(503).json({
            success: false,
            status: startupStatus === 'failed' ? 'DOWN' : 'STARTING',
            database: 'INITIALIZING',
            release
        });
    }
    try {
        await db.query('SELECT 1');
        res.status(200).json({ success: true, status: 'UP', database: 'CONNECTED', release });
    } catch (err) {
        logger.error({ err }, 'Health check failed');
        res.status(500).json({ success: false, status: 'DOWN', database: 'DISCONNECTED', release, error: err.message });
    }
});

app.use('/api/auth', authRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/print', printRoutes);
app.use('/api/spooler/v2', spoolerV2Routes.router);
app.use('/api/order-intake/v1', orderIntakeRoutes);

// ─── Static Frontend Serving ────────────────────────────────────────────────────
// Serve compiled static assets from dist first
const distRoot = path.join(__dirname, 'dist');
const sendDistFile = (file) => (req, res) => res.sendFile(file, { root: distRoot });
const { setFrontendStaticHeaders } = require('./backend/http/frontendStaticHeaders');
app.use(express.static(distRoot, { setHeaders: setFrontendStaticHeaders }));
const uploadDir = process.env.POSAPP_UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));


// If a build emptied dist while the server stayed alive, regenerate the static menu on demand.
app.get('/public_menu.json', async (req, res) => {
    const menuPath = path.join(__dirname, 'dist', 'public_menu.json');
    try {
        if (!fs.existsSync(menuPath)) {
            await generateStaticMenu();
        }
        if (fs.existsSync(menuPath)) {
            return res.sendFile('public_menu.json', { root: distRoot });
        }
        return res.status(503).json({ success: false, message: 'Menu cache is unavailable.' });
    } catch (err) {
        logger.error({ err }, 'Failed to serve public menu cache.');
        return res.status(500).json({ success: false, message: 'Failed to load public menu.' });
    }
});

// Serve the main assets folder (css, js, images) natively as fallback
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve clean HTML pages from Vite's dist build
app.get('/login', sendDistFile('login.html'));
app.get('/device-enrollment', sendDistFile('login.html'));
app.get('/pos', sendDistFile('index.html'));
app.get('/tables', sendDistFile('index.html'));
app.get('/order-notes', sendDistFile('index.html'));
app.get('/ai-catalog', (req, res) => res.redirect('/admin/inventory'));
app.get('/table-splits', sendDistFile('index.html'));
app.get(/^\/admin(?:\/.*)?$/, sendDistFile('admin.html'));

app.get('/menu', sendDistFile('menu.html'));
app.get('/print-receipt', sendDistFile('print_receipt.html'));

// Legacy redirects for 301 support of old .php urls preserving query parameters
const redirectWithQuery = (target) => (req, res) => {
    const queryString = new URLSearchParams(req.query).toString();
    res.redirect(301, queryString ? `${target}?${queryString}` : target);
};

app.get('/login.php', redirectWithQuery('/login'));
app.get('/index.php', redirectWithQuery('/pos'));
app.get('/admin.php', redirectWithQuery('/admin/dashboard'));
app.get('/tables.php', redirectWithQuery('/tables'));
app.get('/menu.php', redirectWithQuery('/menu'));
app.get('/print_receipt.php', redirectWithQuery('/print-receipt'));
app.get('/print_receipt.html', redirectWithQuery('/print-receipt'));

// Explicitly serve static PWA files
app.get('/manifest.json', (req, res) => res.sendFile('manifest.json', { root: __dirname }));
app.get('/favicon.ico', (req, res) => {
    const faviconPath = path.join(__dirname, 'favicon.ico');
    if (fs.existsSync(faviconPath)) {
        res.sendFile('favicon.ico', { root: __dirname });
    } else {
        res.status(204).end(); // No Content
    }
});

app.get('/', (req, res) => res.redirect('/pos'));

// ─── Health Check ────────────────────────────────────────────────────────────────
// Probed by load balancers, PM2, and uptime monitors.
// Returns 200 OK when the DB is reachable, 503 when degraded.
app.get('/health', async (req, res) => {
    if (startupStatus !== 'ready') {
        return res.status(503).json({
            status: startupStatus,
            db: 'initializing',
            release,
            timestamp: new Date().toISOString()
        });
    }
    try {
        await db.query('SELECT 1');
        res.json({
            status: 'ok',
            db: 'connected',
            release,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        logger.error({ err: e }, 'Health check DB ping failed.');
        res.status(503).json({
            status: 'degraded',
            db: 'disconnected',
            release,
            timestamp: new Date().toISOString()
        });
    }
});

// ─── Express Global Error Handler ────────────────────────────────────────────────
// Catches any error passed to next(err) or thrown from an async route in Express 5.
// Must be registered AFTER all routes and BEFORE server.listen.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error({
        err,
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role,
    }, 'Unhandled route error caught by Express error middleware.');

    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;
    // Never leak internal error details to clients in production
    const message = process.env.NODE_ENV === 'production' || status === 500
        ? 'An unexpected server error occurred. Please try again.'
        : err.message;

    res.status(status).json({ success: false, message });
});

// ─── Start Server ───────────────────────────────────────────────────────────────
// Guard: do not start the HTTP server when this module is imported by tests.
// Supertest creates its own ephemeral server; calling server.listen() here
// would conflict with it and leave an open handle blocking test exit.
function onServerStarted() {
    logger.info(`POS Server running on port ${PORT}`);
    printQueuePurge.start();
    void printQueueWatchdog.start();
    void jofotaraOperationsRunner.start();
    void stockReportWorker.start();
    if (!ENFORCE_HTTPS) {
        logger.warn('ENFORCE_HTTPS is disabled. Session cookies are sent over HTTP. Set ENFORCE_HTTPS=true in .env for any non-localhost deployment.');
    }
    generateStaticMenu(); // Generate static menu cache on startup

    // ── Print queue orphan reset ──────────────────────────────────────────────
    broadcastFailedPrintJobsCount()
        .catch(e => logger.warn({ err: e }, 'Failed to read print queue status on startup.'));

    // ── Stale QR draft cleanup ────────────────────────────────────────────────
    // QR customers who abandon their session without ordering leave orphaned rows
    // in qr_table_drafts. Clean up any draft whose table is no longer occupied
    // (status = 'available' guarantees no active order exists for that table).
    async function cleanStaleQrDrafts() {
        try {
            const [result] = await db.query(`
                DELETE qd FROM qr_table_drafts qd
                JOIN restaurant_tables t ON qd.table_id = t.id
                WHERE t.status = 'available'
            `);
            if (result.affectedRows > 0) {
                logger.info({ count: result.affectedRows }, 'Cleaned up stale QR table drafts.');
            }
        } catch (e) {
            logger.warn({ err: e }, 'Failed to clean up stale QR table drafts (non-fatal).');
        }
    }
    cleanStaleQrDrafts(); // run immediately on startup
    setInterval(cleanStaleQrDrafts, 60 * 60 * 1000); // then hourly

    const cleanExpiredYArchives = () => cleanupExpiredYHeldReportArchives(db)
        .catch(e => logger.warn({ err: e }, 'Failed to clean expired Y report snapshots (non-fatal).'));
    cleanExpiredYArchives();
    setInterval(cleanExpiredYArchives, 60 * 60 * 1000);
}

function listenForStartup() {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(PORT, () => {
            server.off('error', onError);
            resolve(server);
        });
    });
}

async function startServer() {
    startupStatus = 'starting';
    await (startupListenPromise || listenForStartup());
    try {
        await migrateAndValidate(db, { logger });
        startupStatus = 'ready';
        db.databaseRuntime.start();
        onServerStarted();
        return server;
    } catch (error) {
        startupStatus = 'failed';
        throw error;
    }
}

if (process.env.NODE_ENV !== 'test') {
    startServer().catch(async err => {
        logger.fatal({ err }, 'Database migration or schema validation failed. POS server was not started.');
        try {
            await db.end();
        } catch (closeError) {
            logger.error({ err: closeError }, 'Failed to close the database pool after startup validation failed.');
        }
        process.exit(1);
    });
}

// ─── Graceful Shutdown Handler ──────────────────────────────────────────────────
const pool = db;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;
let shutdownStarted = false;

function gracefulShutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    const databaseMaintenanceStop = pool.databaseRuntime.stopMaintenance();
    const printQueuePurgeStop = printQueuePurge.stop();
    const printQueueWatchdogStop = printQueueWatchdog.stop();
    const jofotaraOperationsRunnerStop = jofotaraOperationsRunner.stop();
    const stockReportWorkerStop = stockReportWorker.stop();

    // Set a timeout to force exit if cleanup hangs (e.g. frozen connection)
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out. Forcing process exit...');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    spoolerSyncWakeHub.close();
    // Writes the carts still pending (bounded); awaited below before the pool closes.
    const customerCartDrain = customerCartWriter.shutdown();

    // 1. Close Socket.io server to disconnect all client WebSockets
    try {
        logger.info('Closing Socket.io server...');
        io.close();
        logger.info('Socket.io server closed.');
    } catch (ioErr) {
        logger.error({ err: ioErr }, 'Error closing Socket.io server.');
    }

    // 2. Stop accepting new HTTP connections and wait for in-flight requests to complete
    logger.info('Closing HTTP server...');
    server.close(async (err) => {
        if (err) {
            logger.error({ err }, 'Error during HTTP server close.');
        } else {
            logger.info('HTTP server closed. In-flight requests completed.');
        }

        // 3. Drain and close MySQL connection pool
        try {
            logger.info('Draining MySQL connection pool...');
            try {
                await Promise.all([
                    databaseMaintenanceStop,
                    printQueuePurgeStop,
                    printQueueWatchdogStop,
                    jofotaraOperationsRunnerStop,
                    stockReportWorkerStop,
                    customerCartDrain
                ]);
                await pool.databaseRuntime.stop();
            } catch (error) {
                logger.error({
                    event: 'database_runtime_stop_failed',
                    code: String(error?.code || 'UNKNOWN')
                }, 'Database connection runtime did not stop cleanly.');
            }
            await pool.end();
            logger.info('MySQL connection pool closed.');
        } catch (dbErr) {
            logger.error({ err: dbErr }, 'Error closing MySQL connection pool.');
        }

        clearTimeout(forceExitTimeout);
        logger.info('Process exiting cleanly.');
        process.exit(0);
    });
}

if (process.env.NODE_ENV !== 'test') {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Capture PM2 shutdown message on Windows (passed via process IPC)
    process.on('message', (msg) => {
        if (msg === 'shutdown') {
            gracefulShutdown('shutdown');
        }
    });

    // ─── Process-Level Crash Handlers ────────────────────────────────────────────
    // Without these, an unhandled promise rejection (Node 15+) or uncaught exception
    // crashes the process immediately with no log entry and no graceful cleanup.
    // These handlers ensure: (a) a FATAL log is written, (b) shutdown drains cleanly.
    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'Uncaught exception — initiating graceful shutdown.');
        gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        logger.fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) },
            'Unhandled promise rejection — initiating graceful shutdown.');
        gracefulShutdown('unhandledRejection');
    });
}

module.exports = {
    app,
    server,
    io,
    customerCartWriter,
    startServer
};

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('V2-only spooler delivery contract', () => {
  it('shares the failed-print badge count and locks the station row without unused columns', () => {
    const watchdog = read('backend/services/printQueueWatchdog.js');
    const server = read('server.js');
    const routes = read('backend/routes/spoolerV2.js');
    const sync = read('backend/services/spoolerSync.js');
    const agents = read('backend/services/spoolerAgents.js');
    expect(watchdog).toContain('function getFailedPrintJobsCount');
    expect(server).toContain('refreshFailedPrintJobsCount');
    expect(routes).toContain('refreshFailedPrintJobsCount');
    expect(routes).not.toMatch(/SELECT COUNT\(\*\)[\s\S]{0,80}failed['"]?, ['"]dead_letter/);
    expect(sync).toContain('SELECT spooler_id FROM spooler_stations WHERE spooler_id = ? FOR UPDATE');
    expect(sync).not.toContain('SELECT first_v2_accepted_at FROM spooler_stations');
    expect(agents).not.toContain('getStationCutoverStatus');
    expect(agents).toContain('function getStationStatus');
    expect(routes).toContain('getStationStatus');
  });

  it('timestamps and disables caching for every Express-compatible sync alias before body parsing', () => {
    const server = read('server.js');
    const routes = read('backend/routes/spoolerV2.js');
    const middleware = server.indexOf('spoolerSyncStartedAt');
    const jsonParser = server.indexOf("app.use(express.json({ limit: process.env.JSON_BODY_LIMIT");
    expect(middleware).toBeGreaterThan(-1);
    expect(middleware).toBeLessThan(jsonParser);
    expect(server).toContain("'/api/spooler/v2/sync'");
    expect(server).toMatch(/toLowerCase\(\)[\s\S]{0,160}replace\(\/\\\/\+\$\//);
    expect(server).toContain("res.set('Cache-Control', 'no-store')");
    expect(routes).toContain("res.set('Cache-Control', 'no-store')");
  });

  it('keeps waits separate from authentication and never recreates connection ownership', () => {
    const routes = read('backend/routes/spoolerV2.js');
    const client = read('pos-spooler-printer/v2/sync-client.js');
    expect(routes).toContain("router.post('/sync', spoolerSyncLifecycle, requireAgentAuth");
    expect(routes).not.toContain('spooler_id_already_connected');
    expect(routes).not.toContain('connectedAgents');
    expect(client).not.toContain('socket.io-client');
    expect(client).not.toContain('/v3');
  });

  it('releases held syncs before closing shared network servers', () => {
    const server = read('server.js');
    const shutdown = server.slice(server.indexOf('function gracefulShutdown'));
    expect(shutdown.indexOf('spoolerSyncWakeHub.close()')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('spoolerSyncWakeHub.close()')).toBeLessThan(shutdown.indexOf('io.close()'));
    expect(shutdown.indexOf('spoolerSyncWakeHub.close()')).toBeLessThan(shutdown.indexOf('server.close('));
  });

  it('owns and drains the event-first print watchdog before closing the pool', () => {
    const server = read('server.js');
    const routes = read('backend/routes/spoolerV2.js');
    const shutdown = server.slice(server.indexOf('function gracefulShutdown'));
    expect(server).toContain("app.set('printQueueWatchdog', printQueueWatchdog)");
    expect(server).toContain('void printQueueWatchdog.start()');
    expect(shutdown.indexOf('printQueueWatchdog.stop()')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('printQueueWatchdog.stop()')).toBeLessThan(shutdown.indexOf('pool.end()'));
    expect(server).not.toMatch(/setInterval\(async \(\) => \{\s*try \{\s*const health = await getPrintQueueHealth/s);
    expect(routes.indexOf("req.app.get('printQueueWatchdog')?.wake()")).toBeGreaterThan(-1);
    expect(routes.indexOf("req.app.get('printQueueWatchdog')?.wake()")).toBeLessThan(routes.indexOf('if (outcome.aborted || res.writableEnded) return'));
  });

  it('owns and drains JoFotara recovery without an overlapping interval', () => {
    const server = read('server.js');
    const shutdown = server.slice(server.indexOf('function gracefulShutdown'));
    expect(server).toContain("app.set('jofotaraOperationsRunner', jofotaraOperationsRunner)");
    expect(server).toContain('void jofotaraOperationsRunner.start()');
    expect(server).not.toContain('setInterval(processJofotara, 60 * 1000)');
    expect(shutdown.indexOf('jofotaraOperationsRunner.stop()')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('jofotaraOperationsRunner.stop()')).toBeLessThan(shutdown.indexOf('pool.end()'));
  });

  it('owns and drains the stock report worker before closing the pool', () => {
    const server = read('server.js');
    const shutdown = server.slice(server.indexOf('function gracefulShutdown'));
    expect(server).toContain("app.set('stockReportWorker', stockReportWorker)");
    expect(server).toContain('void stockReportWorker.start()');
    expect(shutdown.indexOf('stockReportWorker.stop()')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('stockReportWorker.stop()')).toBeLessThan(shutdown.indexOf('pool.end()'));
  });
});

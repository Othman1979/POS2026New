const { spawnSync } = require('node:child_process');
const path = require('node:path');

describe('server process lifecycle ownership', () => {
    it('does not install signal or crash handlers when imported by a test runner', () => {
        const root = path.resolve(__dirname, '../../..');
        const probe = `
            const events = ['SIGINT', 'SIGTERM', 'message', 'uncaughtException', 'unhandledRejection'];
            const before = Object.fromEntries(events.map(event => [event, process.listenerCount(event)]));
            require('./server');
            const added = Object.fromEntries(events.map(event => [event, process.listenerCount(event) - before[event]]));
            console.log('PROCESS_LIFECYCLE_PROBE=' + JSON.stringify(added));
            process.exit(0);
        `;
        const result = spawnSync(process.execPath, ['-e', probe], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                LOG_LEVEL: 'silent',
            },
        });

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('PROCESS_LIFECYCLE_PROBE='));
        expect(line).toBeTruthy();
        expect(JSON.parse(line.slice('PROCESS_LIFECYCLE_PROBE='.length))).toEqual({
            SIGINT: 0,
            SIGTERM: 0,
            message: 0,
            uncaughtException: 0,
            unhandledRejection: 0,
        });
    });
});

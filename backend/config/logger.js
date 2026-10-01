const pino = require('pino');
const fs = require('fs');
const path = require('path');

const logsDir = process.env.POSAPP_LOG_DIR || path.join(__dirname, '../../logs');
const output = process.env.LOG_OUTPUT || (process.env.POSAPP_LOG_DIR ? 'files' : 'stdout');
if (!['stdout', 'files'].includes(output)) throw new Error('LOG_OUTPUT must be stdout or files.');

const isDev = process.env.NODE_ENV !== 'production';

let logger;

if (isDev) {
    // Development: pretty colored output to stdout
    logger = pino({
        level: process.env.LOG_LEVEL || 'debug',
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
            }
        }
    });
} else if (output === 'stdout') {
    // The host collects stdout. Avoid a permanent V8 worker for a simple JSON destination.
    logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: { err: pino.stdSerializers.err, req: pino.stdSerializers.req, res: pino.stdSerializers.res }
    }, pino.destination({ dest: 1, sync: false }));
} else {
    // Opt-in local rotation for installations that need files in addition to host logs.
    fs.mkdirSync(logsDir, { recursive: true });
    logger = pino(
        {
            level: process.env.LOG_LEVEL || 'debug',
            timestamp: pino.stdTimeFunctions.isoTime,
            serializers: {
                err: pino.stdSerializers.err,
                req: pino.stdSerializers.req,
                res: pino.stdSerializers.res,
            }
        },
        pino.transport({
            targets: [
                // 1. Stream standard logs directly to stdout (file descriptor 1)
                {
                    target: 'pino/file',
                    options: { destination: 1 },
                    level: process.env.LOG_LEVEL || 'info'
                },
                // 2. Stream debug logs to a rotating log file using pino-roll
                {
                    target: 'pino-roll',
                    options: {
                        file: path.join(logsDir, 'app.log'),
                        size: '10m',      // Rotate when the active log hits 10MB
                        mkdir: true,      // Auto-create directory if missing
                        limit: {
                            count: 5      // Keep a maximum of 5 rotated logs, deleting older ones
                        }
                    },
                    level: 'debug'
                }
            ]
        })
    );
}

module.exports = logger;

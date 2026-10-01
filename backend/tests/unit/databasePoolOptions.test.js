const path = require('path');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');

const mysql2Root = path.dirname(require.resolve('mysql2/package.json'));
const getTextParser = require(path.join(mysql2Root, 'lib/parsers/text_parser.js'));
const getBinaryParser = require(path.join(mysql2Root, 'lib/parsers/binary_parser.js'));
const Packet = require(path.join(mysql2Root, 'lib/packets/packet.js'));
const Types = require(path.join(mysql2Root, 'lib/constants/types.js'));

function decodeMariaDbJson(poolOptions, json, getParser) {
    const bytes = json === null ? null : Buffer.from(json, 'utf8');
    const fields = [{
        columnType: Types.LONG_BLOB,
        extendedFormat: 'json',
        characterSet: 224,
        encoding: 'utf8',
        columnLength: bytes?.length || 0,
        schema: 'pos',
        table: 'print_queue',
        name: 'payload'
    }];
    const binary = getParser === getBinaryParser;
    const row = binary
        ? Buffer.concat([
            Buffer.from([0, json === null ? 4 : 0]),
            ...(bytes ? [Buffer.from([bytes.length]), bytes] : [])
        ])
        : bytes
            ? Buffer.concat([Buffer.from([bytes.length]), bytes])
            : Buffer.from([0xfb]);
    const packet = new Packet(
        0,
        Buffer.concat([Buffer.alloc(4), row]),
        0,
        row.length + 4
    );
    const queryOptions = {};
    const RowParser = getParser(fields, queryOptions, poolOptions);
    return new RowParser(fields).next(packet, fields, queryOptions).payload;
}

describe('database pool options', () => {
    const credentials = {
        DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'app',
        DB_PASSWORD: 'secret', DB_NAME: 'pos'
    };

    it('uses a bounded reusable production pool', () => {
        expect(buildDatabasePoolOptions(credentials)).toMatchObject({
            host: '127.0.0.1', port: 3306,
            connectionLimit: 10, maxIdle: 2, idleTimeout: 45000,
            gracefulEnd: true, queueLimit: 50,
            enableKeepAlive: true, keepAliveInitialDelay: 0,
            connectTimeout: 10000
        });
    });

    it.each([
        ['text query', getTextParser],
        ['binary prepared-statement', getBinaryParser]
    ])('preserves MariaDB JSON columns as JSON text through mysql2 %s decoding', (_name, parser) => {
        const json = '{"printer_name":"المطبخ","data":{"items":[1]}}';

        const decoded = decodeMariaDbJson(buildDatabasePoolOptions(credentials), json, parser);

        expect(decoded).toBe(json);
        expect(JSON.parse(decoded)).toEqual({
            printer_name: 'المطبخ',
            data: { items: [1] }
        });
    });

    it.each([
        ['text query', getTextParser],
        ['binary prepared-statement', getBinaryParser]
    ])('retains SQL NULL through mysql2 %s JSON decoding', (_name, parser) => {
        const decoded = decodeMariaDbJson(buildDatabasePoolOptions(credentials), null, parser);
        expect(decoded).toBeNull();
    });

    it('honors small valid overrides without allowing an unbounded queue', () => {
        expect(buildDatabasePoolOptions({
            ...credentials, DB_CONNECTION_LIMIT: '5', DB_QUEUE_LIMIT: '0'
        })).toMatchObject({ connectionLimit: 5, maxIdle: 2, queueLimit: 50 });
        expect(buildDatabasePoolOptions({
            ...credentials, DB_CONNECTION_LIMIT: '2'
        })).toMatchObject({ connectionLimit: 2, maxIdle: 1 });
        expect(buildDatabasePoolOptions({
            ...credentials, DB_CONNECTION_LIMIT: '1'
        })).toMatchObject({ connectionLimit: 1, maxIdle: 1 });
    });

    it.each([
        ['DB_CONNECTION_LIMIT', 'abc'], ['DB_CONNECTION_LIMIT', '0'],
        ['DB_QUEUE_LIMIT', '-1'], ['DB_PORT', 'invalid']
    ])('fails closed for invalid %s=%s', (key, value) => {
        expect(() => buildDatabasePoolOptions({ ...credentials, [key]: value }))
            .toThrow(/Invalid database configuration/);
    });
});

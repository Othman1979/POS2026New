const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const IGNORED_TABLES = new Set(['schema_migrations']);
const IGNORED_INDEXES = new Set();

const loadEnvFile = (filename) => {
    const filePath = path.resolve(__dirname, '..', filename);
    if (!fs.existsSync(filePath)) {
        console.error(`\x1b[31m[-] Configuration file ${filename} not found.\x1b[0m`);
        process.exit(1);
    }
    return dotenv.parse(fs.readFileSync(filePath));
};

async function run() {
    const devEnv = loadEnvFile('.env');
    const testEnv = loadEnvFile('.env.test');

    const devDbName = devEnv.DB_NAME || 'posapp';
    const testDbName = testEnv.DB_NAME || 'posapp_test';

    console.log(`\x1b[36m[*] Comparing Dev Database (${devDbName}) and Test Database (${testDbName})...\x1b[0m`);

    let devConn, testConn;
    try {
        devConn = await mysql.createConnection({
            host: devEnv.DB_HOST || '127.0.0.1',
            user: devEnv.DB_USER || 'root',
            password: devEnv.DB_PASSWORD || '',
            database: devDbName
        });
    } catch (err) {
        console.error(`\x1b[31m[-] Failed to connect to Dev Database (${devDbName}): ${err.message}\x1b[0m`);
        process.exit(1);
    }

    try {
        testConn = await mysql.createConnection({
            host: testEnv.DB_HOST || '127.0.0.1',
            user: testEnv.DB_USER || 'root',
            password: testEnv.DB_PASSWORD || '',
            database: testDbName
        });
    } catch (err) {
        console.error(`\x1b[31m[-] Failed to connect to Test Database (${testDbName}): ${err.message}\x1b[0m`);
        devConn.end();
        process.exit(1);
    }

    try {
        let hasDrift = false;

        // 1. Compare Tables
        const [devTablesRows] = await devConn.query('SHOW TABLES');
        const [testTablesRows] = await testConn.query('SHOW TABLES');

        const devTables = devTablesRows.map(r => Object.values(r)[0]).filter(table => !IGNORED_TABLES.has(table));
        const testTables = testTablesRows.map(r => Object.values(r)[0]).filter(table => !IGNORED_TABLES.has(table));

        const missingInTest = devTables.filter(t => !testTables.includes(t));
        const extraInTest = testTables.filter(t => !devTables.includes(t));

        if (missingInTest.length > 0) {
            console.error(`\x1b[31m[-] Missing tables in Test Database: ${missingInTest.join(', ')}\x1b[0m`);
            hasDrift = true;
        }
        if (extraInTest.length > 0) {
            console.error(`\x1b[31m[-] Extra tables in Test Database: ${extraInTest.join(', ')}\x1b[0m`);
            hasDrift = true;
        }

        // 2. Compare Columns
        const [devColumnRows] = await devConn.query(`
            SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ?
        `, [devDbName]);

        const [testColumnRows] = await testConn.query(`
            SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ?
        `, [testDbName]);

        const devCols = devColumnRows.filter(column => !IGNORED_TABLES.has(column.TABLE_NAME));
        const testCols = testColumnRows.filter(column => !IGNORED_TABLES.has(column.TABLE_NAME));
        const makeColKey = (c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`;
        const devColMap = new Map(devCols.map(c => [makeColKey(c), c]));
        const testColMap = new Map(testCols.map(c => [makeColKey(c), c]));

        for (const [key, devCol] of devColMap.entries()) {
            const testCol = testColMap.get(key);
            if (!testCol) {
                if (testTables.includes(devCol.TABLE_NAME)) {
                    console.error(`\x1b[31m[-] Column '${key}' is missing in Test Database.\x1b[0m`);
                    hasDrift = true;
                }
                continue;
            }

            const mismatches = [];
            if (devCol.COLUMN_TYPE !== testCol.COLUMN_TYPE) {
                mismatches.push(`Type: expected '${devCol.COLUMN_TYPE}', got '${testCol.COLUMN_TYPE}'`);
            }
            if (devCol.IS_NULLABLE !== testCol.IS_NULLABLE) {
                mismatches.push(`Nullable: expected '${devCol.IS_NULLABLE}', got '${testCol.IS_NULLABLE}'`);
            }
            if (devCol.COLUMN_DEFAULT !== testCol.COLUMN_DEFAULT) {
                mismatches.push(`Default: expected '${devCol.COLUMN_DEFAULT}', got '${testCol.COLUMN_DEFAULT}'`);
            }

            if (mismatches.length > 0) {
                console.error(`\x1b[31m[-] Mismatched definition for Column '${key}':\n    ${mismatches.join('\n    ')}\x1b[0m`);
                hasDrift = true;
            }
        }

        for (const key of testColMap.keys()) {
            if (!devColMap.has(key)) {
                const tableName = key.split('.')[0];
                if (devTables.includes(tableName)) {
                    console.error(`\x1b[31m[-] Extra Column '${key}' exists in Test Database.\x1b[0m`);
                    hasDrift = true;
                }
            }
        }

        // 3. Compare Indexes
        const [devIndexRows] = await devConn.query(`
            SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = ?
        `, [devDbName]);

        const [testIndexRows] = await testConn.query(`
            SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = ?
        `, [testDbName]);

        const includedIndex = index => !IGNORED_TABLES.has(index.TABLE_NAME) &&
            !IGNORED_INDEXES.has(`${index.TABLE_NAME}.${index.INDEX_NAME}`);
        const devIndexes = devIndexRows.filter(includedIndex);
        const testIndexes = testIndexRows.filter(includedIndex);
        const makeIdxKey = (i) => `${i.TABLE_NAME}.${i.INDEX_NAME}.${i.SEQ_IN_INDEX}`;
        const devIdxMap = new Map(devIndexes.map(i => [makeIdxKey(i), i]));
        const testIdxMap = new Map(testIndexes.map(i => [makeIdxKey(i), i]));

        for (const [key, devIdx] of devIdxMap.entries()) {
            const testIdx = testIdxMap.get(key);
            if (!testIdx) {
                if (testTables.includes(devIdx.TABLE_NAME)) {
                    console.error(`\x1b[31m[-] Index '${devIdx.INDEX_NAME}' (part ${devIdx.SEQ_IN_INDEX}) is missing on Table '${devIdx.TABLE_NAME}' in Test Database.\x1b[0m`);
                    hasDrift = true;
                }
                continue;
            }

            const mismatches = [];
            if (devIdx.COLUMN_NAME !== testIdx.COLUMN_NAME) {
                mismatches.push(`Column: expected '${devIdx.COLUMN_NAME}', got '${testIdx.COLUMN_NAME}'`);
            }
            if (devIdx.NON_UNIQUE !== testIdx.NON_UNIQUE) {
                mismatches.push(`Non-Unique: expected '${devIdx.NON_UNIQUE}', got '${testIdx.NON_UNIQUE}'`);
            }

            if (mismatches.length > 0) {
                console.error(`\x1b[31m[-] Mismatched definition for Index '${devIdx.INDEX_NAME}' on Table '${devIdx.TABLE_NAME}':\n    ${mismatches.join('\n    ')}\x1b[0m`);
                hasDrift = true;
            }
        }

        for (const key of testIdxMap.keys()) {
            if (!devIdxMap.has(key)) {
                const parts = key.split('.');
                const tableName = parts[0];
                const indexName = parts[1];
                if (devTables.includes(tableName)) {
                    console.error(`\x1b[31m[-] Extra Index '${indexName}' exists on Table '${tableName}' in Test Database.\x1b[0m`);
                    hasDrift = true;
                }
            }
        }

        if (hasDrift) {
            console.error(`\x1b[31m[-] Database Schema comparison failed: Drift detected.\x1b[0m`);
            process.exit(1);
        } else {
            console.log(`\x1b[32m[+] Database Schema comparison succeeded: zero drift detected.\x1b[0m`);
            process.exit(0);
        }
    } catch (err) {
        console.error(`\x1b[31m[-] An error occurred during schema validation: ${err.message}\x1b[0m`);
        process.exit(1);
    } finally {
        await devConn.end();
        await testConn.end();
    }
}

run();

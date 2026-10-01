const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname,'../..');
const dbName = process.env.POSAPP_REVIEW_DB;
assert.match(dbName || '',/^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME,dbName);
const targetName='2026-09-05-recipe-ledger-v1';
const predecessor='2026-09-03-y-order-type-setting-v1';
const results={head:'d6cc1ab2',database:dbName};
async function main() {
    const admin=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
    await admin.query('CREATE DATABASE '+dbName+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    const [[engine]]=await admin.query('SELECT VERSION() AS version');results.engine=engine.version;
    await admin.end();
    // Use the actual pre-Task-2 fixture from Git, not today's fixture minus guessed columns.
    const filename=path.join(root,'backend/tests/fixtures/seed.js');
    const prior=execFileSync('git',['show','74820d4b:backend/tests/fixtures/seed.js'],{cwd:root,encoding:'utf8'});
    const fixture=new Module(filename,module);fixture.filename=filename;
    fixture.paths=Module._nodeModulePaths(path.dirname(filename));fixture._compile(prior,filename);
    await fixture.exports.seedDatabase();
    const pool=mysql.createPool({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:dbName});
    const {runPendingMigrations,splitMysqlScript}=require('../../backend/migrations/runPendingMigrations');
    try {
        const manifest=JSON.parse(fs.readFileSync(path.join(root,'backend/migrations/auto-manifest.json'),'utf8'));
        const targetIndex=manifest.migrations.findIndex(m=>m.name===targetName);
        const entry=manifest.migrations[targetIndex];
        // The earlier fixture stops its ledger one migration before the required
        // predecessor. Advance with the real runner, without synthesizing ledger rows.
        const predecessorManifest=path.join(root,'backend/migrations',dbName+'.review.json');
        fs.writeFileSync(predecessorManifest,JSON.stringify({migrations:manifest.migrations.slice(0,targetIndex)}),{flag:'wx'});
        try { results.predecessorPreparation=await runPendingMigrations(pool,{manifestPath:predecessorManifest}); }
        finally { fs.unlinkSync(predecessorManifest); }
        const [[ledger]]=await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?',[predecessor]);
        assert.equal(ledger.checksum,'4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3');
        const [[before]]=await pool.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'");
        assert.equal(Number(before.n),0);
        results.upgrade=await runPendingMigrations(pool);
        assert.deepEqual(results.upgrade.applied,[targetName]);
        results.noop=await runPendingMigrations(pool);
        assert.deepEqual(results.noop.applied,[]);
        const automatic=fs.readFileSync(path.join(root,'backend/migrations',targetName+'.auto.sql'),'utf8');
        // Verify the shipped SQL's own repeat safety in addition to runner ledger skip.
        for(const sql of splitMysqlScript(automatic))await pool.query(sql);
        results.directRepeat='PASS';
        results.schema={};
        for(const table of ['ingredients','product_recipe_lines','ingredient_movements','order_items','subscription_redemption_items']) {
            const [[create]]=await pool.query('SHOW CREATE TABLE '+table);
            results.schema[table]=create['Create Table'];
        }
        const temp=fs.mkdtempSync(path.join(__dirname,'recipe-p1-manifest-'));
        const scoped=path.join(temp,'manifest.json');
        fs.writeFileSync(scoped,JSON.stringify({migrations:[entry]}));
        fs.writeFileSync(path.join(temp,entry.file),automatic);
        // Scope fail-closed checks to this migration, preserving exact checked-in entry and SQL bytes.
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[predecessor]);
        try { await runPendingMigrations(pool,{manifestPath:scoped});assert.fail('Missing predecessor accepted'); }
        catch(error) { assert.match(error.message,/requires .*exact checksum/);results.missingPredecessor=error.message; }
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[predecessor,entry.requires.checksum]);
        await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?',['0'.repeat(64),targetName]);
        try { await runPendingMigrations(pool,{manifestPath:scoped});assert.fail('Checksum conflict accepted'); }
        catch(error) { assert.match(error.message,/checksum conflict/);results.checksumConflict=error.message; }
        await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?',[entry.checksum,targetName]);
        // Only remove exact files created by this script; no recursive filesystem cleanup.
        fs.unlinkSync(scoped);fs.unlinkSync(path.join(temp,entry.file));fs.rmdirSync(temp);
        results.status='PASS';
    } finally { await pool.end(); }
}
main().catch(error=>{results.status='FAIL';results.error=error.message;process.exitCode=1;})
    .finally(()=>{fs.writeFileSync(path.join(__dirname,'recipe-ledger-phase1-migration-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({...results,schema:results.schema?Object.keys(results.schema):undefined}));});

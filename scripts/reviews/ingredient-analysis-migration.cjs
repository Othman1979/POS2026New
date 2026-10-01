const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const Module=require('node:module');
const {execFileSync}=require('node:child_process');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${crypto.randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const {getTestDatabaseOptions}=require('../../backend/tests/testDatabase.cjs');
const mysql=require('mysql2/promise');
const root=path.resolve(__dirname,'../..');
const name='2026-09-07-ingredient-analysis-v1';
const {database,...options}=getTestDatabaseOptions();
let created=false;
async function main(){
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'backend/migrations/auto-manifest.json'),'utf8'));
    const entry=manifest.migrations.find(item=>item.name===name);
    const sql=fs.readFileSync(path.join(root,'backend/migrations',entry.file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(crypto.createHash('sha256').update(sql).digest('hex'),entry.sha256);
    const fallback=fs.readFileSync(path.join(root,'deployment/database/hostinger-manual-migrations.sql'),'utf8').replace(/\r\n/g,'\n');
    assert(fallback.includes(`-- BEGIN AUTO MIGRATION: ${name} | ${entry.checksum}\n${sql}-- END AUTO MIGRATION: ${name} | ${entry.checksum}`));
    const admin=await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);created=true;await admin.end();
    const filename=path.join(root,'backend/tests/fixtures/seed.js');
    const prior=execFileSync('git',['show','edded956:backend/tests/fixtures/seed.js'],{cwd:root,encoding:'utf8'});
    const fixture=new Module(filename,module);fixture.filename=filename;fixture.paths=Module._nodeModulePaths(path.dirname(filename));fixture._compile(prior,filename);
    await fixture.exports.seedDatabase();
    const pool=mysql.createPool({...options,database,connectionLimit:1});
    try{
        const {runPendingMigrations}=require('../../backend/migrations/runPendingMigrations');
        const [[predecessor]]=await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?',[entry.requires.name]);
        assert.equal(predecessor.checksum,entry.requires.checksum);
        const [item]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Migration sample','weight','kg')");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,150)',[item.insertId]);
        await pool.query("INSERT INTO ingredient_movements(ingredient_id,kind,qty,unit_cost,source_type,business_date) VALUES (?,'receipt',1000,0.004,'manual','2026-09-07')",[item.insertId]);
        const result=await runPendingMigrations(pool);assert.deepEqual(result.applied,[name]);
        const [[recipe]]=await pool.query('SELECT qty_per_unit,yield_pct FROM product_recipe_lines');
        assert.equal(Number(recipe.qty_per_unit),150);assert.equal(Number(recipe.yield_pct),100);
        const [[movement]]=await pool.query('SELECT qty,unit_cost,purchase_priced,cost_source FROM ingredient_movements');
        assert.equal(Number(movement.qty),1000);assert.equal(Number(movement.unit_cost),0.004);assert.equal(Number(movement.purchase_priced),0);assert.equal(movement.cost_source,'legacy');
        assert.deepEqual((await runPendingMigrations(pool)).applied,[]);
        const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'posapp-analysis-migration-'));
        const manifestPath=path.join(temp,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({migrations:[entry]}));fs.writeFileSync(path.join(temp,entry.file),sql);
        try {
            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[entry.requires.name]);
            await assert.rejects(runPendingMigrations(pool,{manifestPath}),/requires .*exact checksum/);
            await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[entry.requires.name,entry.requires.checksum]);
            await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?',['0'.repeat(64),name]);
            await assert.rejects(runPendingMigrations(pool,{manifestPath}),/checksum conflict/);
        } finally {fs.unlinkSync(manifestPath);fs.unlinkSync(path.join(temp,entry.file));fs.rmdirSync(temp);}
        console.log(JSON.stringify({database,predecessor:'edded956',upgrade:result.applied,noop:true,legacy_values_preserved:true,fail_closed:['missing predecessor','conflicting checksum']}));
    }finally{await pool.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    if(created){const admin=await mysql.createConnection(options);await admin.query(`DROP DATABASE \`${database}\``);await admin.end();}
});

// Run alone. Backs up, upgrades, restores and re-upgrades only its own generated loopback fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomBytes,createHash,randomUUID}=require('node:crypto');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('../../scripts/reviews/recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise'),{database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
assert.match(database,/^posapp_review_recipe_p1_[a-f0-9]{12}$/);
const {execDump}=require('../../scripts/db-backup.js');
const {runPendingMigrations}=require('../../backend/migrations/runPendingMigrations');
let pool=require('../../backend/config/db'),created=false;
const dump=path.resolve('scratch',`${database}.sql`);
async function fingerprint(connection){
 const [tables]=await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
 const data={};for(const {name} of tables){assert.match(name,/^[a-z0-9_]+$/);const [rows]=await connection.query(`SELECT * FROM \`${name}\``);data[name]={count:rows.length,hash:createHash('sha256').update(rows.map(row=>JSON.stringify(row)).sort().join('\n')).digest('hex')};}
 return data;
}
(async()=>{
 const admin=await mysql.createConnection(options);try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
 await require('../../backend/tests/fixtures/seed').seedDatabase({legacyMovementSchema:true});
 const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,working_quantity,working_quantity_known,working_last_count_id,working_initialized) VALUES ('Restore fixture','count','unit',120,1,1,1)");
 await pool.query("INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES (?,'count',100,'manual','2026-09-12'),(?,'receipt',20,'manual','2026-09-12')",[ingredient.insertId,ingredient.insertId]);
 const before=await fingerprint(pool);
 await execDump(process.env.MYSQLDUMP_PATH || (process.platform==='win32' ? 'C:/xampp/mysql/bin/mysqldump.exe' : 'mariadb-dump'),['-h',options.host,'-P',String(options.port||3306),'-u',options.user,'--single-transaction','--quick','--hex-blob','--default-character-set=utf8mb4',database],dump,{...process.env,MYSQL_PWD:options.password||''});
 const result=await runPendingMigrations(pool);assert.deepEqual(result.applied,['2026-09-12-unified-stock-movements-v1']);
 await require('../../backend/services/schemaValidation').validateRequiredSchema(pool);
 const conn=await pool.getConnection();try{await conn.beginTransaction();await require('../../backend/services/RecipeLedgerService').recordManualMovement(conn,{ingredientId:ingredient.insertId,kind:'receipt',qty:2,unit:'unit',clientKey:randomUUID(),businessDate:'2026-09-12',actor:{id:1}});await conn.commit();}catch(error){await conn.rollback();throw error;}finally{conn.release();}
 assert.equal(Number((await pool.query('SELECT working_quantity FROM ingredients WHERE id=?',[ingredient.insertId]))[0][0].working_quantity),122);
 await pool.end();pool=null;
 const restoreAdmin=await mysql.createConnection(options);try{await restoreAdmin.query(`DROP DATABASE \`${database}\``);await restoreAdmin.query(`CREATE DATABASE \`${database}\``);}finally{await restoreAdmin.end();}
 pool=mysql.createPool({...options,database,timezone:'Z',jsonStrings:true,multipleStatements:true,connectionLimit:1});
 // Match databaseRuntime's SQL session timezone, not only mysql2's parser.
 await pool.query("SET time_zone='+00:00'");
 const sql=fs.readFileSync(dump,'utf8');assert(!/^\s*(?:USE\s|(?:CREATE|DROP)\s+DATABASE\b)/im.test(sql));
 await pool.query(sql);
 assert.deepEqual(await fingerprint(pool),before);
 assert.deepEqual((await runPendingMigrations(pool)).applied,['2026-09-12-unified-stock-movements-v1']);
 await require('../../backend/services/schemaValidation').validateRequiredSchema(pool);
 assert.equal(Number((await pool.query('SELECT working_quantity FROM ingredients WHERE id=?',[ingredient.insertId]))[0][0].working_quantity),120);
 const evidence={tables_restored:Object.keys(before).length,all_table_data_hashes_matched:true,new_code_mutation_before_restore_verified:true,reupgrade_verified:true,dump_bytes:fs.statSync(dump).size,customer_database_used:false};
 fs.writeFileSync('scratch/unified-movement-restore.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 if(pool)await pool.end();if(fs.existsSync(dump))fs.unlinkSync(dump);
 if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});

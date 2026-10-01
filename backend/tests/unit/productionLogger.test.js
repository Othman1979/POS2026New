const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const childEnv={...process.env};delete childEnv.NODE_OPTIONS;delete childEnv.POSAPP_REVIEW_DB;
describe('production stdout logging',()=>{
 it('preserves structured errors and flushes on explicit exit without a worker',()=>{
  const source=`const logger=require('./backend/config/logger');logger.info({event:'ready'},'Ready');logger.error({err:new Error('probe')},'Failed');logger.fatal('Exiting');process.exit(0);`;
  const run=spawnSync(process.execPath,['-e',source],{cwd:path.resolve(__dirname,'../../..'),env:{...childEnv,NODE_ENV:'production',LOG_OUTPUT:'stdout',LOG_LEVEL:'info'},encoding:'utf8'});
  expect(run.status).toBe(0);const lines=run.stdout.trim().split('\n').map(JSON.parse);
  // fatal flushes synchronously while the first stdout write may still be
  // asynchronous. Assert every record survives, without assuming pipe order.
  expect(lines.map(x=>x.level).sort((a,b)=>a-b)).toEqual([30,50,60]);
  expect(lines.find(x=>x.level===30)).toMatchObject({event:'ready',msg:'Ready'});
  expect(lines.find(x=>x.level===50).err).toMatchObject({type:'Error',message:'probe'});
  expect(lines.find(x=>x.level===60).msg).toBe('Exiting');
 });
 it('fails clearly for an unknown logging destination',()=>{
  const run=spawnSync(process.execPath,['-e',"require('./backend/config/logger')"],{cwd:path.resolve(__dirname,'../../..'),env:{...childEnv,NODE_ENV:'production',LOG_OUTPUT:'typo'},encoding:'utf8'});
 expect(run.status).not.toBe(0);expect(run.stderr).toContain('LOG_OUTPUT must be stdout or files');
 });
 it('preserves explicitly configured local file logs when LOG_OUTPUT is not set',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'posapp-logger-test-'));
  const env={...childEnv,NODE_ENV:'production',LOG_LEVEL:'info',POSAPP_LOG_DIR:folder};delete env.LOG_OUTPUT;
  try{
   const run=spawnSync(process.execPath,['-e',"const logger=require('./backend/config/logger');logger.info({event:'file-check'},'Local log');"],{cwd:path.resolve(__dirname,'../../..'),env,encoding:'utf8'});
   expect(run.status).toBe(0);expect(JSON.parse(run.stdout.trim()).event).toBe('file-check');
   const logs=fs.readdirSync(folder).filter(name=>fs.lstatSync(path.join(folder,name)).isFile());
   expect(logs.some(name=>fs.readFileSync(path.join(folder,name),'utf8').includes('file-check'))).toBe(true);
  }finally{fs.rmSync(folder,{recursive:true,force:true})}
 });
});

const xlsx=require('xlsx');
const {parseCatalogWorkbook}=require('../../services/catalogWorkbook');
function book(rows, extra) {const wb=xlsx.utils.book_new();xlsx.utils.book_append_sheet(wb,xlsx.utils.json_to_sheet([{Name:'Food'}]),'Categories');const sheet=xlsx.utils.json_to_sheet(rows);if(extra)sheet['!ref']=extra;xlsx.utils.book_append_sheet(wb,sheet,'Products');return xlsx.write(wb,{type:'buffer',bookType:'xlsx',compression:true});}
describe('catalog workbook parsing worker',()=>{
 it('preserves template and legacy mapping values',async()=>{
  const rows=[{Name:'Coffee',Price:2,Category:'Food','Tax Rate':16}];
  expect(await parseCatalogWorkbook(book(rows))).toEqual({catRows:[{Name:'Food'}],prodRows:rows,legacyFormat:false});
  const wb=xlsx.utils.book_new();xlsx.utils.book_append_sheet(wb,xlsx.utils.aoa_to_sheet([['Coffee',2,'Food',16]]),'Sheet1');
  const parsed=await parseCatalogWorkbook(xlsx.write(wb,{type:'buffer',bookType:'xlsx'}),JSON.stringify({name:0,price:1,category:2,tax:3}));
  expect(parsed).toMatchObject({legacyFormat:true,catRows:[{Name:'Food'}],prodRows:[{Name:'Coffee',Price:2,Category:'Food','Tax Rate':16,__legacyRow:1}]});
 });
 it('rejects invalid and oversized ranges without silently truncating imports',async()=>{
  await expect(parseCatalogWorkbook(Buffer.from('bad'))).rejects.toMatchObject({statusCode:400});
  await expect(parseCatalogWorkbook(book([{Name:'First'}],'A1:A50002'))).rejects.toMatchObject({statusCode:400});
 });
 it('keeps the main event loop responsive during a real 20,000-row parse',async()=>{
  const buffer=book(Array.from({length:20000},(_,i)=>({Name:'Product '+i,Price:i,Category:'Food'})));
  let ticks=0;const timer=setInterval(()=>ticks++,5);
  try{const result=await parseCatalogWorkbook(buffer);expect(result.prodRows).toHaveLength(20000);expect(ticks).toBeGreaterThan(5);}finally{clearInterval(timer)}
 });
});

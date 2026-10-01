const fs=require('fs');const {encodeRasterBands}=require('../../pos-spooler-printer/thermal-raster');
const data=fs.readFileSync(process.argv[2]);let output;
for(let i=0;i<Number(process.argv[4]);i++) output=Buffer.concat(encodeRasterBands({width:576,height:data.length/2304,data}));
fs.writeFileSync(process.argv[3],output);

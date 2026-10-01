/* Compare medians of perf-venue-measure runs. Usage: node scripts/reviews/perf-venue-summary.cjs <label> [<label>...] */
const fs=require('fs');const labels=process.argv.slice(2);
const dir=require('path').resolve(__dirname,'../../scratch/perf-hunt');
const R=labels.map(l=>JSON.parse(fs.readFileSync(`${dir}/results-${l}.json`)));
const keys=[...new Set(R.flatMap(r=>Object.values(r.median).flatMap(m=>Object.keys(m))))];
for(const lang of ['en','ar']){console.log('\n### '+lang+'  '+labels.join(' | '));
 for(const k of keys){const row=R.map(r=>r.median[lang]?.[k]);if(row.every(v=>v==null))continue;console.log(k.padEnd(38)+row.map(v=>String(v??'-').padStart(12)).join(''));}}

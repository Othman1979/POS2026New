/* Initial JS per HTML entry (static import closure): raw, gzip and brotli bytes. Usage: node scripts/reviews/perf-venue-bytes.cjs <dist dir> */
const fs=require('fs'),path=require('path'),z=require('zlib');
const dist=process.argv[2];
const imports=f=>{const s=fs.readFileSync(path.join(dist,f),'utf8');const o=new Set();for(const m of s.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g))o.add(path.posix.join(path.posix.dirname(f),m[1]));return [...o].filter(x=>fs.existsSync(path.join(dist,x)));};
const closure=e=>{const s=new Set();const st=[e];while(st.length){const f=st.pop();if(s.has(f))continue;s.add(f);imports(f).forEach(i=>st.push(i));}return s;};
const sz=fl=>{let r=0,g=0,b=0;for(const f of fl){const buf=fs.readFileSync(path.join(dist,f));r+=buf.length;g+=z.gzipSync(buf).length;b+=z.brotliCompressSync(buf).length;}return `files=${fl.length} raw=${r} gz=${g} br=${b}`;};
for(const h of ['index','login','admin','menu','print_receipt']){const html=fs.readFileSync(path.join(dist,h+'.html'),'utf8');const m=html.match(/<script type="module"[^>]*src="\/([^"]+)"/);const c=closure(m[1]);console.log(h,sz([...c]));
 if(h==='index'){const pt=fs.readdirSync(dist+'/chunks').find(f=>f.startsWith('PosTerminal-')&&f.endsWith('.js'));const c2=closure('chunks/'+pt);for(const x of c)c2.add(x);console.log('index+PosTerminal',sz([...c2]));}}

// Fails if a built bundle still contains Vue development-only code
// (e.g. when NODE_ENV=development leaked into `vite build`).
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || 'dist');

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.js')) yield p;
  }
}

if (!fs.existsSync(dir)) {
  console.error(`verify-production-build: directory not found: ${dir}`);
  process.exit(1);
}

const offenders = [];
for (const file of walk(dir)) {
  if (fs.readFileSync(file, 'utf8').includes('[Vue warn]')) {
    offenders.push(path.relative(dir, file));
  }
}

if (offenders.length) {
  console.error('verify-production-build: development build detected ([Vue warn] found) in:');
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}

// The register route (PosTerminal) is preloaded from index.html only; login.html must not carry it.
const pageLinks = (name) => {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').match(/<link\b[^>]*>/g) || [] : null;
};
const indexLinks = pageLinks('index.html');
if (indexLinks) {
  const hasRouteJs = indexLinks.some((l) => /rel="modulepreload"/.test(l) && /\/chunks\/PosTerminal-[^"]+\.js"/.test(l));
  const hasRouteCss = indexLinks.some((l) => /rel="preload"/.test(l) && /as="style"/.test(l) && /\/assets\/PosTerminal-[^"]+\.css"/.test(l));
  const hrefs = indexLinks.map((l) => (l.match(/\bhref="([^"]+)"/) || [])[1]).filter(Boolean);
  const duplicates = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
  const loginLeak = (pageLinks('login.html') || []).some((l) => /PosTerminal-/.test(l));
  if (!hasRouteJs || !hasRouteCss || duplicates.length || loginLeak) {
    console.error('verify-production-build: register route preload is wrong in index.html/login.html '
      + `(js=${hasRouteJs} css=${hasRouteCss} duplicates=${duplicates.length} loginLeak=${loginLeak})`);
    process.exit(1);
  }
}

console.log(`verify-production-build: OK (${dir})`);

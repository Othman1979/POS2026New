'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceCssPath = path.join(root, 'assets', 'css', 'fontawesome.css');
const manifestPath = path.join(root, 'assets', 'fontawesome-subset-manifest.json');
const sourceSuffixes = new Set(['.vue', '.js', '.ts', '.cjs', '.mjs', '.html']);
const rootSources = ['index.html', 'admin.html', 'menu.html', 'print_receipt.html'];
const ignoredParts = new Set(['__tests__', 'node_modules']);
const ignoredSuffixes = ['.spec.js', '.spec.ts', '.test.js', '.test.ts'];
const expectedFonts = {
  solid: { source: 'fa-solid-900.woff2', output: 'fa-solid-900-subset.woff2', maxBytes: 16000 },
  regular: { source: 'fa-regular-400.woff2', output: 'fa-regular-400-subset.woff2', maxBytes: 6000 },
  brands: { source: 'fa-brands-400.woff2', output: 'fa-brands-400-subset.woff2', maxBytes: 2000 },
};
const nonGlyphClasses = new Set([
  'fa-solid', 'fa-regular', 'fa-brands', 'fa-classic',
  'fa-spin', 'fa-pulse', 'fa-fw', 'fa-rotate-90',
]);
const iconToken = /\bfa-[a-z0-9-]+\b/g;
const iconBlock = /((?:\.fa-[a-z0-9-]+)(?:,\.fa-[a-z0-9-]+)*)\{--fa:"\\?([^"]+)"\}/gi;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(file) {
  const contents = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredParts.has(entry.name)) return [];
      return filesUnder(full);
    }
    if (!sourceSuffixes.has(path.extname(entry.name).toLowerCase())) return [];
    if (ignoredSuffixes.some(suffix => entry.name.endsWith(suffix))) return [];
    return [full];
  });
}

function cssIconMap(css) {
  const mapping = new Map();
  for (const match of css.matchAll(iconBlock)) {
    const value = match[2];
    const codepoint = /^[0-9a-f]{3,6}$/i.test(value) ? Number.parseInt(value, 16) : value.codePointAt(0);
    for (const selector of match[1].split(',')) mapping.set(selector.slice(1), codepoint);
  }
  return mapping;
}

function collectUsedIcons(mapping) {
  const files = [...filesUnder(path.join(root, 'src')), ...rootSources.map(file => path.join(root, file))];
  const tokens = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(iconToken)) tokens.add(match[0]);
  }
  const unknown = [...tokens].filter(name => !mapping.has(name) && !nonGlyphClasses.has(name)).sort();
  if (unknown.length) throw new Error(`Unmapped Font Awesome classes: ${unknown.join(', ')}`);
  return [...tokens].filter(name => mapping.has(name)).sort();
}

function verify() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sourceCss = fs.readFileSync(sourceCssPath, 'utf8');
  const mapping = cssIconMap(sourceCss);
  const usedIcons = collectUsedIcons(mapping);
  const expectedCodepoints = [...new Set(usedIcons.map(name => mapping.get(name)))]
    .sort((left, right) => left - right)
    .map(codepoint => `U+${codepoint.toString(16).toUpperCase()}`);
  if (JSON.stringify(manifest.icons) !== JSON.stringify(usedIcons)) {
    const registered = new Set(manifest.icons || []);
    const used = new Set(usedIcons);
    const missing = usedIcons.filter(name => !registered.has(name));
    const stale = [...registered].filter(name => !used.has(name));
    throw new Error(`Font Awesome subset is stale. Missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}. Run npm run fontawesome:build.`);
  }
  if (JSON.stringify(manifest.codepoints) !== JSON.stringify(expectedCodepoints)) {
    throw new Error('Font Awesome subset codepoints are stale. Run npm run fontawesome:build.');
  }
  if (manifest.source_css?.sha256 !== sha256Text(sourceCssPath)) {
    throw new Error('The full Font Awesome source CSS changed. Regenerate the subset.');
  }

  const subsetCssPath = path.join(root, manifest.subset_css.path);
  const normalizedSubsetCss = fs.readFileSync(subsetCssPath, 'utf8').replace(/\r\n?/g, '\n');
  if (manifest.subset_css.sha256 !== crypto.createHash('sha256').update(normalizedSubsetCss).digest('hex')
      || manifest.subset_css.bytes !== Buffer.byteLength(normalizedSubsetCss)) {
    throw new Error('The Font Awesome subset CSS does not match its manifest.');
  }
  const subsetMapping = cssIconMap(fs.readFileSync(subsetCssPath, 'utf8'));
  const missingCss = usedIcons.filter(name => !subsetMapping.has(name));
  if (missingCss.length) throw new Error(`Subset CSS is missing icons: ${missingCss.join(', ')}`);
  if (manifest.subset_css.bytes > 20000) throw new Error('The Font Awesome subset CSS exceeded its 20 KB size ceiling.');

  for (const [style, expected] of Object.entries(expectedFonts)) {
    const entry = manifest.fonts?.[style];
    if (!entry || entry.source !== expected.source || entry.output !== expected.output) {
      throw new Error(`The ${style} Font Awesome subset manifest entry is invalid.`);
    }
    const fontPath = path.join(root, 'assets', 'webfonts', entry.output);
    if (entry.sha256 !== sha256(fontPath) || entry.bytes !== fs.statSync(fontPath).size) {
      throw new Error(`${entry.output} does not match the Font Awesome subset manifest.`);
    }
    if (entry.bytes > expected.maxBytes) throw new Error(`${entry.output} exceeded its ${expected.maxBytes}-byte size ceiling.`);
  }

  const subsetCss = fs.readFileSync(subsetCssPath, 'utf8');
  for (const expected of Object.values(expectedFonts)) {
    if (!subsetCss.includes(expected.output)) throw new Error(`Subset CSS does not reference ${expected.output}.`);
  }

  for (const page of ['index.html', 'admin.html', 'menu.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (!html.includes('assets/css/fontawesome-subset.css')) throw new Error(`${page} must load fontawesome-subset.css.`);
    if (html.includes('assets/css/fontawesome.css')) throw new Error(`${page} still loads the full Font Awesome stylesheet.`);
  }

  return { icons: usedIcons.length, codepoints: expectedCodepoints.length };
}

if (require.main === module) {
  try {
    const result = verify();
    console.log(`Font Awesome subset verified: ${result.icons} icons, ${result.codepoints} codepoints.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { sha256Text, verify };

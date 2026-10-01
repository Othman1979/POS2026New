'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceCssPath = path.join(root, 'assets', 'css', 'fontawesome.css');
const outputCssPath = path.join(root, 'assets', 'css', 'fontawesome-subset.css');
const manifestPath = path.join(root, 'assets', 'fontawesome-subset-manifest.json');
const fontDir = path.join(root, 'assets', 'webfonts');
const fontSources = {
  solid: 'fa-solid-900.woff2',
  regular: 'fa-regular-400.woff2',
  brands: 'fa-brands-400.woff2',
};
const fontOutputs = {
  solid: 'fa-solid-900-subset.woff2',
  regular: 'fa-regular-400-subset.woff2',
  brands: 'fa-brands-400-subset.woff2',
};
const sourceSuffixes = new Set(['.vue', '.js', '.ts', '.cjs', '.mjs', '.html']);
const rootSources = ['index.html', 'admin.html', 'menu.html', 'print_receipt.html'];
const ignoredParts = new Set(['__tests__', 'node_modules']);
const ignoredSuffixes = ['.spec.js', '.spec.ts', '.test.js', '.test.ts'];
const nonGlyphClasses = new Set([
  'fa-solid', 'fa-regular', 'fa-brands', 'fa-classic',
  'fa-spin', 'fa-pulse', 'fa-fw', 'fa-rotate-90',
]);
const iconToken = /\bfa-[a-z0-9-]+\b/g;
const iconBlock = /((?:\.fa-[a-z0-9-]+)(?:,\.fa-[a-z0-9-]+)*)\{--fa:"\\?([^"]+)"\}/gi;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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

function sourceFiles() {
  return [...filesUnder(path.join(root, 'src')), ...rootSources.map(file => path.join(root, file))].sort();
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

function collectUsedIcons(files, mapping) {
  const tokens = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(iconToken)) tokens.add(match[0]);
  }
  const unknown = [...tokens].filter(name => !mapping.has(name) && !nonGlyphClasses.has(name)).sort();
  if (unknown.length) throw new Error(`Unmapped Font Awesome classes: ${unknown.join(', ')}`);
  return [...tokens].filter(name => mapping.has(name)).sort();
}

function createSubsetCss(css, icons) {
  const used = new Set(icons);
  let result = css.replace(iconBlock, (block, selectorList) => {
    const selectors = selectorList.split(',').map(selector => selector.slice(1));
    return selectors.some(selector => used.has(selector)) ? block : '';
  });
  for (const style of Object.keys(fontSources)) {
    result = result.replaceAll(fontSources[style], fontOutputs[style]);
  }
  return result;
}

function writeIfChanged(file, contents) {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(next)) return false;
  fs.writeFileSync(file, next);
  return true;
}

async function build() {
  let subsetFont;
  try {
    subsetFont = require('subset-font');
  } catch (error) {
    throw new Error('Font subset generation requires development dependencies. Run npm install first.', { cause: error });
  }

  const css = fs.readFileSync(sourceCssPath, 'utf8').replace(/\r\n?/g, '\n');
  const mapping = cssIconMap(css);
  const files = sourceFiles();
  const icons = collectUsedIcons(files, mapping);
  const codepoints = [...new Set(icons.map(name => mapping.get(name)))].sort((left, right) => left - right);
  const glyphText = codepoints.map(codepoint => String.fromCodePoint(codepoint)).join('');
  const subsetCss = createSubsetCss(css, icons);
  const fontBuffers = {};
  for (const style of Object.keys(fontSources)) {
    fontBuffers[style] = await subsetFont(fs.readFileSync(path.join(fontDir, fontSources[style])), glyphText, { targetFormat: 'woff2' });
  }

  writeIfChanged(outputCssPath, subsetCss);
  for (const style of Object.keys(fontOutputs)) writeIfChanged(path.join(fontDir, fontOutputs[style]), fontBuffers[style]);

  const manifest = {
    version: 1,
    source_css: {
      path: path.relative(root, sourceCssPath).replaceAll('\\', '/'),
      sha256: sha256(css),
    },
    subset_css: {
      path: path.relative(root, outputCssPath).replaceAll('\\', '/'),
      bytes: Buffer.byteLength(subsetCss),
      sha256: sha256(subsetCss),
    },
    icons,
    codepoints: codepoints.map(codepoint => `U+${codepoint.toString(16).toUpperCase()}`),
    fonts: Object.fromEntries(Object.keys(fontSources).map(style => [style, {
      source: fontSources[style],
      output: fontOutputs[style],
      bytes: fontBuffers[style].length,
      sha256: sha256(fontBuffers[style]),
    }])),
  };
  writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    sourceFiles: files.length,
    icons: icons.length,
    codepoints: codepoints.length,
    cssBytes: Buffer.byteLength(subsetCss),
    fontBytes: Object.fromEntries(Object.keys(fontBuffers).map(style => [style, fontBuffers[style].length])),
  };
}

if (require.main === module) {
  build()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  build,
  collectUsedIcons,
  cssIconMap,
  fontOutputs,
  fontSources,
  nonGlyphClasses,
  outputCssPath,
  root,
  sourceCssPath,
  sourceFiles,
};

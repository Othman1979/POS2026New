# Arabic Catalog Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` and `test-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `src/shared/i18n.js` to a stable compatibility facade while preserving every currently effective Arabic key/value and every public/runtime behavior.

**Architecture:** Keep the existing English-readable-key translation engine and every existing `@/shared/i18n.js` import. Move the executable engine and 29 dynamic translation rules to `src/shared/i18n/runtime.js`, statically import a single deduplicated `src/shared/i18n/ar.json` catalog, and make `src/shared/i18n.js` re-export the runtime API.

**Tech Stack:** Vue 3, Vite 6 JSON modules, Vitest, JavaScript, JSON.

## Global Constraints

- Work only on branch `codex/i18n-catalog-extraction`; do not merge or push.
- Use Ponytail at full intensity: no `vue-i18n` dependency, no `en.json`, no lazy loading, no feature locale files, and no new translation abstraction.
- Preserve the public import path `@/shared/i18n.js` and these exports exactly: `currentLanguage`, `languageChoices`, `initI18n`, `setLanguage`, `t`, `getDirection`, `onLanguageChange`, `POS_I18N_KEY`, `createPosI18n`.
- Preserve English identity fallback, whitespace preservation, all 29 dynamic translation patterns, DOM/attribute translation, MutationObserver behavior, browser-dialog translation, language persistence, RTL behavior, and all runtime options.
- Preserve the **currently effective last-write value** for every duplicate key. Do not choose new wording in this structural refactor.
- The pre-extraction effective Arabic catalog is exactly **2,265 keys** with canonical SHA-256 **`9d4d4cf914e371a93707640726aa7a5db7815a287b3390738bba09f1d9c39f9e`**, where canonical form is `JSON.stringify(Object.fromEntries(Object.entries(catalog).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)))`.
- `ar.json` must contain exactly one property per effective key, all values must be non-empty strings, and its canonical hash must match the value above. The 2,265-key count/hash is immutable root-parity evidence; the permanent behavior test only requires a non-empty catalog so future additions do not make it stale.
- Preserve the one legacy noncanonical key exactly as authored: `Custom Background: ` (with its trailing space). The catalog test validates this exception and routes every canonical key through `t()`.
- Do not edit production consumers, Vite configuration, package files, backend code, database files, translations, styling, or documentation outside this plan and the implementation report.
- Convert tests that inspect the monolithic source into catalog/runtime behavior assertions; do not preserve them with comments or duplicate translation text in the facade.

---

### Task 1: Extract the catalog behind the unchanged public facade

**Files:**
- Create: `src/shared/i18n/ar.json`
- Create: `src/shared/i18n/runtime.js`
- Create: `src/shared/__tests__/i18nCatalog.spec.js`
- Modify: `src/shared/i18n.js`
- Modify only as required: the existing localization contract tests returned by `rg -l 'shared/i18n\.js' src -g '*spec.js' -g '*test.js'`
- Write ignored execution evidence: `.superpowers/sdd/i18n-catalog-extraction-report.md`

**Interfaces:**
- Consumes: the existing effective `const ar` object, dynamic translation rules, and exported API from `src/shared/i18n.js`.
- Produces: the exact same API at `@/shared/i18n.js`, backed by a static JSON catalog.

- [ ] **Step 1: Record the immutable before-state evidence**

Run this read-only command before changing production files:

```powershell
@'
const fs = require('fs');
const crypto = require('crypto');
const parser = require('@babel/parser');
const source = fs.readFileSync('src/shared/i18n.js', 'utf8');
const ast = parser.parse(source, { sourceType: 'module' });
let ar;
for (const node of ast.program.body) {
  if (node.type !== 'VariableDeclaration') continue;
  for (const declaration of node.declarations) {
    if (declaration.id?.name === 'ar') ar = declaration.init;
  }
}
if (!ar || ar.type !== 'ObjectExpression') throw new Error('Arabic catalog object not found');
const effective = {};
for (const property of ar.properties) {
  const key = property.key.type === 'StringLiteral' ? property.key.value : property.key.name;
  effective[key] = property.value.value;
}
const ordered = Object.fromEntries(Object.entries(effective).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const canonical = JSON.stringify(ordered);
console.log(JSON.stringify({
  keys: Object.keys(effective).length,
  sha256: crypto.createHash('sha256').update(canonical).digest('hex')
}, null, 2));
'@ | node -
```

Expected:

```json
{
  "keys": 2265,
  "sha256": "9d4d4cf914e371a93707640726aa7a5db7815a287b3390738bba09f1d9c39f9e"
}
```

Write the command and output into `.superpowers/sdd/i18n-catalog-extraction-report.md`.

- [ ] **Step 2: Write the failing architectural and behavior contract**

Create `src/shared/__tests__/i18nCatalog.spec.js` with this behavior:

```js
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as i18n from '../i18n.js';

const facadePath = resolve(process.cwd(), 'src/shared/i18n.js');
const catalogPath = resolve(process.cwd(), 'src/shared/i18n/ar.json');

describe('shared i18n catalog boundary', () => {
    it('keeps the existing public module as a thin compatibility facade', () => {
        const source = readFileSync(facadePath, 'utf8');
        expect(source.trim()).toBe("export * from './i18n/runtime.js';");
        expect(Object.keys(i18n).sort()).toEqual([
            'POS_I18N_KEY',
            'createPosI18n',
            'currentLanguage',
            'getDirection',
            'initI18n',
            'languageChoices',
            'onLanguageChange',
            'setLanguage',
            't'
        ]);
    });

    it('preserves static Arabic catalog entries and routes canonical keys through t()', () => {
        expect(existsSync(catalogPath)).toBe(true);
        if (!existsSync(catalogPath)) return;

        const ar = JSON.parse(readFileSync(catalogPath, 'utf8'));
        expect(Object.keys(ar).length).toBeGreaterThan(0);
        const nonCanonicalKeys = Object.keys(ar).filter(
            (key) => key !== key.replace(/\s+/g, ' ').trim()
        );
        expect(nonCanonicalKeys).toEqual(['Custom Background: ']);
        for (const [key, value] of Object.entries(ar)) {
            expect(typeof value).toBe('string');
            expect(value.trim()).not.toBe('');
            if (!nonCanonicalKeys.includes(key)) expect(i18n.t(key, 'ar')).toBe(value);
        }
    });

    it('preserves English identity, outer whitespace and dynamic Arabic rules', () => {
        expect(i18n.t('  Orders  ', 'en')).toBe('  Orders  ');
        expect(i18n.t('  Orders  ', 'ar')).toBe('  الطلبات  ');
        expect(i18n.t('Cashier: Maya', 'ar')).toBe('الكاشير: Maya');
        expect(i18n.t('Only 2.00 JD remaining', 'ar')).toBe('تبقى 2.00 JD فقط');
    });
});
```

- [ ] **Step 3: Run the new test and capture RED**

Run:

```powershell
npx vitest run src/shared/__tests__/i18nCatalog.spec.js
```

Expected: failure because `src/shared/i18n.js` is not a thin facade and `src/shared/i18n/ar.json` does not exist. Record the failing assertions in the report. A setup/import error is not valid RED.

- [ ] **Step 4: Perform the minimal mechanical extraction**

Create `src/shared/i18n/ar.json` from the effective last-write Arabic object. Duplicate keys must collapse to their currently effective final values; do not hand-edit translations.

Create `src/shared/i18n/runtime.js` by moving the executable parts of the existing module. Its only catalog change is:

```js
import { ref } from 'vue';
import ar from './ar.json';

// existing constants, runtime state and public exports remain unchanged
const dictionaries = { ar };
// existing dynamicTranslations and all functions remain unchanged
```

Replace `src/shared/i18n.js` with exactly:

```js
export * from './i18n/runtime.js';
```

Do not create forwarding exports anywhere else and do not modify the 53 production consumers.

- [ ] **Step 5: Replace brittle source-file test contracts**

For each existing test that reads `src/shared/i18n.js` to search for Arabic text:

1. Import or parse `src/shared/i18n/ar.json`.
2. Replace source substring assertions with exact property assertions such as:

```js
expect(ar['Print Check']).toBe('طباعة الفاتورة');
```

3. Keep component-source assertions that prove the English key is actually rendered or passed to `t()`.
4. Do not weaken or delete feature-specific localization assertions.
5. Tests that import runtime exports from `@/shared/i18n.js` must continue using that public facade unchanged.

- [ ] **Step 6: Verify exact catalog preservation**

Run this against the extracted JSON:

```powershell
@'
const fs = require('fs');
const crypto = require('crypto');
const ar = JSON.parse(fs.readFileSync('src/shared/i18n/ar.json', 'utf8'));
const ordered = Object.fromEntries(Object.entries(ar).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const canonical = JSON.stringify(ordered);
console.log(JSON.stringify({
  keys: Object.keys(ar).length,
  sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  invalidValues: Object.entries(ar).filter(([, value]) => typeof value !== 'string' || !value.trim()).length
}, null, 2));
'@ | node -
```

Expected:

```json
{
  "keys": 2265,
  "sha256": "9d4d4cf914e371a93707640726aa7a5db7815a287b3390738bba09f1d9c39f9e",
  "invalidValues": 0
}
```

If the hash differs, stop and restore missing or changed key/value pairs before continuing. Record the command and output in the report.

- [ ] **Step 7: Run focused GREEN verification**

Run:

```powershell
$files = rg -l 'shared/i18n\.js|shared/i18n/ar\.json' src -g '*spec.js' -g '*test.js'
npx vitest run src/shared/__tests__/i18nCatalog.spec.js $files
```

Expected: all selected files and tests pass with zero failures.

- [ ] **Step 8: Run integration and hygiene verification**

Run:

```powershell
npm run build
git diff --check
git status --short
```

Expected: Vite production build succeeds, diff check is clean, and status contains only this plan, the facade/runtime/catalog, the new catalog test, directly affected localization tests, and the implementation report. The i18n bundle may change its internal module composition but must not gain an asynchronous locale request.

- [ ] **Step 9: Self-review and commit**

Inspect the complete diff and confirm:

- all 2,265 effective key/value pairs survived exactly;
- all 29 dynamic patterns remain;
- no production consumer import changed;
- no English catalog, dependency, lazy loader, namespace system, or unrelated cleanup was added;
- direct source-reading tests now verify the actual catalog or runtime behavior;
- no generated `dist/` or dependency artifacts are tracked.

Append the RED/GREEN commands, counts, build result, preservation hash and concerns to the report, then commit all scoped files:

```powershell
git add docs/superpowers/plans/2026-08-09-i18n-arabic-catalog-extraction.md src
git commit -m "refactor: extract Arabic translation catalog"
```

The report remains ignored scratch evidence and must not be force-added. Do not merge or push.

## Plan Self-Review

- **Spec coverage:** The facade, static Arabic JSON, dynamic JavaScript rules, exact key preservation, existing consumer compatibility, test migration, and build behavior are all explicitly covered.
- **Scope control:** One cohesive task; no framework migration, semantic-key conversion, English catalog, lazy loading, feature splitting, translation rewriting, backend or database work.
- **Type/interface consistency:** The facade re-exports the exact existing runtime names; all current callers retain the same module path and synchronous API.
- **Key-loss protection:** Before/after canonical count and SHA-256 are identical; the permanent behavior test validates all values and routes every canonical JSON key through the real `t()` function while explicitly preserving the one legacy noncanonical key.

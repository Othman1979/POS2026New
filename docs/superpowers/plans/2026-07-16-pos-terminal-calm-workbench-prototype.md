# POS Terminal Calm Workbench Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated three-variant POS terminal redesign mock that demonstrates the approved Calm Workbench direction without modifying any production file.

**Architecture:** Create a standalone plain-HTML prototype under `src/components/__prototypes__/pos-terminal-calm-workbench/`. `app.js` owns in-memory state and render functions, `styles.css` owns the complete prototype design system and responsive layouts, and `index.html` provides the root, modal host, and asset links. The prototype is served from the existing Vite development server but is not imported by the Vue app or router.

**Tech Stack:** Semantic HTML, modern CSS, vanilla JavaScript, existing local Inter and IBM Plex Sans Arabic font assets, existing Vite development server.

## Global Constraints

- Do not modify any existing production file, route, Vue component, store, stylesheet, API, or database behavior.
- Implementation files may be created only under `src/components/__prototypes__/pos-terminal-calm-workbench/`.
- Use restrained teal for primary actions, focus, current selection, and small state accents only.
- Use neutral gray surfaces with strong contrast; no gradients, glass effects, decorative patterns, or bright white expanses.
- Use 8px radii for controls and 12px for modal shells; do not use 24px-or-larger card radii.
- Use no deep card shadows and never pair a decorative border with a wide shadow.
- Keep Latin digits in both Arabic RTL and English LTR modes.
- Keep frequent actions at 44–48px and compact secondary actions near 40px.
- Remove Course and “Fire Immediately / إرسال فوري” from the default cart path; retain course assignment under More.
- Use no backend requests, storage, cookies, or persistent mutations.
- Prototype acceptance viewports are 1366×768, 1024×768, 768×1024, and 390×844.

---

### Task 1: Standalone shell, state model, and variant router

**Files:**
- Create: `src/components/__prototypes__/pos-terminal-calm-workbench/index.html`
- Create: `src/components/__prototypes__/pos-terminal-calm-workbench/app.js`

**Interfaces:**
- Produces: `state`, `copy`, `catalog`, `cart`, `setVariant(key)`, `setLanguage(language)`, `render()`, `openModal(name)`, and `closeModal()`.
- Consumes: URL query parameter `variant=A|B|C` and no external data.

- [ ] **Step 1: Create the semantic prototype document**

Create `index.html` with the local font preload, stylesheet, application root, live region, modal host, and module script:

```html
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>POS Calm Workbench Prototype</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main id="prototype" aria-label="POS Calm Workbench prototype"></main>
  <div id="modal-root"></div>
  <div id="live-region" class="sr-only" aria-live="polite"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Define realistic in-memory restaurant data and state**

Create `app.js` with stable data shapes and Latin-digit formatting:

```js
const state = {
  variant: new URLSearchParams(location.search).get('variant') || 'A',
  language: 'ar',
  activeCategory: 'grill',
  selectedCartId: 'line-2',
  modal: null,
  numpadValue: '',
  cartOpen: false,
};

const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const catalog = [
  { id: 1, category: 'grill', ar: 'برجر لحم', en: 'Beef Burger', price: 5.50, qty: 2 },
  { id: 2, category: 'grill', ar: 'برجر دجاج', en: 'Chicken Burger', price: 4.75, qty: 0 },
  { id: 3, category: 'drinks', ar: 'مياه معدنية', en: 'Mineral Water', price: 0.50, qty: 1 },
  { id: 4, category: 'sides', ar: 'بطاطا مقلية', en: 'French Fries', price: 1.75, qty: 0 },
];

const cart = [
  { id: 'line-1', ar: 'برجر لحم', en: 'Beef Burger', qty: 2, unit: 5.50, noteAr: 'بدون بصل', noteEn: 'No onion' },
  { id: 'line-2', ar: 'بطاطا مقلية', en: 'French Fries', qty: 1, unit: 1.75, discount: '10%' },
  { id: 'line-3', ar: 'مياه معدنية', en: 'Mineral Water', qty: 2, unit: 0.50 },
  { id: 'service', ar: 'رسوم الخدمة', en: 'Service charge', qty: 1, unit: 1.10, automatic: true },
];
```

- [ ] **Step 3: Implement URL-stable variant and language controls**

Implement these exact behaviors:

```js
function setVariant(key) {
  state.variant = ['A', 'B', 'C'].includes(key) ? key : 'A';
  const url = new URL(location.href);
  url.searchParams.set('variant', state.variant);
  history.replaceState({}, '', url);
  render();
}

function setLanguage(language) {
  state.language = language === 'en' ? 'en' : 'ar';
  document.documentElement.lang = state.language;
  document.documentElement.dir = state.language === 'ar' ? 'rtl' : 'ltr';
  render();
}
```

Left/right arrow keys cycle variants unless the focused element is an input, textarea, select, button, or contenteditable element.

- [ ] **Step 4: Verify the standalone shell**

Run:

```powershell
node --check src/components/__prototypes__/pos-terminal-calm-workbench/app.js
```

Expected: exit code 0 with no output.

- [ ] **Step 5: Commit the shell**

```powershell
git add -- src/components/__prototypes__/pos-terminal-calm-workbench/index.html src/components/__prototypes__/pos-terminal-calm-workbench/app.js
git commit -m "prototype: add POS workbench shell"
```

### Task 2: Three structurally distinct terminal renderers

**Files:**
- Modify: `src/components/__prototypes__/pos-terminal-calm-workbench/app.js`
- Create: `src/components/__prototypes__/pos-terminal-calm-workbench/styles.css`

**Interfaces:**
- Consumes: shared `state`, `catalog`, `cart`, translation helper `t(ar, en)`, and `money` formatter.
- Produces: `renderVariantA()`, `renderVariantB()`, `renderVariantC()`, `renderSwitcher()`, and complete responsive class contracts.

- [ ] **Step 1: Add shared semantic render helpers**

Define the variant contract before writing their individual markup:

```js
const t = (ar, en) => state.language === 'ar' ? ar : en;
const lineTotal = (line) => line.qty * line.unit;

const variantConfig = Object.freeze({
  A: { variant: 'A', catalog: 'balanced', cart: 'workbench', keypad: 'persistent' },
  B: { variant: 'B', catalog: 'compact', cart: 'ledger', keypad: 'slim' },
  C: { variant: 'C', catalog: 'wide', cart: 'focus', keypad: 'contextual' },
});

function renderVariantA() { return renderTerminal(variantConfig.A); }
function renderVariantB() { return renderTerminal(variantConfig.B); }
function renderVariantC() { return renderTerminal(variantConfig.C); }

function renderTerminal(config) {
  return `<section class="terminal terminal--${config.variant}">
    ${renderCatalog(config.catalog)}
    ${renderCart(config.cart, config.keypad)}
  </section>`;
}
```

`renderCatalog(catalogMode)`, `renderCart(cartMode, keypadMode)`, and `renderNumpad(keypadMode)` must each return complete semantic markup. All three variants show identical business content and differ in split ratio, cart hierarchy, and keypad behavior.

- [ ] **Step 2: Implement Variant A — Calm Workbench**

Use a 64/36 split at 1024px, direct cart ledger, compact More/Clear controls, persistent keypad, compact financial summary, and full-width Update Table and Pay actions. Do not render a course button or default course heading.

- [ ] **Step 3: Implement Variant B — Order Ledger**

Use a 58/42 split, wider cart names and detail, smaller product cells, and a keypad beside the financial summary. The cart must remain a table-like ledger rather than cards.

- [ ] **Step 4: Implement Variant C — Focus Controls**

Use a 68/32 resting split. Hide the keypad until a row is selected, then reveal a focused row-control tray containing quantity, note, remove, and keypad controls. Keep Save and Pay permanently visible.

- [ ] **Step 5: Create the restrained visual system**

Define CSS tokens and apply them consistently:

```css
:root {
  --bg: #dfe3e7;
  --surface: #f2f4f5;
  --surface-2: #e8ebed;
  --surface-3: #d9dee1;
  --ink: #17211f;
  --muted: #52605d;
  --line: #c7cecc;
  --teal: #0f766e;
  --teal-strong: #0b5f59;
  --teal-soft: #d5ebe8;
  --danger: #b4233d;
  --danger-soft: #f5dde2;
  --radius-control: 8px;
  --radius-modal: 12px;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
}
```

Do not use `linear-gradient`, `radial-gradient`, `backdrop-filter`, `border-radius` above 999px except genuine status pills, or shadows with blur above 8px outside the evaluation switcher.

- [ ] **Step 6: Verify structure and banned-pattern constraints**

Run:

```powershell
node --check src/components/__prototypes__/pos-terminal-calm-workbench/app.js
rg -n "linear-gradient|radial-gradient|backdrop-filter|border-radius:\s*(2[4-9]|[3-9][0-9])px|box-shadow:[^;]*(1[0-9]|[2-9][0-9])px" src/components/__prototypes__/pos-terminal-calm-workbench
```

Expected: JavaScript exits 0; the pattern scan prints no matches.

- [ ] **Step 7: Commit the three layouts**

```powershell
git add -- src/components/__prototypes__/pos-terminal-calm-workbench/app.js src/components/__prototypes__/pos-terminal-calm-workbench/styles.css
git commit -m "prototype: design three calm POS layouts"
```

### Task 3: Interactions, Arabic direction, and representative modals

**Files:**
- Modify: `src/components/__prototypes__/pos-terminal-calm-workbench/app.js`
- Modify: `src/components/__prototypes__/pos-terminal-calm-workbench/styles.css`

**Interfaces:**
- Consumes: shared state and renderers from Tasks 1–2.
- Produces: product/category selection, cart selection, numpad state, mobile cart state, `renderCheckoutModal()`, `renderMoreModal()`, Escape handling, and focus restoration.

- [ ] **Step 1: Wire delegated interactions**

Use one click listener on `#prototype` and `data-action` attributes for `variant`, `language`, `category`, `product`, `cart-row`, `numpad`, `mobile-cart`, `checkout`, `more`, and `close-modal`. Every state change ends with `render()`.

- [ ] **Step 2: Implement the More action list**

Render text-first actions for order note, line note, customer details, split, transfer, join, and course assignment. Course must exist only here. Separate Clear Order visually as the destructive action.

- [ ] **Step 3: Implement the checkout modal**

Render a maximum 420px solid-surface modal with a compact header, restrained amount due, cash/card segmented control, tendered input, change due, and one teal confirmation button. Use a small shadow and no decorative border.

- [ ] **Step 4: Implement keyboard and focus behavior**

Escape closes the active modal. Opening a modal stores the trigger; closing returns focus when possible. Variant arrow shortcuts ignore focused form fields. Modal background clicks close only when the backdrop itself is clicked.

- [ ] **Step 5: Implement responsive and RTL layouts**

At widths below 800px, keep the catalog visible and open the cart as a full-height sheet. At widths below 520px, use a persistent bottom order bar. Use logical CSS properties so RTL reverses structure naturally. Apply `direction:ltr` to prices, quantities, and formatted totals.

- [ ] **Step 6: Verify syntax, isolation, and file scope**

Run:

```powershell
node --check src/components/__prototypes__/pos-terminal-calm-workbench/app.js
git diff --name-only master...HEAD
```

Expected: syntax exits 0; changed files consist only of the approved design/plan documents and files below `src/components/__prototypes__/pos-terminal-calm-workbench/`.

- [ ] **Step 7: Commit interactions and modals**

```powershell
git add -- src/components/__prototypes__/pos-terminal-calm-workbench/app.js src/components/__prototypes__/pos-terminal-calm-workbench/styles.css
git commit -m "prototype: add POS interactions and modals"
```

### Task 4: Browser verification and design refinement

**Files:**
- Modify only if verification finds issues: `src/components/__prototypes__/pos-terminal-calm-workbench/app.js`
- Modify only if verification finds issues: `src/components/__prototypes__/pos-terminal-calm-workbench/styles.css`
- Create: `src/components/__prototypes__/pos-terminal-calm-workbench/NOTES.md`

**Interfaces:**
- Consumes: completed standalone prototype.
- Produces: verified browser deliverable URL and a durable prototype question/verdict record.

- [ ] **Step 1: Start the prototype**

Run from the repository root:

```powershell
npx vite --host 127.0.0.1 --port 4178
```

Open:

`http://127.0.0.1:4178/src/components/__prototypes__/pos-terminal-calm-workbench/index.html?variant=A`

- [ ] **Step 2: Verify all variants at POS viewports**

Inspect A, B, and C at 1366×768 and 1024×768. Confirm there is no page-level scrolling, clipped control, overlapping text, hidden Pay/Save action, default course row, or excessive glare.

- [ ] **Step 3: Verify tablet and mobile behavior**

Inspect Variant A at 768×1024 and 390×844. Confirm the product catalog remains primary, the bottom order bar opens a full-height cart, the cart closes, and modal content remains reachable.

- [ ] **Step 4: Verify interactions and browser health**

Exercise category selection, product selection, cart row selection, numpad entry, More modal, checkout modal, Arabic/English direction, Escape close, and variant keyboard navigation. Confirm browser console contains no errors.

- [ ] **Step 5: Run final static checks**

```powershell
node --check src/components/__prototypes__/pos-terminal-calm-workbench/app.js
git diff --check
rg -n "linear-gradient|radial-gradient|backdrop-filter" src/components/__prototypes__/pos-terminal-calm-workbench
git status --short
```

Expected: syntax and diff checks pass; pattern scan has no matches; only intentional prototype refinement files and `NOTES.md` remain uncommitted.

- [ ] **Step 6: Record the evaluation question**

Create `NOTES.md` containing:

```markdown
# POS Calm Workbench Prototype

Question: Which structure gives restaurant operators the clearest high-density workflow at 1024×768 while preserving existing POS muscle memory?

Variants:
- A — Calm Workbench: balanced catalog and persistent controls.
- B — Order Ledger: wider cart and denser catalog.
- C — Focus Controls: maximum workspace with contextual row controls.

Current recommendation: Variant A.
Verdict: Awaiting client review.
```

- [ ] **Step 7: Commit verified prototype**

```powershell
git add -- src/components/__prototypes__/pos-terminal-calm-workbench
git commit -m "prototype: verify POS calm workbench"
```

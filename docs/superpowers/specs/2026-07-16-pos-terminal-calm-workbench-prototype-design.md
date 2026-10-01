# POS Terminal Calm Workbench Prototype Design

## Purpose

Create a throwaway, browser-viewable redesign prototype for the existing POS terminal. The prototype answers one question: how can the terminal feel calmer, denser, clearer, and more credible on ordinary restaurant touchscreens without changing its established workflow or teal identity?

This is a visual prototype only. It must not modify, import into, or replace any production route, Vue component, store, stylesheet, API, or database behavior.

## Physical scene

A cashier or waiter uses a 1024×768 touchscreen for hours under mixed restaurant lighting. The display may have weak contrast and poor brightness. The operator needs large enough targets, dense order visibility, immediate state recognition, and minimal decorative glare.

## Design principles

- Use restrained teal for current selection, primary action, focus, and small status accents only.
- Use neutral gray surfaces with strong text contrast. Avoid bright white expanses and low-contrast gray text.
- Remove gradients, glass effects, ornamental animation, oversized rounding, deep shadows, and border-plus-shadow card styling.
- Use one type family: Inter with IBM Plex Sans Arabic fallback.
- Use Latin digits in both directions while preserving Arabic labels and RTL layout.
- Prefer separators, surface changes, and spacing over wrapping every region in a card.
- Use 8px radii for controls and 12px for modal shells. Pills are reserved for true status or compact segmented controls.
- Preserve practical touch targets: approximately 40px for compact secondary controls and 44–48px for frequent actions.
- Keep motion between 150–220ms and only for state changes. Respect reduced-motion preferences.

## Shared content and state

All variants show the same realistic Arabic restaurant state:

- Active table 6 with waiter identity and saved status.
- Search, category navigation, and a populated product catalog.
- A cart containing several products, quantity, modifiers or notes, one line discount, automatic service charge, subtotal, discount, tax, and total.
- Selected cart row state.
- Table actions: split, transfer, join, clear, save/update table, print check, and payment.
- An Arabic-first UI toggleable to English for direction testing.
- Interactive product selection, cart-row selection, category selection, numpad entry, modal opening, and variant switching using in-memory state only.

## Course behavior

- Remove the always-visible Course button from the cart utility strip.
- Remove the default “Fire Immediately / إرسال فوري” group heading.
- Keep course assignment under “More” for restaurants that use it.
- Render a course label in the cart only when an item was explicitly assigned to a course.

## Prototype variants

The prototype uses one standalone URL with `?variant=A`, `?variant=B`, and `?variant=C`. A fixed evaluation switcher cycles variants and updates the URL. Variants share content but disagree structurally.

### Variant A — Calm Workbench (recommended)

- Approximately 64% catalog and 36% cart at 1024px.
- Compact top toolbar with search as the dominant control; low-frequency controls become quiet text buttons.
- Horizontal category rail and dense product tiles with restrained color.
- Cart begins directly with the order header and item ledger.
- Secondary table actions live in a single compact overflow menu; Clear remains visible but visually quiet and destructive.
- Persistent compact numpad, summary, Update Table, and Pay region.
- Best balance between existing muscle memory and reclaimed space.

### Variant B — Order Ledger

- Approximately 58% catalog and 42% cart.
- Cart is the dominant readable ledger with wider product names, modifier detail, and explicit discounts.
- Catalog uses narrower tiles and a more compact category rail.
- Numpad is reduced to a slim keypad beside the totals.
- Best for large table orders and long item descriptions, with less catalog capacity.

### Variant C — Focus Controls

- Approximately 68% catalog and 32% cart at rest.
- Numpad is collapsed until a cart row is selected; selection opens a focused control tray.
- Cart footer prioritizes total, Save, and Pay while secondary row actions appear contextually.
- Best cart viewport and catalog capacity, but changes operator muscle memory the most.

## Product catalog

- Product tiles use moderate 8px corners, flat fills, and no large shadow.
- Price and product name form the hierarchy; icons are omitted unless they communicate state.
- Quantity-in-cart uses a compact numeric badge without shadow.
- Selected or in-cart products use a soft teal surface and a clear full outline, not a colored side stripe.
- Category controls use text labels; only the active category carries teal.

## Cart

- Treat the cart as a ledger, not a stack of cards.
- Use stable columns for item, quantity, and total. Unit price becomes secondary information inside the item cell when width is constrained.
- Selected rows use a soft teal full-row background with a subtle full outline.
- Notes, modifiers, and discounts appear as compact secondary lines, without nested pills or boxes.
- Automatic service charge is a normal ledger row with a short “تلقائي” label; no concierge icon or tinted promotional block.
- Use a single quiet rule before financial totals.

## Modals

The prototype includes two representative modal states:

1. Checkout modal
   - Width around 420px at desktop and nearly full width on narrow screens.
   - Compact header with title and plain close button.
   - Amount due stays prominent but does not become a giant hero metric.
   - Cash/card is a restrained segmented control.
   - Tendered amount, change, and confirmation form one clear vertical path.

2. More-actions modal
   - Compact action list rather than an icon grid.
   - Contains order note, line note, course assignment, customer details, split, transfer, and join where relevant.
   - Destructive actions are separated and use red text or a pale red surface only when needed.

Modal backdrops are dark enough to focus attention but not opaque. Modal shells use a solid neutral surface, one small shadow without a decorative border, and a maximum 12px radius.

## Responsive behavior

- 1366×768: balanced desktop split with full catalog and cart.
- 1024×768: primary acceptance viewport; all actions remain reachable without page scrolling.
- 768×1024: catalog remains visible while the cart opens as a full-height sheet.
- 390×844: products remain the default view; a persistent bottom order bar opens the cart sheet.
- Arabic RTL reverses structural direction while numbers remain LTR.

## Accessibility and operational checks

- Body text contrast targets at least 4.5:1; large or bold labels at least 3:1.
- Focus rings are visible and teal.
- Buttons have hover, focus, active, and disabled states.
- Selected state never depends on color alone; it also uses weight or outline.
- Variant switcher supports left/right keyboard navigation unless a form field has focus.
- Modals close with Escape and return focus to their trigger in the prototype.
- No decorative icon-only controls without an accessible label.

## Isolation and files

New files may exist only under:

`src/components/__prototypes__/pos-terminal-calm-workbench/`

The prototype will be plain HTML, CSS, and JavaScript so it cannot accidentally couple to production state. It will run from the existing Vite development server at:

`/src/components/__prototypes__/pos-terminal-calm-workbench/index.html?variant=A`

No existing file will be edited. No backend calls or persistent writes are allowed.

## Acceptance criteria

- Three structurally distinct variants are switchable from one URL.
- Variant A embodies the approved Calm Workbench direction.
- Course and “Fire Immediately” are absent from the default cart path; course remains under More.
- Teal remains the only brand accent and is used sparingly.
- No gradients, glass effects, giant rounding, deep card shadows, or decorative icon saturation.
- Product and cart density visibly improve at 1024×768.
- Checkout and More modals demonstrate the calmer component language.
- Arabic RTL and English LTR both render correctly with Latin digits.
- The browser console has no errors.
- Production files and production routes remain unchanged.


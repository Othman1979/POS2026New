---
name: POSAPP
description: A calm, accountable restaurant operating system built for live service.
colors:
  primary: "#24405e"
  primary-hover: "#1d3450"
  primary-soft: "#dce4ee"
  pos-canvas: "#e3e6ea"
  pos-surface: "#f2f4f6"
  admin-canvas: "#fafafa"
  surface: "#ffffff"
  ink: "#111827"
  admin-ink: "#09090b"
  muted: "#71717a"
  pos-border: "#c2c8d0"
  admin-border: "#e4e4e7"
  danger: "#e11d48"
  warning: "#f59e0b"
  console: "#111315"
typography:
  display:
    fontFamily: "Space Grotesk, Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 800
    lineHeight: 1.3
  title:
    fontFamily: "Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "1rem"
    fontWeight: 800
    lineHeight: 1.35
  body:
    fontFamily: "Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "0.02em"
  data:
    fontFamily: "Inter, IBM Plex Sans Arabic, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.35
    fontFeature: "tnum"
rounded:
  control-sm: "6px"
  control: "8px"
  dialog: "10px"
  container: "12px"
  round: "9999px"
spacing:
  xs: "4px"
  sm: "6px"
  control: "8px"
  compact: "10px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.pos-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control-sm}"
    padding: "10px 14px"
    height: "44px"
  button-tactile:
    backgroundColor: "{colors.pos-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "10px"
    height: "44px"
  input:
    backgroundColor: "{colors.pos-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control-sm}"
    padding: "10px 12px"
    height: "44px"
  card-pos:
    backgroundColor: "{colors.pos-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px"
  card-admin:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.admin-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.container}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.pos-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.dialog}"
    padding: "16px"
---

# Design System: POSAPP

## Overview

**Creative North Star: "The Working Counter"**

POSAPP should feel like a well-kept restaurant counter: calm enough to read under pressure, compact enough to keep the next action close, and dependable enough to disappear into the work. The voice is calm, operational, and direct. Familiar controls win over decorative novelty.

The terminal, administration, and reporting surfaces are contextual expressions of the same system. The POS terminal uses low-glare layered neutrals and shallow tactile feedback for frequently pressed controls. Administration stays flatter and quieter. Reports use ledger-like alignment and hierarchy so operational and financial numbers can be checked quickly.

The system explicitly rejects generic AI-style layouts, excessive rounding or padding, glare, gradients, decorative icons, heavy shadows, clutter, oversized cards, unnecessary motion, flicker, and unnatural interface copy.

**Key Characteristics:**

- Restrained Ledger Ink used only for action, selection, and meaningful state
- Low-glare POS surfaces with brighter administrative reading surfaces
- Compact, tactile, dependable controls with clear focus and pressed states
- Flat-by-default containers separated by tone and one-pixel borders
- Arabic and English parity, logical RTL layout, and Latin tabular digits
- Structural responsiveness for phones, tablets, POS touchscreens, and desktops

## Colors

The palette combines a deep ledger ink with quiet neutral surfaces; color communicates state and never decorates empty space.

### Primary

- **Ledger Ink** (`#24405e`): Primary actions, active navigation, selected controls, and live operational emphasis.
- **Deep Ledger Ink** (`#1d3450`): Hover states, strong ink text, and restrained contrast against ink washes.
- **Ledger Ink Wash** (`#dce4ee`): Selected rows, automatic service-charge rows, and low-intensity active states.

Use the tokens, not the hex. The two surfaces name the wash differently, so pick the token by surface:

| Role | Admin (`src/admin/styles.css`) | POS (`src/pos.css`, adapts to dark mode) |
| --- | --- | --- |
| Ink | `--color-primary` | `--color-primary` |
| Deep ink / hover | `--color-brand-800`, `--color-on-primary-container` | `--color-primary-container` (a dark fill; text on it is `--color-on-primary-container`, white) |
| Wash (low-intensity selection) | `--color-primary-container` | `--color-primary-fixed` |

In the POS, `--color-primary-container` is a dark ink fill, not the wash: never use it for a low-intensity selection there.

### Tertiary

- **Console Black** (`#111315`): Administrative console bars and dark operational navigation only.
- **Warning Amber** (`#f59e0b`): Warnings that require attention but do not indicate failure.
- **Incident Rose** (`#e11d48`): Errors, destructive actions, shortages, and failed operations only.

### Neutral

- **Low-Glare Steel** (`#e3e6ea`): Main POS canvas on screens where bright white creates fatigue.
- **Work Surface** (`#f2f4f6`): POS cards, controls, and modal content.
- **Paper White** (`#fafafa`): Administrative page canvas and report reading surface.
- **Pure Surface** (`#ffffff`): Administrative cards and focused content areas.
- **Operational Ink** (`#111827`): Primary POS text and data.
- **Console Ink** (`#09090b`): Primary administrative text and dense report headings.
- **Muted Zinc** (`#71717a`): Secondary labels, descriptions, and supporting metadata.
- **POS Divider** (`#c2c8d0`): Structural POS borders on low-glare surfaces.
- **Admin Divider** (`#e4e4e7`): Quiet administrative borders and table separators.

**The Ink Means Action Rule.** Ledger Ink marks a primary action, current selection, or meaningful live state. It is never background decoration.

**The Low-Glare Rule.** POS work areas use Low-Glare Steel and Work Surface instead of large pure-white fields. Administrative reports may use Paper White because reading density is the task.

**The Semantic Color Rule.** Rose is destructive, amber is cautionary, and ink is affirmative. Never use these colors interchangeably.

## Typography

**Display Font:** Space Grotesk with Inter and IBM Plex Sans Arabic fallbacks  
**Body Font:** Inter with IBM Plex Sans Arabic fallback  
**Label/Mono Font:** Inter with tabular numeral features for operational data

**Character:** Clear, dense, and unshowy. Arabic uses IBM Plex Sans Arabic throughout, while Latin data remains stable and quickly scannable. Display styling is reserved for large administrative metrics; it never appears on buttons or routine labels.

### Hierarchy

- **Display** (700, `2rem`, 1.2): Major dashboard totals and rare high-level report numbers.
- **Headline** (800, `1.25rem`, 1.3): Page titles and decisive modal headings.
- **Title** (800, `1rem`, 1.35): Panel, card, and section headings.
- **Body** (500, `0.875rem`, 1.5): Explanations, table content, and form values.
- **Label** (750, `0.75rem`, 1.35): Controls, field labels, statuses, and compact operational metadata.
- **Data** (700, `0.875rem`, 1.35): Prices, counts, timestamps, invoice numbers, and table numbers using tabular Latin digits.

**The One Operational Voice Rule.** Routine UI uses the body family. Space Grotesk is limited to large Latin dashboard data, and Arabic never inherits Latin display tracking.

**The Latin Digit Rule.** Digits remain Latin in Arabic and English. Monetary values, times, identifiers, and counts use tabular numerals while preserving the existing currency presentation.

## Elevation

The system is flat by default. Depth comes first from tonal layers and one-pixel borders. Repeated POS controls may use a shallow two-pixel tactile edge so pressing them gives immediate physical feedback. Shadows are reserved for overlays and floating administrative popovers, where they communicate separation from the current task.

### Shadow Vocabulary

- **Tactile Edge** (`box-shadow: 0 2px 0 #a5b0b9`): Product tiles, categories, and numpad keys that are pressed repeatedly.
- **Primary Tactile Edge** (`box-shadow: 0 2px 0 #172a3c`): The main POS confirmation action only.
- **Focused Dialog** (`box-shadow: 0 4px 8px rgb(17 24 39 / 24%)`): POS dialogs over a darkened backdrop.
- **Console Popover** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45)`): Dark administrative dropdowns that must float above the console bar.

**The Flat-By-Default Rule.** Cards and panels rest flat. If a normal content card needs a large shadow to be understood, its border or tonal hierarchy is wrong.

**The Pressed-State Rule.** Tactile controls move down by two pixels and lose their edge shadow while pressed. They never bounce, scale, or glow.

## Components

Components are compact, tactile where useful, and dependable everywhere. Every interactive component requires default, hover, focus-visible, active, disabled, loading, and error behavior when those states apply.

### Buttons

- **Shape:** Gently squared controls (`6px` or `8px` radius); circular treatment is reserved for true icon-only or status-dot controls.
- **Primary:** Ledger Ink background, white text, at least `44px` high, and compact `12px 16px` padding.
- **Hover / Focus:** Deep Ledger Ink on hover; a two-pixel Ledger Ink outline with a two-pixel offset on keyboard focus.
- **Secondary:** Work Surface or white background, one-pixel structural border, dark text, and no resting shadow.
- **Tactile:** Product, category, and numpad controls may use the Tactile Edge; the active state translates by `2px` and removes the shadow.
- **Destructive:** Incident Rose is used only when the action can remove, void, cancel, or irreversibly change work.

### Chips

- **Style:** Compact state labels use a restrained tinted background, readable semantic text, and a `5px` to `6px` radius.
- **State:** Selected filters may use Ledger Ink Wash and Deep Ledger Ink. Never use fully saturated pills for inactive options.

### Cards / Containers

- **Corner Style:** POS working cards use `8px`; administrative containers use no more than `12px`.
- **Background:** Work Surface for POS and Pure Surface over Paper White for administration.
- **Shadow Strategy:** Flat at rest. Tactile edges belong only to pressable working controls.
- **Border:** One-pixel POS Divider or Admin Divider according to the surface.
- **Internal Padding:** `10px` to `12px` for POS density; `16px` to `24px` for administrative reading surfaces.

### Inputs / Fields

- **Style:** One-pixel border, `6px` to `8px` radius, quiet surface fill, and a minimum `44px` touch height where space allows.
- **Focus:** Ledger Ink border or outline with a restrained translucent ink ring; no glow.
- **Error / Disabled:** Errors use Incident Rose with explanatory text. Disabled controls retain their shape and label while reducing contrast, never disappearing.

### Navigation

- **Style:** Navigation is compact, structurally responsive, and uses logical properties for RTL. Active items use ink text or an ink wash; inactive items remain neutral.
- **Desktop:** The administrative sidebar may collapse while preserving a stable `44px` icon lane. POS categories become a vertical rail at `1024px` and above.
- **Mobile and tablet:** Side navigation becomes a drawer or horizontal rail. Content hierarchy stays intact; controls do not merely shrink.

### Tables and Ledgers

- **Style:** Start-aligned labels, end-aligned monetary values, quiet separators, tabular digits, and sticky headers only when the scroll context needs them.
- **Density:** POS order rows stay compact. Administrative reports earn more vertical space for scanning and thermal-print decisions.
- **Responsive behavior:** Preserve core identifiers and totals; move secondary fields into row detail instead of compressing every column.

### POS Working Controls

- **Product grid:** Auto-filling tiles with `8px` radius, compact `10px` padding, readable names, stable prices, and shallow tactile feedback.
- **Numpad:** Dense four-column layout, Latin digits, consistent key geometry, and no decorative iconography.
- **Checkout:** Focused dark backdrop, compact integrated panels, structural expansion for customer details, and motion limited to short enter-only state communication (see Do's).

## Do's and Don'ts

### Do:

- **Do** use Ledger Ink (`#24405e`, admin token `--color-primary`) for primary action, active selection, and meaningful operational state.
- **Do** keep frequently pressed POS controls at least `44px` high and give them a clear pressed state.
- **Do** use low-glare POS surfaces and flatter administrative surfaces within the same component vocabulary.
- **Do** use logical CSS properties, mirrored directional affordances, and natural Arabic translations.
- **Do** keep Latin tabular digits for prices, times, identifiers, and counts in both languages.
- **Do** adapt layouts structurally at phone, tablet, POS touchscreen, and desktop breakpoints.
- **Do** mount new content on the same frame as the user's action: enter-only fades (opacity/transform, at most `150ms` desktop and `200ms` mobile, ease-out, reduced-motion override) with the outgoing element removed immediately (`.x-leave-active { display: none }`). A short leave (at most `200ms`) is acceptable only for user-triggered dismissals with nothing waiting behind them.
- **Do** make sensitive, destructive, and permission-controlled actions visually explicit without turning every action into a warning.

### Don't:

- **Don't** create generic AI-style layouts or unnatural interface copy.
- **Don't** use excessive rounding, padding, glare, gradients, decorative icons, or heavy shadows.
- **Don't** create clutter, oversized cards, or decoration that competes with operational information.
- **Don't** add unnecessary motion, flicker, or transitions that slow down live service.
- **Don't** use `mode="out-in"` on screens, sections, panes or dialogs the user is switching to.
- **Don't** introduce inconsistent controls or unfamiliar affordances without an operational reason.
- **Don't** use Ledger Ink as decoration or apply saturated color to inactive states.
- **Don't** shrink touch controls below practical use on phones, tablets, or dedicated POS hardware.
- **Don't** apply uppercase letter spacing to Arabic or substitute Arabic numerals for Latin digits.
- **Don't** use modal dialogs as the first solution when inline or progressive disclosure keeps the workflow clearer.

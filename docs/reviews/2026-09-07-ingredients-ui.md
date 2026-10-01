# Ingredients and recipe UI verification

## Ingredients redesign follow-up

- Rebuilt the ingredients ledger with name search, measure/status filters, attention and missing-opening views, sorting, and 10/25/50-row pagination. Filters work on the fetched snapshot without a request for each keystroke.
- Added permanent Arabic explanations for opening stock and every quantity column, plus expandable definitions. Opening is the first count of the business day; expected balance follows the latest count and subsequent movements. Zero is distinct from an unrecorded count.
- Reduced row actions to a visible physical-count button and a More selector. Improved movement, ingredient and opening forms with concrete field descriptions and action-specific submit labels.
- Created the requested local programmer account and signed into it in the in-app browser. No inventory movements or recipe changes were submitted during this follow-up.
- Verified the Arabic page at 1280 × 800: the table and its container both measured 968 px with no horizontal overflow or clipped actions. At 390 × 700, document width remained 390 px; labeled rows, actions, pagination and opening-dialog controls were reachable. Verified empty search, clearing filters, and the attention filter against the real two-row dataset. Restored the browser viewport afterward.
- Multi-page behavior uses a 26-ingredient test fixture, not fabricated business data. Six behavior tests cover pagination, combined filters, zero/null opening, attention classification, refresh clamping, sorting, units and request behavior.
- Final validation: 540 frontend tests across 89 files passed; the focused ingredients/recipes/i18n run passed 15 tests; `npm run build:admin` and `git diff --check` passed. No backend or schema changes.

## Reproduced in the application

- Ingredient action borders, backgrounds and table separators used nonexistent `--border`, `--card` and `--muted` variables inside `hsl()`. The current theme defines complete colors under `--color-*`.
- Recipes were accessible only through Inventory → Edit product → Recipe. The empty editor showed a cost summary for zero ingredients without explaining portion quantities.
- Ingredient dialogs had small labels, no separation of optional fields, and forms that could hide the footer at short viewport heights. The transformed app content constrained the backdrop to exclude the sidebar.

## Changes

- Use existing theme colors, visible button borders and labeled mobile ingredient rows.
- Add a searchable, paginated Product recipes workspace from Ingredients, reusing the existing recipe editor and API. Guard switching products, returning to ingredients and route navigation against unsaved changes.
- Explain per-portion quantities, show a ten-portion preview, provide an empty state and explicit Save recipe feedback. Collapse recipe rows into labeled fields on phones.
- Group optional ingredient cost/stock/packaging fields. Scroll long forms while preserving footer actions.
- Teleport shared modals and ingredient history to the body; focus a visible form field, trap modal keyboard navigation, and restore focus on close. Keep nested admin confirmation handling independent.
- Replace the recipe editor source-string test with behavior checks for quantity validation, persistence, failed saves and discarded drafts. Add search-race and navigation-guard tests.

## Evidence and boundaries

- `npm run build:admin` passed.
- Full frontend run: 538 tests across 89 files passed. Final focused recipe/workspace/ingredients/i18n checks also passed after the last UI changes.
- Browser inspection used the local application through the registered Chrome profile. Verified Arabic desktop and a 390 × 700 viewport: visible action borders, mobile rows, expanded optional fields with reachable footer, initial field focus, forward/backward focus wrapping, Escape focus restoration, direct recipe entry, unsaved-change cancellation, and a draft preview of 150 g per portion / 1500 for ten portions.
- Recipe drafts were discarded; no recipe, opening balance or stock movement was submitted. One existing ingredient form was submitted unchanged and reopened to verify its values.
- Save/error behavior is covered with API doubles; this pass did not create a new recipe in the business database or certify all other consumers of the shared modal in a browser. No backend or schema changes.

# Recipe ledger Phase 4 — combined acceptance

Task 13 is complete on `codex/inventory-recipe-research`, following the [performance corrections](2026-09-06-recipe-ledger-performance-fixes.md). Review began at `041d3a99`. One new integration defect was reproduced and fixed. The final checks below passed; no push, merge, or deployment was performed.

## Finding and correction

The actual POS browser workflow saved three separate burgers, re-saved them unchanged, and added a fourth burger. Saving again returned **409: Saved item context is stale or ambiguous**. The new burger had no saved row ID, but fallback resolution compared it with the three already-identified saved rows and treated their different recipe keys as ambiguity.

`saveTableOrder` now determines which saved rows are already represented by explicit IDs before resolving fallback identities. A new line beside those rows receives its own identity, regardless of cart order. Existing saved rows retain their frozen recipes; missing or ambiguous saved identities and duplicated saved IDs remain rejected. The change adds no database commands or dependencies.

The [new HTTP regression suite](../../backend/tests/integration/recipeLedgerPhase4Regression.test.js) demonstrated two failures before the fix and three passes afterward. It covers one or three existing burgers, a new burger before or after saved lines, a changed current recipe (250 g versus the saved 200 g), independent recipe keys, and an unchanged subsequent save.

## Combined verification

| Check | Result |
| --- | --- |
| Combined Task 13 suite, expanded for prior corrections, subscriptions, post-commit behavior, and command budgets | 629 tests passed in 30 files |
| Focused verification after the new fix | 66 tests passed in 7 files |
| Full table, bundle-table, and settlement-context follow-up after the fix | 247 tests passed in 3 files |
| Combined coverage, counting each test case once across those runs | 656 tests in 32 files; all passed |
| Complete restaurant workflow through the built UI | English and Arabic passed |
| Existing ingredient/recipe/report browser regressions | All 14 cases passed, including 390 px Arabic, retries, late responses, history pagination, and both print layouts |
| Admin production build | Passed |
| Architecture generation and validation | Passed: 232 nodes, 65 flows, 493 steps, 173 source files; existing unrelated declared defect unchanged |
| Read-only local schema comparison | Zero drift |

The combined run started before the new fix. The affected table suites and saved-line cases were then rerun on the final implementation; the 656 figure is the union of those runs, not a claim about one invocation. Two preexisting test titles are reused, so evidence preserves per-file case counts and ordered result checksums instead of collapsing by title. All other application files match the previously verified performance implementation.

## Restaurant acceptance evidence

The [browser runner](../../scripts/reviews/recipe-ledger-phase4-browser.py) performs business writes through the real built UI and independently checks quantities through HTTP reads. Each language uses a freshly seeded, isolated loopback server.

| Step | Verified result |
| --- | --- |
| Disable recipe ledger; complete a normal register sale | Sale succeeds; Ingredients navigation is hidden |
| Create Chicken and Pepsi; save both product recipes | Chicken 0.2 kg per burger; plate cost 0.90 JD and margin 82%; Pepsi one unit per drink |
| Opening quantities | Chicken 10 kg; Pepsi 100 units, equivalent to one sack and four cartons plus four loose units |
| Save three burgers and two drinks; re-save | Chicken 9.4 kg; Pepsi 98; re-save does not charge again |
| Add one burger; split into two checks; settle both | Chicken 9.2 kg; settlement does not repeat usage |
| Refund one burger from the actual split invoice | Chicken 9.4 kg; Pepsi 98; 47 burger portions; chicken usage cost 2.70 JD |
| Receive 2 kg at entered receipt cost 4.2; waste 0.5 kg | Expected chicken 10.9 kg |
| Correct the waste, then correct a receipt posted before opening | Expected chicken 11.4 kg after each correction |
| Count 11.1 kg | Stored expected 11.4 kg; variance −0.3 kg |
| Day report and A4/thermal print handshake | Chicken used 0.6 kg / 2.70 JD; closing 11.1 kg; Pepsi closing 98; rendered quantities include units |
| Next-day opening | Prior test ingredient history is shifted to yesterday by the guarded fixture helper; today's usage clears, opening prefill is 11.1 kg, and overwriting with 11 kg saves |
| Disable ledger; refund only one more burger | Chicken becomes 11.2 kg; Pepsi remains 98 |

The next-day check changes only the two named scratch ingredients' movement dates; it does not change the machine clock. The report retains the existing gross receipt/waste figures and separate correction movements; this review did not redefine that reporting model. Printed output was rendered in Chromium; physical paper output and production/Hostinger behavior were not tested.

## Reproduction and evidence

Use a fresh `POSAPP_REVIEW_DB=posapp_review_recipe_p1_<12 hex characters>` with `NODE_OPTIONS=--require=./scripts/reviews/recipe-ledger-phase1-preload.cjs` for Vitest. The [compact verification record](../../scripts/reviews/recipe-ledger-phase4-verification.json) lists the exact files, source hashes, raw-result hashes, and browser evidence.

For the browser flow, run `npm run build:admin`, start [the isolated server](../../scripts/reviews/recipe-ledger-phase3-browser-server.cjs) with another fresh review database, then run `recipe-ledger-phase4-browser.py --language en --database <that database> --output <result.json>` using Python with Playwright/Chromium. Repeat with a fresh fixture and `--language ar`. The existing `recipe-ledger-phase3-browser.py --output <result.json>` supplies the 14 browser regression cases. [The rollover helper](../../scripts/reviews/recipe-ledger-phase4-rollover.cjs) validates the scratch database name and both ingredient identities before changing fixture dates.

Preexisting research documents and local raw evidence were preserved. No schema migration, environment-file change, production-data mutation, or dependency change was needed for this correction.

## PR integration verification

The first branch-specific GitHub run passed 895 tests in 44 files and the actual predecessor upgrade on MariaDB 11.4.13. Its browser runner then exposed a navigation race: after a successful split payment, the runner opened the next check before the POS returned to `/tables`. The runner now waits for that return transition explicitly; application behavior and assertions are unchanged. Both complete language flows passed again locally, with results in `recipe-ledger-ci-browser-en.json` and `recipe-ledger-ci-browser-ar.json`. The earlier verification record remains evidence for its original reviewed revision. See [PR #7](https://github.com/skelvar/posappv4/pull/7) for the final required Release gate result.

# Release gate compatibility corrections

The first run of PR #11 at `f9210284` reproduced failures already present in the preceding `master` run at `64f1add7`. The release gate was retained and the merge paused while the causes were checked.

## Database JSON contract

Newer mysql2 recognizes MariaDB's extended JSON metadata on text/blob columns and decodes values into objects by default. Existing POS consumers explicitly parse persisted JSON text, and some pass that text back into SQL. This caused JSON parsing failures and affected category copying and spooler reprints as well as test assertions.

`buildDatabasePoolOptions` now sets `jsonStrings: true` so the established text contract is consistent across server metadata formats. Connection limits, UTC event timestamps, and the delivery-date wall-clock conversion remain unchanged. Regression tests decode actual mysql2 packets through both text-query and binary prepared-statement parsers, including Arabic JSON and SQL NULL. No query, table, migration SQL, or business rule changed.

Verification: the decoder regression failed before the option and passes afterward; all 10 pool-option tests pass. An isolated loopback run covering category copying, spooler V2 sync, print authorization, held-order numbers, and products passes **146 tests in 5 files**.

## Current fixture contracts

- The split-restore reset test now supplies the required table identity and asserts restoration succeeded before inspecting reset state. The application continues to reject checks without a table identity.
- The installer baseline test expects the current 79-table baseline and explicitly excludes the ten retired purchasing tables. Existing checks for business-row absence and retained schema remain.
- The historical procurement migration test checks the retained stock request-uniqueness index instead of a retired purchasing index. Missing/mismatched predecessor checks remain.

All three tests failed before correction. The corrected isolated run passes **28 tests in 3 files**, including a real fresh-baseline bootstrap and schema validation.

## Reviewed print artifacts

The already-merged QR change at `64f1add7` changed shared artifact CSS and the accepted JoFotara QR layout, but retained twelve older artifact-hash expectations. The compiler and built-in defaults were loaded from the preceding `2636250b` revision and compared with the current implementations on the same twelve fixtures. All eleven non-accepted artifacts have identical HTML and metadata, with only the shared QR CSS differing. The accepted JoFotara fixture additionally has the intended QR HTML/raster/layout change; its metadata is unchanged.

Only those twelve expected hashes were updated. The new values match the hashes received in the earlier Ubuntu CI run. Production compiler/defaults and legacy HTML fixtures are unchanged.

The print parity and compiler suites pass **70 tests in 2 files** in each of two fresh database-free runs, with `TZ=UTC` and `TZ=Asia/Amman`. The accepted artifact's non-QR HTML is identical; its QR changes from an inline 128-pixel image to the reviewed 556-pixel full-width placement with a white quiet zone.

The local runs use guarded test databases and do not establish customer-host behavior. The corrected PR head must pass GitHub's unchanged Release gate before integration.

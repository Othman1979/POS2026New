# Scale scanner compatibility

The attached labels contain product code `100000` and totals encoded in cents:

| Printed label | Unit price | Quantity | Total |
|---|---:|---:|---:|
| 0100000014523 | 11.00 | 1.320 | 14.52 |
| 0100000040591 | 11.00 | 3.690 | 40.59 |
| 0100000054369 | 12.00 | 4.530 | 54.36 |

## Diagnosis

The existing decoder was implemented in `ac8e56c4`, catalog wiring in `09cdfd31`, and fractional-cart wiring in `115dc95f`. All are present in this checkout. The six-digit catalog key is correct; storing the complete variable-price label as a product barcode would be incorrect for this setup.

The original 13-digit label worked through actual scanner-style keyboard events, catalog HTTP lookup and the built cart. The equivalent 12-digit input `100000014523` returned `{success:true, product:null, scale_total_cents:null}`. Earlier tests covered the printed EAN-13 strings, but not this scanner representation.

Scanner output representation is configurable: the [Opticon NFT manual](https://www.opticonusa.com/assets/documents/user-manuals/NFT-2x00%20User%20Manual.pdf) documents UPC-A as EAN-13 output with a leading zero. This supports testing both representations; it does not establish the user's actual scanner settings. The photos identify the printed digits, not the exact transmitted keystrokes or deployed revision.

## Fix

- Normalize exactly 12 numeric digits to the zero-prefixed representation before decoding. Keep checksum, positive total, and product lookup validation.
- Preserve exact ordinary-barcode precedence and inactive-product protection for both lengths. Do not guess a five-digit product key.
- Distinguish a failed network/server lookup from a genuine unknown product; previously both showed “Unknown Code.” Include Arabic copy for the lookup failure.
- No dependencies, schema changes or extra database queries.

## Evidence

- Before: real browser scanner input `100000014523` failed while `0100000014523` passed (`scratch/scale-browser-before.log`).
- After: all three labels, with and without the leading zero, passed scanner keyboard events → real lookup → real cart → payment → MySQL. Every saved product ID, quantity and total matched the table above. The final run used the rebuilt frontend (`scratch/scale-browser-final.log`, `scratch/scale-browser.json`).
- Focused suite: **63/63 passed** across `scaleBarcode`, `useTerminal`, and `bundle.catalog`. Covers invalid checksums, exact ordinary matches, inactive matches, lookup failures, and query-count parity (`scratch/scale-fix-tests.log`).
- Production frontend build passed (`scratch/scale-fix-build.log`).

Reproduce with `node scripts/reviews/scale-barcode-browser.cjs` after building. The script creates/removes only its own random loopback fixture. A fixture initially failed checkout because it assigned zero tax without updating the JoFotara category; correcting that fixture to category Z made all six payments pass.

No physical scanner or hosted deployment was accessed. The confirmed compatibility gap is fixed locally; deployment/restart is still necessary on the affected server. If that server receives all 13 digits and still fails, its deployed code/catalog/API response must be inspected rather than attributing that result to the leading-zero case.

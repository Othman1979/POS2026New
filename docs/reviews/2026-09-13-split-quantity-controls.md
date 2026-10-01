# Split quantity controls

## Behavior

Split editing now shares the item-transfer quantity control. Staff can move or return a chosen whole or fractional quantity, use All, or continue tapping the item for the default one-unit move. Both the available quantity and the quantity about to move are shown. Notes remain visible so otherwise similar saved lines can be distinguished. Half/third/quarter division remains under **Advanced fractions**.

Each pane initially renders forty lines and expands in groups of forty on demand. The allocation model still contains the whole bill, so hiding later rows does not change quantities or totals. Selection values are local to each line/check, do not trigger API requests and reset when the modal closes. Invalid, zero or excessive movement quantities do nothing. Fraction division refuses a result containing a zero-sized row at six-decimal storage precision; existing thirds/sixths residue allocation remains unchanged.

An existing split group may now put all remaining unpaid food on its Remaining Check and save that edit. New split creation still requires moving at least one item to a destination. The existing server rewrite retains its revision checks, frozen pricing, fee/discount allocation and immutable paid checks. No backend/schema changes were needed for this task.

Mutation controls and close/Escape stay locked while split confirmation is pending. Desktop/mobile navigation, drag assignment, keyboard focus trapping and reduced-motion behavior remain available. The keyboard trap includes the new disclosure controls and excludes hidden fraction buttons.

## Verification

- Ten new quantity/remaining-only cases failed before implementation, then passed: exact fractional move/return with saved metadata intact, malformed/zero/excessive quantities, sub-quantum division, and a remaining-only rewrite request.
- 275 existing split-math and order-session unit checks passed; 29 focused frontend checks passed; 11 existing progressive split lifecycle integration cases passed. Production build, architecture generation/check and whitespace checks passed.
- Real built UI, HTTP and MySQL passed English/Arabic desktop/mobile. A saved 3.25-unit order with a 10% service charge and 0.50 JD order discount remained 6.65 JD throughout: move 2.125, return 0.125, divide the remainder into quarters, add another check and finalize. A delayed committed response verified that edits and close/Escape were blocked until acknowledgement.
- After paying one check, the UI hid Cancel Splits. All remaining unpaid food was then returned to the Remaining Check and saved. All fetched fields in the paid order remained unchanged. Reload and final checkout produced two payments of **4.08 JD and 2.57 JD**, totaling 6.65 JD. Product stock remained 96.75 from 100, ingredient usage remained -3.25, and the table released after the last payment. No browser page errors occurred.
- Large-list verification expanded 40 → 80 → 120 rows, moved the last saved line and verified its note on the destination, with no HTTP writes. Layout review covered desktop/mobile in both languages. A missing Arabic Move label was corrected and rechecked in a focused Arabic browser capture. The visual detector reported one advisory for the existing 0.7rem action-label size.

## Resource comparison

Five local samples per size, with the built application, loaded saved cart and two animation-frame observation points. No API reads or writes occurred when opening/editing the split preview. This measures local presentation timing, including frame scheduling; it is not an INP or customer-device benchmark.

| Saved lines | Initial rendered rows before → after | Dialog DOM nodes before → after | Open observation p50 before → after |
| ---: | ---: | ---: | ---: |
| 1 | 1 → 1 | 65 → 74 | 4.8 → 5.0 ms |
| 120 | 120 → 40 | 1850 → 1011 | 32.9 → 26.2 ms |

The quantity controls add work and row height on a small bill; the measured small-case difference is within frame-scheduling noise and is not a speedup claim. Large bills perform less initial rendering. Full-bill quantity and money calculations remain necessary and retain their existing allocation semantics.

Evidence and guarded harnesses: `scratch/split-quantity-20260913/`. Eight recorded generated loopback fixture databases are verified removed. No customer database, machine environment file, physical printer or deployment was changed.

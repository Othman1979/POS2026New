# Receipt Item Note Rendering Implementation Plan

**Revision 2 — 2026-08-25.** Revision 1 named two row producers and missed a third, specified no test for the held/split mapper, and proposed a new test file that duplicates an existing one. This revision supersedes it; do not work from the earlier copy.

> **TASK 1 DONE — 2026-08-25, commit `255597be`.** The three-line backend fix shipped with tests for all three mappers, mutation-proved. Item notes now render on paid receipts, reprints, admin prints, held checks, split receipts and guest checks.
>
> **STILL DEFERRED:** the custom-template question in "Custom template scope" below. `printTemplateEngine.js:368` requires only `name`, `qty`, `netAmount`, so a published custom revision may omit the note binding and that venue still sees no notes. Making it required invalidates every published revision lacking it, so it needs a migration story and belongs to the print-template redesign — the builder is over-guarded and its drag-and-drop too constrained to build on. Formal modifier display stays deferred with it.

**Goal:** Make the item note stored in `order_items.note` appear on the customer receipt, on every server-derived receipt path.

**Architecture:** `order_items.note` is already correct in the database and the built-in receipt template already binds it. Three separate mappers build the row input that reaches `buildReceiptPresentation()`, and none of them copies `note`, so every row arrives with an empty note and the template's truthy guard hides it. Add the field in all three and pin each with a test that drives the real producer. No schema change, no template change, no new module, no new test file.

**Tech Stack:** Express, MySQL/MariaDB, Vitest, Supertest.

## Global Constraints

- Do not add a migration, column, dependency, setting, template revision, i18n key, or test file.
- Do not change `order_items.note` writing, note composition in the browser, or the built-in print templates.
- Do not change receipt money. `note` is display text and contributes nothing to any total.
- Keep `Auto-Gratuity` suppressed: it is the internal service-charge marker, not a customer note, and `receiptPresentation.js:40` already blanks it.
- Normalize `note` in exactly one place. `receiptPresentation.js:40` owns blanking and the `?? ''` default; `printDocumentModel.js` owns the 500-character bound. A mapper copies the raw value and nothing else.
- This plan guarantees the **built-in** receipt template only — see "Custom template scope" below.
- Formal modifier display (`Size: Large`) is out of scope — see "Out of scope" below.
- Use focused RED/GREEN tests only.
- Do not deploy, migrate, merge, or push as part of this plan.

---

## Evidence

Every item below was reproduced against the test database or confirmed by direct experiment, not read off the source.

### The defect

1. A checkout carrying both a typed note and a priced note persists correctly:

```
DB order_items.note   : "No onion\nTwo slices (+0.20)"
DB selected_modifiers : [{"group":"Size","option":"Large","price":0.5,"gid":"g1","oid":"o1"},
                         {"noteProductId":11,"group":"Two slices","option":"Two slices","price":0.2}]
```

2. Printing that invoice through `POST /api/print/print` produces:

```
receipt_display_v1 rows  : [{"name":"Test Burger","note":""}]
html contains "No onion" : false
html contains "Two slices": false
```

3. **Three** mappers build the row input and none carries `note`:

| # | Location | Feeds |
|---|---|---|
| 1 | `backend/services/ReceiptPresentationSources.js:186-199` (`orderPresentationInput`) | paid receipts, reprints, admin order prints, checkout |
| 2 | `backend/services/ReceiptPresentationSources.js:386-427` (held/split mapper) | held checks, split receipts |
| 3 | `backend/routes/print.js:627-646` (guest-check mapper) | guest checks / provisional table prints |

   All three emit the same field list — `key, kind, name, qty, price, discountType, discountValue, tax_rate, parent_item_id, modifier_surcharge, modifier_tax_amount` — and all three **read** `item.note` a few lines earlier for the Auto-Gratuity price check before dropping it.

4. Mapper 3 matters independently. `print.js:662` passes its already-stripped rows into `buildOrderPresentation()`, which maps them again through mapper 1. Fixing mapper 1 alone cannot recover a field that was stripped upstream, so guest checks stay broken unless mapper 3 is fixed too.

5. `src/utils/receiptPresentation.js:40` then evaluates `String(source.note ?? '')` and yields `''`.

6. Adding `note: item.note` to mapper 1 flipped the reproduction: `html contains "No onion": true`, `html contains "Two slices": true`. Applying it to mappers 1 and 2 kept 44 adjacent receipt tests green. Both experiments were reverted; they are the proof, not the fix.

### Scope is wider than the original report

7. This drops **every** item note, not only note-product text. A hand-typed `No onion` is lost identically.
8. Kitchen tickets are unaffected: `backend/services/printDocumentModel.js:201` maps `note` for the kitchen model. That is why the same note prints in the kitchen and vanishes on the customer copy.
9. Not a built-in template problem. `backend/services/printTemplateDefaults.js:66` defines `receipt-item-note` bound to `note` with a truthy visibility guard, and both `print_templates` rows currently have `active_revision_id = NULL`, so the built-in template is live.

### Age and ownership

10. `note` has **never** existed in any of the three mappers: `git log -S "note: item.note" -- backend/services/ReceiptPresentationSources.js` returns nothing. Mapper 1 was introduced by `05446ee3` (2026-07-12, `feat(pos): emit authoritative receipt presentation data`) already missing the field.
11. The legacy split payload at `backend/routes/print.js:573` **does** carry `note: item.note || ''`. So the field was understood to matter on the old item-list path and was simply not carried into the `receipt_display_v1` row shape that superseded it.
12. This is therefore **not** a regression from the catalog-backed priced-note work. That work is only how the defect surfaced: it created a new class of item note and nobody checked that it reached the customer copy.

### Why nothing caught it

13. `note` is optional in the presentation contract. `src/utils/receiptPresentation.js:165` accepts `row.note` when it is `null`/absent and only rejects a non-string. Four producers may therefore disagree about the field while `validateReceiptPresentation()` stays green.
14. A fourth producer *does* carry it. `src/pos/stores/orderSession/checkoutFlow.js:31` emits `note: item.note ?? ''`. It is unreachable in practice: `checkoutFlow.js:171` prefers `response.receipt_display_v1`, and the server always returns one for a modern order, so the note-carrying builder only runs for pre-v1 legacy orders.
15. The only existing assertions on a row note — `backend/tests/unit/printDocumentModel.test.js:168` and `backend/tests/unit/spoolerReceiptDisplay.test.js:163` — hand-construct the row and feed it to the consumer. They test the renderer, never a producer, so the seam where the field is lost has no coverage at all.

---

## Custom template scope

`backend/services/printTemplateEngine.js:368` requires only `name`, `qty`, and `netAmount` in a receipt's primary rows band. A published custom revision may legally omit the `note` binding, and this plan does **not** change that.

So after this fix: a venue on the built-in template sees item notes; a venue that published a custom revision without a note field still will not. That is the current, intended template freedom — the same freedom that lets a venue drop the invoice number. Making `note` a required binding is a separate decision with migration weight, because every already-published revision that lacks it would become invalid. Do not make it here. Record it as an open question for the owner.

---

## Out of scope: formal modifier display

`Size: Large` is missing from the receipt too, but it is a **different problem with a different fix**, and it needs a product decision before any code moves:

- `src/utils/receiptPresentation.js:35-49` has no field for modifiers at all. Only the money reaches the receipt, folded into `modifier_surcharge`.
- The built-in receipt template has no node that could render one.
- Note-category products only ever appeared because `src/pos/noteProductSelections.js:34` composes their text into `item.note`. Formal modifiers were never composed anywhere.

Fixing it means adding a field to the row shape, a node to the built-in template, an entry to the template field catalog, and deciding whether a customer copy should show `Size: Large` at all when its price is already inside the line total. Do not start it inside this plan.

---

## File map

- Modify `backend/services/ReceiptPresentationSources.js`: carry `note` in mappers 1 and 2.
- Modify `backend/routes/print.js`: carry `note` in mapper 3, the guest-check builder.
- Modify `backend/tests/unit/receiptPresentation.test.js`: pin the paid and held/split producers at the unit seam. Do **not** create a new test file — this one already imports `buildOrderPresentation` and `buildHeldPresentations` at `:8`, and already drives the held path with a stub queryable at `:358`.
- Modify `backend/tests/integration/checkout.test.js`: pin the note reaching the fresh checkout receipt and a reprint. It already provides `openShift()`, `cashierCookie`, `cashierShiftId`, and `[priced note]` fixtures.
- Modify `backend/tests/integration/print.authz.test.js`: pin the guest-check route's independent row producer and compiled artifact.
- Modify `backend/tests/integration/adminRouting.test.js`: pin admin order details to the shared paid-order producer.
- Modify `backend/tests/unit/printDocumentModel.test.js`: pin the existing 500-character printable-note boundary.

---

### Task 1: Carry the item note through all three receipt row producers

**Files:**
- Modify: `backend/tests/unit/receiptPresentation.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/print.authz.test.js`
- Modify: `backend/tests/integration/adminRouting.test.js`
- Modify: `backend/tests/unit/printDocumentModel.test.js`
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/routes/print.js`

**Interfaces:**
- Consumes: `order_items` rows, held `cart_data` items, and guest-check `data.items`, each carrying `note`.
- Produces: `receipt_display_v1.rows[].note` populated from the source row on the paid, held, split, and guest-check paths.

- [x] **Step 1: Write the failing unit tests for mappers 1 and 2**

Add to `backend/tests/unit/receiptPresentation.test.js`. The paid cases:

```js
  describe('item notes survive into the receipt row', () => {
    const order = {
      invoice_id: 1, subtotal: 2.70, tax: 0, total: 2.70,
      discount_type: null, discount_value: 0, tax_inclusive_at_sale: 0,
      tax_exempt_at_sale: 0, tax_registration_type_at_sale: 'sales_tax',
      payment_method: 'cash', parent_invoice_id: null
    };
    const paidRow = (note) => buildOrderPresentation({
      order,
      items: [{ id: 5, item_name: 'Burger', quantity: 1, price_at_sale: 2.70, tax_rate: 0, note }]
    }).rows[0];

    it('copies a typed note onto a paid receipt row', () => {
      expect(paidRow('No onion').note).toBe('No onion');
    });

    it('keeps a multi-line note mixing manual text and a priced note', () => {
      expect(paidRow('No onion\nTwo slices (+0.20)').note).toBe('No onion\nTwo slices (+0.20)');
    });

    it('still suppresses the Auto-Gratuity marker', () => {
      expect(paidRow('Auto-Gratuity').note).toBe('');
    });

    it('leaves a row with no note as an empty string', () => {
      expect(paidRow(null).note).toBe('');
    });
  });
```

Then the held and split cases, which are what makes mapper 2 a committed test rather than a hope. Copy the stub-queryable idiom already used at `receiptPresentation.test.js:358`:

```js
    const heldRow = async (note, split) => {
      const [entry] = await buildHeldPresentations({
        query: async (sql) => {
          // buildHeldPresentations reads the tax-mode setting before the items.
          // Omit this branch and the stub throws before the mapper is ever reached.
          if (sql.includes('FROM settings')) return [[{ setting_value: '0' }]];
          if (sql.includes('FROM order_items')) return [[{ id: 7, tax_rate: 0 }]];
          throw new Error(`Unexpected query: ${sql}`);
        }
      }, [{
        id: 9,
        reference_name: split ? 'Table 4 / Seat 1' : 'Hold 9',
        cart_data: JSON.stringify({
          items: [{ id: 7, name: 'Burger', qty: 1, price: 2.70, tax_rate: 0, note }],
          subtotal: 2.70, tax: 0, total: 2.70
        })
      }], { split });
      return entry.presentation.rows[0];
    };

    it('copies a typed note onto a held check row', async () => {
      expect((await heldRow('No onion', false)).note).toBe('No onion');
    });

    it('copies a typed note onto a split check row', async () => {
      expect((await heldRow('No onion', true)).note).toBe('No onion');
    });

    it('suppresses Auto-Gratuity on a held check row', async () => {
      expect((await heldRow('Auto-Gratuity', false)).note).toBe('');
    });
```

This fixture is verified: it reaches mapper 2 and fails with `expected '' to be 'No onion'` on both variants, then passes once Step 4 is applied. Do not weaken the assertion, and do not skip the split variant.

- [x] **Step 2: Write the failing integration test for the checkout and reprint paths**

Add to `backend/tests/integration/checkout.test.js` a test named `[priced note] renders the item note on the fresh receipt and on a reprint`. It must use the **catalog-backed note workflow**, because that is the defect that surfaced this, and it must assert the fresh checkout response *before* reprinting, because a receipt the cashier never reprints is the common case:

```js
    it('[priced note] renders the item note on the fresh receipt and on a reprint', async () => {
        await openShift();
        const [category] = await pool.query(
            "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
        );
        const [note] = await pool.query(
            "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
            [category.insertId]
        );
        await pool.query("UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?", [SEED.product1.id]);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Note Front', 'receipt', 'windows', 'Note Front', 'primary')"
        );

        const checkout = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id, qty: 1, price: 2.90,
                note: 'No onion\nTwo slices (+0.20)',
                selectedModifiers: [{ noteProductId: note.insertId }]
            }],
            shift_id: cashierShiftId,
            subtotal: 2.90, tax: 0, total: 2.90,
            payment_method: 'cash', amount_tendered: 3, change_due: 0.10,
            idempotency_key: 'receipt-note-render'
        });
        expect(checkout.statusCode).toBe(200);
        expect(checkout.body.receipt_display_v1.rows[0].note).toBe('No onion\nTwo slices (+0.20)');

        const printed = await request(app).post('/api/print/print').set('Cookie', cashierCookie).send({
            print_type: 'receipt', invoice_id: checkout.body.invoice_id, receipt_printer_id: printer.insertId
        });
        expect(printed.statusCode).toBe(200);

        const [[job]] = await pool.query("SELECT payload FROM print_queue WHERE print_type='receipt' ORDER BY id DESC LIMIT 1");
        const data = JSON.parse(job.payload).data;
        expect(data.receipt_display_v1.rows[0].note).toBe('No onion\nTwo slices (+0.20)');
        expect(data.compiled_document_v1.html).toContain('No onion');
        expect(data.compiled_document_v1.html).toContain('Two slices');
    });
```

- [x] **Step 3: Run the focused tests and observe RED**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js -t "note"
npx vitest run backend/tests/integration/checkout.test.js -t "renders the item note"
```

Expected: the note assertions fail with `expected '' to be 'No onion'` on both the paid and held paths, and the compiled HTML does not contain the note. The Auto-Gratuity and empty-note cases already pass, for the wrong reason — they are regression anchors for Step 4, not evidence.

- [x] **Step 4: Carry the field in all three mappers**

Add one line, `note: item.note,`, directly after `name` in each returned object:

- `backend/services/ReceiptPresentationSources.js:190` — mapper 1, after `name: item.item_name || item.name || 'Unknown Item',`
- `backend/services/ReceiptPresentationSources.js:418` — mapper 2, after `name: item.name || item.item_name || 'Unknown Item',`
- `backend/routes/print.js:636` — mapper 3, after `name: item.name || 'Unknown Item',`

Do not normalize, trim, blank, or default the value in any mapper. Those responsibilities already have owners, named in the Global Constraints.

- [x] **Step 5: Run the focused tests and observe GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js -t "note"
npx vitest run backend/tests/integration/checkout.test.js -t "renders the item note"
```

Expected: all seven unit cases and the integration case pass.

- [x] **Step 6: Run the adjacent receipt regressions**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/checkoutFlow.test.js
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/taxExemptWorkflow.test.js
```

Expected: no failures. A row gaining a populated string field must not move any total; if a money assertion moves, stop and treat it as a real finding rather than updating the expectation.

- [x] **Step 7: Break it before committing**

Confirm each by experiment, not by reading:

1. Revert mapper 1 only; the paid unit cases and the integration test must go RED. Restore.
2. Revert mapper 2 only; the held **and** split unit cases must go RED. Restore. If they do not, the held fixture is not reaching the mapper and Step 1 is not finished.
3. Revert mapper 3 only; print a guest check and confirm its note disappears while the paid receipt keeps its own. Restore.
4. Check out with `note: 'Auto-Gratuity'` on a real line and confirm the receipt still shows an empty note.
5. Check out a line with a 600-character note and confirm the compiled artifact truncates at 500 without throwing.
6. Confirm `orders.subtotal`, `orders.total`, and every `order_items` money column are byte-identical before and after the change for the same cart.

- [x] **Step 8: Commit Task 1**

```powershell
git add backend/services/ReceiptPresentationSources.js backend/routes/print.js backend/tests/unit/receiptPresentation.test.js backend/tests/integration/checkout.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/adminRouting.test.js backend/tests/unit/printDocumentModel.test.js
git commit -m "fix(pos): show item notes on the customer receipt"
```

---

## Completion review

Answer each from source and test evidence before reporting done:

1. Does a typed item note render on a fresh receipt, a reprint, an admin order print, a held check, a split receipt, and a guest check? All six must, and each must be covered by a test that drives the real producer.
2. Does a priced-note line render its generated text? It must, by the same mechanism as a typed note — no second code path.
3. Is `Auto-Gratuity` still suppressed on the customer copy, on both the paid and held paths? It must be.
4. Did any money value change anywhere? None may.
5. Is `note` normalized in exactly one place? It must be.
6. Do the new tests exercise the real producers rather than hand-built rows? They must; that is the specific gap that let this ship.
7. Is the custom-template limitation written down and surfaced to the owner as an open decision? It must be — the fix does not cover a published revision that omits the note binding.

## Lessons this defect teaches

Recorded for review, not for implementation:

- **An optional field in a shared contract is an unenforced contract.** `note` was optional, so four producers disagreed for six weeks and the validator never complained. If a field belongs to the row shape, either the validator requires it or every producer is tested against one shared fixture.
- **Test the seam, not the end you find convenient.** Both existing note tests hand-built a row and asserted the renderer. The renderer was never broken. Everything between the database and the renderer was, and it had no test.
- **When you find the second instance of a bug, stop patching and go count.** Revision 1 of this plan found two mappers and declared the goal met. There were three. The tell was mechanical — every producer reads `item.note` for the Auto-Gratuity check and then omits it from the return — so one `grep` for the shared field list would have found all of them before any code was written.
- **A step written as prose is not a test.** Revision 1 said "add or run a held-check receipt" in the break-it section. That sentence would have passed review, shipped nothing, and left half the fix unverified.
- **A feature is not delivered until you look at its output.** The priced-note work added a new kind of item note, canonicalized it, priced it, froze it, persisted it, and tested five lifecycles — without ever printing one and reading it.

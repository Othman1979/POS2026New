# Checkout UI remediation — 2026-09-10

Reviewed against `48e6721d` on `codex/checkout-receipt-formatter`. The original
[Grok audit](2026-09-10-checkout-ui-audit.md) is preserved. This review covers all
18 confirmed findings, not only the five in the chat summary.

## Findings and dispositions

| ID | Fix and verification |
| --- | --- |
| C1 | `checkoutFlow.js` separates receipt validation from payment success. Checkout finalizes the confirmed sale before printing. An invalid presentation suppresses local printing and directs the operator to Orders. Store and browser regressions send invalid receipt data with a successful payment response; the cart finalizes and another Pay does not charge it again. |
| C2 | `useTerminal` accepts saved-transaction context. Checkout kitchen/receipt and subscription collect/reverse/refund paths warn that the transaction succeeded when printing fails. Unexpected printer-helper exceptions cannot reverse a successful subscription result. Browser 503 and store exception cases pass. |
| C3 | Selected styling and `aria-pressed` normalize order-type IDs the same way as the click handler. Browser starts with string `"3"` and numeric catalog ID `3`, then changes types and pays. |
| C4 | Hash selection focuses the actual `checkout-hash` field. Verified in Chromium. |
| C5 | POS confirms replacement of a populated draft and checks ownership/content around confirmation and claim. An intervening payment/hold also blocks replacement. Failures retain the handoff and show a warning. Browser executes the production handler: failed claim, declined replacement, edit during delayed claim, then successful explicit retry. |
| C6 | Server rejects a supplied mixed/nonmatching subscription cart before canonical pricing. An explicit empty array remains valid for the existing server-priced plan API. POS blocks extra catalog items during a pending subscription purchase. Real HTTP/SQL subscription tests verify both compatibility and rejection. |
| C7 | Fingerprint includes split ID, revision and parent invoice. Tests distinguish sibling checks and revisions. A sent request retains its original payload/key for recovery. |
| C8 | Split restore uses authoritative `table_id`, then saved payload identity, then legacy floor lookup. Missing identity fails before replacing the draft. Store regression restores a renamed check without a matching floor row. |
| C9 | A private in-flight flag survives UI resets. Previous-sale success keeps a newer draft and labels the notification accordingly. **Adjustment to Grok's recommendation:** the paid sale still prints its frozen kitchen/receipt payload; suppressing that work merely because the cashier navigated would lose legitimate printing. Tests cover busy-state reset and session replacement. |
| C10 | Pay checks hold state. Hold/split restore check private checkout state. Split restore owns an in-flight guard and rechecks draft ownership/content after workspace loading. Checkout and split-board controls reflect busy state. Delayed-restore and Pay-during-hold cases pass. |
| C11 | Held persistence carries `baselineUnknown`; round-trip test verifies it with kitchen firing state. |
| C12 | Browser guest payload carries `guest_check`. Preview and thermal markup explicitly label it unpaid, independently of configurable template blocks. Both outputs are rendered in the test. |
| C13 | Reverse/refund keys are separate and scoped to subscription/collection. Retries keep their key; editing a reason does not rotate it. Busy state is reserved before confirmation and released in `finally`. Tests cover duplicate clicks, confirmation failure, different operations and switching subscription targets. |
| C14 | Table restore retains its saved type/hash. Register defaults do not apply to table sessions. A table that actually requires a hash exposes the field. Restore and order-type render tests pass. |
| C15/C16 | Server derives settlement from the locked held order's type, including a historically inactive type. Held platform checkout succeeds with zero cash/card; forged client cash cannot change settlement. Two real create/claim/checkout tests assert persisted order type and tender. **Adjustment to Grok's recommendation:** retain valid held-platform checkout rather than disabling it. |
| C17 | `pos_pending_checkout` retains the frozen submitted request and draft identity. Close/reload/new-draft actions do not erase uncertain requests. Recovery reuses original tender/key and keeps newer drafts. POS exposes explicit recovery even with an empty register. Store/browser tests cover cash/split tender resets, reload, changed/empty drafts and authorization failure during retry. |
| C18 | Platform success says the platform sale was recorded. Platform/receivable preview and thermal output omit Tendered/Change and state that no payment was collected. Browser and rendering tests pass. |

## Adjacent fixes and limits

- Fingerprint construction now supplies `payment.method` correctly (S14).
- The public order-type action accepts `null` and synchronizes settlement itself
  (S11/S12); a store test exercises it without the modal handler.
- Success-notification rejection is contained (S4); it cannot become an unhandled
  payment error.
- Recovery storage excludes manager PINs. Retry uses current manager authority;
  another cashier cannot silently replay the original cashier's sale. Tests inspect
  storage and the retry payload.
- An uncertain request is not discarded on a later authorization/server rejection:
  rejection of a retry does not establish that the original failed. Restore the
  original cashier's authority or investigate the sale before proceeding. There is
  no unsafe “forget payment and charge again” action.
- Recovery is local to this browser's storage, not a cross-terminal journal.
  Clearing browser data removes that evidence. No new polling, worker, migration,
  dependency or payment-provider request was added.
- Remaining audit suspicions about idle standalone-print state, customer-lookup
  messaging, unusual permission combinations, last-line held lease expiry and
  receipt-preview discoverability were not promoted to confirmed failures. This
  report does not claim exhaustive proof of every hypothetical application path.

## Verification

1. `npm run test:isolated -- orderSessionStore.test.js orderSessionBoundaries.test.js checkoutFlow.test.js checkoutAttemptCache.test.js orderSessionPersistence.test.js`
   — **294/294**, five files; `posapp_review_recipe_p1_f53a9973de3a`.
2. `npm run test:frontend -- receiptPreviewRender.spec.js receiptSplitPayment.spec.js checkoutSplitPayment.spec.js orderWorkflowTransitions.spec.js subscriptionModal.spec.js subscriptionReturns.spec.js tableSplitsBoard.spec.js posTerminalOwnership.spec.js`
   — **75/75**, eight files.
3. Earlier real-database run: `npm run test:isolated -- checkout.test.js subscriptionPurchase.test.js checkoutPostCommit.test.js`
   — **177 passed, four failed** across five files on
   `posapp_review_recipe_p1_c2e7d21e7c45`. The four failures exposed the empty-array
   canonical subscription compatibility requirement. After correcting the guard,
   **all 16 subscription purchase cases passed** on
   `posapp_review_recipe_p1_292f5175de66`. Other checkout/postcommit files, including
   the new held-platform cases, passed the earlier run. These are separate runs;
   the original combined run was not green.
4. `node scripts/reviews/checkout-ui-browser.cjs` — **12 browser checks passed**,
   four controlled checkout requests and three held claims, no Vue/page errors.
   JSON: ignored `scratch/checkout-ui-browser-results.json`.
5. Facade scan: **133 exports**, no dangling exports or missing consumer bindings.
   Private store-only symbols are not missing UI exports. Focused boundary tests
   also pass.
6. Production admin/POS/standalone-print build, architecture validation and Git
   whitespace checks pass.

The browser harness mounts real Checkout/Receipt components with Pinia stores and
HTTP helpers. It reads the handoff function from the production SFC and executes
it with the same store dependencies; it does not mount the complete router,
scanner, socket or shift bootstrap. Auth/catalog and HTTP outcomes are fixtures.
Real-database cases ran only on generated loopback test databases. No customer
database, physical printer, live card transaction, JoFotara submission or
Hostinger deployment was used. No push or deployment is part of this work.

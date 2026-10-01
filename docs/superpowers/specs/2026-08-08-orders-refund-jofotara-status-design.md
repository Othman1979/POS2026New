# Orders Refund and JoFotara Status Design

## Decision

Order History will expose refund and JoFotara state where administrators already inspect sales. It remains a compact ledger, not a second JoFotara Operations page.

## Filters

The existing Filters popover gains two single-choice groups:

- Refund: all, not refunded, partial refund, full refund.
- JoFotara: all, not sent, accepted, needs attention.

Filters run in `GET /api/admin/orders` before pagination and therefore affect the rows, record count, pages, and revenue summary consistently. Unknown filter values are ignored rather than changing the result set.

`needs_attention` means an original invoice document exists but is not accepted: pending, submitting, rejected, or unknown. This gives every JoFotara state a filter home without creating a control for each internal processing state.

## Row status markers

Desktop rows and mobile cards show a compact status line below the invoice identity. The existing refund marker moves from the payment area into this line; it is not rendered twice. The line may contain:

- Original JoFotara invoice: `مرحل`, `لم يرحل`, `قيد الإرسال`, `رفضتها فوترة`, or `تحتاج مراجعة`.
- Financial refund: `مرتجع جزئي` or `مرتجع كامل`.
- JoFotara return, only when a financial refund exists and the original invoice was accepted: `المرتجع مرحل`, `المرتجع لم يرحل`, `المرتجع قيد الإرسال`, `المرتجع مرفوض`, or `المرتجع يحتاج مراجعة`.

Voided orders do not show JoFotara markers. Refund and JoFotara markers remain independent because one order can be financially refunded while its legal return has a different submission state.

Status markers are small squared chips using the existing admin semantic colors: teal for accepted, neutral zinc for not sent, blue for sending, rose for rejected/full refund, and amber for review/partial refund. They contain readable text rather than unexplained dots or icon-only states.

## Return aggregation

An invoice may have more than one saved refund. The Orders endpoint returns one aggregate `jofotara_return_status` without multiplying order rows:

1. `unknown` if any return is unknown.
2. `rejected` if any return is rejected.
3. `submitting` if any return is submitting.
4. `pending` if any return document is pending.
5. `not_submitted` if any saved refund has no JoFotara document.
6. `accepted` only when every saved refund has an accepted JoFotara document.
7. `null` when the order has no financial refunds.

The aggregate is display information only. Submission, retry, QR, and detailed error handling stay owned by JoFotara Operations and the existing order detail modal.

## Scope boundaries

- No schema or migration changes.
- No new endpoint or frontend API module.
- No dedicated status column.
- No client-only filtering of a paginated result.
- No change to refund calculations, JoFotara submission, automatic submission, or printing.
- No attempt to replace JoFotara Operations.

## Verification

- Integration tests prove refund and JoFotara filters are applied before pagination and stats, invalid values are ignored, joins do not duplicate orders, and multiple returns aggregate conservatively.
- Orders binding tests prove both query parameters, filter reset/count/chips, desktop markers, mobile markers, and natural Arabic keys are wired.
- Production build verifies the Vue template and translations compile.

# Shift-opening drawer reference design

## Goal

When a staff member reaches the POS shift-opening modal, show the counted closing cash from the most recently closed shift in the current business day as a read-only reference. The staff member must still count the drawer and enter the new shift's starting cash manually.

## Authority and disclosure

- `shifts.actual_cash` is the only source for the reference.
- Use the existing configured business-day window from `backend/utils/businessDate.js`.
- Return only `previous_shift_closing_cash`, never the previous shift ID, cashier, timestamps, sales, expected cash, or variance.
- Return `null` when the actor lacks `shift.open`, when there is no closed shift in the current business day, or while any shift remains open. The last condition avoids presenting one drawer's cash as authoritative when the schema has no physical-drawer identity.
- The value is informational only. It never defaults, overwrites, or validates `starting_cash`.

## Data flow

Extend the existing authenticated self-shift check (`GET /api/auth/shifts?action=check`) rather than add another endpoint. If the user has no open shift and can open one, load the latest non-null `actual_cash` whose `closed_at` is inside the current business-day range, provided no shift is open. Return it as `previous_shift_closing_cash`; otherwise return `null`.

`src/pos/useAuth.js` stores the optional numeric reference separately from `startingCashInput`. `src/components/PosTerminal.vue` renders a compact read-only reference above the existing starting-cash input.

English copy:

- `Previous shift drawer closing balance`
- `For reference only. Count the drawer and enter the current amount.`

Arabic copy:

- `رصيد الصندوق عند إغلاق الوردية السابقة`
- `للمقارنة فقط. عُدّ النقد وأدخل الرصيد الحالي.`

## Verification

- The first shift of a business day receives `null`.
- Multiple sequential shifts receive only the latest closed shift's actual cash.
- A prior-business-day close is excluded.
- Missing `shift.open` authority and any currently open shift suppress the reference.
- Frontend hydration stores the reference without changing the starting-cash input.
- The modal contains no previous-shift metadata beyond the amount.

No schema change or migration is required.

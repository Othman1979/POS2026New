# Call-Center Review Fixes Implementation Plan

> **Execution skill:** Use `executing-plans` and mandatory test-first TDD. Execute tasks strictly in order. Do not use subagents unless the user explicitly asks.

**Goal:** Fix every verified call-center regression, security hole, recovery gap, and operator-context omission that changes real behavior. Keep benign cleanup out.

**Fixed point:** `codex/call-center-held-orders` at `2ab654e0`. The implementation must start from that commit (or a descendant containing it) and must not merge or push.

**Architecture:** Keep authority in the existing catalog route, held-order lifecycle, order-session store, Users route, and POS components. Reuse the existing claim/version/token APIs, Socket.IO event, translation catalog, and theme variables. Add no table, migration, endpoint, permission, service, controller, framework, or background job.

## Global constraints

- Work inline on `codex/call-center-held-orders`; do not create a branch/worktree, merge, push, rebuild installers, or apply migrations.
- Preserve all unrelated/user work. Before every task, confirm the tree contains only the prior committed tasks plus the two review documents.
- Run one Vitest process at a time because the suites share `posapp_test`.
- Use focused Vitest files during Tasks 1–9. Run the full Vitest suite exactly once in Task 10.
- English is the i18n identity fallback. English text is the key; add/rename only the matching Arabic entries in `src/shared/i18n/ar.json`.
- Never weaken the fixed-role wall: `call_center` has zero grants, no shift, and no checkout/payment/print/refund/admin authority.
- Do not touch any migration, `.auto.sql`, `auto-manifest.json`, Hostinger fallback, database baseline, fixture schema, or schema validator. The migration chain was independently verified.
- `docs/architecture.html` is generated. Edit only `docs/architecture.json`, then run `npm run architecture`.
- Do not log phone/name/address/cart/token data.
- After each task: inspect the whole task diff, run its focused tests, run `git diff --check`, and commit only that task with the exact message shown.

---

## Task 1 — Restore public QR availability updates

The branch changed the global `product_availability_changed` emit to the `staff` room. QR-menu sockets do not join `staff`, so customers retain stale availability until reload.

**Files**

- Modify `backend/routes/pos/catalog.js`
- Test `backend/tests/integration/bundle.catalog.test.js`

### RED

In the existing product-availability PATCH test, after the current `product_availability_changed` assertion, add:

```js
expect(global.__mockTo__.mock.calls.filter(call => call[0] === 'staff')).toHaveLength(1);
```

Run:

```powershell
npx vitest run backend/tests/integration/bundle.catalog.test.js
```

Expected RED: two `staff` room selections are recorded.

### GREEN

Change only the availability handler’s emit block to:

```js
if (req.io) {
    req.io.to('staff').emit('inventory_changed');
    req.io.emit('product_availability_changed', payload);
}
```

Run the same focused test; expect green.

Commit:

```powershell
git add backend/routes/pos/catalog.js backend/tests/integration/bundle.catalog.test.js
git commit -m "fix: restore public product availability updates"
```

---

## Task 2 — Scope immediate 401 draft cleanup to call-center sessions

Fable’s report overclaimed that an ordinary draft survives a later successful login: `src/components/Login.vue` already performs deliberate cross-user cleanup. The real branch regression is that the global interceptor now destroys POS state immediately on any internal 401 for every role. Preserve the approved call-center privacy rule (customer PII is cleared on expiry), but do not wipe cashier/waiter/table drafts here.

**Files**

- Modify `src/shared/authInterceptor.js`
- Test `src/shared/__tests__/authInterceptor.spec.js`

### RED

Replace the interceptor source-contract test with:

```js
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('auth interceptor POS boundary', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/shared/authInterceptor.js'), 'utf8');

  it('clears POS order state only for an expired call-center session', () => {
    const block = source.slice(source.indexOf('if (response.status === 401'), source.indexOf('return response'));
    expect(block).toMatch(/sessionStorage\.getItem\('pos_user'\)/);
    expect(block).toMatch(/role === 'call_center'[\s\S]*clearPosOrderSession\(localStorage\)/);
    expect(block.indexOf("getItem('pos_user')")).toBeLessThan(block.indexOf("removeItem('pos_user')"));
    expect(block).toMatch(/sessionStorage\.removeItem\('pos_user'\)[\s\S]*location\.href/);
  });
});
```

Run:

```powershell
npx vitest run src/shared/__tests__/authInterceptor.spec.js
```

Expected RED: cleanup is unconditional and the stored role is never checked.

### GREEN

Keep the existing import. Read the stored user before removing authentication, tolerate corrupt storage, and scope only the POS-state wipe:

```js
if (response.status === 401 && isInternalApi && !resourceUrl.includes('api/auth/login')) {
    let expiredUser = null;
    try { expiredUser = JSON.parse(sessionStorage.getItem('pos_user') || 'null'); } catch (_) {}
    if (expiredUser?.role === 'call_center') clearPosOrderSession(localStorage);
    sessionStorage.removeItem('pos_user');
    removeLegacyReadableToken();
    window.location.href = '/login?reason=expired';
}
```

Do not clear ordinary POS state in the `else` path. Successful login remains the existing cross-user cleanup boundary.

Run the focused test; expect green.

Commit:

```powershell
git add src/shared/authInterceptor.js src/shared/__tests__/authInterceptor.spec.js
git commit -m "fix: scope 401 draft cleanup to call center"
```

---

## Task 3 — Require phone proof before a call-center claim returns PII

Only the call-center claim route needs the phone to be mandatory. Later update/follow-up/release/cancel routes already require the valid claim token and expected version. Align the wire contract with the approved `{ phone }` field instead of the implementation-only `customer_phone` field.

**Files**

- Modify `backend/routes/pos/orders.js`
- Modify `src/pos/stores/orderSession/orderSessionApi.js`
- Test `backend/tests/integration/heldOrders.test.js`
- Test `src/components/pos/__tests__/callCenterWorkflow.spec.js`

### RED

In `heldOrders.test.js`, in `searches exact normalized phone metadata and requires that phone before revealing cart`:

1. Rename the existing claim request keys from `customer_phone` to `phone`.
2. After the `activeWrongPhone` assertions, add:

```js
const noPhone = await request(app)
    .post(`/api/pos/held_orders/${created.body.id}/claim`)
    .set('Cookie', callCenterCookie)
    .send({ claim_token: 'c'.repeat(64), expected_version: good.body.claim.version });
expect(noPhone.statusCode).toBe(404);
expect(noPhone.body.code).toBe('CALL_CENTER_HELD_ORDER_NOT_FOUND');
expect(JSON.stringify(noPhone.body)).not.toContain('cart_data');
```

In `callCenterWorkflow.spec.js`, replace the current whole-file claim assertion with a function-bounded assertion so unrelated customer payloads may still use their canonical names:

```js
const claimApi = api.slice(
  api.indexOf('export const claimHeldOrder'),
  api.indexOf('export const updateHeldOrder'),
);
expect(claimApi).toContain('{ phone: customerPhone }');
expect(claimApi).not.toContain('customer_phone');
```

Run:

```powershell
npx vitest run backend/tests/integration/heldOrders.test.js src/components/pos/__tests__/callCenterWorkflow.spec.js
```

Expected RED: the backend still accepts an omitted phone and the wrapper still serializes `customer_phone`.

### GREEN

Change the guard to:

```js
async function assertCallCenterHeldRow(conn, row, { phone = null, requirePhone = false } = {}) {
    if (!row?.call_center_user_id || !isRegisterHold(row) || row.parent_invoice_id != null || row.table_id != null) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    if (requirePhone && (typeof phone !== 'string' || !phone.trim())) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    const payload = readHeldPayload(row);
    await assertCallCenterOrderType(conn, payload.order_type_id);
    const storedPhone = normalizeCustomerPhone(payload.customer_phone);
    if (phone != null && normalizeCustomerPhone(phone) !== storedPhone) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    return { payload, storedPhone };
}
```

At the call-center branch of `POST /held_orders/:id/claim`, call:

```js
await assertCallCenterHeldRow(conn, candidate, {
    phone: req.body?.phone,
    requirePhone: true,
});
```

Leave the other four guard call sites unchanged. In `orderSessionApi.claimHeldOrder`, keep the JavaScript argument name `customerPhone` but serialize:

```js
...(customerPhone ? { phone: customerPhone } : {}),
```

Run:

```powershell
npx vitest run backend/tests/integration/heldOrders.test.js backend/tests/integration/callCenterRoleWalls.test.js src/components/pos/__tests__/callCenterWorkflow.spec.js
```

Commit:

```powershell
git add backend/routes/pos/orders.js src/pos/stores/orderSession/orderSessionApi.js backend/tests/integration/heldOrders.test.js src/components/pos/__tests__/callCenterWorkflow.spec.js
git commit -m "fix: require phone proof for call-center claims"
```

---

## Task 4 — Make reconnect and unknown cancellation outcomes fail closed

Two recovery paths belong together because both must preserve the same local draft and reuse the same claim authority:

- Reconnect must claim the stored held ID at the stored version and update only lease metadata; it must never restore the fresh server cart over local edits.
- A lost cancellation response must not consult the filtered phone-match list. Reuse `POST /held_orders/:id/claim` with the same token/version/phone: `404` proves the row is gone; `200` proves it remains; `409`/network/other responses remain uncertain and must preserve the draft.

**Files**

- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/shared/i18n/ar.json`
- Test `backend/tests/unit/orderSessionStore.test.js`

### RED

Add five tests to the existing `useOrderSessionStore — call-center boundary` describe:

1. `reconnect reclaims at the stored version and keeps local cart edits`
   - restore held id 55/version 3/token `x`.repeat(64), phone `0791234567`, one Burger;
   - add a local Cola;
   - mock `claimHeldOrder` success with claim version 4/new token;
   - assert it was called with id 55, expectedVersion 3, and that phone;
   - assert both cart lines remain and only `restoredHeldOrder.version/token/expiry` changed.
2. `reconnect version conflict preserves the draft and refreshes exact-phone matches`
   - same setup;
   - mock claim 409 `HELD_VERSION_CONFLICT`;
   - mock `getCustomerByPhone` and `findPhoneHeldOrders` as successful empty responses;
   - assert false, two cart lines, context version still 3, and `findPhoneHeldOrders` called.
3. `lost cancellation response keeps the draft when same-token claim proves the row remains`
   - restore id 55/version 3/token/phone/cart;
   - mock `cancelHeldOrder` to reject `TypeError('network lost')`;
   - mock `claimHeldOrder` as 200 with `data.order` and claim version 3/same token/new expiry;
   - assert false, cart/context preserved, and claim called with the existing token/version/phone (not a fresh token).
4. `lost cancellation response clears the draft only when claim returns 404`
   - same setup;
   - cancellation rejects;
   - claim returns 404 `CALL_CENTER_HELD_ORDER_NOT_FOUND`;
   - assert true, cart cleared, call-center intake reset, and success toast shown.
5. `lost cancellation response with a claim conflict preserves the draft and refreshes matches`
   - cancellation rejects;
   - reconciliation claim returns 409;
   - mock customer lookup and `findPhoneHeldOrders` success;
   - assert false, cart/context and cancellation operation ID remain, and exact-phone matches refresh.

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js
```

Expected RED: reconnect refreshes/restores the server row, and cancellation still uses `findCallCenterOrders()` absence as proof.

### GREEN — reconnect

Replace `reconnectCallCenterOrder` with a claim-only implementation:

```js
const reconnectCallCenterOrder = async () => {
  const context = restoredHeldOrder.value;
  if (!context?.id || getDeps().auth.activeUser.value?.role !== 'call_center') return false;
  const claimToken = createHeldClaimToken();
  try {
    const { response, data } = await orderSessionApi.claimHeldOrder({
      id: context.id,
      claimToken,
      expectedVersion: Number(context.version),
      customerPhone: customerPhone.value || callCenterSession.value.searchedPhone,
    });
    if (response.ok && data.success && data.order) {
      restoredHeldOrder.value = {
        ...context,
        version: Number(data.claim?.version || context.version),
        claimToken: data.claim?.claimToken || claimToken,
        claimExpiresAt: data.claim?.claimExpiresAt || null,
      };
      persistOrderContext();
      return true;
    }
    if (response.status === 409) {
      await findCallCenterOrders();
      window.showPosToast?.(t('This phone order changed on the server. Your draft is preserved.'), 'warning');
      return false;
    }
    window.showPosToast?.(data.message || t('This phone order is no longer available.'), 'warning');
    return false;
  } catch (_) {
    window.showPosToast?.(t('Network error. Your phone order was not changed.'), 'error');
    return false;
  }
};
```

### GREEN — cancellation reconciliation

Replace only the `catch` body in `cancelCallCenterOrder` with:

```js
} catch (_) {
  try {
    const { response, data } = await orderSessionApi.claimHeldOrder({
      id: context.id,
      claimToken: context.claimToken,
      expectedVersion: context.version,
      customerPhone: customerPhone.value || callCenterSession.value.searchedPhone,
    });
    if (response.status === 404) {
      clearHeldOperationId('cancel', context.id, localStorage);
      finishCallCenterOrder();
      window.showPosToast?.(t('Order cancelled'), 'success');
      return true;
    }
    if (response.ok && data.success && data.order) {
      restoredHeldOrder.value = {
        ...context,
        version: Number(data.claim?.version || context.version),
        claimToken: data.claim?.claimToken || context.claimToken,
        claimExpiresAt: data.claim?.claimExpiresAt || context.claimExpiresAt || null,
      };
      persistOrderContext();
      window.showPosToast?.(t('The phone order is still open. Your draft is preserved.'), 'warning');
      return false;
    }
    if (response.status === 409) await findCallCenterOrders();
  } catch (_) {
    // Still uncertain: never clear the local draft or the retry operation id.
  }
  window.showPosToast?.(t('Could not confirm whether the order was cancelled. Your draft is preserved.'), 'error');
  return false;
}
```

Do not clear the cancellation operation ID on any uncertain path.

Add these Arabic keys near the existing call-center entries:

```json
"This phone order changed on the server. Your draft is preserved.": "تغيّر هذا الطلب على الخادم. تم الاحتفاظ بمسودتك.",
"The phone order is still open. Your draft is preserved.": "الطلب الهاتفي ما زال مفتوحاً. تم الاحتفاظ بمسودتك.",
"Could not confirm whether the order was cancelled. Your draft is preserved.": "تعذر التأكد من إلغاء الطلب. تم الاحتفاظ بمسودتك."
```

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js src/components/pos/__tests__/callCenterWorkflow.spec.js
```

Commit:

```powershell
git add src/pos/stores/orderSessionStore.js src/shared/i18n/ar.json backend/tests/unit/orderSessionStore.test.js
git commit -m "fix: preserve call-center drafts during recovery"
```

---

## Task 5 — Prevent cleared cashier discounts from resurrecting on FOLLOW UP

The backend merges submitted cart fields over the previous payload. Omitting a zero discount therefore means “keep the old discount.” Call center must continue omitting synthetic zero authority; register users must explicitly send zero.

**Files**

- Modify `src/pos/stores/orderSessionStore.js`
- Test `backend/tests/unit/orderSessionStore.test.js`

### RED

Add a test that sets the active role to `cashier`, restores a held order with a 10% discount, changes `store.orderDiscount` to `{ type:'percent', value:0 }`, sends FOLLOW UP, and asserts:

```js
expect(followUp.mock.calls[0][1].cart.order_discount).toEqual({ type: 'percent', value: 0 });
```

Keep the two existing call-center tests proving synthetic zero is omitted and a pre-existing nonzero server-authored discount is preserved.

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js
```

Expected RED: cashier payload omits `order_discount`.

### GREEN

In `sendHeldOrderFollowUp`, use:

```js
...(getDeps().auth.activeUser.value?.role === 'call_center'
  ? (Number(orderDiscount.value?.value || 0) !== 0
      ? { order_discount: orderDiscount.value }
      : {})
  : { order_discount: orderDiscount.value || { type: 'percent', value: 0 } }),
```

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/integration/heldOrders.test.js
```

Commit:

```powershell
git add src/pos/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix: persist cleared register discounts on follow-up"
```

---

## Task 6 — Release claims on permission revocation and surface ambiguous customer lookup

These are the two worthwhile lower-severity operational gaps. Keep them in one small admin/frontend recovery task:

- revoking `pos.hold_orders` must release any active claim just like a role change, while name edits and unrelated grant changes that retain `pos.hold_orders` must not interrupt work;
- duplicate normalized customer phones return a deliberate 409 but the intake silently ignores it. Warn the worker to enter details manually, then continue the active-phone-order search.

**Files**

- Modify `backend/routes/admin/users.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/shared/i18n/ar.json`
- Test `backend/tests/integration/users.test.js`
- Test `backend/tests/unit/orderSessionStore.test.js`

### RED — permission edit

In `users.test.js`:

1. Change the current misleading `does not interrupt ... profile-only update` test into `releases an active held claim when hold authority is revoked without a role change`; keep its claimed row, query the current grant keys and send all of them except `pos.hold_orders`, then assert version 5 plus null claim fields and one `staff/held_orders_changed` emit.
2. Add a true profile-only test: query the user’s current grant keys, send those same keys while changing only the name, and assert version remains 4 and claim fields remain intact.
3. Add `does not release an active claim when unrelated grants change but hold authority remains`: send the current grant set without `orders.view` but with `pos.hold_orders`, and assert version/claim fields remain unchanged.

### RED — ambiguity warning

In the call-center store describe:

```js
it('warns about ambiguous customer records but still searches active phone orders', async () => {
  const lookup = vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
    response: { ok: false, status: 409 },
    data: {
      success: false,
      code: 'CUSTOMER_PHONE_AMBIGUOUS',
      message: 'More than one customer uses this phone number. Enter the details manually.',
    },
  });
  const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
    response: { ok: true, status: 200 },
    data: { success: true, data: [] },
  });
  const s = useOrderSessionStore();
  s.customerPhone = '0791234567';
  await s.findCallCenterOrders();
  expect(window.showPosToast).toHaveBeenCalledWith(
    'More than one customer uses this phone number. Enter the details manually.',
    'warning',
  );
  expect(matches).toHaveBeenCalledWith('0791234567');
  lookup.mockRestore();
  matches.mockRestore();
});
```

Run:

```powershell
npx vitest run backend/tests/integration/users.test.js backend/tests/unit/orderSessionStore.test.js
```

### GREEN — permission change detection

Inside the existing Users PUT transaction, after locking the target user and before `releaseActiveHeldClaims`:

```js
const [currentGrantRows] = await conn.query(
    'SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key FOR UPDATE',
    [userId]
);
const [implementedRows] = await conn.query(
    'SELECT perm_key FROM permissions WHERE implemented=1'
);
const implemented = new Set(implementedRows.map(row => row.perm_key));
const requestedGrantKeys = (role === 'admin' || role === 'programmer' || role === 'call_center')
    ? []
    : [...new Set((Array.isArray(data.permissions) ? data.permissions : [])
        .filter(key => implemented.has(key)))].sort();
const currentGrantKeys = currentGrantRows.map(row => row.perm_key).sort();
const losesHoldAuthority = currentGrantKeys.includes('pos.hold_orders')
    && !requestedGrantKeys.includes('pos.hold_orders');
const releasedClaims = (role !== targets[0].role || losesHoldAuthority)
    ? await releaseActiveHeldClaims(userId, conn)
    : 0;
```

Keep `replaceUserGrants` as the single writer and keep release + user/grant update in the same transaction. Do not release for name/user-number/section edits or unrelated grant changes when `pos.hold_orders` remains granted.

### GREEN — ambiguity warning

In `findCallCenterOrders`, immediately after `getCustomerByPhone` and the stale-phone guard:

```js
if (customerResult.response?.status === 409
    && customerResult.data?.code === 'CUSTOMER_PHONE_AMBIGUOUS') {
  window.showPosToast?.(t(customerResult.data.message), 'warning');
}
```

Do not throw; continue to `findPhoneHeldOrders`. Add:

```json
"More than one customer uses this phone number. Enter the details manually.": "يوجد أكثر من عميل يستخدم رقم الهاتف هذا. أدخل بيانات العميل يدوياً."
```

Run the same two focused files; expect green.

Commit:

```powershell
git add backend/routes/admin/users.js src/pos/stores/orderSessionStore.js src/shared/i18n/ar.json backend/tests/integration/users.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix: recover held claims after access changes"
```

---

## Task 7 — Complete operator context in the call-center UI

Do not redesign the POS. Add only the approved missing information/control:

- match rows show original worker, kitchen/FOLLOW UP state, and active claimant;
- after Start Order, a compact identity strip shows customer name/phone with one Edit action and one Cancel Call/Cancel edits action;
- destructive cancellation shows reference, total item quantity, and kitchen/FOLLOW UP state before reason selection;
- cancellation labels match the approved bilingual design exactly.

All styling must use existing POS theme variables and work in graphite/light mode.

**Files**

- Modify `src/components/PosTerminal.vue`
- Modify `src/components/pos/PosCartWorkspace.vue`
- Modify `src/components/pos/CheckoutModal.vue`
- Modify `src/pos/useCart.js`
- Modify `src/pos.css`
- Modify `src/shared/i18n/ar.json`
- Test `src/components/pos/__tests__/callCenterWorkflow.spec.js`

### RED

Extend `callCenterWorkflow.spec.js` to assert:

```js
const ar = JSON.parse(read('src/shared/i18n/ar.json'));
expect(terminal).toContain('match.call_center_user_name');
expect(terminal).toContain('match.kitchen_dispatch_version');
expect(terminal).toContain('match.claim_owner_name');
expect(cart).toContain('call-center-cart-identity');
expect(cart).toContain('editCallCenterCustomer');
expect(checkout).toContain('call-center-cancel-context');
expect(checkout).toContain('restoredHeldReference');
expect(checkout).toContain("label: 'Customer changed mind'");
expect(checkout).toContain("label: 'Order entered incorrectly'");
expect(ar['Call taken by']).toBe('استلم المكالمة');
expect(ar['Customer changed mind']).toBe('العميل غيّر رأيه');
expect(ar['Order entered incorrectly']).toBe('أُدخل الطلب بالخطأ');
expect(ar).not.toHaveProperty('Customer changed their mind');
expect(ar).not.toHaveProperty('Entered by mistake');
```

Run:

```powershell
npx vitest run src/components/pos/__tests__/callCenterWorkflow.spec.js
```

### GREEN — match metadata

In `PosTerminal.vue`, keep the current button and its date/Continue column. Under customer/item count, add three compact metadata lines:

```vue
<small v-if="match.call_center_user_name">
  {{ $t('Call taken by') }}: <span data-no-i18n>{{ match.call_center_user_name }}</span>
</small>
<small>
  {{ $t(match.kitchen_fired ? 'Kitchen sent' : 'Not sent') }}
  <template v-if="Number(match.kitchen_dispatch_version) > 1">
    · {{ $t('FOLLOW UP') }} #{{ Number(match.kitchen_dispatch_version) - 1 }}
  </template>
</small>
<small v-if="match.claimed_by_user_id && match.claim_expires_at && new Date(match.claim_expires_at).getTime() > Date.now()">
  {{ $t('Being edited') }}<span v-if="match.claim_owner_name" data-no-i18n>: {{ match.claim_owner_name }}</span>
</small>
```

### GREEN — identity strip

In `useCart.js`, re-export the existing `restoredHeldReference` ref. Do not derive anything in the facade.

In `PosCartWorkspace.vue`:

- remove the current call-center-only Cancel button from the navigation bar;
- put `v-if="!isCallCenter || mobileCartOpen"` on the navigation wrapper so it remains for normal POS and for the mobile close button, but does not waste a blank 48px row on a desktop call-center cart;
- immediately below it add one `.call-center-cart-identity` strip when `isCallCenter`;
- show `customerName || $t('Phone order')`, the phone, Edit, and exactly one Cancel Call/Cancel edits action;
- `editCallCenterCustomer` sets `showCustomerDrawer.value = true` and `showCheckoutModal.value = true` directly, so editing also works before any cart item is added;
- reuse `handleCallCenterAbort` for the cancel action.

Required script additions to the existing `useCart()` destructure:

```js
showCheckoutModal,
showCustomerDrawer,
customerPhone,
customerName,
restoredHeldReference,
```

Required helper:

```js
const editCallCenterCustomer = () => {
  showCustomerDrawer.value = true;
  showCheckoutModal.value = true;
};
```

### GREEN — cancellation context and labels

In `CheckoutModal.vue`, destructure `restoredHeldReference` and add:

```js
const callCenterCancelItemCount = computed(() => cart.value.reduce(
  (sum, item) => sum + Math.max(0, Number(item.qty || 0)),
  0,
));
```

At the top of `.call-center-cancel-box`, before the reason label, add:

```vue
<div class="call-center-cancel-context">
  <strong data-no-i18n>{{ restoredHeldReference || `Phone #${restoredHeldOrder?.id || ''}` }}</strong>
  <span>{{ callCenterCancelItemCount }} {{ $t('items') }}</span>
  <span>
    {{ $t(restoredHeldOrder?.kitchenFired ? 'Kitchen sent' : 'Not sent') }}
    <template v-if="Number(restoredHeldOrder?.kitchenDispatchVersion) > 1">
      · {{ $t('FOLLOW UP') }} #{{ Number(restoredHeldOrder.kitchenDispatchVersion) - 1 }}
    </template>
  </span>
</div>
```

Use the exact labels/codes:

```js
const callCenterCancelReasons = [
  { value: 'customer_changed_mind', label: 'Customer changed mind' },
  { value: 'duplicate_order', label: 'Duplicate order' },
  { value: 'entered_in_error', label: 'Order entered incorrectly' },
  { value: 'other_customer_request', label: 'Other customer request' },
];
```

Delete stale English keys `Customer changed their mind` and `Entered by mistake`. Add/update:

```json
"Call taken by": "استلم المكالمة",
"Phone order": "طلب هاتفي",
"Customer changed mind": "العميل غيّر رأيه",
"Duplicate order": "طلب مكرر",
"Order entered incorrectly": "أُدخل الطلب بالخطأ",
"Other customer request": "طلب آخر من العميل"
```

### GREEN — scoped CSS

Add next to the existing call-center CSS in `src/pos.css`:

```css
.call-center-cart-identity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 52px;
  padding: 8px 10px;
  color: var(--color-on-surface);
  background: var(--color-surface-container-low);
  border-bottom: 1px solid var(--color-outline-variant);
}
.call-center-cart-identity__customer { display: grid; min-width: 0; gap: 2px; }
.call-center-cart-identity__customer strong,
.call-center-cart-identity__customer small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.call-center-cart-identity__customer small { color: var(--color-on-surface-variant); }
.call-center-cart-identity__actions { display: flex; flex: 0 0 auto; gap: 6px; }
.call-center-cart-identity__actions button { min-height: 38px; padding: 0 10px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container-high); color: var(--color-on-surface); font-weight: 800; }
.call-center-cart-identity__actions .is-danger { color: var(--color-error); }
.call-center-cancel-context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding-bottom: 8px; border-bottom: 1px solid var(--color-outline-variant); color: var(--color-on-surface-variant); }
.call-center-cancel-context strong { color: var(--color-on-surface); }
@media (max-width: 640px) {
  .call-center-cart-identity { align-items: stretch; flex-direction: column; }
  .call-center-cart-identity__actions button { flex: 1; }
}
```

Run:

```powershell
npx vitest run src/components/pos/__tests__/callCenterWorkflow.spec.js
npm run build
```

Commit:

```powershell
git add src/components/PosTerminal.vue src/components/pos/PosCartWorkspace.vue src/components/pos/CheckoutModal.vue src/pos/useCart.js src/pos.css src/shared/i18n/ar.json src/components/pos/__tests__/callCenterWorkflow.spec.js
git commit -m "feat: complete call-center operator context"
```

---

## Task 8 — Add browser proof only for the changed recovery and UI paths

Do not duplicate every backend failure-injection test in Playwright. Extend the existing serial spec with two high-value browser flows: mobile/light operator context and 1024/graphite reconnect/version conflict.

**Files**

- Modify `tests/e2e/specs/call-center.holds.spec.js`

### Test helper changes

Split the current helper without changing its behavior:

```js
async function findPhoneOrder(page, id) {
  const intake = page.getByRole('dialog', { name: 'New Phone Order' });
  await intake.getByLabel('Mobile No.').fill(customerPhone);
  await intake.getByRole('button', { name: 'Find active phone orders' }).click();
  const match = intake.getByRole('button').filter({ hasText: `Phone #${id}` });
  await expect(match).toBeVisible();
  return match;
}

async function findAndContinue(page, id) {
  const match = await findPhoneOrder(page, id);
  await match.click();
  await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeHidden();
}
```

Add this helper for expiry simulation:

```js
async function expireClaimForBrowser(page, id, { bumpVersion = false } = {}) {
  await pool.query(
    `UPDATE held_orders
        SET claim_expires_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE)
            ${bumpVersion ? ', version=version+1' : ''}
      WHERE id=?`,
    [id],
  );
  await page.evaluate(() => {
    const context = JSON.parse(localStorage.getItem('pos_order_context') || 'null');
    if (!context?.heldOrder) throw new Error('Expected persisted held-order context');
    context.heldOrder.claimExpiresAt = '2000-01-01T00:00:00.000Z';
    localStorage.setItem('pos_order_context', JSON.stringify(context));
  });
  await page.reload();
  await waitForPos(page);
}
```

Add one exact bounds helper and use it for every scoped light/graphite assertion:

```js
async function expectInsideViewport(locator, width, height) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}
```

### Browser test A — mobile/light context

Insert after `sends a phone hold ...` and before any kitchen fire:

1. Open a new context with `baseURL`, log in using `secondPhonePin`, set viewport `390x844`, and go to `/pos`.
2. Use `findPhoneOrder(page, heldOrderId)` and assert the match contains `E2E Phone Desk` and `Not sent`.
3. Continue; assert `.call-center-cart-identity` contains `Phone Customer`, `customerPhone`, `Edit`, and `Cancel edits`.
4. While this lease is active, open one observer context logged in with `setupPhonePin`, search the same phone, and assert the match contains `Being edited` and `E2E Second Phone Desk`; close only the observer context.
5. Back on the mobile page, click Edit; assert the `Send Order` dialog and Mobile No. input are visible; click the dialog’s Customer button to collapse the customer panel, then close the dialog.
6. Open Send Order again, click Cancel order, and assert `.call-center-cancel-context` contains ``Phone #${heldOrderId}``, `1 items`, and `Not sent`.
7. Click Cancel edits (not Confirm cancellation), assert intake reopens, then close the browser context. This releases the lease and preserves the held row for the next test.
8. Use `expectInsideViewport` on the match, identity strip, and cancel context at the points where each is visible. The context is light by default.

### Browser test B — graphite reconnect and conflict

Insert next, still before the existing kitchen fire/follow-up/cancel test:

1. Open a context with `baseURL`, log in using `secondPhonePin`, set viewport `1024x768`, and set `localStorage.pos_theme='dark'` before `/pos`.
2. `findAndContinue(page, heldOrderId)`; assert `.call-center-cart-identity` is visible in graphite, then click the existing product card for `SEED.product1.name` once so the local quantity becomes 2.
3. Call `expireClaimForBrowser(page, heldOrderId)`.
4. Open Send Order, click Reconnect to order, assert the button disappears, then assert the exact product row still has quantity 2:

   ```js
   const cartRow = page.locator('.cart-items-scroll tbody tr')
     .filter({ hasText: SEED.product1.name })
     .first();
   await expect(cartRow.locator('td').nth(1)).toHaveText('2');
   ```

   Close the dialog.
5. Call `expireClaimForBrowser(page, heldOrderId, { bumpVersion:true })`.
6. Open Send Order, click Reconnect to order, assert the toast `This phone order changed on the server. Your draft is preserved.` and repeat the exact product-row quantity assertion above.
7. Assert `.pos-polish.pos-theme-dark` is visible and the dialog bounds stay within 1024x768; close the context. Do not save the local extra item. The server row remains available (expired lease) for the existing follow-up/cancel test.

### Run

```powershell
npx playwright test tests/e2e/specs/call-center.holds.spec.js
```

In the existing final follow-up/cancellation test, use `findPhoneOrder` instead of immediately continuing at both recall points:

- after the cashier’s initial kitchen fire, assert the match contains `Kitchen sent` and the original source `E2E Phone Desk`, then click it;
- after FOLLOW UP, assert the next match contains `Kitchen sent`, `FOLLOW UP #1`, and the same original source, then click it.

Before the final cancellation click, simulate a committed DELETE whose response is lost:

```js
await page.route(`**/api/pos/held_orders/${heldOrderId}`, async route => {
  if (route.request().method() !== 'DELETE') return route.continue();
  const response = await route.fetch();
  expect(response.ok(), await response.text()).toBe(true);
  await route.abort('failed');
}, { times: 1 });
```

Keep the existing UI and database assertions. They now prove that the DELETE committed, the browser lost its response, the same-token claim reconciliation received 404, the UI cleared safely, and exactly one cancellation ticket/audit row exists.

Expected: all serial call-center tests green; no duplicate hold, print job, or cancellation side effect.

Commit:

```powershell
git add tests/e2e/specs/call-center.holds.spec.js
git commit -m "test: prove call-center recovery and operator context"
```

---

## Task 9 — Map the call-center flow in the architecture authority

The graph currently has no call-center reference. Add exact nodes/flow using the existing schema and IDs; do not invent placeholder IDs or hand-edit HTML.

**Files**

- Modify `docs/architecture.json`
- Generate `docs/architecture.html`

### JSON additions

Add these nodes:

```json
{
  "id": "actor-callcenter",
  "layer": "actor",
  "label": "Call-center worker",
  "sub": "fixed zero-permission role; no shift or checkout authority"
},
{
  "id": "reg-held-orders-route",
  "layer": "api",
  "label": "Held-order HTTP lifecycle",
  "sub": "phone create/search/claim/update/release/follow-up/cancel plus cashier-held workflows",
  "file": "backend/routes/pos/orders.js"
}
```

Add this flow using existing node IDs `reg-terminal`, `db-held_orders`, `actor-cashier`, `reg-execute-checkout`, and `db-orders`:

```json
{
  "id": "pos-flow-callcenter-phone-order",
  "label": "Call-center phone order to cashier checkout",
  "actor": "actor-callcenter",
  "summary": "A fixed shiftless call-center role creates and safely recalls attributed phone holds; only a cashier can consume the locked hold through normal checkout.",
  "steps": [
    { "n": 1, "from": "actor-callcenter", "to": "reg-terminal", "label": "Enter customer identity and build a phone cart", "file": "src/components/PosTerminal.vue" },
    { "n": 2, "from": "reg-terminal", "to": "reg-held-orders-route", "label": "Create or phone-search/claim a server-repriced register hold", "file": "backend/routes/pos/orders.js" },
    { "n": 3, "from": "reg-held-orders-route", "to": "db-held_orders", "label": "Persist source, lease/version state, kitchen baseline and held audit atomically", "file": "backend/routes/pos/orders.js" },
    { "n": 4, "from": "actor-cashier", "to": "reg-execute-checkout", "label": "Cashier supplies shift and payment authority; call-center is rejected", "file": "backend/modules/checkout/executeCheckout.js" },
    { "n": 5, "from": "reg-execute-checkout", "to": "db-held_orders", "label": "Lock and consume the exact held row only after successful checkout work", "file": "backend/modules/checkout/executeCheckout.js" },
    { "n": 6, "from": "reg-execute-checkout", "to": "db-orders", "label": "Persist cashier as seller and copy call-center source only from the locked hold", "file": "backend/modules/checkout/executeCheckout.js" }
  ]
}
```

Append this invariant to `meta.invariants`:

```json
"A call_center session always has zero grants and no section/shift authority; checkout, payment, refund, expense, service-charge, print, table, manager-override and admin routes reject the role. Phone-source attribution is written by the server on held creation and copied to orders only from the locked held row during cashier checkout."
```

### Verify and commit

```powershell
npm run architecture
npm run architecture:check
git add docs/architecture.json docs/architecture.html
git commit -m "docs: map the call-center phone-order flow"
```

---

## Task 10 — Final branch verification (no implementation commit)

Run in this order:

```powershell
npx vitest run
npx playwright test tests/e2e/specs/held-order-lifecycle.spec.js tests/e2e/specs/call-center.holds.spec.js
npm run build
npm run architecture:check
git diff --check 2ab654e0..HEAD
git log --oneline 2ab654e0..HEAD
git status --short
```

Expected:

- full Vitest suite green (run only once here);
- both focused browser workflows green;
- production build and architecture authority green;
- exactly nine task commits after `2ab654e0`;
- only the two review/plan documents may remain untracked; no product-code changes uncommitted;
- no migration/schema/manifest/fallback diff;
- no merge or push.

If the single full Vitest run fails, fix only the confirmed failing task with focused tests and report that the one-full-run rule prevents claiming a fresh full-suite pass until the user authorizes another full run.

---

## Deliberately not doing

These review points are non-defects or redundant work and must stay out of this fix series:

- Keep the useful third `Other orders` held-page filter.
- Do not refactor repeated `role === 'call_center'` comparisons merely for style.
- Do not rewrite the tables-router middleware fall-through; no current route or authorization wall is broken.
- Do not revert the intentional shift response/socket-disconnect hardening.
- Do not duplicate backend audit rollback, `xyz=1`, queue failure, route-wall, and cashier checkout failure-injection coverage in Playwright. The browser task covers only the UI/recovery behavior changed by this plan.
- Do not add CTI/caller-ID integration, phone index columns, new claims/audit tables, general Held Orders access for call center, negative FOLLOW UP, partial sent-line voids, platform settlement, JoFotara automation, or any new configurable permission.

## Execution-ready gate

Before Task 1, the executor must confirm:

```powershell
git branch --show-current
git merge-base --is-ancestor 2ab654e0 HEAD
git status --short
```

Proceed only when the branch is `codex/call-center-held-orders`, `2ab654e0` is an ancestor, and no unrelated tracked edits exist. This plan contains no placeholder paths, selector discovery, schema decisions, or owner decisions.

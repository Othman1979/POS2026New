# Manager Override Audit Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit successful, invalid, and locked manager-override attempts on the standalone `/api/auth/manager_override` route while preserving the global rule that `users.xyz = 1` suppresses every audit event created for that user.

**Architecture:** First restore the documented `xyz` contract at the shared audit boundary so both ordinary and security-shaped audit writers honor it. Then add one small manager-override audit helper inside `ManagerOverrideService` and call it from both existing inline overrides and the standalone route. Verification policies, eligible roles, rate-limit namespaces, PIN hashing, frontend behavior, and API responses remain unchanged.

**Tech Stack:** Node.js 22, Express, mysql2, Vitest/Supertest, existing `audit_events` table and architecture generator.

## Global Constraints

- `users.xyz = 1` means **no row may be written to `audit_events` when that user is either the actor (`user_id`) or the authorizer (`manager_id`)**, including login, device-access, and manager-override events.
- `users.xyz = 0` retains the current audit behavior.
- Do not delete `appendSecurityAuditEvent`; existing authentication/device call sites keep using it, but it must delegate through the same `xyz` decision as `appendAuditEvent`.
- No schema migration, new event type, setting, dependency, frontend change, or API response change.
- Preserve standalone eligible roles exactly: `admin` and `programmer`; `table_manager` remains ineligible for temporary-admin mode.
- Preserve inline eligible roles exactly: `admin`, `programmer`, and `table_manager`.
- Preserve the independent attempt namespaces `manager_override:user:*`, `permission_override:user:*`, and `drawer_pop:user:*`.
- Preserve five failures followed by a five-minute lockout and the one-in-flight verifier rule.
- Never store or log `admin_pin`, `managerPin`, candidate hashes, or a request body.
- Audit metadata stores only the route path; query parameters are discarded before persistence so a caller cannot smuggle a PIN or other secret into `new_value`.
- For users without `xyz=1`, the audit actor is the authenticated requesting user. Only successful events carry the matched manager's user id in `manager_id`.
- Missing-PIN validation and call-center middleware rejection happen before PIN verification and do not create `pin_override_*` events.
- Existing inline checkout/table paths must not wait for an additional pool command while holding their transaction. The standalone route owns no transaction and may await its internally-caught audit attempt for deterministic tests/response ordering.
- Audit storage failures remain fail-open for authorization and are logged; they must not change a 200, 401, or 429 decision.
- Run only the focused tests named below; no full-suite run is required.

---

## Evidence and fixed decisions

1. `backend/migrations/2026-07-18-add-users-xyz-audit-bypass.sql` defines `xyz` as: `When 1, actions by this user are not written to audit_events`—there is no security-event exception.
2. `docs/architecture.json` repeats the broad invariant: per-user audit logging can be suppressed by `users.xyz=1`, so `audit_events` is not complete for every user.
3. `backend/services/auditEvents.js:123-182` makes `appendAuditEvent` check only `user_id`, while `appendSecurityAuditEvent` skips suppression entirely. A normal cashier authorized by an `xyz=1` manager still produces a row naming that manager. Both behaviors contradict the owner decision that `xyz` users do not appear as actors or authorizers in new audit rows.
4. `appendSecurityAuditEvent` has eleven production call sites covering programmer login, browser enrollment, credential changes, device step-up, and device-auth mode changes. Fixing each caller would duplicate policy; the shared writer is the correct boundary.
5. `backend/routes/auth.js:168-211` owns a separate manager-PIN implementation and currently writes no audit event on success, failure, or lockout.
6. `src/pos/useAuth.js:52-60` uses that endpoint to grant temporary client-side admin state, so ordinary users should leave the same `pin_override_*` trail as inline permission overrides.
7. `backend/services/ManagerOverrideService.js:93-160` already emits `pin_override_success`, `pin_override_failed`, and `pin_override_locked` through `appendAuditEvent`; inline override auditing already honors `xyz` and must continue doing so.
8. `backend/services/PermissionService.js:32` confirms the standalone route accepts only `admin` and `programmer`. Fully delegating it to `authorizeManagerOverride` would wrongly admit `table_manager`, merge attempt budgets, and grant permission keys. The plan shares only audit writing.
9. `backend/tests/integration/products.test.js:240-275` is the existing executable contract for `xyz`; extending it to the security writer gives one direct RED/GREEN proof for the global rule.
10. `backend/tests/integration/auth.test.js:110-159` owns standalone route behavior and is the correct place for outcome/audit assertions.
11. Focused baseline before implementation: `auth.test.js` plus `managerOverrideAttempts.test.js` passes 18/18 tests on `master` at `9ffe80fd`.

### Rejected approaches

- **Make manager overrides unsuppressible:** rejected by the explicit `xyz` contract and owner decision.
- **Change every security-event caller:** rejected because one shared writer already owns insertion policy.
- **Delegate the standalone route to `authorizeManagerOverride`:** rejected because it changes role eligibility, attempt isolation, and permission behavior.
- **Paste three raw INSERTs into `auth.js`:** rejected because it bypasses shared suppression and error handling.
- **Add a queue, schema, or new event taxonomy:** rejected; existing storage and `pin_override_*` names already fit.

---

### Task 1: Make every audit writer honor `xyz`

**Files:**
- Modify: `backend/services/auditEvents.js`
- Modify: `backend/routes/admin/printQueue.js`
- Modify: `backend/services/spoolerAgents.js`
- Modify: `backend/tests/integration/products.test.js`
- Modify: `backend/tests/integration/printQueueCancellation.test.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`

**Interfaces:**
- Preserves: `appendAuditEvent(executor, event)`.
- Preserves: `appendSecurityAuditEvent(executor, event)`, including its default `entityType: 'security'`.
- Changes: `isAuditDisabled(executor, userId, managerId)` checks both audit identities, and `appendSecurityAuditEvent` delegates through `appendAuditEvent`.

**Review correction:** The initial source scan found two human-actor spooler writers that inserted directly into `audit_events`. Route those cancellation, drain, and replacement events through `appendAuditEvent` as well. Keep the agent-driven decommission event direct because it has no actor or authorizer to suppress.

- [ ] **Step 1: Extend the existing `xyz` test to cover the security writer**

Change the import in `backend/tests/integration/products.test.js`:

```js
const { appendAuditEvent, appendSecurityAuditEvent } = require('../../services/auditEvents');
```

Inside `xyz=1 suppresses shared and batch audit writes without blocking the work`, immediately after the existing `appendAuditEvent` call, add:

```js
await appendSecurityAuditEvent(pool, {
    eventType: 'xyz_security_probe',
    userId: SEED.adminUser.id,
    newValue: { source: 'security_writer' },
});
```

Also prove the non-suppressed side of the contract. Before the test changes the administrator to `xyz=1`, write and verify one security-shaped event while the seeded user still has `xyz=0`:

```js
await appendSecurityAuditEvent(pool, {
    eventType: 'xyz_security_enabled_probe',
    userId: SEED.adminUser.id,
    newValue: { source: 'security_writer' },
});
const [[enabledAudit]] = await pool.query(
    "SELECT COUNT(*) AS total FROM audit_events WHERE user_id = ? AND event_type = 'xyz_security_enabled_probe'",
    [SEED.adminUser.id]
);
expect(Number(enabledAudit.total)).toBe(1);

await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.cashierUser.id]);
await appendAuditEvent(pool, {
    eventType: 'xyz_manager_probe',
    userId: SEED.adminUser.id,
    managerId: SEED.cashierUser.id,
});
const [[managerAudit]] = await pool.query(
    "SELECT COUNT(*) AS total FROM audit_events WHERE event_type = 'xyz_manager_probe'"
);
expect(Number(managerAudit.total)).toBe(0);
await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [SEED.cashierUser.id]);

await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.adminUser.id]);
```

Move the test's existing `UPDATE users SET xyz = 1` to this position; do not execute it twice.

Extend the audit-count predicate:

```sql
AND (event_type IN ('xyz_shared_probe', 'xyz_security_probe')
     OR (event_type = 'product_created' AND entity_id = ?))
```

Extend cleanup:

```js
await pool.query(
    "DELETE FROM audit_events WHERE event_type IN ('xyz_shared_probe', 'xyz_security_probe', 'xyz_security_enabled_probe', 'xyz_manager_probe')"
);
```

The `finally` block must also restore both seeded users:

```js
await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
```

- [ ] **Step 2: Run the focused RED test**

Run:

```powershell
npx vitest run backend/tests/integration/products.test.js -t "xyz=1 suppresses shared and batch audit writes without blocking the work"
```

Expected: FAIL because current code inserts both the manager-authorized probe and the security-writer probe.

- [ ] **Step 3: Remove the duplicate INSERT and delegate through the global policy**

In `backend/services/auditEvents.js`, first replace `isAuditDisabled` and the call in `appendAuditEvent`:

```js
async function isAuditDisabled(executor, userId, managerId = null) {
    if (!userId && !managerId) return false;
    const [[result]] = await executor.query(
        'SELECT COALESCE(MAX(xyz), 0) AS disabled FROM users WHERE id IN (?, ?)',
        [userId || 0, managerId || 0]
    );
    return Number(result?.disabled) === 1;
}
```

```js
if (await isAuditDisabled(executor, userId, managerId)) return;
```

Then replace `appendSecurityAuditEvent` with:

```js
// Security-shaped events retain their entity default, but the global xyz flag
// suppresses every audit event created for that actor.
async function appendSecurityAuditEvent(executor, {
    eventType,
    userId = null,
    managerId = null,
    entityType = 'security',
    entityId = null,
    oldValue = null,
    newValue = null,
    ipAddress = null
}) {
    return appendAuditEvent(executor, {
        eventType,
        userId,
        managerId,
        entityType,
        entityId,
        oldValue,
        newValue,
        ipAddress
    });
}
```

Do not add a second `isAuditDisabled` call; delegation performs exactly one suppression lookup covering actor and manager, and at most one INSERT. Both ids remain query parameters.

- [ ] **Step 4: Run focused GREEN and compatibility tests**

Run:

```powershell
npx vitest run backend/tests/integration/products.test.js -t "xyz=1 suppresses shared and batch audit writes without blocking the work"
```

Expected: PASS. The same focused test proves `xyz=0` still writes, while actor-side, authorizer-side, ordinary, batch, and security-shaped writes are suppressed for `xyz=1`.

Also add and run focused behavioral tests proving an `xyz=1` administrator can cancel a print job or replace a spooler agent while the mutation succeeds and its human audit row is absent:

```powershell
npx vitest run backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/spoolerV2Sync.test.js -t "xyz enabled"
```

- [ ] **Step 5: Commit Task 1**

```powershell
git add backend/services/auditEvents.js backend/routes/admin/printQueue.js backend/services/spoolerAgents.js backend/tests/integration/products.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/spoolerV2Sync.test.js docs/superpowers/plans/2026-08-29-manager-override-security-audit.md
git commit -m "fix(audit): honor xyz for security events"
```

---

### Task 2: Complete standalone manager-override auditing

**Files:**
- Modify: `backend/services/ManagerOverrideService.js`
- Modify: `backend/routes/auth.js`
- Modify: `backend/tests/integration/auth.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Produces: `recordManagerOverrideAudit({ eventType, userId, managerId, route, ipAddress }): Promise<void>` exported from `ManagerOverrideService.js`.
- Preserves: `authorizeManagerOverride`, attempt helpers, route request body, response statuses/messages, and frontend contract.

- [ ] **Step 1: Add standalone outcome and suppression tests**

In `backend/tests/integration/auth.test.js`, import the attempt store:

```js
const { overrideAttempts } = require('../../services/ManagerOverrideService');
```

Inside `describe('POST /api/auth/manager_override')`, add scoped cleanup:

```js
beforeEach(async () => {
    overrideAttempts.clear();
    await pool.query(
        "DELETE FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
    );
    await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
});

afterEach(async () => {
    overrideAttempts.clear();
    await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
});
```

Extend the existing successful override test:

```js
const [[event]] = await pool.query(
    "SELECT * FROM audit_events WHERE event_type = 'pin_override_success' ORDER BY id DESC LIMIT 1"
);
expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: SEED.adminUser.id });
expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
expect(String(event.new_value)).not.toContain(SEED.adminUser.pin);
```

Extend the incorrect-PIN test:

```js
const [[event]] = await pool.query(
    "SELECT * FROM audit_events WHERE event_type = 'pin_override_failed' ORDER BY id DESC LIMIT 1"
);
expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: null });
expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
expect(String(event.new_value)).not.toContain('wrong_pin');
```

Add the lockout test:

```js
it('audits the standalone lockout without testing the supplied PIN', async () => {
    const loginRes = await request(app).post('/api/auth/login')
        .send({ user_number: SEED.cashierUser.user_number });
    const cookie = loginRes.headers['set-cookie'][0];

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await request(app).post('/api/auth/manager_override')
            .set('Cookie', cookie).send({ admin_pin: 'wrong_pin' });
        expect(failed.statusCode).toBe(401);
    }

    const locked = await request(app).post('/api/auth/manager_override')
        .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
    expect(locked.statusCode).toBe(429);

    const [[event]] = await pool.query(
        "SELECT * FROM audit_events WHERE event_type = 'pin_override_locked' ORDER BY id DESC LIMIT 1"
    );
    expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: null });
    expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
    expect(String(event.new_value)).not.toContain(SEED.adminUser.pin);
});
```

Add explicit actor-side and authorizer-side `xyz` suppression coverage:

```js
it('does not audit when either manager-override participant has xyz enabled', async () => {
    const loginRes = await request(app).post('/api/auth/login')
        .send({ user_number: SEED.cashierUser.user_number });
    const cookie = loginRes.headers['set-cookie'][0];
    for (const hiddenUserId of [SEED.cashierUser.id, SEED.adminUser.id]) {
        await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [hiddenUserId]);
        const response = await request(app).post('/api/auth/manager_override')
            .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
        expect(response.statusCode).toBe(200);

        const [[{ count }]] = await pool.query(
            "SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ? AND manager_id = ? AND event_type = 'pin_override_success'",
            [SEED.cashierUser.id, SEED.adminUser.id]
        );
        expect(Number(count)).toBe(0);
        await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [hiddenUserId]);
    }
});
```

Extend the missing-PIN test with:

```js
const [[{ count }]] = await pool.query(
    "SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
);
expect(Number(count)).toBe(0);
```

- [ ] **Step 2: Run the standalone route RED tests**

Run:

```powershell
npx vitest run backend/tests/integration/auth.test.js -t "POST /api/auth/manager_override"
```

Expected: current HTTP behavior passes; normal success/failure/lockout audit assertions fail because the route writes nothing. The `xyz` zero-event assertion passes already and must remain green.

- [ ] **Step 3: Add one PIN-free shared audit helper**

In `backend/services/ManagerOverrideService.js`, retain the `appendAuditEvent` import and add above `authorizeManagerOverride`:

```js
async function recordManagerOverrideAudit({
    eventType,
    userId,
    managerId = null,
    route,
    ipAddress = null,
}) {
    try {
        const routePath = String(route || '').split('?', 1)[0];
        await appendAuditEvent(pool, {
            eventType,
            userId: userId || null,
            managerId,
            newValue: { route: routePath },
            ipAddress,
        });
    } catch (auditErr) {
        logger.error(
            { err: auditErr, eventType, userId: userId || null, managerId },
            `audit_events: failed to log ${eventType}`
        );
    }
}
```

The helper deliberately has no PIN or arbitrary payload parameter.

**Review correction:** `req.originalUrl` includes its query string. Normalize the shared helper to the pathname before persistence and keep an integration regression test using `?admin_pin=query-pin-must-not-be-stored`; this protects standalone and inline callers without duplicating route handling.

Replace the three existing `appendAuditEvent(...).catch(...)` blocks in `authorizeManagerOverride` with non-awaited helper calls at their current outcome positions:

```js
void recordManagerOverrideAudit({ eventType: 'pin_override_locked', userId: user?.id, route, ipAddress });
```

```js
void recordManagerOverrideAudit({ eventType: 'pin_override_failed', userId: user?.id, route, ipAddress });
```

```js
void recordManagerOverrideAudit({
    eventType: 'pin_override_success', userId: user?.id,
    managerId: matchedManager.id, route, ipAddress
});
```

Export `recordManagerOverrideAudit`. Do not await these inline calls because checkout/table callers can hold a transaction connection and row locks.

- [ ] **Step 4: Wire only the standalone route outcomes**

Extend the `ManagerOverrideService` import in `backend/routes/auth.js` with `recordManagerOverrideAudit`.

Around `beginOverrideAttempt(attemptKey)`, audit only a 429 result:

```js
try {
    await beginOverrideAttempt(attemptKey);
    began = true;
} catch (error) {
    if (error.statusCode === 429) {
        await recordManagerOverrideAudit({
            eventType: 'pin_override_locked', userId: req.user?.id,
            route: req.originalUrl, ipAddress: req.ip || null,
        });
    }
    throw error;
}
```

On successful `isAdminUser(matchedUser)` authorization, write before returning:

```js
action = 'success';
await recordManagerOverrideAudit({
    eventType: 'pin_override_success', userId: req.user?.id,
    managerId: matchedUser.id, route: req.originalUrl, ipAddress: req.ip || null,
});
return sendSuccess(res, { message: 'Manager override approved.' });
```

On invalid PIN, write before returning:

```js
action = 'failed';
await recordManagerOverrideAudit({
    eventType: 'pin_override_failed', userId: req.user?.id,
    route: req.originalUrl, ipAddress: req.ip || null,
});
return sendError(res, 401, 'Invalid manager PIN.');
```

Do not change candidate SQL, `isAdminUser`, legacy-hash upgrade, response messages, attempt actions, or `finally`.

- [ ] **Step 5: Run focused route and compatibility tests**

Run:

```powershell
npx vitest run backend/tests/integration/auth.test.js backend/tests/integration/usersAdminPin.test.js backend/tests/integration/security.test.js -t "manager_override|manager override|ManagerOverride|validateManagerPinOverride|Admin Users API"
npx vitest run backend/tests/unit/managerOverrideAttempts.test.js backend/tests/unit/checkoutModuleWiring.test.js
```

Expected: PASS. This covers normal auditing, `xyz` suppression, eligible PIN behavior, inline auditing, lockout/serialization, independent namespaces, and checkout wiring.

- [ ] **Step 6: Correct the architecture map and remove only the closed defect**

In `docs/architecture.json`:

1. Keep the broad `xyz` invariant and clarify that it covers both writers and both audit identity columns (`user_id` and `manager_id`).
2. Update node `auth-auditsvc`: the security wrapper supplies the `security` entity default but delegates through the same `xyz` suppression policy.
3. Update node `auth-override-route.sub`: ordinary users emit `pin_override_success/failed/locked`, while `xyz=1` suppresses them.
4. Remove the node's `defects: ["d-auth-login-no-rehash-audit"]` property.
5. Update the manager-override flow audit step to name `recordManagerOverrideAudit -> appendAuditEvent`.
6. Delete only top-level defect `d-auth-login-no-rehash-audit`; leave `d-cors-wide-open` unchanged.
7. Refresh line anchors against symbols after the code change.

Run:

```powershell
npm run architecture
npm run architecture:check
```

Expected: PASS; `docs/architecture.html` changes only as generated output.

- [ ] **Step 7: Perform the scoped adversarial closeout**

Run:

```powershell
rg -n "appendAuditEvent|appendSecurityAuditEvent|recordManagerOverrideAudit|pin_override_(success|failed|locked)|manager_override:user|permission_override:user|xyz" backend/services/auditEvents.js backend/services/ManagerOverrideService.js backend/routes/auth.js backend/tests/integration/auth.test.js backend/tests/integration/products.test.js docs/architecture.json
git diff --check
git status --short
```

Confirm:

- Both audit APIs reach the same two-identity `isAuditDisabled` check exactly once.
- `xyz=1` tests prove actor-side, authorizer-side, ordinary, batch, security-shaped, and manager-override rows are absent.
- `xyz=0` manager-override success/failure/lockout rows are present.
- No event/logger contains a PIN or candidate hash.
- Standalone candidates remain `admin`/`programmer`; inline remains `admin`/`programmer`/`table_manager`.
- Attempt namespaces, lockout, missing-PIN 400, and call-center 403 behavior are unchanged.
- Inline checkout/table paths do not await their audit promise.
- Audit insert failure is logged without changing authorization.
- Exactly one architecture defect is removed.

- [ ] **Step 8: Commit Task 2**

```powershell
git add backend/services/ManagerOverrideService.js backend/routes/auth.js backend/tests/integration/auth.test.js docs/architecture.json docs/architecture.html
git commit -m "fix(auth): audit standalone manager overrides"
```

---

## Definition of done

- `xyz=1` suppresses every event written through either shared audit API when that user would be `user_id` or `manager_id`, including authentication and device events.
- For `xyz=0`, standalone and inline manager-PIN success, invalid, and locked outcomes use the existing `pin_override_*` records.
- Successful normal-user rows identify both requesting actor and approving manager.
- No submitted PIN or hash is persisted or logged.
- Query parameters are never persisted as manager-override route metadata.
- Eligible roles, attempt namespaces, lockout timing, concurrency control, response shapes, and frontend behavior are unchanged.
- Inline checkout/table transactions do not wait for an audit pool command.
- Focused tests and architecture checks pass.
- No migration, dependency, deployment, merge, or push occurs as part of this plan.

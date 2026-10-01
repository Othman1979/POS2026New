const crypto = require('crypto');

const DEFAULT_CONFLICT_CODE = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
const EXPIRED_CODE = 'SERVICE_CHARGE_SNAPSHOT_EXPIRED';
const HOLDER_TYPES = new Set(['none', 'held_order', 'claim', 'order']);
const ALLOWED = new Set([
    'draft:open_order', 'draft:held', 'draft:finalized', 'draft:abandoned',
    'open_order:finalized', 'open_order:split_parent', 'open_order:abandoned',
    'held:claimed', 'held:finalized',
    'claimed:held', 'claimed:finalized', 'claimed:abandoned',
    'split_parent:abandoned', 'split_parent:open_order', 'held:abandoned'
]);

const conflict = (message, publicCode = DEFAULT_CONFLICT_CODE) => {
    const error = new Error(message);
    error.statusCode = 409;
    error.publicCode = publicCode;
    return error;
};

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const assertHolder = (holderType, holderId) => {
    if (!HOLDER_TYPES.has(holderType)) throw conflict('Service-charge snapshot holder is invalid.');
    if (holderType === 'none' && holderId != null) {
        throw conflict('An unbound service-charge snapshot cannot have a holder ID.');
    }
    if (holderType !== 'none' && holderId == null) {
        throw conflict('A bound service-charge snapshot requires a holder ID.');
    }
};

// Claimed rows normally reach 'abandoned' through the token-aware DELETE endpoint when the
// register clears the order; the 7-day reap is a safety net for crashed/never-cleared browsers.
// A live claim that outlives it still recovers at checkout: the vanished row surfaces as
// SERVICE_CHARGE_SNAPSHOT_EXPIRED and the register re-adds the fee at current settings.
const cleanupExpiredDrafts = (conn, now = new Date()) => conn.query(`
    DELETE scs
      FROM service_charge_snapshots scs
      LEFT JOIN orders o
        ON o.service_charge_snapshot_id=scs.id
      LEFT JOIN held_orders h
        ON h.service_charge_snapshot_id=scs.id
      LEFT JOIN service_charge_snapshots child
        ON child.parent_snapshot_id=scs.id
     WHERE (
            (scs.state='draft' AND scs.expires_at < ?)
         OR (
            scs.state='abandoned'
            AND scs.updated_at < DATE_SUB(?, INTERVAL 1 DAY)
         )
         OR (scs.state='claimed' AND scs.updated_at < DATE_SUB(?, INTERVAL 7 DAY))
     )
       AND o.invoice_id IS NULL
       AND h.id IS NULL
       AND child.id IS NULL
`, [now, now, now]);

const createDraft = async (conn, { userId, percentage, taxRate, taxCategory, now = new Date() }) => {
    await cleanupExpiredDrafts(conn, now);
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + (24 * 60 * 60 * 1000));
    await conn.query(`
        INSERT INTO service_charge_snapshots
            (id, percentage, tax_rate, jofotara_tax_category, state, holder_type, created_by, version, expires_at)
        VALUES (?, ?, ?, ?, 'draft', 'none', ?, 1, DATE_ADD(?, INTERVAL 24 HOUR))
    `, [id, percentage, taxRate, taxCategory, userId, now]);
    return {
        id,
        percentage: Number(percentage),
        taxRate: Number(taxRate),
        taxCategory,
        state: 'draft',
        version: 1,
        expiresAt
    };
};

const getForUpdate = async (conn, snapshotId) => {
    const [rows] = await conn.query(`
        SELECT * FROM service_charge_snapshots WHERE id=? FOR UPDATE
    `, [snapshotId]);
    if (rows.length !== 1) {
        // A missing row means the snapshot was reaped (expired draft, orphaned claim) — not a
        // concurrent edit. Surface it as EXPIRED so the register clears the fee and re-adds it,
        // instead of the unrecoverable retry loop a generic conflict produces. Rows referenced by
        // orders/held_orders FKs cannot vanish, so bound paths never take this branch.
        throw conflict(
            'Service-charge snapshot expired. Add the service charge again.',
            EXPIRED_CODE
        );
    }
    return rows[0];
};

const assertDraftUsableBy = (snapshot, userId, version) => {
    const expired = snapshot.expires_at && new Date(snapshot.expires_at).getTime() <= Date.now();
    if (expired) {
        throw conflict(
            'Service-charge snapshot expired. Add the service charge again.',
            EXPIRED_CODE
        );
    }
    if (
        snapshot.state !== 'draft' ||
        Number(snapshot.created_by) !== Number(userId) ||
        Number(snapshot.version) !== Number(version)
    ) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
};

const transition = async (conn, {
    snapshotId,
    version,
    from,
    to,
    holderType,
    holderId,
    claimTokenHash = null
}) => {
    if (!ALLOWED.has(`${from}:${to}`)) {
        throw conflict(`Illegal service-charge snapshot transition: ${from} -> ${to}.`);
    }
    assertHolder(holderType, holderId);
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET state=?, holder_type=?, holder_id=?, claim_token_hash=?, version=version+1
         WHERE id=? AND state=? AND version=?
    `, [to, holderType, holderId, claimTokenHash, snapshotId, from, version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};

const bindDraft = async (conn, {
    snapshotId,
    version,
    userId,
    state,
    holderType,
    holderId
}) => {
    const current = await getForUpdate(conn, snapshotId);
    assertDraftUsableBy(current, userId, version);
    return transition(conn, {
        snapshotId,
        version,
        from: 'draft',
        to: state,
        holderType,
        holderId
    });
};

const touchOpenOrder = async (conn, { snapshotId, version, orderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [snapshotId, String(orderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};

// Holder swap for a table merge: the snapshot follows its fee to the surviving order.
// State stays 'open_order'; only holder_id changes, under the same version CAS as
// touchOpenOrder so a concurrent save/settle on either order rolls the merge back.
const rehomeOpenOrder = async (conn, { snapshotId, version, fromOrderId, toOrderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET holder_id=?, version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [String(toOrderId), snapshotId, String(fromOrderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};

// Ownership-aware terminal transition for void/merge. Including the old holder in
// the UPDATE predicate prevents a stale/dangling order FK from abandoning another
// order's snapshot.
const abandonOpenOrder = async (conn, { snapshotId, version, orderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET state='abandoned', holder_type='none', holder_id=NULL,
               claim_token_hash=NULL, version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [snapshotId, String(orderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};

const claimHeld = async (conn, { snapshotId, version, heldOrderId, userId }) => {
    const current = await getForUpdate(conn, snapshotId);
    if (
        current.state !== 'held' ||
        current.holder_type !== 'held_order' ||
        String(current.holder_id) !== String(heldOrderId) ||
        Number(current.version) !== Number(version)
    ) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    const claimToken = crypto.randomBytes(32).toString('hex');
    await transition(conn, {
        snapshotId,
        version,
        from: 'held',
        to: 'claimed',
        holderType: 'claim',
        holderId: String(userId),
        claimTokenHash: hashToken(claimToken)
    });
    return {
        snapshot: { ...current, state: 'claimed', version: Number(version) + 1 },
        claimToken
    };
};

const consumeClaim = async (conn, {
    snapshotId,
    version,
    claimToken,
    userId,
    to,
    holderType,
    holderId
}) => {
    const current = await getForUpdate(conn, snapshotId);
    if (
        current.state !== 'claimed' ||
        current.holder_type !== 'claim' ||
        String(current.holder_id) !== String(userId) ||
        Number(current.version) !== Number(version) ||
        !current.claim_token_hash ||
        !claimToken
    ) {
        throw conflict('Service-charge claim changed or was already consumed.');
    }
    const expected = Buffer.from(String(current.claim_token_hash), 'hex');
    const supplied = Buffer.from(hashToken(claimToken), 'hex');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        throw conflict('Service-charge claim token is invalid.');
    }
    return transition(conn, {
        snapshotId,
        version,
        from: 'claimed',
        to,
        holderType,
        holderId,
        claimTokenHash: null
    });
};

const abandonDraft = (conn, { snapshotId, version, userId }) =>
    bindDraft(conn, {
        snapshotId,
        version,
        userId,
        state: 'abandoned',
        holderType: 'none',
        holderId: null
    });

const createChildHeldSnapshot = async (conn, { parentSnapshot, heldOrderId, userId }) => {
    const id = crypto.randomUUID();
    await conn.query(`
        INSERT INTO service_charge_snapshots
            (id, percentage, tax_rate, jofotara_tax_category, parent_snapshot_id, state, holder_type, holder_id, created_by, version, expires_at)
        VALUES (?, ?, ?, ?, ?, 'held', 'held_order', ?, ?, 1, NULL)
    `, [
        id,
        parentSnapshot.percentage,
        parentSnapshot.tax_rate,
        parentSnapshot.jofotara_tax_category,
        parentSnapshot.id,
        String(heldOrderId),
        userId
    ]);
    return {
        id,
        percentage: Number(parentSnapshot.percentage),
        taxRate: Number(parentSnapshot.tax_rate),
        taxCategory: parentSnapshot.jofotara_tax_category,
        parentSnapshotId: parentSnapshot.id,
        state: 'held',
        version: 1
    };
};

// A moved portion inherits the saved policy, without reading today's settings or
// creating an unrelated register draft. The caller already locks the parent.
async function createChildOpenSnapshot(conn, { parentSnapshot, orderId, userId }) {
    const id = crypto.randomUUID();
    await conn.query(`INSERT INTO service_charge_snapshots
        (id,percentage,tax_rate,jofotara_tax_category,parent_snapshot_id,state,holder_type,holder_id,created_by,version,expires_at)
        VALUES(?,?,?,?,?,'open_order','order',?,?,1,NULL)`, [id, parentSnapshot.percentage, parentSnapshot.tax_rate,
        parentSnapshot.jofotara_tax_category, parentSnapshot.id, String(orderId), userId]);
    return { ...parentSnapshot, id, parent_snapshot_id: parentSnapshot.id, state: 'open_order', holder_type: 'order', holder_id: String(orderId), version: 1 };
}

module.exports = {
    ALLOWED,
    conflict,
    createDraft,
    getForUpdate,
    assertDraftUsableBy,
    bindDraft,
    transition,
    touchOpenOrder,
    rehomeOpenOrder,
    abandonOpenOrder,
    claimHeld,
    consumeClaim,
    abandonDraft,
    createChildHeldSnapshot,
    createChildOpenSnapshot,
    cleanupExpiredDrafts
};

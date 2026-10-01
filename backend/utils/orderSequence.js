// backend/utils/orderSequence.js
// Single source of truth for minting the daily display order_id.
// Write-based counters only — never SELECT MAX(order_id)+1 (snapshot-stale under
// InnoDB REPEATABLE READ → duplicate ids across concurrent terminals).

async function reserveDailyOrderId(conn, { businessDate } = {}) {
  if (!businessDate) throw new Error('Order id reservation requires a businessDate.');
  const [result] = await conn.query(
    `INSERT INTO daily_sequences (sequence_date, current_value)
     VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)`,
    [businessDate]
  );

  const orderId = Number(result?.insertId || 0);
  if (!orderId) throw new Error('Order id reservation failed.');
  return orderId;
}

function scopeKeyFor({ businessDate } = {}) {
  if (!businessDate) throw new Error('Order id scope requires a businessDate.');
  return `date:${businessDate}`;
}

function alphabeticPrefix(ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('Invalid order prefix ordinal.');
  let prefix = '';
  while (ordinal > 0) {
    ordinal--;
    prefix = String.fromCharCode(65 + ordinal % 26) + prefix;
    ordinal = Math.floor(ordinal / 26);
  }
  return prefix;
}

// Caller owns the transaction. The existing day row also serializes prefix-map
// creation, including simultaneous first holds/checkouts from different tills.
async function reserveDailyOrderIdentity(conn, { businessDate, orderTypeId, separateByType } = {}) {
  if (!businessDate) throw new Error('Order id reservation requires a businessDate.');
  if (separateByType === undefined) {
    const [[setting]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key='order_type_numbering'");
    separateByType = setting?.setting_value === '1';
  }
  if (!separateByType) {
    const orderId = await reserveDailyOrderId(conn, { businessDate });
    return { order_id: orderId, order_seq_scope: scopeKeyFor({ businessDate }), order_display_no: String(orderId) };
  }
  const typeId = Number(orderTypeId || 0);
  if (!Number.isSafeInteger(typeId) || typeId < 0) throw new Error('Invalid order type for numbering.');
  await conn.query(`INSERT INTO daily_sequences(sequence_date,current_value) VALUES(?,0)
    ON DUPLICATE KEY UPDATE current_value=current_value`, [businessDate]);
  const [assigned] = await conn.query(`SELECT order_type_id,prefix_ordinal FROM daily_order_type_sequences
    WHERE sequence_date=? ORDER BY prefix_ordinal FOR UPDATE`, [businessDate]);
  const known = new Map(assigned.map(row => [Number(row.order_type_id), Number(row.prefix_ordinal)]));
  if (!known.has(typeId)) {
    // Match the configured order-type list, not the order of incoming requests.
    const [types] = await conn.query('SELECT id FROM order_types ORDER BY id LOCK IN SHARE MODE');
    if (typeId && !types.some(row => Number(row.id) === typeId)) throw new Error('Order type no longer exists.');
    let ordinal = Math.max(0, ...known.values());
    const missing = types.map(row => Number(row.id)).filter(id => !known.has(id));
    if (!typeId && !known.has(0)) missing.push(0); // Legacy/no-type orders get their own final prefix.
    for (const id of missing) {
      known.set(id, ++ordinal);
      await conn.query(`INSERT INTO daily_order_type_sequences(sequence_date,order_type_id,prefix_ordinal,current_value)
        VALUES(?,?,?,0)`, [businessDate, id, ordinal]);
    }
  }
  const [result] = await conn.query(`UPDATE daily_order_type_sequences SET current_value=LAST_INSERT_ID(current_value+1)
    WHERE sequence_date=? AND order_type_id=?`, [businessDate, typeId]);
  const orderId = Number(result.insertId);
  if (!orderId) throw new Error('Order type sequence reservation failed.');
  const prefix = alphabeticPrefix(known.get(typeId));
  return { order_id: orderId, order_seq_scope: `type:${businessDate}:${typeId}:${prefix}`, order_display_no: `${prefix}-${orderId}` };
}

module.exports = { reserveDailyOrderId, scopeKeyFor, reserveDailyOrderIdentity, alphabeticPrefix };

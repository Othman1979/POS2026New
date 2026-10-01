'use strict';

// Customer cart drafts are written per TABLE, not per socket: every guest at a table shares
// one qr_table_drafts row. One write in flight per table, latest accepted cart wins, at least
// MIN_INTERVAL_MS between writes. A queued cart is still written after its socket disconnects.
// The entry is kept through the cooldown and deleted when nothing is pending.
// Readers of the draft call flush(tableId) first so they see the latest accepted cart;
// revoking a table's QR (regenerate token, delete table) calls cancel(tableId); shutdown()
// drains what is pending before the database closes.
const MIN_INTERVAL_MS = 500;

function createCustomerCartWriter({ db, io, logger, broadcastTableDraftChanged }) {
    const entries = new Map();
    let closed = false;

    function schedule(tableId, e) {
        if (closed || e.timer || e.writing) return;
        e.timer = setTimeout(() => onTimer(tableId, e), Math.max(0, e.lastWriteAt + MIN_INTERVAL_MS - Date.now()));
    }

    function onTimer(tableId, e) {
        e.timer = null;
        if (e.writing) return;
        if (e.pending === undefined) {
            if (entries.get(tableId) === e) entries.delete(tableId);
            return;
        }
        write(tableId, e);
    }

    async function save(tableId, cart) {
        try {
            if (cart.length === 0) {
                await db.query('DELETE FROM qr_table_drafts WHERE table_id = ?', [tableId]);
                await broadcastTableDraftChanged(io, tableId, 0);
            } else {
                const cartJson = JSON.stringify(cart);
                await db.query(
                    'INSERT INTO qr_table_drafts (table_id, cart_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE cart_data = ?',
                    [tableId, cartJson, cartJson]
                );
                await broadcastTableDraftChanged(io, tableId, cart.length);
            }
        } catch (err) {
            logger.error({ err, tableId }, 'Failed to save or broadcast customer table cart draft.');
        }
    }

    function write(tableId, e) {
        const cart = e.pending;
        e.pending = undefined;
        e.writing = save(tableId, cart).then(() => {
            e.writing = null;
            e.lastWriteAt = Date.now();
            if (entries.get(tableId) === e) {
                if (closed) entries.delete(tableId);
                else schedule(tableId, e);
            }
        });
        return e.writing;
    }

    return {
        queue(tableId, cart) {
            if (closed) return;
            let e = entries.get(tableId);
            if (!e) {
                e = { pending: undefined, writing: null, lastWriteAt: 0, timer: null };
                entries.set(tableId, e);
            }
            e.pending = cart;
            schedule(tableId, e);
        },
        // Wait for an in-flight write, then write a pending cart now, ignoring the cooldown.
        async flush(tableId) {
            const e = entries.get(tableId);
            if (!e) return;
            if (e.timer) { clearTimeout(e.timer); e.timer = null; }
            while (e.writing) await e.writing;
            // The finished write re-armed the cooldown; this flush writes now instead.
            if (e.timer) { clearTimeout(e.timer); e.timer = null; }
            if (e.pending !== undefined && entries.get(tableId) === e) await write(tableId, e);
            else schedule(tableId, e);
        },
        // Drop a pending cart (revoked client). A write already in flight cannot be recalled.
        cancel(tableId) {
            const e = entries.get(tableId);
            if (!e) return;
            if (e.timer) { clearTimeout(e.timer); e.timer = null; }
            e.pending = undefined;
            // A running write keeps the entry until it lands, so later flushes wait for it
            // and a new cart cannot start a second, overlapping write.
            if (!e.writing) entries.delete(tableId);
        },
        // Stop accepting carts and write what is still pending, so a restart loses none.
        // Gives up after timeoutMs; the caller closes the database only after this settles.
        async shutdown(timeoutMs = 5000) {
            closed = true;
            const drains = [...entries].map(async ([tableId, e]) => {
                if (e.timer) { clearTimeout(e.timer); e.timer = null; }
                while (e.writing) await e.writing;
                if (e.pending !== undefined) await write(tableId, e);
            });
            let timer;
            const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
            const result = await Promise.race([Promise.all(drains), timedOut]);
            clearTimeout(timer);
            if (result === 'timeout') {
                const pending = [...entries.values()].filter(e => e.pending !== undefined).length;
                logger.error({ pending, inFlight: entries.size - pending }, 'Customer cart drain timed out; unwritten carts dropped.');
            }
            for (const e of entries.values()) clearTimeout(e.timer);
            entries.clear();
        },
        size: () => entries.size
    };
}

module.exports = { createCustomerCartWriter };

const pool = require('../../config/db');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { canCheckout, canCheckoutTable, canEditLocked } = require('../../services/PermissionService');
const { lockTableSession } = require('../../services/TableSettlementContext');

async function markTablePrinted({ user, input, io }) {
    const tableId = Number(input.table_id);
    const expectedInvoiceId = Number(input.expected_invoice_id);
    if (!Number.isSafeInteger(tableId) || tableId <= 0) {
        const error = new Error('A valid table ID is required.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isSafeInteger(expectedInvoiceId) || expectedInvoiceId <= 0) {
        const error = new Error('The expected invoice ID is required.');
        error.statusCode = 400;
        throw error;
    }

    let conn;
    let hasTransaction = false;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        hasTransaction = true;
        const context = await lockTableSession(conn, {
            user,
            tableId,
            invoiceId: expectedInvoiceId,
            withMoney: false
        });

        const isAdmin = user.role === 'admin' || user.role === 'programmer';
        const isOwner = !context.order.waiter_id
            || Number(context.order.waiter_id) === Number(user.id);
        const mayDropCheck = isAdmin || canCheckout(user) || canCheckoutTable(user)
            || (isOwner && canEditLocked(user));
        if (!mayDropCheck) {
            const error = new Error('Forbidden: You are not authorized to update this table.');
            error.statusCode = 403;
            throw error;
        }

        const [updated] = await conn.query(
            `UPDATE restaurant_tables
                SET status='printed'
              WHERE id IN (?)
                AND current_order_id=?
                AND status IN ('occupied','printed')`,
            [context.groupTableIds, context.order.invoice_id]
        );
        if (Number(updated.affectedRows) !== context.groupTableIds.length) {
            const error = new Error('Table changed while marking the guest check. Refresh and try again.');
            error.statusCode = 409;
            error.publicCode = 'TABLE_SESSION_CONFLICT';
            throw error;
        }

        await conn.commit();
        hasTransaction = false;
        conn.release();
        conn = null;
        if (io) {
            await broadcastTableUpdates(io, context.groupTableIds, {
                invalidateDashboard: false
            });
        }
        return {
            message: 'Table status updated to Check Dropped.',
            table_ids: context.groupTableIds,
            status: 'printed',
            invoice_id: Number(context.order.invoice_id)
        };
    } catch (error) {
        if (conn && hasTransaction) {
            await conn.rollback().catch(() => {});
        }
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { markTablePrinted };

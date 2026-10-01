function auditDocumentIdFromPayload(payload) {
    if (!payload || payload.print_type !== 'audit_report') return null;
    const rawId = payload.data?.audit_report_document_id || payload.audit_report_document_id;
    const id = Number(rawId);
    return Number.isInteger(id) && id > 0 ? id : null;
}

async function updateAuditPrintStatus(db, payload, { success, error = null } = {}) {
    const documentId = auditDocumentIdFromPayload(payload);
    if (!documentId) return;

    if (success) {
        await db.query(
            `UPDATE audit_report_documents
                SET last_print_status = 'printed',
                    last_print_error = NULL,
                    last_printed_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [documentId]
        );
        return;
    }

    await db.query(
        `UPDATE audit_report_documents
            SET last_print_status = 'failed',
                last_print_error = ?
          WHERE id = ?`,
        [error ? String(error).slice(0, 1000) : null, documentId]
    );
}

module.exports = { auditDocumentIdFromPayload, updateAuditPrintStatus };

-- 2026-10-02-purchase-item-kind-v1
-- Requires migration: 2026-10-01-stock-documents-v1
-- Requires checksum: 81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0
-- A purchase invoice holds products or ingredients, never both: stock_documents gets item_kind (NULL on stock counts).
-- Existing purchase documents whose lines are all ingredients (at least one) become 'ingredient'; every other
-- purchase document (product-only, mixed, or without lines) becomes 'product'.
-- The header rule now requires item_kind on purchases and forbids it on counts, and the same supplier invoice number
-- may be entered once per kind. Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pk_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-stock-documents-v1' AND checksum='81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-02-purchase-item-kind-v1' AND checksum<>'ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e')),'SELECT * FROM posapp_purchase_item_kind_requires_review','SELECT 1');
PREPARE pk_stmt FROM @pk_sql;
EXECUTE pk_stmt;
DEALLOCATE PREPARE pk_stmt;

ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS item_kind ENUM('product','ingredient') NULL AFTER doc_type;

UPDATE stock_documents d
   SET d.item_kind = IF(EXISTS (SELECT 1 FROM stock_document_lines l WHERE l.document_id = d.id)
                          AND NOT EXISTS (SELECT 1 FROM stock_document_lines l WHERE l.document_id = d.id AND l.product_id IS NOT NULL),
                        'ingredient', 'product')
 WHERE d.doc_type = 'purchase' AND d.item_kind IS NULL;

ALTER TABLE stock_documents
  DROP INDEX IF EXISTS uq_stock_document_supplier_reference,
  ADD UNIQUE KEY uq_stock_document_supplier_reference (supplier_id, reference, item_kind);

ALTER TABLE stock_documents
  DROP CONSTRAINT IF EXISTS ck_stock_document_shape,
  ADD CONSTRAINT ck_stock_document_shape CHECK (
    (doc_type = 'purchase' AND item_kind IS NOT NULL AND supplier_id IS NOT NULL AND reference IS NOT NULL AND payment_status IS NOT NULL
      AND subtotal >= 0 AND tax_total >= 0 AND total >= 0)
    OR (doc_type = 'count' AND item_kind IS NULL AND supplier_id IS NULL AND payment_status IS NULL AND status IN ('draft','posted')));

-- Each invoice list (one kind, newest first, optionally one status) reads only its own kind through this index.
ALTER TABLE stock_documents ADD INDEX IF NOT EXISTS idx_stock_document_kind_list (doc_type, item_kind, status, id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-02-purchase-item-kind-v1',
  'ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

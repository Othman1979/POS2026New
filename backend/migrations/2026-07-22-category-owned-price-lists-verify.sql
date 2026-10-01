-- Read-only post-import verification. Require blocking_findings = 0.

SET @ps_missing_category_column := 1 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories'
       AND COLUMN_NAME = 'price_list_root_id' AND DATA_TYPE = 'int' AND IS_NULLABLE = 'YES'
);
SET @ps_missing_override_table := 1 - (
    SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_price_overrides'
);
SET @ps_missing_category_index := 1 - (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories'
           AND INDEX_NAME = 'idx_categories_price_list_tree'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,is_active,id'
    ) required_index
);
SET @ps_missing_override_primary_key := 1 - (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_price_overrides'
           AND INDEX_NAME = 'PRIMARY'
         GROUP BY INDEX_NAME
        HAVING MIN(NON_UNIQUE) = 0
           AND CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,product_id'
    ) required_primary_key
);
SET @ps_missing_category_foreign_key := 1 - (
    SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE() AND kcu.TABLE_NAME = 'categories'
       AND kcu.CONSTRAINT_NAME = 'fk_categories_price_list_root'
       AND kcu.COLUMN_NAME = 'price_list_root_id' AND kcu.REFERENCED_TABLE_NAME = 'categories'
       AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'SET NULL'
);
SET @ps_missing_override_foreign_keys := 2 - (
    SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE() AND kcu.TABLE_NAME = 'product_price_overrides'
       AND ((kcu.CONSTRAINT_NAME = 'fk_product_price_overrides_root'
             AND kcu.COLUMN_NAME = 'price_list_root_id' AND kcu.REFERENCED_TABLE_NAME = 'categories'
             AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'CASCADE')
         OR (kcu.CONSTRAINT_NAME = 'fk_product_price_overrides_product'
             AND kcu.COLUMN_NAME = 'product_id' AND kcu.REFERENCED_TABLE_NAME = 'products'
             AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'CASCADE'))
);
SET @ps_missing_nonnegative_constraint := 1 - (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'product_price_overrides'
       AND CONSTRAINT_NAME = 'chk_product_price_overrides_nonnegative' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @ps_missing_ledger := 1 - (
    SELECT COUNT(*) FROM schema_migrations
     WHERE migration_name = '2026-07-22-category-owned-price-lists-v1'
       AND checksum = 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb'
);
SET @ps_invalid_price_list_roots := (
    SELECT COUNT(*) FROM categories root
     WHERE (root.price_list_root_id = root.id AND (root.parent_id IS NOT NULL OR root.is_notes <> 0))
        OR (root.id IN (
            SELECT DISTINCT category_row.price_list_root_id
              FROM categories category_row
             WHERE category_row.price_list_root_id IS NOT NULL
         ) AND (root.price_list_root_id IS NULL OR root.price_list_root_id <> root.id))
);
SET @ps_invalid_price_list_descendants := (
    SELECT COUNT(*) FROM categories c
      LEFT JOIN categories root ON root.id = c.price_list_root_id
      LEFT JOIN categories parent ON parent.id = c.parent_id
     WHERE (c.price_list_root_id IS NOT NULL AND c.price_list_root_id <> c.id
       AND (root.id IS NULL OR root.price_list_root_id <> root.id))
        OR (c.parent_id IS NOT NULL AND NOT (c.price_list_root_id <=> parent.price_list_root_id))
);
SET @ps_negative_override_prices := (
    SELECT COUNT(*) FROM product_price_overrides WHERE price < 0
);
SET @ps_dormant_override_rows := (
    SELECT COUNT(*) FROM product_price_overrides override_row
      LEFT JOIN products product ON product.id = override_row.product_id
      LEFT JOIN categories category_row ON category_row.id = product.category_id
     WHERE product.id IS NULL OR category_row.price_list_root_id IS NULL
        OR category_row.price_list_root_id <> override_row.price_list_root_id
);

SELECT 'categories_price_list_column' AS check_name, @ps_missing_category_column AS missing_count, @ps_missing_category_column AS blocking_findings
UNION ALL SELECT 'product_price_overrides_table', @ps_missing_override_table, @ps_missing_override_table
UNION ALL SELECT 'categories_price_list_index', @ps_missing_category_index, @ps_missing_category_index
UNION ALL SELECT 'product_price_overrides_primary_key', @ps_missing_override_primary_key, @ps_missing_override_primary_key
UNION ALL SELECT 'categories_price_list_foreign_key', @ps_missing_category_foreign_key, @ps_missing_category_foreign_key
UNION ALL SELECT 'product_price_overrides_foreign_keys', @ps_missing_override_foreign_keys, @ps_missing_override_foreign_keys
UNION ALL SELECT 'product_price_overrides_nonnegative_constraint', @ps_missing_nonnegative_constraint, @ps_missing_nonnegative_constraint
UNION ALL SELECT 'migration_ledger', @ps_missing_ledger, @ps_missing_ledger
UNION ALL SELECT 'invalid_price_list_roots', @ps_invalid_price_list_roots, @ps_invalid_price_list_roots
UNION ALL SELECT 'invalid_price_list_descendants', @ps_invalid_price_list_descendants, @ps_invalid_price_list_descendants
UNION ALL SELECT 'negative_override_prices', @ps_negative_override_prices, @ps_negative_override_prices
UNION ALL SELECT 'dormant_override_rows', @ps_dormant_override_rows, 0;

SELECT (
    @ps_missing_category_column + @ps_missing_override_table + @ps_missing_category_index +
    @ps_missing_override_primary_key + @ps_missing_category_foreign_key + @ps_missing_override_foreign_keys +
    @ps_missing_nonnegative_constraint + @ps_missing_ledger + @ps_invalid_price_list_roots +
    @ps_invalid_price_list_descendants + @ps_negative_override_prices
) AS blocking_findings;

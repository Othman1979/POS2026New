-- Category-owned price lists migration (phpMyAdmin-safe).
-- Import the whole file, then run the paired read-only verifier.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260722_category_price_lists`$$
CREATE PROCEDURE `_ps_20260722_category_price_lists`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name varchar(190) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (migration_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('categories', 'products');
    IF v_count <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required category and product tables are missing';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-22-category-owned-price-lists-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE categories
        ADD COLUMN IF NOT EXISTS price_list_root_id int(11) DEFAULT NULL AFTER is_notes;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'categories'
       AND COLUMN_NAME = 'price_list_root_id'
       AND DATA_TYPE = 'int'
       AND IS_NULLABLE = 'YES';
    IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: categories.price_list_root_id conflicts with the required nullable integer column';
    END IF;

    SELECT COUNT(*) INTO v_count FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND INDEX_NAME = 'idx_categories_price_list_tree'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,is_active,id'
    ) required_index;
    IF v_count = 0 THEN
        SELECT COUNT(*) INTO v_count
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND INDEX_NAME = 'idx_categories_price_list_tree';
        IF v_count > 0 THEN
            ALTER TABLE categories DROP INDEX idx_categories_price_list_tree;
        END IF;
        ALTER TABLE categories
            ADD KEY idx_categories_price_list_tree (price_list_root_id, is_active, id);
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND kcu.TABLE_NAME = rc.TABLE_NAME
       AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
     WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
       AND rc.TABLE_NAME = 'categories'
       AND rc.CONSTRAINT_NAME = 'fk_categories_price_list_root'
       AND kcu.COLUMN_NAME = 'price_list_root_id'
       AND kcu.REFERENCED_TABLE_NAME = 'categories'
       AND kcu.REFERENCED_COLUMN_NAME = 'id'
       AND rc.DELETE_RULE = 'SET NULL';
    IF v_count = 0 THEN
        SELECT COUNT(*) INTO v_count
          FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND TABLE_NAME = 'categories'
           AND CONSTRAINT_NAME = 'fk_categories_price_list_root';
        IF v_count > 0 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: conflicting category price-list foreign-key name';
        END IF;
        ALTER TABLE categories
            ADD CONSTRAINT fk_categories_price_list_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE SET NULL;
    END IF;

    CREATE TABLE IF NOT EXISTS product_price_overrides (
        price_list_root_id int(11) NOT NULL,
        product_id int(11) NOT NULL,
        price decimal(10,6) NOT NULL,
        updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        PRIMARY KEY (price_list_root_id, product_id),
        CONSTRAINT fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE CASCADE,
        CONSTRAINT fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
        CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-22-category-owned-price-lists-v1',
        'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb'
    );
END$$

CALL `_ps_20260722_category_price_lists`()$$
DROP PROCEDURE `_ps_20260722_category_price_lists`$$

DELIMITER ;

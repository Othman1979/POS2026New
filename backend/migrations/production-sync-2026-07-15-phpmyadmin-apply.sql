-- APPLY MIGRATION. Import from phpMyAdmin's Import tab, not the Query text box.
-- Requirements: MariaDB 10.4+; preflight blocking_findings must be 0.
-- Stop the POS and take a database backup before importing.

SET NAMES utf8mb4;

-- Recheck the operational and relational blockers before any application-table DDL.
DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260715_assert_clean`$$
CREATE PROCEDURE `_ps_20260715_assert_clean`()
BEGIN
  DECLARE v_findings INT DEFAULT 0;

  SELECT COUNT(*) INTO v_findings FROM (
    SELECT 'orders' table_name UNION ALL SELECT 'order_items' UNION ALL
    SELECT 'held_orders' UNION ALL SELECT 'refunds' UNION ALL
    SELECT 'settings' UNION ALL SELECT 'permissions' UNION ALL
    SELECT 'user_permissions' UNION ALL SELECT 'products' UNION ALL
    SELECT 'users' UNION ALL SELECT 'product_bundle_items'
  ) required LEFT JOIN information_schema.TABLES t
    ON t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=required.table_name
  WHERE t.TABLE_NAME IS NULL;
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: required tables are missing'; END IF;

  SELECT COUNT(*) INTO v_findings FROM orders o JOIN order_items oi ON oi.invoice_id=o.invoice_id
  WHERE o.payment_method='unpaid_table' AND oi.note='Auto-Gratuity';
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: open table orders contain service charges'; END IF;

  SELECT COUNT(*) INTO v_findings FROM held_orders WHERE cart_data LIKE '%Auto-Gratuity%';
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: held orders contain service charges'; END IF;

  SELECT COUNT(*) INTO v_findings FROM order_items c
  LEFT JOIN order_items p ON p.id=c.parent_item_id
  WHERE NOT (c.quantity > 0) OR (c.parent_item_id IS NOT NULL AND p.id IS NULL);
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid order-item bundle data'; END IF;

  SELECT COUNT(*) INTO v_findings FROM order_items c JOIN order_items p ON p.id=c.parent_item_id
  WHERE c.invoice_id <> p.invoice_id OR p.parent_item_id IS NOT NULL;
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: cross-invoice or nested bundle data'; END IF;

  SELECT COUNT(*) INTO v_findings FROM product_bundle_items WHERE NOT (qty > 0);
  IF v_findings > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid bundle catalog quantity'; END IF;
END$$
CALL `_ps_20260715_assert_clean`()$$
DROP PROCEDURE `_ps_20260715_assert_clean`$$
DELIMITER ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_inclusive_at_sale TINYINT(1) NULL AFTER tax;

CREATE TABLE IF NOT EXISTS service_charge_snapshots (
  id CHAR(36) NOT NULL,
  percentage DECIMAL(7,4) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL,
  parent_snapshot_id CHAR(36) DEFAULT NULL,
  state ENUM('draft','held','claimed','open_order','split_parent','finalized','abandoned') NOT NULL,
  holder_type ENUM('none','held_order','claim','order') NOT NULL DEFAULT 'none',
  holder_id VARCHAR(80) DEFAULT NULL,
  claim_token_hash CHAR(64) DEFAULT NULL,
  created_by INT(11) NOT NULL,
  version INT(11) NOT NULL DEFAULT 1,
  expires_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
  PRIMARY KEY (id),
  KEY idx_scs_state_expires (state, expires_at),
  KEY idx_scs_holder (holder_type, holder_id),
  KEY idx_scs_parent (parent_snapshot_id),
  CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots(id),
  CONSTRAINT fk_scs_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS service_charge_snapshot_id CHAR(36) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_orders_service_charge_snapshot (service_charge_snapshot_id);

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS service_charge_snapshot_id CHAR(36) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_held_orders_service_charge_snapshot (service_charge_snapshot_id);

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='orders'
     AND CONSTRAINT_NAME='fk_orders_service_charge_snapshot' AND CONSTRAINT_TYPE='FOREIGN KEY') = 0,
  'ALTER TABLE orders ADD CONSTRAINT fk_orders_service_charge_snapshot FOREIGN KEY (service_charge_snapshot_id) REFERENCES service_charge_snapshots(id)',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
     AND CONSTRAINT_NAME='fk_held_service_charge_snapshot' AND CONSTRAINT_TYPE='FOREIGN KEY') = 0,
  'ALTER TABLE held_orders ADD CONSTRAINT fk_held_service_charge_snapshot FOREIGN KEY (service_charge_snapshot_id) REFERENCES service_charge_snapshots(id)',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS selected_modifiers LONGTEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS modifier_surcharge DECIMAL(10,6) DEFAULT NULL;

-- Canonicalize product modifier definitions and add stable IDs without Node.js.
DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260715_modifier_ids`$$
CREATE PROCEDURE `_ps_20260715_modifier_ids`()
BEGIN
  DECLARE v_done INT DEFAULT 0;
  DECLARE v_product_id INT;
  DECLARE v_json LONGTEXT;
  DECLARE v_new LONGTEXT;
  DECLARE v_g INT;
  DECLARE v_o INT;
  DECLARE v_groups INT;
  DECLARE v_options INT;
  DECLARE v_group_path VARCHAR(80);
  DECLARE v_option_path VARCHAR(100);
  DECLARE v_id VARCHAR(32);
  DECLARE v_name VARCHAR(255);
  DECLARE v_text VARCHAR(255);
  DECLARE v_price DECIMAL(10,6);
  DECLARE v_bool TINYINT;
  DECLARE modifier_cursor CURSOR FOR
    SELECT id, modifiers FROM products WHERE modifiers IS NOT NULL AND TRIM(modifiers) <> '' ORDER BY id;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  CREATE TEMPORARY TABLE `_ps_modifier_updates` (
    product_id INT NOT NULL PRIMARY KEY,
    modifiers LONGTEXT NULL
  );
  CREATE TEMPORARY TABLE `_ps_modifier_ids` (id VARCHAR(32) NOT NULL PRIMARY KEY);

  OPEN modifier_cursor;
  product_loop: LOOP
    FETCH modifier_cursor INTO v_product_id, v_json;
    IF v_done = 1 THEN LEAVE product_loop; END IF;
    IF JSON_VALID(v_json)=0 OR JSON_TYPE(JSON_EXTRACT(v_json,'$')) <> 'ARRAY' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid product modifier JSON';
    END IF;
    SET v_groups=JSON_LENGTH(v_json), v_new=v_json, v_g=0;
    -- Match backend/services/modifierDefs.js: an empty array means no modifiers.
    IF v_groups=0 THEN
      INSERT INTO `_ps_modifier_updates` VALUES (v_product_id,NULL);
      ITERATE product_loop;
    END IF;
    IF v_groups>50 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: too many modifier groups'; END IF;
    TRUNCATE TABLE `_ps_modifier_ids`;

    WHILE v_g < v_groups DO
      SET v_group_path=CONCAT('$[',v_g,']');
      IF JSON_TYPE(JSON_EXTRACT(v_new,v_group_path)) <> 'OBJECT' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: modifier group is not an object';
      END IF;
      SET v_name=TRIM(JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.name'))));
      IF v_name IS NULL OR v_name='' OR CHAR_LENGTH(v_name)>100 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid modifier group name';
      END IF;
      IF JSON_TYPE(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.options'))) <> 'ARRAY' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: modifier options are not an array';
      END IF;
      SET v_options=JSON_LENGTH(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.options')));
      IF v_options=0 OR v_options>100 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid modifier option count'; END IF;

      SET v_id=JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.id')));
      IF v_id IS NULL OR v_id NOT REGEXP '^[A-Za-z0-9_-]{1,32}$'
         OR EXISTS(SELECT 1 FROM `_ps_modifier_ids` WHERE id=v_id) THEN
        SET v_id=MD5(CONCAT('g:',v_product_id,':',v_g));
      END IF;
      INSERT INTO `_ps_modifier_ids` VALUES (v_id);
      SET v_text=LOWER(JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.required'))));
      SET v_bool=IF(v_text IN ('true','1'),1,0);
      SET v_new=JSON_SET(v_new,CONCAT(v_group_path,'.id'),v_id,
                              CONCAT(v_group_path,'.name'),v_name,
                              CONCAT(v_group_path,'.required'),v_bool);
      SET v_text=LOWER(JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_group_path,'.multi_select'))));
      SET v_bool=IF(v_text IN ('true','1'),1,0);
      SET v_new=JSON_SET(v_new,CONCAT(v_group_path,'.multi_select'),v_bool);

      SET v_o=0;
      WHILE v_o < v_options DO
        SET v_option_path=CONCAT(v_group_path,'.options[',v_o,']');
        IF JSON_TYPE(JSON_EXTRACT(v_new,v_option_path)) <> 'OBJECT' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: modifier option is not an object';
        END IF;
        SET v_name=TRIM(JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_option_path,'.name'))));
        IF v_name IS NULL OR v_name='' OR CHAR_LENGTH(v_name)>100 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid modifier option name';
        END IF;
        SET v_text=JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_option_path,'.price')));
        IF v_text IS NULL OR v_text='' THEN SET v_price=0;
        ELSE
          IF v_text NOT REGEXP '^[0-9]+([.][0-9]+)?$' OR CAST(v_text AS DECIMAL(10,6))>10000 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STOP: invalid modifier option price';
          END IF;
          SET v_price=CAST(v_text AS DECIMAL(10,6));
        END IF;
        SET v_id=JSON_UNQUOTE(JSON_EXTRACT(v_new,CONCAT(v_option_path,'.id')));
        IF v_id IS NULL OR v_id NOT REGEXP '^[A-Za-z0-9_-]{1,32}$'
           OR EXISTS(SELECT 1 FROM `_ps_modifier_ids` WHERE id=v_id) THEN
          SET v_id=MD5(CONCAT('o:',v_product_id,':',v_g,':',v_o));
        END IF;
        INSERT INTO `_ps_modifier_ids` VALUES (v_id);
        SET v_new=JSON_SET(v_new,CONCAT(v_option_path,'.id'),v_id,
                                CONCAT(v_option_path,'.name'),v_name,
                                CONCAT(v_option_path,'.price'),v_price);
        SET v_o=v_o+1;
      END WHILE;
      SET v_g=v_g+1;
    END WHILE;
    INSERT INTO `_ps_modifier_updates` VALUES (v_product_id,v_new);
  END LOOP;
  CLOSE modifier_cursor;

  UPDATE products p JOIN `_ps_modifier_updates` u ON u.product_id=p.id
  SET p.modifiers=u.modifiers
  WHERE NOT (p.modifiers <=> u.modifiers);
  DROP TEMPORARY TABLE `_ps_modifier_ids`;
  DROP TEMPORARY TABLE `_ps_modifier_updates`;
END$$
CALL `_ps_20260715_modifier_ids`()$$
DROP PROCEDURE `_ps_20260715_modifier_ids`$$
DELIMITER ;

-- Enforce same-invoice bundle parents and positive quantities.
SET @has_unique = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_items'
    GROUP BY INDEX_NAME, NON_UNIQUE
    HAVING NON_UNIQUE=0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)= 'id,invoice_id'
  ) x
);
SET @sql=IF(@has_unique=0,
  'ALTER TABLE order_items ADD UNIQUE KEY uq_order_items_id_invoice (id,invoice_id)','DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_child_index = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_items'
    GROUP BY INDEX_NAME
    HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)= 'parent_item_id,invoice_id'
  ) x
);
SET @sql=IF(@has_child_index=0,
  'ALTER TABLE order_items ADD KEY idx_order_items_parent_invoice (parent_item_id,invoice_id)','DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_quantity_check = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='order_items'
    AND CONSTRAINT_NAME='chk_order_items_quantity_positive' AND CONSTRAINT_TYPE='CHECK'
);
SET @sql=IF(@has_quantity_check=0,
  'ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0)','DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @legacy_fk = (
  SELECT MIN(k.CONSTRAINT_NAME)
  FROM information_schema.KEY_COLUMN_USAGE k
  WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='order_items'
    AND k.COLUMN_NAME='parent_item_id' AND k.REFERENCED_TABLE_NAME='order_items'
    AND k.REFERENCED_COLUMN_NAME='id'
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k2
      WHERE k2.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND k2.TABLE_NAME=k.TABLE_NAME
        AND k2.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND k2.ORDINAL_POSITION=2
    )
);
SET @sql=IF(@legacy_fk IS NULL,'DO 0',
  CONCAT('ALTER TABLE order_items DROP FOREIGN KEY `',REPLACE(@legacy_fk,'`','``'),'`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_composite_fk = (
  SELECT COUNT(*) FROM (
    SELECT k.CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='order_items'
      AND k.REFERENCED_TABLE_NAME='order_items' AND r.DELETE_RULE='CASCADE'
    GROUP BY k.CONSTRAINT_NAME
    HAVING GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION)='parent_item_id,invoice_id'
       AND GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION)='id,invoice_id'
  ) x
);
SET @sql=IF(@has_composite_fk=0,
  'ALTER TABLE order_items ADD CONSTRAINT fk_order_items_parent_invoice FOREIGN KEY (parent_item_id,invoice_id) REFERENCES order_items(id,invoice_id) ON DELETE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO settings (setting_key,setting_value)
VALUES ('auto_apply_service_charge','0');

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS created_at DATETIME NULL DEFAULT NULL;
UPDATE order_items oi
LEFT JOIN orders o ON o.invoice_id=oi.invoice_id
SET oi.created_at=COALESCE(o.created_at,CURRENT_TIMESTAMP)
WHERE oi.created_at IS NULL;
ALTER TABLE order_items
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS table_number VARCHAR(50) NULL AFTER table_id;

-- Intentional removal of the obsolete tax-exempt permission and its grants.
START TRANSACTION;
DELETE FROM user_permissions WHERE perm_key='pos.tax_exempt';
DELETE FROM permissions WHERE perm_key='pos.tax_exempt';
COMMIT;

SELECT 'Migration applied. Import the verification file now.' AS result;

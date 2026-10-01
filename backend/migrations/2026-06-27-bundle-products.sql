-- Bundle / Package Products — 2026-06-27
-- 1) flag bundle products
ALTER TABLE products
  ADD COLUMN is_bundle TINYINT(1) NOT NULL DEFAULT 0;

-- 2) bundle composition
CREATE TABLE product_bundle_items (
  id         INT(11) NOT NULL AUTO_INCREMENT,
  bundle_id  INT(11) NOT NULL,
  product_id INT(11) NOT NULL,
  qty        DECIMAL(10,3) NOT NULL DEFAULT 1.000,
  sort_order INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pbi_bundle (bundle_id),
  KEY idx_pbi_product (product_id),
  CONSTRAINT fk_pbi_bundle  FOREIGN KEY (bundle_id)  REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_pbi_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) link child order_items to their bundle parent row
ALTER TABLE order_items
  ADD COLUMN parent_item_id INT(11) NULL,
  ADD KEY idx_order_items_parent (parent_item_id),
  ADD CONSTRAINT fk_order_items_parent FOREIGN KEY (parent_item_id) REFERENCES order_items (id) ON DELETE CASCADE;

-- 4) silent audit log for cashier bundle edits
CREATE TABLE bundle_modifications (
  id           INT(11) NOT NULL AUTO_INCREMENT,
  order_id     INT(11) NOT NULL,
  cashier_id   INT(11) NOT NULL,
  product_name VARCHAR(255) DEFAULT NULL,
  action       ENUM('removed','swapped','note_modified') NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bundle_mods_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 2026-09-08-stock-procurement-v1
-- Requires migration: 2026-09-08-stock-report-daily-projection-v1
-- Requires checksum: eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67
-- Suppliers, versioned packs, purchase orders, receipts, vendor returns and price-only adjustments.
CREATE TABLE IF NOT EXISTS stock_suppliers (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(120) NOT NULL,
 is_active TINYINT NOT NULL DEFAULT 1,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_supplier_name (name),
 KEY idx_stock_supplier_active_name (is_active,name,id),
 CONSTRAINT ck_stock_supplier_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_supplier_items (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 supplier_sku VARCHAR(80) DEFAULT NULL,
 pack_barcode VARCHAR(50) DEFAULT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_supplier_item (supplier_id,stock_item_id),
 UNIQUE KEY uq_stock_supplier_pack_barcode (pack_barcode),
 KEY idx_stock_supplier_item_sku (supplier_id,supplier_sku),
 CONSTRAINT fk_stock_supplier_item_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT fk_stock_supplier_item_stock FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_supplier_item_pack CHECK (pack_qty>0),
 CONSTRAINT ck_stock_supplier_item_currency CHECK (currency='JD'),
 CONSTRAINT ck_stock_supplier_item_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_purchase_orders (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'draft',
 revision INT UNSIGNED NOT NULL DEFAULT 1,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 notes VARCHAR(240) DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_po_request (request_key),
 KEY idx_stock_po_status_date (status,business_date,id),
 KEY idx_stock_po_supplier (supplier_id,id),
 CONSTRAINT fk_stock_po_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT ck_stock_po_status CHECK (status IN ('draft','approved','partially_received','closed','cancelled')),
 CONSTRAINT ck_stock_po_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_purchase_order_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 purchase_order_id BIGINT UNSIGNED NOT NULL,
 revision INT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 supplier_item_id BIGINT UNSIGNED DEFAULT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 ordered_packs DECIMAL(16,6) NOT NULL DEFAULT 0,
 ordered_loose DECIMAL(16,6) NOT NULL DEFAULT 0,
 ordered_qty DECIMAL(16,6) NOT NULL,
 received_qty DECIMAL(16,6) NOT NULL DEFAULT 0,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 UNIQUE KEY uq_stock_po_line (purchase_order_id,revision,line_ordinal),
 KEY idx_stock_po_line_item (purchase_order_id,revision,stock_item_id),
 CONSTRAINT fk_stock_po_line_po FOREIGN KEY (purchase_order_id) REFERENCES stock_purchase_orders(id),
 CONSTRAINT fk_stock_po_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_po_line_qty CHECK (ordered_qty>=0 AND received_qty>=0 AND pack_qty>0 AND ordered_packs>=0 AND ordered_loose>=0),
 CONSTRAINT ck_stock_po_line_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_receipts (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 supplier_id BIGINT UNSIGNED DEFAULT NULL,
 purchase_order_id BIGINT UNSIGNED DEFAULT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 supplier_document_ref VARCHAR(80) DEFAULT NULL,
 supplier_document_ack TINYINT NOT NULL DEFAULT 0,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 discount_amount DECIMAL(18,8) NOT NULL DEFAULT 0,
 nonrecoverable_charges DECIMAL(18,8) NOT NULL DEFAULT 0,
 recoverable_tax DECIMAL(18,8) NOT NULL DEFAULT 0,
 lines_subtotal DECIMAL(18,8) DEFAULT NULL,
 allocated_total DECIMAL(18,8) DEFAULT NULL,
 business_date DATE NOT NULL,
 operation_id BIGINT UNSIGNED DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_receipt_request (request_key),
 KEY idx_stock_receipt_status_date (status,business_date,id),
 KEY idx_stock_receipt_supplier_ref (supplier_id,supplier_document_ref),
 KEY idx_stock_receipt_po (purchase_order_id,id),
 CONSTRAINT fk_stock_receipt_supplier FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id),
 CONSTRAINT fk_stock_receipt_po FOREIGN KEY (purchase_order_id) REFERENCES stock_purchase_orders(id),
 CONSTRAINT ck_stock_receipt_status CHECK (status IN ('draft','posted')),
 CONSTRAINT ck_stock_receipt_currency CHECK (currency='JD'),
 CONSTRAINT ck_stock_receipt_ack CHECK (supplier_document_ack IN (0,1)),
 CONSTRAINT ck_stock_receipt_money CHECK (discount_amount>=0 AND nonrecoverable_charges>=0 AND recoverable_tax>=0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_receipt_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 purchase_order_line_id BIGINT UNSIGNED DEFAULT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 pack_qty DECIMAL(16,6) NOT NULL,
 packs DECIMAL(16,6) NOT NULL DEFAULT 0,
 loose DECIMAL(16,6) NOT NULL DEFAULT 0,
 received_qty DECIMAL(16,6) NOT NULL,
 ordered_qty DECIMAL(16,6) DEFAULT NULL,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 allocated_cost DECIMAL(18,8) DEFAULT NULL,
 currency CHAR(3) NOT NULL DEFAULT 'JD',
 UNIQUE KEY uq_stock_receipt_line (receipt_id,line_ordinal),
 KEY idx_stock_receipt_line_item (receipt_id,stock_item_id),
 KEY idx_stock_receipt_line_po (purchase_order_line_id),
 CONSTRAINT fk_stock_receipt_line_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT fk_stock_receipt_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_receipt_line_location FOREIGN KEY (location_id) REFERENCES stock_locations(id),
 CONSTRAINT fk_stock_receipt_line_lot FOREIGN KEY (lot_id) REFERENCES stock_lots(id),
 CONSTRAINT ck_stock_receipt_line_qty CHECK (received_qty>0 AND pack_qty>0 AND packs>=0 AND loose>=0),
 CONSTRAINT ck_stock_receipt_line_currency CHECK (currency='JD')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_vendor_returns (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 operation_id BIGINT UNSIGNED DEFAULT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_vendor_return_request (request_key),
 KEY idx_stock_vendor_return_receipt (receipt_id,id),
 CONSTRAINT fk_stock_vendor_return_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT ck_stock_vendor_return_status CHECK (status IN ('draft','posted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_vendor_return_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 vendor_return_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 receipt_line_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL,
 UNIQUE KEY uq_stock_vendor_return_line (vendor_return_id,line_ordinal),
 KEY idx_stock_vendor_return_source (receipt_line_id),
 CONSTRAINT fk_stock_vendor_return_line_return FOREIGN KEY (vendor_return_id) REFERENCES stock_vendor_returns(id),
 CONSTRAINT fk_stock_vendor_return_line_source FOREIGN KEY (receipt_line_id) REFERENCES stock_receipt_lines(id),
 CONSTRAINT ck_stock_vendor_return_line_qty CHECK (quantity>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_price_adjustments (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 receipt_id BIGINT UNSIGNED NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 request_key VARCHAR(80) DEFAULT NULL,
 business_date DATE NOT NULL,
 actor_id INT DEFAULT NULL,
 UNIQUE KEY uq_stock_price_adjustment_request (request_key),
 KEY idx_stock_price_adjustment_receipt (receipt_id,id),
 CONSTRAINT fk_stock_price_adjustment_receipt FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id),
 CONSTRAINT ck_stock_price_adjustment_status CHECK (status IN ('draft','posted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_price_adjustment_lines (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 price_adjustment_id BIGINT UNSIGNED NOT NULL,
 line_ordinal INT UNSIGNED NOT NULL,
 receipt_line_id BIGINT UNSIGNED NOT NULL,
 unit_cost DECIMAL(18,8) DEFAULT NULL,
 UNIQUE KEY uq_stock_price_adjustment_line (price_adjustment_id,line_ordinal),
 KEY idx_stock_price_adjustment_source (receipt_line_id),
 CONSTRAINT fk_stock_price_adjustment_line_adj FOREIGN KEY (price_adjustment_id) REFERENCES stock_price_adjustments(id),
 CONSTRAINT fk_stock_price_adjustment_line_source FOREIGN KEY (receipt_line_id) REFERENCES stock_receipt_lines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO permissions
 (perm_key,label,label_ar,description,description_ar,category,sort_order,implemented,default_cashier,overridable) VALUES
 ('inventory.read','View inventory','عرض المخزون','Read stock identities, receipts and purchase documents.','قراءة أصناف المخزون وإيصالات الاستلام وأوامر الشراء.','inventory',300,1,0,0),
 ('receipt.enter','Enter receipts','إدخال الاستلام','Create and edit receipt drafts.','إنشاء مسودات الاستلام وتعديلها.','inventory',310,1,0,0),
 ('receipt.post','Post receipts','ترحيل الاستلام','Post receipt, return and price-adjustment documents.','ترحيل إيصالات الاستلام والمرتجعات وتعديلات السعر.','inventory',320,1,0,0),
 ('purchase.approve','Approve purchases','اعتماد المشتريات','Approve, amend or cancel purchase orders.','اعتماد أوامر الشراء أو تعديلها أو إلغاء المتبقي منها.','inventory',330,1,0,0),
 ('supplier.manage','Manage suppliers','إدارة الموردين','Create and edit suppliers and pack mappings.','إنشاء الموردين وتعريفات العبوات وتعديلها.','inventory',340,1,0,0),
 ('count.enter','Enter counts','إدخال الجرد','Reserved for count drafts.','محجوز لمسودات الجرد.','inventory',350,0,0,0),
 ('count.post','Post counts','ترحيل الجرد','Reserved for posting counts.','محجوز لترحيل الجرد.','inventory',360,0,0,0),
 ('recipe.publish','Publish recipes','نشر الوصفات','Reserved for recipe publication.','محجوز لنشر الوصفات.','inventory',370,0,0,0),
 ('prep.post','Post preparations','ترحيل التحضير','Reserved for preparation batches.','محجوز لترحيل دفعات التحضير.','inventory',380,0,0,0),
 ('transfer.dispatch','Dispatch transfers','صرف التحويل','Reserved for transfer dispatch.','محجوز لصرف التحويل.','inventory',390,0,0,0),
 ('transfer.receive','Receive transfers','استلام التحويل','Reserved for transfer receipt.','محجوز لاستلام التحويل.','inventory',400,0,0,0),
 ('waste.post','Post waste','ترحيل الهدر','Reserved for waste posting.','محجوز لترحيل الهدر.','inventory',410,0,0,0),
 ('value.adjust','Adjust valuation','تعديل التقييم','Reserved for valuation adjustments.','محجوز لتعديلات التقييم.','inventory',420,0,0,0),
 ('period.close','Close periods','إقفال الفترات','Reserved for period close.','محجوز لإقفال الفترات.','inventory',430,0,0,0)
ON DUPLICATE KEY UPDATE label=VALUES(label),label_ar=VALUES(label_ar),description=VALUES(description),description_ar=VALUES(description_ar),category=VALUES(category),sort_order=VALUES(sort_order),implemented=VALUES(implemented),default_cashier=VALUES(default_cashier),overridable=VALUES(overridable);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-procurement-v1','a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

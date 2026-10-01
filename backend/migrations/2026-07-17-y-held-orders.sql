INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES ('y_order_type_id', '');

CREATE TABLE master_held (
    id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
    business_start_at datetime NOT NULL,
    business_end_at datetime NOT NULL,
    report_payload longtext NOT NULL,
    held_orders_payload longtext NOT NULL,
    generated_by_user_id int(11) DEFAULT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp(),
    expires_at datetime NOT NULL,
    restored_at datetime DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_master_held_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

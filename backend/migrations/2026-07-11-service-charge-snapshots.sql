CREATE TABLE IF NOT EXISTS service_charge_snapshots (
  id char(36) NOT NULL,
  percentage decimal(7,4) NOT NULL,
  tax_rate decimal(5,2) NOT NULL,
  parent_snapshot_id char(36) DEFAULT NULL,
  state enum('draft','held','claimed','open_order','split_parent','finalized','abandoned') NOT NULL,
  holder_type enum('none','held_order','claim','order') NOT NULL DEFAULT 'none',
  holder_id varchar(80) DEFAULT NULL,
  claim_token_hash char(64) DEFAULT NULL,
  created_by int(11) NOT NULL,
  version int(11) NOT NULL DEFAULT 1,
  expires_at datetime DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_scs_state_expires (state, expires_at),
  KEY idx_scs_holder (holder_type, holder_id),
  KEY idx_scs_parent (parent_snapshot_id),
  CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots(id),
  CONSTRAINT fk_scs_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS service_charge_snapshot_id char(36) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_orders_service_charge_snapshot (service_charge_snapshot_id);

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS service_charge_snapshot_id char(36) DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_held_orders_service_charge_snapshot (service_charge_snapshot_id);

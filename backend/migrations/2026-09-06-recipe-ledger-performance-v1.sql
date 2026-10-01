-- 2026-09-06-recipe-ledger-performance-v1
-- Requires migration: 2026-09-05-recipe-ledger-v1
-- Requires checksum: 9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb

-- Evidence/operational source for the immutable per-line ingredient lock record.
-- Apply before starting the updated application, through the managed runner.
-- Existing movement quantities and cost snapshots are unchanged.

CREATE TABLE IF NOT EXISTS recipe_ledger_lines (
  line_key char(32) NOT NULL PRIMARY KEY,
  ingredient_ids JSON NOT NULL,
  CONSTRAINT chk_rll_array CHECK (JSON_TYPE(ingredient_ids)='ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- MariaDB 10.4 has no JSON_ARRAYAGG. Guard against GROUP_CONCAT truncation
-- explicitly: incomplete discovery must fail, never silently omit a lock.
SET @recipe_line_previous_concat_limit = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 4294967295;

INSERT INTO recipe_ledger_lines (line_key, ingredient_ids)
SELECT line_key, CASE
  WHEN OCTET_LENGTH(GROUP_CONCAT(ingredient_id ORDER BY ingredient_id)) =
       SUM(OCTET_LENGTH(CAST(ingredient_id AS CHAR))) + COUNT(*) - 1
  THEN CONCAT('[', GROUP_CONCAT(ingredient_id ORDER BY ingredient_id), ']')
  ELSE NULL END
FROM (
  SELECT DISTINCT line_key, ingredient_id FROM ingredient_movements
  WHERE line_key IS NOT NULL AND kind IN ('usage','reversal')
) recorded
GROUP BY line_key
ON DUPLICATE KEY UPDATE line_key=VALUES(line_key);

SET SESSION group_concat_max_len = @recipe_line_previous_concat_limit;

-- A saved key without any usage rows is a frozen empty composition.
-- Split holds retain their parent order lines until settlement; merged and
-- settled lines retain the same keys. Movement keys above cover removed lines.
INSERT INTO recipe_ledger_lines (line_key, ingredient_ids)
SELECT recipe_line_key, '[]' FROM order_items WHERE recipe_line_key IS NOT NULL
UNION
SELECT recipe_line_key, '[]' FROM subscription_redemption_items WHERE recipe_line_key IS NOT NULL
ON DUPLICATE KEY UPDATE line_key=VALUES(line_key);

-- Replace the two existing read indexes with covering versions. The balance
-- index keeps ingredient/id ordering; the day index also orders flow groups.
ALTER TABLE ingredient_movements
  ADD KEY IF NOT EXISTS idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date),
  ADD KEY IF NOT EXISTS idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE ingredient_movements
  DROP KEY IF EXISTS idx_im_ingredient_id,
  DROP KEY IF EXISTS idx_im_date_ingredient,
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-06-recipe-ledger-performance-v1', 'f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

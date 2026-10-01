-- Read-only preflight for 2026-09-02-expense-zero-amount-v1.
-- Accept only the exact predecessor ledger and the known old or target amount check.

SELECT CASE WHEN (
  (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name = '2026-09-01-fractional-stock-precision-v1'
      AND checksum = 'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'expenses'
      AND TABLE_TYPE = 'BASE TABLE') = 1
  AND (
    (SELECT COUNT(*)
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'expenses'
        AND tc.CONSTRAINT_NAME = 'chk_expenses_amount'
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND LOWER(REPLACE(REPLACE(REPLACE(cc.CHECK_CLAUSE, '`', ''), ' ', ''), CHAR(10), '')) = 'amount>0') = 1
    OR
    (SELECT COUNT(*)
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'expenses'
        AND tc.CONSTRAINT_NAME = 'chk_expenses_amount'
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND LOWER(REPLACE(REPLACE(REPLACE(cc.CHECK_CLAUSE, '`', ''), ' ', ''), CHAR(10), '')) = 'amount>=0') = 1
  )
) THEN 1 ELSE 0 END AS ok;

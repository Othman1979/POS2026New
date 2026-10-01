-- JoFotara operations controls (phpMyAdmin-safe).
SET NAMES utf8mb4;

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260724_jofotara_operations`$$
CREATE PROCEDURE `_ps_20260724_jofotara_operations`()
migration: BEGIN
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

    SELECT MAX(checksum) INTO v_checksum FROM schema_migrations
     WHERE migration_name='2026-07-24-jofotara-operations-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum IS NOT NULL THEN LEAVE migration; END IF;

    INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('jofotara_auto_submit', '0'),
      ('jofotara_auto_submit_since', '');

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-24-jofotara-operations-v1', '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e');
END$$
CALL `_ps_20260724_jofotara_operations`()$$
DROP PROCEDURE IF EXISTS `_ps_20260724_jofotara_operations`$$
DELIMITER ;

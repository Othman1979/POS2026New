-- Multi-spooler printer ownership migration (phpMyAdmin-safe).
-- Existing printers remain on the "primary" print station.

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `_ps_20260719_multi_spooler`$$
CREATE PROCEDURE `_ps_20260719_multi_spooler`()
migration: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_checksum CHAR(64) DEFAULT NULL;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: select the client database before importing this file';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('printers', 'print_queue', 'schema_migrations');
    IF v_count <> 3 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: required printer tables are missing';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM schema_migrations
     WHERE migration_name = '2026-07-18-foundation-final-hygiene-v1'
       AND checksum = 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021';
    IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: foundation hygiene migration must be applied first';
    END IF;

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-19-multi-spooler-printer-ownership-v1';
    IF v_checksum IS NOT NULL AND v_checksum <> '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum = '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d' THEN
        LEAVE migration;
    END IF;

    ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS spooler_id varchar(96) NOT NULL DEFAULT 'primary' AFTER assigned_ips;

    SELECT COUNT(*) INTO v_count FROM (
        SELECT CASE
            WHEN type = 'network' THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port), ''), '9100'))
            ELSE CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
        END AS endpoint_key
          FROM printers
         WHERE is_active = 1
         GROUP BY endpoint_key
        HAVING COUNT(*) > 1
    ) duplicate_endpoints;
    IF v_count <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: duplicate active physical printer endpoints require correction';
    END IF;

    ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS active_endpoint_key varchar(255)
            AS (CASE
                WHEN is_active = 1 AND type = 'network'
                    THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port), ''), '9100'))
                WHEN is_active = 1 AND type = 'windows'
                    THEN CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
                ELSE NULL
            END) PERSISTENT;

    ALTER TABLE printers
        ADD KEY IF NOT EXISTS idx_printers_spooler (spooler_id, is_active, id),
        ADD UNIQUE KEY IF NOT EXISTS uq_printers_active_endpoint (active_endpoint_key);

    -- Old queue rows used printer names/IPs. Preserve uniquely mappable rows and
    -- null only unmatched historical identities; the original JSON payload remains.
    UPDATE print_queue q
       SET q.printer_id = (
            SELECT CASE WHEN COUNT(DISTINCT p.id) = 1 THEN MIN(p.id) ELSE NULL END
              FROM printers p
             WHERE q.printer_id = p.name
                OR q.printer_id = p.windows_name
                OR q.printer_id = p.network_ip
       )
     WHERE q.printer_id IS NOT NULL
       AND q.printer_id NOT REGEXP '^[0-9]+$';

    UPDATE print_queue q
    LEFT JOIN printers p ON p.id = CAST(q.printer_id AS UNSIGNED)
       SET q.printer_id = NULL
     WHERE q.printer_id IS NOT NULL
       AND p.id IS NULL;

    ALTER TABLE print_queue
        MODIFY printer_id int(11) DEFAULT NULL,
        ADD KEY IF NOT EXISTS idx_print_queue_owner_claim (printer_id, status, locked_until, id);

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES (
        '2026-07-19-multi-spooler-printer-ownership-v1',
        '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d'
    );
END$$

CALL `_ps_20260719_multi_spooler`()$$
DROP PROCEDURE `_ps_20260719_multi_spooler`$$

DELIMITER ;

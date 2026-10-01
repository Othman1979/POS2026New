-- Durable print-template revisions (phpMyAdmin-safe).
-- Run 2026-07-25-print-templates-preflight.sql first and require blocking_findings = 0.
SET NAMES utf8mb4;

DELIMITER $$
DROP PROCEDURE IF EXISTS `_ps_20260725_print_templates`$$
CREATE PROCEDURE `_ps_20260725_print_templates`()
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

    SELECT MAX(checksum) INTO v_checksum
      FROM schema_migrations
     WHERE migration_name = '2026-07-25-print-templates-v1';
    IF v_checksum IS NOT NULL
       AND v_checksum <> 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'STOP: migration checksum conflict';
    END IF;
    IF v_checksum IS NOT NULL THEN LEAVE migration; END IF;

    CREATE TABLE print_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      document_type VARCHAR(16) NOT NULL,
      active_revision_id BIGINT UNSIGNED NULL,
      draft_revision_id BIGINT UNSIGNED NULL,
      lock_version INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_templates_document_type (document_type),
      CONSTRAINT chk_print_templates_document_type CHECK (document_type IN ('receipt','kitchen'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE print_template_revisions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      template_id BIGINT UNSIGNED NOT NULL,
      revision_no INT UNSIGNED NOT NULL,
      schema_version SMALLINT UNSIGNED NOT NULL,
      definition_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      definition_hash CHAR(64) NOT NULL,
      created_by INT(11) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_compile_error_code VARCHAR(64) NULL,
      last_compile_error_message VARCHAR(500) NULL,
      last_compile_failed_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_template_revision_no (template_id, revision_no),
      UNIQUE KEY uq_print_template_revision_hash (template_id, definition_hash),
      KEY idx_print_template_revisions_history (template_id, created_at, id),
      CONSTRAINT fk_print_template_revisions_template FOREIGN KEY (template_id) REFERENCES print_templates(id) ON DELETE RESTRICT,
      CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT chk_print_template_revision_no CHECK (revision_no > 0),
      CONSTRAINT chk_print_template_revision_json CHECK (JSON_VALID(definition_json))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    CREATE TABLE print_template_revision_tests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      revision_id BIGINT UNSIGNED NOT NULL,
      printer_id INT(11) NULL,
      printer_name VARCHAR(200) NOT NULL,
      printer_endpoint_key VARCHAR(255) NOT NULL,
      queue_id INT(11) NULL,
      spooler_version VARCHAR(64) NOT NULL,
      acknowledged_at DATETIME NOT NULL,
      confirmed_by INT(11) NULL,
      confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_print_template_revision_test_queue (queue_id),
      KEY idx_print_template_tests_revision_printer (revision_id, printer_id, confirmed_at, id),
      CONSTRAINT fk_print_template_tests_revision FOREIGN KEY (revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
      CONSTRAINT fk_print_template_tests_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL,
      CONSTRAINT fk_print_template_tests_queue FOREIGN KEY (queue_id) REFERENCES print_queue(id) ON DELETE SET NULL,
      CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

    ALTER TABLE print_templates
      ADD CONSTRAINT fk_print_templates_active_revision
        FOREIGN KEY (active_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_print_templates_draft_revision
        FOREIGN KEY (draft_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

    INSERT IGNORE INTO print_templates (document_type) VALUES ('receipt'), ('kitchen');

    INSERT INTO schema_migrations (migration_name, checksum)
    VALUES ('2026-07-25-print-templates-v1', 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07');
END$$
CALL `_ps_20260725_print_templates`()$$
DROP PROCEDURE IF EXISTS `_ps_20260725_print_templates`$$
DELIMITER ;

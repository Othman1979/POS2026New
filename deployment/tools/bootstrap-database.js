const fs = require('fs');
const { permissionCatalogSql } = require('../../backend/config/permissionCatalog');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');
const { validateRequiredSchema } = require('../../backend/services/schemaValidation');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'database', 'baseline.sql');
const MANIFEST_PATH = path.join(ROOT, 'database', 'manifest.json');
const IDENTIFIER = /^[A-Za-z0-9_]+$/;

function normalizeSqlText(buffer) {
    return buffer.toString('utf8').replace(/\r\n/g, '\n');
}

function assertIdentifier(value, label) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
        throw new Error(`Invalid ${label}.`);
    }
    return value;
}

function readVerifiedBaseline() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.baseline?.id !== 'posapp-fresh-baseline-v1') {
        throw new Error('Unsupported fresh database manifest.');
    }
    const baseline = normalizeSqlText(fs.readFileSync(path.join(ROOT, 'database', manifest.baseline.file)));
    const digest = crypto.createHash('sha256').update(baseline, 'utf8').digest('hex');
    if (digest !== manifest.baseline.sha256) {
        throw new Error('Fresh database baseline checksum mismatch.');
    }
    return { manifest, baseline };
}

async function bootstrapDatabase(options = {}) {
    const {
        database = 'posapp',
        appUser = 'posapp_runtime',
        appPassword,
        maintenanceUser = 'posapp_maintenance',
        maintenancePassword,
        adminUserNumber = '009384',
        adminName = 'Administrator',
        programmerUserNumber,
        programmerName = 'Programmer',
        executor,
        validate = validateRequiredSchema,
        host = '127.0.0.1',
        port = 3306,
        adminUser = 'root',
        initialAdminPassword = '',
        adminPassword = ''
    } = options;

    for (const [value, label] of [[database, 'database'], [appUser, 'application user'], [maintenanceUser, 'maintenance user']]) {
        assertIdentifier(value, label);
    }
    if (!String(adminUserNumber).trim() || !String(adminName).trim()) throw new Error('Administrator identity is required.');
    if (!/^[1-9][0-9]{11}$/.test(String(programmerUserNumber || '')) || !String(programmerName).trim()) throw new Error('A generated twelve-digit programmer identity is required.');
    if (String(programmerUserNumber) === String(adminUserNumber)) throw new Error('Programmer and administrator numbers must differ.');
    if (!String(appPassword || '').trim() || !String(maintenancePassword || '').trim()) {
        throw new Error('Generated database passwords are required.');
    }

    const { manifest, baseline } = readVerifiedBaseline();
    assertIdentifier(adminUser, 'administrative user');
    if (!String(adminPassword).trim()) throw new Error('Generated administrative password is required.');
    const conn = executor || await mysqlPromise.createConnection({ host, port, user: adminUser, password: initialAdminPassword, multipleStatements: true });
    const q = (sql, params) => conn.query(sql, params);
    try {
        await q(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await q(`USE \`${database}\``);
        await q(baseline);

        const accountHosts = ['localhost', '127.0.0.1'];
        for (const accountHost of accountHosts) {
            const appAccount = `${mysql.escape(appUser)}@${mysql.escape(accountHost)}`;
            const maintenanceAccount = `${mysql.escape(maintenanceUser)}@${mysql.escape(accountHost)}`;
            await q(`CREATE USER IF NOT EXISTS ${appAccount} IDENTIFIED BY ${mysql.escape(appPassword)}`);
            await q(`CREATE USER IF NOT EXISTS ${maintenanceAccount} IDENTIFIED BY ${mysql.escape(maintenancePassword)}`);
            await q(`ALTER USER ${appAccount} IDENTIFIED BY ${mysql.escape(appPassword)}`);
            await q(`ALTER USER ${maintenanceAccount} IDENTIFIED BY ${mysql.escape(maintenancePassword)}`);
            await q(`GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON \`${database}\`.* TO ${appAccount}`);
            await q(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO ${maintenanceAccount}`);
            await q(`GRANT ALL PRIVILEGES ON \`posapp_restore_test\`.* TO ${maintenanceAccount}`);
        }

        await q(`INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
            ('tax_inclusive_pricing','0'), ('tables_enabled','1'), ('table_mode','fixed'),
            ('admin_language','en'), ('stock_enabled','0'),
            ('use_invoice_no_only','0'), ('order_type_numbering','0'), ('service_charge_enabled','0'),
            ('service_charge_percentage','10'), ('service_charge_tax_rate','0'),
            ('service_charge_jofotara_tax_category','O'),
            ('auto_apply_service_charge','0'), ('jofotara_enabled','0'),
            ('tax_registration_type','sales_tax'), ('jofotara_auto_submit','0'),
            ('jofotara_auto_submit_since',''), ('jofotara_sales_tax_client_id',''),
            ('jofotara_sales_tax_secret_key',''), ('jofotara_sales_tax_income_source_sequence',''),
            ('jofotara_sales_tax_seller_tax_number',''), ('jofotara_sales_tax_seller_registered_name',''),
            ('jofotara_income_tax_client_id',''), ('jofotara_income_tax_secret_key',''),
            ('jofotara_income_tax_income_source_sequence',''), ('jofotara_income_tax_seller_tax_number',''),
            ('jofotara_income_tax_seller_registered_name',''),
            ('y_order_type_id',''),
            ('recipe_ledger_enabled','0'),
            ('low_stock_threshold','3'),
            ('staff_device_auth_mode','disabled'),
            ('webauthn_bootstrap_consumed','0')`);
        await q(permissionCatalogSql());
        await q(`INSERT IGNORE INTO order_types (name, requires_hash, is_active) VALUES ('Dine In', 0, 1)`);
        await q(`INSERT IGNORE INTO invoice_sequences (sequence_name, current_value) VALUES ('global_invoice', 0)`);
        await q(`INSERT IGNORE INTO schema_migrations (migration_name, checksum) VALUES
            ('2026-09-14-permission-catalog-v1','4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883'),
            ('2026-09-14-table-access-scope-v1','d468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919'),
            ('2026-09-14-permission-catalog-v2','a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408'),
            ('2026-09-17-print-queue-timings-v1','3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e'),
            ('2026-09-19-customer-phone-index-v1','3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a'),
            ('2026-09-20-order-intake-requests-v1','8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab'),
            ('2026-09-22-product-customer-info-v1','e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30'),
            ('2026-09-23-subscriptions-retirement-v1','2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd'),
            ('2026-09-26-expense-request-id-v1','317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63'),
            ('2026-09-30-printer-last-printed-v1','c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031'),
            ('2026-09-30-multi-terminal-permission-v1','39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893'),
            ('2026-09-30-purchase-invoices-v1','d229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9'),
            ('2026-10-01-retire-purchasing-tables-v1','1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b'),
            ('2026-10-01-stock-documents-v1','81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0'),
            ('2026-10-02-purchase-item-kind-v1','ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e'),
            ('2026-10-03-product-barcodes-v1','d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e'),
            ('2026-10-04-packaging-units-v1','bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6'),
            ('2026-09-12-ingredient-state-v1','2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e'),
            ('2026-09-12-unified-stock-movements-v1','91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99'),
            ('2026-09-12-stock-item-identity-v1','045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b'),
            ('2026-09-08-stock-ledger-core-v1','39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4'),
            ('2026-09-08-stock-sale-snapshots-v1','b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f'),
            ('2026-09-08-stock-read-index-v1','318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081'),
            ('2026-09-08-stock-report-generations-v1','724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510'),
            ('2026-09-08-stock-report-facts-v1','c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb'),
            ('2026-09-08-stock-availability-policy-v1','161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88'),
            ('2026-09-08-stock-ingredient-cutover-v1','a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a'),
            ('2026-09-08-stock-item-projections-v1','6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b'),
            ('2026-09-08-stock-procurement-v1','a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d'),
            ('2026-09-08-stock-adjustments-v1','24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc'),
            ('2026-07-23-admin-manual-subscriptions-v1','bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf'),
            ('2026-07-24-progressive-split-checks-v1','14178039d66459e3b898cd2038e5570df68edd714e31fb4fb9935ce7b765c3c4'),
            ('2026-07-24-jofotara-operations-v1','3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e'),
            ('2026-07-25-print-templates-v1','d5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07'),
            ('2026-07-29-subscription-receivables-v1','b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da'),
             ('2026-07-31-platform-held-order-settlement-v1','cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85'),
             ('2026-07-31-tax-exempt-checks-v1','6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3'),
             ('2026-08-01-additive-schema-reconciliation-v1','5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679'),
             ('2026-08-03-platform-provider-reconciliation-v1','21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999'),
             ('2026-08-04-jofotara-tax-categories-v1','dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41'),
             ('2026-08-04-special-source-buyer-snapshots-v1','084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244'),
             ('2026-08-05-service-charge-jofotara-tax-category-v1','9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678'),
             ('2026-08-08-settings-value-capacity-v1','ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff'),
             ('2026-08-09-imported-schema-drift-repair-v1','0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73'),
             ('2026-08-09-baseline-foreign-key-authority-v1','8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937'),
             ('2026-08-10-order-reference-authority-v1','da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35'),
             ('2026-08-10-legacy-permission-column-retirement-v1','d3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550'),
             ('2026-08-10-refund-status-reconciliation-v1','00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6'),
             ('2026-08-10-order-reference-index-authority-v1','8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d'),
             ('2026-08-10-held-order-lifecycle-v1','af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160'),
             ('2026-08-10-call-center-held-orders-v1','f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b'),
            ('2026-08-11-receipt-tax-display-v1','90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3'),
            ('2026-08-13-split-quantity-precision-v1','eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76'),
            ('2026-08-13-webauthn-registered-device-access-v1','20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'),
            ('2026-08-17-spooler-v2-agents-v1','e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985'),
            ('2026-08-23-audit-browser-preview-v1','e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af'),
            ('2026-08-30-jofotara-stale-submission-index-v1','5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed'),
            ('2026-08-31-pos-order-history-default-v1','862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b'),
            ('2026-09-01-product-price-override-lock-v1','e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8'),
            ('2026-09-01-fractional-stock-precision-v1','b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e'),
            ('2026-09-02-expense-zero-amount-v1','264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75'),
            ('2026-09-03-y-order-type-setting-v1','4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3')`);
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-ingredient-rebuild-v1','73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329'),('2026-09-08-stock-resolved-product-links-v1','c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301'),('2026-09-08-stock-report-backfill-v1','7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4'),('2026-09-08-stock-report-count-intervals-v1','6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4'),('2026-09-08-ingredient-working-balances-v1','bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84'),('2026-09-08-stock-report-daily-projection-v1','eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67'),('2026-09-08-procurement-request-integrity-v1','257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f')");
        await q("INSERT IGNORE INTO stock_report_backfill(source) VALUES ('orders'),('refunds'),('ingredient_movements'),('stock_operations')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-09-held-order-numbers-v1','be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-order-type-numbering-v1','91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-held-report-date-index-v1','46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-13-table-action-recovery-v1','00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-13-paid-split-parent-index-v1','ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-13-table-seating-v1','78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-14-deleted-table-items-v1','b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e')");
        await q("INSERT IGNORE INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-05-recipe-ledger-v1','9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb'),('2026-09-06-recipe-ledger-performance-v1','f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c'),('2026-09-07-ingredient-analysis-v1','e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60')");
        await q(`INSERT IGNORE INTO print_templates (document_type) VALUES ('receipt'), ('kitchen')`);

        const [[users]] = await q('SELECT COUNT(*) AS count FROM users');
        if (Number(users?.count || 0) === 0) {
            await q(`INSERT INTO users (user_number, name, role, admin_pin, is_active, xyz, table_access_scope)
                VALUES (?, ?, 'admin', NULL, 1, 0, 'all'),
                       (?, ?, 'programmer', NULL, 1, 0, 'all')`, [String(adminUserNumber), String(adminName).trim(), String(programmerUserNumber), String(programmerName).trim()]);
        }

        await q('FLUSH PRIVILEGES');
        await validate(conn);
        await q(`ALTER USER ${mysql.escape(adminUser)}@'localhost' IDENTIFIED BY ${mysql.escape(adminPassword)}`);
        return { baselineVersion: 1, schemaValid: true, baselineId: manifest.baseline.id };
    } finally {
        if (!executor) await conn.end();
    }
}

module.exports = { bootstrapDatabase, assertIdentifier, readVerifiedBaseline, normalizeSqlText };

function readConfig(configPath) {
    if (!configPath || !path.isAbsolute(configPath)) throw new Error('Config path must be absolute.');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (config.host !== '127.0.0.1') throw new Error('Database host must be loopback.');
    for (const key of ['adminPassword', 'appPassword', 'maintenancePassword']) {
        if (!String(config[key] || '').trim() || String(config[key]).includes('{{')) throw new Error(`Missing ${key}.`);
    }
    return config;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 2 || !['--check', '--config'].includes(args[0])) throw new Error('Usage: bootstrap-database.js --check|--config <absolute-json-path>');
        const config = readConfig(args[1]);
        readVerifiedBaseline();
        if (args[0] === '--check') process.stdout.write(JSON.stringify({ valid: true, baseline: 'posapp-fresh-baseline-v1' }) + '\n');
        else bootstrapDatabase(config).then((result) => process.stdout.write(JSON.stringify(result) + '\n')).catch((error) => { console.error(error.message); process.exitCode = 1; });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports.readConfig = readConfig;

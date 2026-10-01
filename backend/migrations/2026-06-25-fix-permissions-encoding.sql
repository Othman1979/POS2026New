-- Corrective migration: the catalog Arabic in 2026-06-25-permissions-model.sql was
-- mangled into mojibake on the live DB because it was applied via the Windows mysql.exe
-- client without --default-character-set=utf8mb4 (client defaulted to cp850, double-encoding
-- the UTF-8 bytes). This re-sets the text columns from the correct source values.
--
-- FK-safe: UPDATE only (DELETE/re-INSERT would cascade and wipe user_permissions grants).
-- Idempotent: re-running sets the same correct values.
--
-- APPLY THROUGH A UTF8MB4 CLIENT. Either:
--   node backend/migrations/apply-fix-permissions-encoding.js
-- or:
--   mysql --default-character-set=utf8mb4 -u root posapp < backend/migrations/2026-06-25-fix-permissions-encoding.sql

SET NAMES utf8mb4;

UPDATE permissions SET label='Checkout Orders',       label_ar='إتمام الطلبات',        description='Finalize an order and take payment.',               description_ar='إنهاء الطلب واستلام الدفع.'              WHERE perm_key='pos.checkout';
UPDATE permissions SET label='Hold Orders',           label_ar='تعليق الطلبات',        description='Park an order to retrieve and finish later.',        description_ar='تعليق الطلب لاسترجاعه لاحقاً.'           WHERE perm_key='pos.hold_orders';
UPDATE permissions SET label='Split Checks',          label_ar='تقسيم الفاتورة',       description='Split one bill into multiple checks.',               description_ar='تقسيم الفاتورة إلى عدة شيكات.'           WHERE perm_key='pos.split_checks';
UPDATE permissions SET label='Discount Button',       label_ar='زر الخصم',             description='Apply a percent or value discount.',                description_ar='تطبيق خصم نسبة أو قيمة.'                 WHERE perm_key='pos.discount';
UPDATE permissions SET label='Price Override Button', label_ar='تعديل السعر',          description='Manually override an item price.',                   description_ar='تعديل سعر الصنف يدوياً.'                 WHERE perm_key='pos.price_override';
UPDATE permissions SET label='Void Line Item',        label_ar='إلغاء صنف',            description='Remove or void a line item from the order.',        description_ar='إزالة أو إلغاء صنف من الطلب.'            WHERE perm_key='pos.void_item';
UPDATE permissions SET label='Void Printed Item',     label_ar='إلغاء صنف مطبوع',      description='Void an item already sent to the kitchen printer.',  description_ar='إلغاء صنف أُرسل إلى طابعة المطبخ.'       WHERE perm_key='pos.void_printed_item';
UPDATE permissions SET label='Tax Exempt Toggle',     label_ar='إعفاء ضريبي',          description='Mark a sale as tax exempt (zero tax).',             description_ar='تعليم الفاتورة كمعفاة من الضريبة.'        WHERE perm_key='pos.tax_exempt';
UPDATE permissions SET label='Reprint Receipt',       label_ar='إعادة طباعة الإيصال',  description='Reprint the last or a selected receipt.',            description_ar='إعادة طباعة آخر إيصال أو إيصال محدد.'    WHERE perm_key='pos.reprint_receipt';
UPDATE permissions SET label='View Orders',           label_ar='عرض الطلبات',          description='View and recall past and held orders.',             description_ar='عرض واسترجاع الطلبات السابقة والمعلقة.'   WHERE perm_key='orders.view';
UPDATE permissions SET label='Open Register',         label_ar='فتح الوردية',          description='Open a register shift with a starting float.',       description_ar='فتح وردية الصندوق برصيد ابتدائي.'        WHERE perm_key='shift.open';
UPDATE permissions SET label='Close Own Shift (Z)',   label_ar='إغلاق الوردية',        description='Close own shift and submit the cash count.',        description_ar='إغلاق الوردية وإدخال عدّ النقد.'          WHERE perm_key='shift.close';
UPDATE permissions SET label='Access Tables Page',    label_ar='دخول صفحة الطاولات',   description='View the floor plan and cash out table orders.',     description_ar='عرض مخطط الطاولات ودفع طلبات الطاولات.'   WHERE perm_key='tables.access';
UPDATE permissions SET label='View عجرم Page',         label_ar='عرض صفحة عجرم',        description='Placeholder — عجرم page not implemented yet.',        description_ar='عنصر نائب — صفحة عجرم غير منفذة بعد.'     WHERE perm_key='ajram.view';

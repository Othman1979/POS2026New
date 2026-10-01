-- 2026-09-14-permission-catalog-v2
-- Requires migration: 2026-09-14-table-access-scope-v1
-- Requires checksum: d468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919
-- Align permission descriptions with shared action rules; preserve grants and installation defaults.
SET NAMES utf8mb4;

INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
('pos.checkout', 'Checkout Orders', 'إتمام الطلبات', 'Finalize an order and take payment.', 'إنهاء الطلب واستلام الدفع.', 'pos', 10, 1, 1, 0),
('pos.hold_orders', 'Hold Orders', 'تعليق الطلبات', 'Park an order to retrieve and finish later.', 'تعليق الطلب لاسترجاعه لاحقاً.', 'pos', 20, 1, 1, 0),
('pos.split_checks', 'Split Checks', 'تقسيم الفاتورة', 'Split one bill into multiple checks.', 'تقسيم الفاتورة إلى عدة شيكات.', 'pos', 30, 1, 0, 0),
('pos.discount', 'Discount Button', 'زر الخصم', 'Apply a percent or value discount.', 'تطبيق خصم نسبة أو قيمة.', 'pos', 40, 1, 0, 1),
('pos.price_override', 'Price Override Button', 'تعديل السعر', 'Manually override an item price.', 'تعديل سعر الصنف يدوياً.', 'pos', 50, 1, 0, 1),
('pos.void_item', 'Cancel saved table items', 'إلغاء أصناف الطاولة المحفوظة', 'Cancel saved items or clear an unpaid table. After the guest bill is printed, also enable Cancel after bill print.', 'إلغاء أصناف محفوظة أو مسح طلب طاولة غير مدفوع. بعد طباعة الحساب، يلزم أيضاً تفعيل صلاحية الإلغاء بعد طباعة الحساب.', 'pos', 60, 1, 0, 1),
('pos.void_printed_item', 'Cancel after bill print', 'إلغاء بعد طباعة الحساب', 'Cancel saved table items after the guest bill is printed. Also requires Cancel saved table items.', 'إلغاء أصناف الطاولة المحفوظة بعد طباعة الحساب. يتطلب أيضاً صلاحية إلغاء أصناف الطاولة المحفوظة.', 'pos', 70, 1, 0, 1),
('pos.service_charge', 'Apply Service Charge', 'تطبيق رسوم الخدمة', 'Add the auto-gratuity service charge to an order.', 'إضافة رسوم الخدمة إلى الطلب.', 'pos', 85, 1, 0, 0),
('pos.reprint_receipt', 'Reprint Receipt', 'إعادة طباعة الإيصال', 'Reprint the last or a selected receipt.', 'إعادة طباعة آخر إيصال أو إيصال محدد.', 'pos', 90, 1, 0, 1),
('pos.expenses', 'Record Expenses', 'تسجيل المصروفات', 'Record an expense from the user\'s open cash shift.', 'تسجيل مصروف من وردية الصندوق المفتوحة للمستخدم.', 'pos', 95, 1, 0, 0),
('pos.product_availability', 'Manage Product Availability', 'إدارة توفر الأصناف', 'Mark products as sold out or return them to sale.', 'إيقاف بيع الأصناف النافدة أو إعادتها للبيع.', 'pos', 97, 1, 0, 0),
('pos.subscriptions', 'Manage Subscriptions', 'إدارة الاشتراكات', 'Sell subscriptions and redeem customer meals.', 'بيع الاشتراكات وصرف وجبات العملاء.', 'pos', 98, 1, 0, 1),
('pos.subscription_credit', 'Issue Subscription Credit', 'منح اشتراك آجل', 'Issue a subscription as a receivable invoice.', 'منح اشتراك كفاتورة ذمم آجلة.', 'pos', 99, 1, 0, 1),
('pos.tax_exempt', 'Tax Exempt', 'إعفاء ضريبي', 'Apply tax exemption to the current unpaid check.', 'تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.', 'pos', 100, 1, 0, 0),
('orders.view', 'POS Order History', 'سجل طلبات نقطة البيع', 'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.', 'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.', 'orders', 100, 1, 0, 0),
('shift.open', 'Open Register', 'فتح الوردية', 'Open a register shift with a starting float.', 'فتح وردية الصندوق برصيد ابتدائي.', 'shift', 110, 1, 1, 0),
('shift.close', 'Close Own Shift (Z)', 'إغلاق الوردية', 'Close own shift and submit the cash count.', 'إغلاق الوردية وإدخال عدّ النقد.', 'shift', 120, 1, 1, 0),
('tables.access', 'Enter tables', 'دخول الطاولات', 'Open the floor plan and view table orders in assigned sections. Saving and payment use separate permissions.', 'فتح مخطط الطاولات وعرض طلباتها ضمن الأقسام المسموحة. الحفظ والدفع لهما صلاحيات منفصلة.', 'tables', 130, 1, 0, 0),
('pos.refund', 'Refund paid orders', 'إرجاع طلبات مدفوعة', 'Return items or money from a paid order. Unpaid table cancellations use the item-void permissions.', 'إرجاع أصناف أو مبالغ من طلب مدفوع. إلغاء أصناف الطاولات غير المدفوعة يستخدم صلاحيات إلغاء الأصناف.', 'pos', 140, 1, 0, 0),
('waiter.edit_locked', 'Edit saved table orders', 'تعديل طلبات الطاولات المحفوظة', 'Add or change saved table items. Waiters also need this permission for their first save. Cancellations use separate permissions.', 'إضافة أصناف أو تعديلها في طلب طاولة محفوظ. يحتاج النادل هذه الصلاحية أيضاً للحفظ الأول. الإلغاء يحتاج صلاحيات منفصلة.', 'waiter', 200, 1, 0, 0),
('waiter.override_tables', 'Handle other employees’ tables', 'التعامل مع طاولات موظفين آخرين', 'Load or edit another employee’s table order, move its items, or create its split checks. Each action still requires its own permission.', 'فتح طلب طاولة موظف آخر أو تعديله أو نقل أصنافه أو تقسيم حسابه. تبقى صلاحية كل إجراء مطلوبة بشكل منفصل.', 'waiter', 210, 1, 0, 0),
('waiter.checkout', 'Take table payments as a waiter', 'استلام دفعات الطاولات كنادل', 'Let a waiter settle saved table orders and their split checks. Counter sales require Checkout Orders.', 'السماح للنادل بتحصيل طلبات الطاولات المحفوظة وحساباتها المقسمة. مبيعات الكاونتر تحتاج صلاحية إتمام الطلبات.', 'waiter', 220, 1, 0, 0),
('waiter.transfer_table', 'Move tables or items', 'نقل الطاولات أو الأصناف', 'Move a whole order to another table. Moving selected items also requires Edit saved table orders and access to the source order.', 'نقل الطلب كاملاً إلى طاولة أخرى. نقل أصناف محددة يتطلب أيضاً صلاحية تعديل طلبات الطاولات المحفوظة والوصول إلى الطلب الأصلي.', 'waiter', 230, 1, 0, 0),
('waiter.merge_tables', 'Join seating / merge bills', 'ضم الجلسات أو دمج الفواتير', 'Join tables into one seating group, separate them again, or combine unpaid bills. Joining seating keeps bills separate.', 'ضم الطاولات في جلسة واحدة أو فصلها، أو جمع الفواتير غير المدفوعة. ضم الجلسات يبقي الفواتير منفصلة.', 'waiter', 240, 1, 0, 0),
('tables.save', 'Save table orders', 'حفظ طلبات الطاولات', 'Let a cashier save a table order and send its items to the kitchen. Requires Enter tables.', 'السماح للكاشير بحفظ طلب الطاولة وإرسال أصنافه إلى المطبخ. يتطلب صلاحية دخول الطاولات.', 'tables', 135, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label),
  label_ar=VALUES(label_ar),
  description=VALUES(description),
  description_ar=VALUES(description_ar),
  category=VALUES(category),
  sort_order=VALUES(sort_order),
  implemented=VALUES(implemented);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-permission-catalog-v2', 'a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);

import { test, expect } from '@playwright/test';
import { SEED } from '../../../backend/tests/fixtures/seed.js';
import { reseedDatabase } from '../reseed.js';
import pool from '../../../backend/config/db.js';

test.describe('Admin Dashboard Workflows', () => {
  test.beforeEach(async () => {
    await reseedDatabase();
  });

  test('loads the dashboard and opens Inventory from the sidebar', async ({ page }) => {
    await page.goto('/admin/dashboard');

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tables right now' })).toBeVisible();

    await page.getByRole('link', { name: 'Inventory' }).click();

    await expect(page).toHaveURL(/\/admin\/inventory$/);
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search items, barcodes...' })).toBeVisible();
  });

  test('ages an interrupted JoFotara submission to review without retrying it', async ({ page }) => {
    const [[next]] = await pool.query('SELECT COALESCE(MAX(invoice_number), 8000) + 1 AS invoice_number FROM orders');
    const [unsubmitted] = await pool.query(
      `INSERT INTO orders
       (invoice_number, user_id, subtotal, tax, tax_inclusive_at_sale, tax_registration_type_at_sale, total, payment_method)
       VALUES (?, ?, 5.00, 0.80, 0, 'sales_tax', 5.80, 'cash')`,
      [next.invoice_number, SEED.adminUser.id]
    );

    await page.goto('/admin/dashboard');
    await page.getByRole('link', { name: 'JoFotara Operations' }).click();
    await expect(page).toHaveURL(/\/admin\/jofotara$/);
    await expect(page.getByRole('main').getByRole('heading', { name: 'JoFotara Operations' })).toBeVisible();
    await expect(page.getByText('JoFotara is disabled.', { exact: false })).toBeVisible();

    const unsubmittedRow = page.locator('article').filter({ hasText: String(next.invoice_number) });
    await expect(unsubmittedRow).toContainText('Not sent to JoFotara');
    await expect(unsubmittedRow.getByRole('checkbox', { name: 'Select document' })).toBeVisible();

    const [staleOrder] = await pool.query(
      `INSERT INTO orders
       (invoice_number, user_id, subtotal, tax, tax_inclusive_at_sale, tax_registration_type_at_sale, total, payment_method)
       VALUES (?, ?, 10.00, 1.60, 0, 'sales_tax', 11.60, 'card')`,
      [Number(next.invoice_number) + 1, SEED.adminUser.id]
    );
    await pool.query(
      `INSERT INTO jofotara_documents
       (source_key, order_invoice_id, document_kind, document_number, document_uuid, status,
        request_xml, response_body, attempt_count, last_attempt_at)
       VALUES (?, ?, 'invoice', 'stale-browser-doc', UUID(), 'submitting', '<private/>',
               'private-response', 1, DATE_SUB(NOW(), INTERVAL 3 MINUTE))`,
      [`invoice:${staleOrder.insertId}`, staleOrder.insertId]
    );

    await page.getByRole('button', { name: 'Recover automatic sales' }).click();

    const staleRow = page.locator('article').filter({ hasText: 'stale-browser-doc' });
    await expect(staleRow).toContainText('Needs review');
    await expect(staleRow).toContainText('Submission was interrupted');
    await expect(staleRow.getByRole('checkbox', { name: 'Select document' })).toHaveCount(0);

    const [[stored]] = await pool.query(
      'SELECT status, attempt_count FROM jofotara_documents WHERE order_invoice_id=?',
      [staleOrder.insertId]
    );
    expect(stored).toMatchObject({ status: 'unknown', attempt_count: 1 });
    const [[unsubmittedDocument]] = await pool.query(
      'SELECT COUNT(*) AS count FROM jofotara_documents WHERE order_invoice_id=?',
      [unsubmitted.insertId]
    );
    expect(Number(unsubmittedDocument.count)).toBe(0);
  });
});

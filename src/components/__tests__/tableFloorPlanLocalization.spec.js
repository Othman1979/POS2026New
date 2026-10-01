import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Table floor localization contract', () => {
  const componentSource = fs.readFileSync(
    path.resolve(__dirname, '../TableFloorPlan.vue'),
    'utf8'
  );
  const arabicCatalog = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), 'src/shared/i18n/ar.json'),
    'utf8'
  ));
  const arabicKeys = new Set(Object.keys(arabicCatalog));

  it('has an Arabic entry for every static table-page translation key', () => {
    const staticKeys = new Set(
      [...componentSource.matchAll(/\$t\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
    );
    expect([...staticKeys].filter((key) => !arabicKeys.has(key)).sort()).toEqual([]);
  });

  it('covers status, elapsed, fallback, navigation, and empty-search keys', () => {
    const dynamicKeys = [
      'Available',
      'Occupied',
      'Bill Printed',
      'Unknown',
      'Staff member',
      'min',
      'hr',
      'No section',
      'Table options',
      'Table status counts',
      'Navigation menu',
      'Close navigation menu',
      'Table actions',
      'No tables match your search.',
      'Try another table number or waiter name.'
    ];
    expect(dynamicKeys.filter((key) => !arabicKeys.has(key))).toEqual([]);
  });

  it('does not expose raw English status or elapsed fallbacks', () => {
    expect(componentSource).not.toContain("|| 'Staff'");
    expect(componentSource).not.toContain("return '0m'");
    expect(componentSource).not.toContain('$t(selectedActionTable?.status)');
  });

  it('keeps the Arabic visible-table count natural and distinct from the page title', () => {
    expect(componentSource).toContain("$t('tables')");
    expect(arabicCatalog.tables).toBe('طاولات');
  });
});

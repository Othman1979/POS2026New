import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../PosTerminal.vue'), 'utf8');
const terminalSource = readFileSync(resolve(process.cwd(), 'src/pos/useTerminal.js'), 'utf8');

describe('POS category-price refresh wiring', () => {
  it('does not let an obsolete table-context watcher reconfigure barcode input', () => {
    expect(source).toContain('tableContextRequestId');
    expect(source).toMatch(/if \(requestId !== tableContextRequestId\) return/);
  });

  it('routes barcode lookup through the live sales context', () => {
    expect(source).toContain('useTerminal({ salesContext: products.salesContext })');
    expect(terminalSource).toContain('sales_context=${lookupContext}');
    expect(terminalSource).toContain("salesContextRef.value !== lookupContext");
  });
});

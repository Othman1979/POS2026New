import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// These specs scrape the component source with regexes that anchor on a blank
// line. Shifts.vue is LF in git, but checks out as CRLF wherever autocrlf is on,
// and every such lookahead then silently fails to match.
const VUE = readFileSync(resolve(__dirname, '../Shifts.vue'), 'utf8').replace(/\r\n/g, '\n');
const I18N = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));

describe('Shifts.vue future-proofing', () => {
  it('T4: every Shifts report action uses the shared browser layout menu', () => {
    expect(VUE).toContain("import ReportPrintMenu from '../components/ReportPrintMenu.vue'");
    expect(VUE).toContain("import { useShiftReportPrint } from '../composables/useShiftReportPrint.js'");
    expect((VUE.match(/<ReportPrintMenu\b/g) || []).length).toBe(7);
    expect(VUE).toMatch(/@select="printShiftReport"/);
    expect(VUE).toMatch(/@select="layout => printAuditReport\(layout, 'x_audit'\)"/);
    expect(VUE).toMatch(/@select="layout => printAuditReport\(layout, 'z_audit'\)"/);
    expect(VUE).toMatch(/@select="printPeriodReport"/);
    expect(VUE).toMatch(/@select="printItemsReport"/);
    expect(VUE).toMatch(/@select="printYReport"/);
    expect(VUE).toMatch(/@select="reopenYArchive"/);
    for (const key of [
      'Reopen last Y',
      'Network error while preparing print preview.',
      'Could not prepare the shift report.',
      'Could not prepare audit report.',
      'Could not prepare period report.',
      'Could not prepare items report.',
      'Could not prepare Y report.',
      'Could not reopen Y report.',
    ]) expect(I18N).toHaveProperty(key);
  });

  it('T5: all three cash number inputs constrain to min="0"', () => {
    const numberInputs = VUE.match(/<input[^>]*type="number"[^>]*>/g) || [];
    expect(numberInputs.length).toBeGreaterThanOrEqual(3);
    for (const inp of numberInputs) {
      expect(inp).toMatch(/min="0"/);
    }
  });

  it('T6: Period toggle checkbox is focusable (sr-only, not display:none)', () => {
    const label = VUE.match(/<label[^>]*>\s*<input type="checkbox" v-model="isPeriodMode"[^>]*>/);
    expect(label).not.toBeNull();
    // the checkbox must not be display:none
    expect(VUE).not.toMatch(/<input type="checkbox" v-model="isPeriodMode" class="hidden"/);
    expect(VUE).toMatch(/<input type="checkbox" v-model="isPeriodMode" class="sr-only"/);
    // the label shows a focus ring when the control is focused
    expect(label[0]).toMatch(/focus-within:ring/);
  });

  it('T8: variance display goes through the varianceInfo() helper', () => {
    expect(VUE).toMatch(/const varianceInfo = \(v\) =>/);
    // used at all 3 render sites (multiple calls each)
    expect((VUE.match(/varianceInfo\(/g) || []).length).toBeGreaterThanOrEqual(6);
    // old duplicated branch removed from the template
    expect(VUE).not.toMatch(/v-else-if="shift\.variance > 0"/);
    expect(VUE).not.toMatch(/v-else-if="selectedShift\?\.variance > 0"/);
    // helper is exposed to the template
    expect(VUE).toMatch(/varianceInfo,/);
  });

  it('uses natural Arabic for the shift drawer explanation', () => {
    expect(I18N).toMatchObject({
      'Drawer cash calculation': 'حساب النقدية في الدرج',
      'Cash expenses paid from drawer': 'المصروفات المدفوعة من الدرج',
      'Cash received from sales': 'النقد المحصل من المبيعات',
      'Cash refunds paid from drawer': 'المرتجعات النقدية المدفوعة من الدرج',
      'Expense details': 'تفاصيل المصروفات',
      'Other shift totals': 'إجماليات أخرى للمناوبة',
      'Net sales after refunds': 'صافي المبيعات بعد المرتجعات',
      'Net sales before tax': 'صافي المبيعات قبل الضريبة',
      'Tax collected after refunds': 'الضريبة المحصلة بعد المرتجعات',
      'Platform Sales (Not collected)': 'مبيعات المنصات (غير محصلة في الدرج)',
      'Receivable Cash Collections': 'تحصيل ذمم الاشتراكات نقداً',
      'Receivable Card Collections (Not in drawer)': 'تحصيل ذمم الاشتراكات بالبطاقة (ليست في الدرج)',
      'Total Discounts': 'إجمالي الخصومات',
      'Closed At': 'وقت الإغلاق',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arabicCatalog = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));

describe('first-shift starting cash setting', () => {
  it('has Arabic labels for the setting', () => {
    expect(arabicCatalog['First-shift starting cash (JD)']).toBe('عهدة بداية أول المناوبات (د.أ)');
    expect(arabicCatalog['Prefills the first shifts of each business day. Cashiers can change it before opening.'])
      .toBe('تُعبّئ عهدة البداية لأول المناوبات في يوم العمل، ويمكن للكاشير تعديلها قبل الفتح.');
  });
});

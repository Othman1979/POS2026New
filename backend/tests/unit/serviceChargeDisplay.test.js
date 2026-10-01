import { beforeAll, describe, expect, it } from 'vitest';
import { prepareLanguage, t } from '@/shared/i18n.js';
import { serviceChargeDisplayName } from '../../../src/utils/serviceChargeDisplay.js';
import { serveArabicDictionary } from '../../../src/shared/__tests__/serveArabicDictionary.js';

describe('service-charge display name', () => {
  beforeAll(async () => {
    // The Arabic dictionary is a fetched asset at runtime; serve it from disk.
    serveArabicDictionary();
    expect(await prepareLanguage('ar')).toBe(true);
  });

  it('localizes the internal fee line without changing its canonical source name', () => {
    const fee = { name: '10% Service Charge', note: 'Auto-Gratuity' };

    expect(serviceChargeDisplayName(fee, key => t(key, 'en'))).toBe('10% Service Charge');
    expect(serviceChargeDisplayName(fee, key => t(key, 'ar'))).toBe('10% رسوم خدمة');
    expect(fee.name).toBe('10% Service Charge');
  });

  it('leaves ordinary product names unchanged', () => {
    expect(serviceChargeDisplayName(
      { name: 'Coffee', note: 'No sugar' },
      key => t(key, 'ar')
    )).toBe('Coffee');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../Users.vue'), 'utf8');

describe('Users.vue quality/hardening', () => {
  it('PIN input is constrained (maxlength 8, numeric)', () => {
    const tag = SRC.match(/<input[^>]*form\.user_number[^>]*>/)[0];
    expect(tag).toMatch(/maxlength="8"/);
    expect(tag).toMatch(/inputmode="numeric"/);
    expect(tag).toMatch(/pattern="\[0-9\]\*"/);
  });

  it('i18n has Arabic for the Users-page dynamic keys', () => {
    const I18N = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
    expect(I18N.Other).toBeTruthy();
    expect(I18N['User deactivated.']).toBeTruthy();
    expect(I18N['Failed to deactivate user.']).toBeTruthy();
  });

  it('setup() does not export the unused raw users ref', () => {
    const ret = SRC.match(/return \{[\s\S]*?\};\s*\n\s*\}\s*\n\}/)[0];
    expect(ret).not.toMatch(/\busers,/);
  });

  it('deleteUser does not send the redundant activeUserId field', () => {
    const fn = SRC.match(/const deleteUser = async \(id\) => \{[\s\S]*?\n        \};/)[0];
    expect(fn).not.toMatch(/activeUserId: activeUserId\.value/);
    expect(fn).toMatch(/JSON\.stringify\(\{ id: id \}\)/);
  });

  it('modal has dialog semantics and can close on backdrop click', () => {
    expect(SRC).toMatch(/role="dialog"/);
    expect(SRC).toMatch(/aria-modal="true"/);
    expect(SRC).toMatch(/aria-labelledby="userModalTitle"/);
    expect(SRC).toMatch(/id="userModalTitle"/);
    expect(SRC).toMatch(/@click\.self="showModal = false"/);
  });

  it('Escape closes the modal', () => {
    expect(SRC).toMatch(/const handleModalKeydown = \(e\) => \{[\s\S]*?Escape[\s\S]*?showModal\.value = false/);
    expect(SRC).toMatch(/window\.addEventListener\('keydown', handleModalKeydown\)/);
    expect(SRC).toMatch(/window\.removeEventListener\('keydown', handleModalKeydown\)/);
  });

  it('modal has an admin-only Manager Override PIN field', () => {
    expect(SRC).toMatch(/v-if="hasGodMode"/);
    expect(SRC).toMatch(/v-model="form\.admin_override_pin"/);
    expect(SRC).toMatch(/admin_override_pin: ''/);
  });

  it('exposes call center as a fixed role in desktop, mobile, filters, and the editor', () => {
    expect(SRC).toMatch(/\['admin', 'cashier', 'waiter', 'call_center'\]/);
    expect(SRC).toMatch(/<option value="call_center">\{\{ \$t\('Call Center'\) \}\}<\/option>/);
    expect((SRC.match(/user\.role === 'call_center'/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(SRC).toMatch(/const isFixedRole = computed\([\s\S]*?call_center/);
  });

  it('has natural Arabic labels for the fixed call-center role', () => {
    const I18N = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
    expect(I18N['Call Center']).toBe('مركز الاتصال');
    expect(I18N.call_center).toBe('مركز الاتصال');
    expect(I18N['Fixed role']).toBeTruthy();
  });

  it('every focus:outline-none also restores a visible focus-visible ring', () => {
    expect(SRC).not.toMatch(/focus:outline-none(?! focus-visible)/);
    expect(SRC).toMatch(/focus-visible:ring-2 focus-visible:ring-teal-500\/40/);
  });

  // <-- append new it() blocks above this line
});

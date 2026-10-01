const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const checkoutSource = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'pos', 'CheckoutModal.vue'),
  'utf8'
);
const posCss = fs.readFileSync(path.join(ROOT, 'src', 'pos.css'), 'utf8');

describe('checkout customer phone keypad', () => {
  it('toggles an accessible touch keypad that edits the existing customer phone value', () => {
    expect(checkoutSource).toContain('class="checkout-phone-keypad-toggle"');
    expect(checkoutSource).toContain(':aria-expanded="phoneKeypadOpen"');
    expect(checkoutSource).toContain('id="checkout-phone-keypad"');
    expect(checkoutSource).toContain('v-for="digit in phoneKeypadDigits"');
    expect(checkoutSource).toContain("customerPhone.value = `${customerPhone.value || ''}${digit}`;");
    expect(checkoutSource).toContain("customerPhone.value = String(customerPhone.value || '').slice(0, -1);");
    expect(checkoutSource).toContain('await lookupCustomer();');
    expect(posCss).toContain('.pos-polish .checkout-phone-keypad-sheet');
    expect(posCss).toContain('min-height: 3.25rem;');
    expect(posCss).toMatch(/\.checkout-customer-phone-actions\s*\{[^}]*inset-inline-end:\s*0;/s);
  });
});

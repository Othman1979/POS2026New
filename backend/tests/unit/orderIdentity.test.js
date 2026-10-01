const { buildOrderIdentity } = require('../../utils/orderIdentity');

describe('buildOrderIdentity table identity', () => {
  it('open table → table_display_no, no ticket/invoice', () => {
    const id = buildOrderIdentity({ invoice_number: null, order_id: null, table_number: 7 });
    expect(id.table_display_no).toBe('7');
    expect(id.ticket_display_no).toBeNull();
    expect(id.invoice_display_no).toBeNull();
  });
  it('paid order → invoice identity, no table_display_no', () => {
    const id = buildOrderIdentity({ invoice_number: 42, order_id: 3, table_number: 7 });
    expect(id.invoice_display_no).toBe('42');
    expect(id.table_display_no).toBeNull();
  });
  it('legacy open table with order_id → ticket, no table_display_no', () => {
    const id = buildOrderIdentity({ invoice_number: null, order_id: 99, table_number: 7 });
    expect(id.ticket_display_no).toBe('99');
    expect(id.table_display_no).toBeNull();
  });
});

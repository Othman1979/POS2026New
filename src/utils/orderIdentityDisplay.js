export const orderIdentityKind = (order) => {
  if (order?.invoice_display_no) return 'invoice';
  if (order?.ticket_display_no) return 'ticket';
  if (order?.table_display_no) return 'table';
  if (order?.order_display_no || order?.order_id) return 'order';
  return 'unknown';
};

export const orderIdentityValue = (order) =>
  order?.invoice_display_no ||
  order?.ticket_display_no ||
  order?.table_display_no ||
  order?.order_display_no ||
  (order?.order_id == null ? '' : String(order.order_id)) ||
  '';

export const orderIdentityLabel = (order, t = (value) => value) => {
  const value = orderIdentityValue(order);
  if (!value) return t('Internal ID hidden');
  if (order?.invoice_display_no) return `${t('INV-')}${value}`;
  if (order?.ticket_display_no) return `${t('Ticket-')}${value}`;
  if (order?.table_display_no) return `${t('Table-')}${value}`;
  return `${t('Order-')}${value}`;
};

export const orderIdentityTitleKey = (order) => {
  const kind = orderIdentityKind(order);
  if (kind === 'invoice') return 'Invoice #';
  if (kind === 'ticket') return 'Ticket #';
  if (kind === 'table') return 'Table #';
  if (kind === 'order') return 'Order #';
  return 'Identity';
};

export const orderIdentityTitle = (order, t = (value) => value) =>
  t(orderIdentityTitleKey(order));

export const orderIdentityCopyMessage = (order, t = (value) => value) =>
  order?.invoice_display_no
    ? t('Invoice number copied to clipboard!')
    : order?.table_display_no
    ? t('Table number copied to clipboard!')
    : t('Ticket number copied to clipboard!');

export const internalInvoiceId = (order) => order?.invoice_id;

const SERVICE_NOTE = 'Auto-Gratuity';
const CANONICAL_NAME = /^(.+?)%\s+Service Charge$/;

// The persisted English name is server-canonical. Localize it only at display time.
export function serviceChargeDisplayName(item, translate = value => value) {
  const name = String(item?.name ?? '');
  if (item?.note !== SERVICE_NOTE) return name;

  const percentage = name.match(CANONICAL_NAME)?.[1];
  return percentage ? `${percentage}% ${translate('Service Charge')}` : translate('Service Charge');
}

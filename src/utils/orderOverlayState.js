export const topmostDismissibleOrderLayer = ({
  details = false,
  delivery = false,
  refund = false,
  summary = false
} = {}) => {
  if (refund) return 'refund';
  if (delivery) return 'delivery';
  if (summary) return 'summary';
  if (details) return 'details';
  return null;
};

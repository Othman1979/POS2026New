export const getDefaultOrderTypeId = (orderTypes = []) => (
    orderTypes.find(type => type.is_default === true || Number(type.is_default) === 1)?.id ?? null
);

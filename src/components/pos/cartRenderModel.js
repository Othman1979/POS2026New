const COURSE_LEVELS = Object.freeze([null, 1, 2, 3, 4, 5]);

const presentationIndex = (rows) => {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!byKey.has(row?.key)) byKey.set(row?.key, row);
  }
  return byKey;
};

export const buildCartRenderModel = ({
  cartItems = [],
  presentationRows = [],
  hideAutomaticServiceCharge = false,
  getGrossTotal = () => 0,
  getDisplayName = item => String(item?.name || ''),
} = {}) => {
  const presentations = presentationIndex(presentationRows);
  const rowsByCourse = new Map(COURSE_LEVELS.map(courseLevel => [courseLevel, []]));

  for (let index = 0; index < cartItems.length; index += 1) {
    const item = cartItems[index];
    if (hideAutomaticServiceCharge && item?.note === 'Auto-Gratuity') continue;
    const courseLevel = item?.course ? item.course.id : null;
    const courseRows = rowsByCourse.get(courseLevel);
    if (!courseRows) continue;

    const key = String(item?.key ?? item?.cartId ?? `row-${index}`);
    const presentation = presentations.get(key) || null;
    courseRows.push({
      item,
      index,
      key,
      presentation,
      displayName: getDisplayName(item),
      noteLines: String(item?.note || '').split('\n').filter(Boolean),
      netAmount: presentation?.netAmount ?? (parseFloat(item?.price) * Number(item?.qty || 0)),
      grossTotal: getGrossTotal(item),
    });
  }

  return {
    groups: COURSE_LEVELS
      .map(courseLevel => ({ courseLevel, rows: rowsByCourse.get(courseLevel) }))
      .filter(group => group.rows.length > 0),
  };
};

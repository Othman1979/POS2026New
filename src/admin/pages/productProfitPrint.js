const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function buildProductProfitPrintHtml({ report, products, t, rtl, money, number, percent, sourceLabel }) {
    const { period, totals } = report;
    const range = period.start_date === period.end_date ? period.start_date : `${period.start_date} → ${period.end_date}`;
    const loss = (value) => (value < 0 ? ' class="loss"' : '');
    const rows = products.map(row => `
        <tr>
            <td><strong>${escapeHtml(row.item_name)}</strong>${row.category_name ? `<small>${escapeHtml(row.category_name)}</small>` : ''}</td>
            <td class="num">${escapeHtml(number(row.sold_qty))}</td>
            <td class="num">${row.returned_qty > 0 ? escapeHtml(number(row.returned_qty)) : '-'}</td>
            <td class="num">${escapeHtml(number(row.net_qty))}</td>
            <td class="num">${escapeHtml(money(row.net_sales))}</td>
            <td class="num">${row.unit_cost === null ? '—' : escapeHtml(number(row.unit_cost, { maximumFractionDigits: 4 }))}<small>${escapeHtml(t(sourceLabel[row.cost_source]))}</small></td>
            <td class="num">${escapeHtml(money(row.cost))}</td>
            <td class="num"${loss(row.profit)}><strong>${escapeHtml(money(row.profit))}</strong></td>
            <td class="num"${loss(row.margin_pct)}>${escapeHtml(percent(row.margin_pct))}</td>
        </tr>`).join('');

    return `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${t('Product profit')} ${range}`)}</title>
<style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #27272a; font: 12px/1.5 Tahoma, "Segoe UI", Arial, sans-serif; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #24405e; padding-bottom: 8px; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 20px; }
    header span { color: #52525b; font-weight: 700; }
    .totals { display: flex; gap: 10px; margin-bottom: 10px; }
    .totals div { flex: 1; border: 1px solid #d4d4d8; border-radius: 6px; padding: 8px 10px; }
    .totals label { display: block; color: #71717a; font-size: 11px; }
    .totals strong { font-size: 16px; }
    .note { color: #71717a; font-size: 10px; margin: 0 0 10px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f4f4f5; color: #52525b; font-size: 10px; text-align: start; }
    th, td { border-bottom: 1px solid #e4e4e7; padding: 6px 8px; vertical-align: top; }
    .num { text-align: end; white-space: nowrap; }
    td small { display: block; color: #71717a; font-size: 9px; }
    tfoot td { border-top: 2px solid #a1a1aa; font-weight: 700; background: #fafafa; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; }
    .loss { color: #be123c; }
</style>
</head>
<body>
    <header><h1>${escapeHtml(t('Product profit'))}</h1><span dir="ltr">${escapeHtml(range)}</span></header>
    <section class="totals">
        <div><label>${escapeHtml(t('Gross profit'))}</label><strong${loss(totals.profit)}>${escapeHtml(money(totals.profit))}</strong></div>
        <div><label>${escapeHtml(t('Net sales before tax'))}</label><strong>${escapeHtml(money(totals.net_sales))}</strong></div>
        <div><label>${escapeHtml(t('Cost of goods sold'))}</label><strong>${escapeHtml(money(totals.known_cost))}</strong></div>
        <div><label>${escapeHtml(t('Margin'))}</label><strong>${escapeHtml(percent(totals.margin_pct))}</strong></div>
    </section>
    <p class="note">${escapeHtml(t('Profit = net sales before tax − sold quantity × weighted average purchase cost. The average uses all posted purchase invoices up to the end of the period.'))}</p>
    <table>
        <thead><tr>
            <th>${escapeHtml(t('Product'))}</th><th class="num">${escapeHtml(t('Sold'))}</th><th class="num">${escapeHtml(t('Returned'))}</th>
            <th class="num">${escapeHtml(t('Net qty'))}</th><th class="num">${escapeHtml(t('Net sales before tax'))}</th>
            <th class="num">${escapeHtml(t('Average unit cost'))}</th><th class="num">${escapeHtml(t('Cost of goods sold'))}</th>
            <th class="num">${escapeHtml(t('Profit'))}</th><th class="num">${escapeHtml(t('Margin'))}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="9">${escapeHtml(t('No sales in this period.'))}</td></tr>`}</tbody>
        <tfoot><tr>
            <td>${escapeHtml(t('Total'))}</td><td></td><td></td><td></td>
            <td class="num">${escapeHtml(money(totals.net_sales))}</td><td></td>
            <td class="num">${escapeHtml(money(totals.known_cost))}</td>
            <td class="num"${loss(totals.profit)}>${escapeHtml(money(totals.profit))}</td>
            <td class="num">${escapeHtml(percent(totals.margin_pct))}</td>
        </tr></tfoot>
    </table>
</body>
</html>`;
}

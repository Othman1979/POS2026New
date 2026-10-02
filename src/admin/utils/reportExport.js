// Excel and PDF export for any report screen, read from what the screen shows:
// section titles, tables (one spreadsheet row per table row) and label/value lists.
const BLOCKS = 'h2, h3, table, dl, .report-metric-label';
const NUMERIC = /^[-+]?\d[\d,]*(\.\d+)?%?$/;

function cellText(cell) {
    const copy = cell.cloneNode(true);
    copy.querySelectorAll('button, input, select, .sr-only, [aria-hidden="true"]').forEach(node => node.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
}

function cellValue(text) {
    const plain = text.replace(/^JD\s*/i, '').trim();
    if (!NUMERIC.test(plain) || plain.endsWith('%')) return text;
    const value = Number(plain.replace(/,/g, ''));
    return Number.isFinite(value) ? value : text;
}

function isHidden(node) {
    return Boolean(node.closest('.print\\:hidden, [hidden], dialog:not([open])'));
}

export function reportRows(root) {
    const rows = [];
    if (!root) return rows;
    for (const block of root.querySelectorAll(BLOCKS)) {
        if (isHidden(block) || (block.tagName !== 'TABLE' && block.closest('table'))) continue;
        if (block.tagName === 'TABLE') {
            for (const tr of block.querySelectorAll('tr')) {
                if (tr.closest('table') !== block) continue;
                const cells = [...tr.children].filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH').map(cell => cellValue(cellText(cell)));
                if (cells.some(value => value !== '')) rows.push(cells);
            }
            rows.push([]);
        } else if (block.tagName === 'DL') {
            for (const term of block.querySelectorAll('dt')) {
                const value = term.nextElementSibling?.tagName === 'DD' ? cellText(term.nextElementSibling) : '';
                rows.push([cellText(term), cellValue(value)]);
            }
            rows.push([]);
        } else if (block.classList.contains('report-metric-label')) {
            const value = block.parentElement?.querySelector('strong, .report-metric-value');
            rows.push([cellText(block), value ? cellValue(cellText(value)) : '']);
        } else {
            const title = cellText(block);
            if (title) rows.push([title]);
        }
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return rows;
}

export async function exportReportExcel(root, { title, period, fileBase, rtl }) {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([[title], [period], [], ...reportRows(root)]);
    const widest = [];
    for (const row of reportRows(root)) row.forEach((value, index) => { widest[index] = Math.max(widest[index] || 10, Math.min(60, String(value).length + 2)); });
    sheet['!cols'] = widest.map(wch => ({ wch }));
    const workbook = XLSX.utils.book_new();
    if (rtl) workbook.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(workbook, sheet, String(title).slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Report');
    XLSX.writeFile(workbook, `${fileBase}.xlsx`);
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function reportPrintHtml(root, { title, period, rtl, styles = '' }) {
    return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${styles}
<style>
@page { size: A4; margin: 12mm; }
body { margin: 0; background: #fff; color: #18181b; font-family: system-ui, "Segoe UI", Tahoma, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.report-export-head { margin-bottom: 12px; border-bottom: 2px solid #18181b; padding-bottom: 6px; }
.report-export-head h1 { margin: 0; font-size: 20px; }
.report-export-head p { margin: 4px 0 0; color: #52525b; font-size: 12px; }
button, input, select, nav, .print\\:hidden { display: none !important; }
table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
tr { page-break-inside: avoid; }
* { max-height: none !important; overflow: visible !important; animation: none !important; transition: none !important; }
</style></head><body><header class="report-export-head"><h1>${escapeHtml(title)}</h1><p dir="ltr">${escapeHtml(period)}</p></header>${root ? root.innerHTML : ''}</body></html>`;
}

export function printReportPdf(root, { title, period, rtl }) {
    const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map(node => node.outerHTML).join('');
    printHtml(reportPrintHtml(root, { title, period, rtl, styles }));
}

// Data-driven variants for screens that page their rows: the caller passes every row, not the visible page.
export async function exportTableExcel(header, rows, { title, period, fileBase, rtl }) {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([[title], [period], [], header, ...rows]);
    sheet['!cols'] = header.map((label, index) => ({
        wch: Math.min(60, Math.max(10, String(label).length + 2, ...rows.map(row => String(row[index] ?? '').length + 2))),
    }));
    const workbook = XLSX.utils.book_new();
    if (rtl) workbook.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(workbook, sheet, String(title).slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Report');
    XLSX.writeFile(workbook, `${fileBase}.xlsx`);
}

export function tableReportHtml(header, rows, { title, period, rtl, numeric = [], footer = '' }) {
    const align = index => (numeric.includes(index) ? ' class="num"' : '');
    const head = header.map((label, index) => `<th${align(index)}>${escapeHtml(label)}</th>`).join('');
    const body = rows.map(row => `<tr>${row.map((value, index) => `<td${align(index)}>${escapeHtml(value ?? '')}</td>`).join('')}</tr>`).join('');
    return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 12mm; }
body { margin: 0; color: #18181b; font: 12px system-ui, "Segoe UI", Tahoma, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #18181b; padding-bottom: 6px; margin-bottom: 10px; }
h1 { margin: 0; font-size: 18px; }
header p { margin: 0; color: #52525b; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th { background: #f4f4f5; font-weight: 700; }
th, td { border: 1px solid #d4d4d8; padding: 5px 8px; text-align: start; }
tbody tr:nth-child(even) td { background: #fafafa; }
tr { page-break-inside: avoid; }
.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
footer { margin-top: 8px; color: #52525b; }
</style></head><body><header><h1>${escapeHtml(title)}</h1><p dir="ltr">${escapeHtml(period)}</p></header>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${footer ? `<footer>${escapeHtml(footer)}</footer>` : ''}</body></html>`;
}

export function printHtml(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px';
    frame.srcdoc = html;
    frame.onload = () => {
        const view = frame.contentWindow;
        view.addEventListener('afterprint', () => frame.remove(), { once: true });
        setTimeout(() => { view.focus(); view.print(); }, 300);
    };
    document.body.appendChild(frame);
}

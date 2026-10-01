import { t } from '@/shared/i18n.js';

// The server returns the same compiled, escaped receipt used by the spooler.
export async function printHeldCustomerReceipt(receipt) {
  if (!receipt) return true;
  if (receipt.mode === 'backend') return true;
  if (receipt.mode === 'unavailable') {
    window.showPosToast?.(t('Order saved. Customer receipt was not printed. Check the receipt printer settings.'), 'error');
    return false;
  }
  const artifact = receipt.data?.compiled_document_v1;
  if (!artifact?.html || typeof artifact.css !== 'string') throw new Error('Held receipt is missing its print layout.');
  const frame = document.createElement('iframe');
  frame.title = t('Print Receipt');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:1px;border:0';
  const cleanup = () => {
    window.removeEventListener('pagehide', cleanup);
    frame.remove();
  };
  window.addEventListener('pagehide', cleanup, {once:true});
  try {
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = reject;
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${artifact.css}@page{size:80mm auto;margin:4mm}html,body{margin:0}@media print{html{zoom:0.47244}}</style></head><body>${artifact.html}</body></html>`;
      document.body.appendChild(frame);
    });
    await frame.contentDocument.fonts?.ready;
    frame.contentWindow.addEventListener('afterprint', cleanup, {once:true});
    frame.contentWindow.focus();
    frame.contentWindow.print();
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}

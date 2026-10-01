import { createCatalogTemplate, inspectCatalogWorkbook } from './catalogWorkbookOperations.js';

self.onmessage = ({ data }) => {
  try {
    if (data?.type === 'inspect') {
      self.postMessage({ ok: true, result: inspectCatalogWorkbook(data.buffer) });
      return;
    }

    if (data?.type === 'template') {
      const buffer = createCatalogTemplate();
      self.postMessage({ ok: true, result: buffer }, [buffer]);
      return;
    }

    throw new Error('Unknown workbook operation');
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

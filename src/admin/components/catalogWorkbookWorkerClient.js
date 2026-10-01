function defaultWorkerFactory() {
  return new Worker(new URL('./catalogWorkbook.worker.js', import.meta.url), { type: 'module' });
}

export function startCatalogWorkbookTask(message, transfer = [], workerFactory = defaultWorkerFactory) {
  const worker = workerFactory();
  let settled = false;
  let rejectTask;

  const finish = () => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };

  const promise = new Promise((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = ({ data }) => {
      if (settled) return;
      settled = true;
      finish();
      if (data?.ok) resolve(data.result);
      else reject(new Error(data?.error || 'Workbook operation failed'));
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      finish();
      reject(new Error('Workbook worker failed'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      finish();
      reject(new Error('Workbook worker returned an unreadable response'));
    };

    try {
      worker.postMessage(message, transfer);
    } catch (error) {
      settled = true;
      finish();
      reject(error);
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      finish();
      rejectTask(new DOMException('Workbook operation cancelled', 'AbortError'));
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import { startCatalogWorkbookTask } from '../catalogWorkbookWorkerClient.js';

function fakeWorker() {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
}

describe('catalog workbook worker client', () => {
  it('transfers the workbook buffer and terminates after success', async () => {
    const worker = fakeWorker();
    const buffer = new ArrayBuffer(8);
    const task = startCatalogWorkbookTask({ type: 'inspect', buffer }, [buffer], () => worker);

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'inspect', buffer }, [buffer]);
    worker.onmessage({ data: { ok: true, result: { kind: 'template' } } });

    await expect(task.promise).resolves.toEqual({ kind: 'template' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates and rejects worker failures', async () => {
    const worker = fakeWorker();
    const task = startCatalogWorkbookTask({ type: 'inspect', buffer: new ArrayBuffer(0) }, [], () => worker);
    worker.onerror();

    await expect(task.promise).rejects.toThrow('Workbook worker failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates when workbook processing reports an error', async () => {
    const worker = fakeWorker();
    const task = startCatalogWorkbookTask({ type: 'inspect', buffer: new ArrayBuffer(0) }, [], () => worker);
    worker.onmessage({ data: { ok: false, error: 'empty workbook' } });

    await expect(task.promise).rejects.toThrow('empty workbook');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates cancellation and ignores late worker messages', async () => {
    const worker = fakeWorker();
    const task = startCatalogWorkbookTask({ type: 'template' }, [], () => worker);
    const lateHandler = worker.onmessage;
    task.cancel();
    lateHandler({ data: { ok: true, result: new ArrayBuffer(1) } });

    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

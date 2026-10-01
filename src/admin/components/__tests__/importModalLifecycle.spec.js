import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJsonResponse: vi.fn(),
  startTask: vi.fn(),
}));

vi.mock('@/shared/http.js', () => ({ fetchJsonResponse: mocks.fetchJsonResponse }));
vi.mock('@/shared/i18n.js', () => ({ t: (value) => value }));
vi.mock('../catalogWorkbookWorkerClient.js', () => ({ startCatalogWorkbookTask: mocks.startTask }));

import { createImportModalState } from '../ImportModal.vue';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function file(name, bufferPromise) {
  return { name, size: 10, arrayBuffer: () => bufferPromise };
}

function createState() {
  let cleanup;
  const state = createImportModalState(vi.fn(), (handler) => {
    cleanup = handler;
  });
  return { state, cleanup: () => cleanup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { showAdminAlert: vi.fn() });
});

describe('catalog import selection lifecycle', () => {
  it('clears an earlier pending file when an invalid replacement is selected and blocks direct submit', async () => {
    const firstBuffer = deferred();
    const first = file('legacy.xlsx', firstBuffer.promise);
    const { state } = createState();

    const firstSelection = state.handleFileSelected({ target: { files: [first] } });
    expect(state.selectedFile.value.name).toBe(first.name);
    expect(state.inspectionPending.value).toBe(true);

    await state.handleFileSelected({ target: { files: [file('invalid.csv', Promise.resolve(new ArrayBuffer(1)))] } });
    expect(state.selectedFile.value).toBeNull();
    expect(state.legacyMapping.value).toBeNull();
    expect(state.columnOptions.value).toEqual([]);
    expect(state.inspectionPending.value).toBe(false);

    await state.startImport();
    expect(mocks.fetchJsonResponse).not.toHaveBeenCalled();

    firstBuffer.resolve(new ArrayBuffer(4));
    await firstSelection;
    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(state.selectedFile.value).toBeNull();
  });

  it.each([
    ['clear', ({ state }) => state.clearFile()],
    ['unmount', ({ cleanup }) => cleanup()],
  ])('ignores an arrayBuffer that resolves after %s', async (_label, cancel) => {
    const pendingBuffer = deferred();
    const context = createState();
    const selection = context.state.handleFileSelected({
      target: { files: [file('pending.xlsx', pendingBuffer.promise)] },
    });

    cancel(context);
    pendingBuffer.resolve(new ArrayBuffer(2));
    await selection;

    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(context.state.inspectionPending.value).toBe(false);
  });

  it('lets a valid replacement win when the earlier arrayBuffer resolves last', async () => {
    const firstBuffer = deferred();
    const secondBuffer = new ArrayBuffer(8);
    const inspection = {
      kind: 'legacy',
      mapping: { name: 0, price: 1, category: null, tax: null },
      columns: [{ index: 0, samples: ['Second'] }, { index: 1, samples: ['2'] }],
    };
    mocks.startTask.mockReturnValue({ promise: Promise.resolve(inspection), cancel: vi.fn() });
    const { state } = createState();

    const firstSelection = state.handleFileSelected({
      target: { files: [file('first.xlsx', firstBuffer.promise)] },
    });
    const second = file('second.xlsx', Promise.resolve(secondBuffer));
    await state.handleFileSelected({ target: { files: [second] } });
    firstBuffer.resolve(new ArrayBuffer(4));
    await firstSelection;

    expect(mocks.startTask).toHaveBeenCalledOnce();
    expect(mocks.startTask).toHaveBeenCalledWith({ type: 'inspect', buffer: secondBuffer }, [secondBuffer]);
    expect(state.selectedFile.value.name).toBe(second.name);
    expect(state.legacyMapping.value).toEqual(inspection.mapping);
    expect(state.columnOptions.value).toEqual([
      { index: 0, label: 'A — Second' },
      { index: 1, label: 'B — 2' },
    ]);
  });

  it('blocks direct submit while inspection is pending', async () => {
    const pendingBuffer = deferred();
    const { state } = createState();
    const selection = state.handleFileSelected({
      target: { files: [file('pending.xlsx', pendingBuffer.promise)] },
    });

    await state.startImport();
    expect(mocks.fetchJsonResponse).not.toHaveBeenCalled();

    state.clearFile();
    pendingBuffer.resolve(new ArrayBuffer(1));
    await selection;
  });
});

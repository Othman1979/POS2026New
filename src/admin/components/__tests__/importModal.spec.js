import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  fetchJsonResponse: vi.fn(),
  startTask: vi.fn(),
}));

vi.mock('@/shared/http.js', () => ({ fetchJsonResponse: mocks.fetchJsonResponse }));
vi.mock('@/shared/i18n.js', () => ({ t: (value) => value }));
vi.mock('../catalogWorkbookWorkerClient.js', () => ({ startCatalogWorkbookTask: mocks.startTask }));

import { createImportModalState } from '../ImportModal.vue';

async function stateWithTemplateWorkbook() {
  mocks.startTask.mockReturnValue({ promise: Promise.resolve({ kind: 'template' }), cancel: vi.fn() });
  const state = createImportModalState(vi.fn(), () => {});
  await state.handleFileSelected({ target: { files: [new File(['catalog'], 'catalog.xlsx')] } });
  return state;
}

function sentFields() {
  expect(mocks.fetchJsonResponse).toHaveBeenCalledOnce();
  const [url, { method, body }] = mocks.fetchJsonResponse.mock.calls[0];
  return { url, method, mode: body.get('mode'), confirmReplace: body.get('confirm_replace') };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchJsonResponse.mockResolvedValue({ response: { ok: true }, data: { success: true } });
  vi.stubGlobal('window', { showAdminAlert: vi.fn() });
});

describe('Catalog import modal', () => {
  it('maps headerless legacy workbooks without changing the template workflow', () => {
    const source = readFileSync(resolve(__dirname, '../ImportModal.vue'), 'utf8');
    const operations = readFileSync(resolve(__dirname, '../catalogWorkbookOperations.js'), 'utf8');
    expect(source).toContain('legacyMapping');
    expect(source).toContain('columnOptions');
    expect(operations).toContain("const LEGACY_MAPPING = { name: 0, price: 1, category: 12, tax: 15 }");
    expect(source).toContain("formData.append('mapping'");
    expect(source).not.toContain("from 'xlsx'");
    expect(operations).not.toContain('sheet_to_json');
    expect(source).toContain(':aria-busy="inspectionPending"');
    expect(source).toContain("startCatalogWorkbookTask({ type: 'inspect', buffer }, [buffer])");
    expect(source).toContain('registerCleanup(() =>');
  });

  it('sends nothing in replace mode until the admin confirms the replacement', async () => {
    const state = await stateWithTemplateWorkbook();
    state.importMode.value = 'replace';

    await state.startImport();
    expect(mocks.fetchJsonResponse).not.toHaveBeenCalled();

    state.replacementConfirmed.value = true;
    await state.startImport();
    expect(sentFields()).toEqual({ url: '/api/admin/import/catalog', method: 'POST', mode: 'replace', confirmReplace: '1' });
  });

  it('sends nothing while a legacy workbook maps two fields to the same column', async () => {
    mocks.startTask.mockReturnValue({ promise: Promise.resolve({ kind: 'legacy', mapping: { name: 0, price: 0, category: 12, tax: 15 }, columns: [] }), cancel: vi.fn() });
    const state = createImportModalState(vi.fn(), () => {});
    await state.handleFileSelected({ target: { files: [new File(['catalog'], 'catalog.xlsx')] } });

    await state.startImport();

    expect(mocks.fetchJsonResponse).not.toHaveBeenCalled();
  });

  it('appends without sending a replacement confirmation', async () => {
    const state = await stateWithTemplateWorkbook();

    await state.startImport();

    expect(sentFields()).toEqual({ url: '/api/admin/import/catalog', method: 'POST', mode: 'append', confirmReplace: null });
  });
});

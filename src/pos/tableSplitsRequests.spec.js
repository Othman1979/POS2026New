import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableOrderWorkflow } from './stores/orderSession/tableOrderWorkflow.js';
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function harness() {
  const pending = [];
  const api = { getTableSplits: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))) };
  const ui = {};
  const workflow = createTableOrderWorkflow({ api, ui, readOrderDraft: () => ({}), getActor: () => ({ user: { id: 1 } }), can: () => false });
  const complete = (index, id, overrides = {}) => pending[index].resolve({ response: { ok: true }, data: { success: true, data: [{ id, total: 25 }] }, ...overrides });
  return { pending, api, ui, workflow, complete };
}

describe('split-list refresh ownership', () => {
  it('queues the latest bill scope and never publishes a late previous-board response', async () => {
    const { api, workflow, complete } = harness();
    const first = workflow.fetchTableSplits({ parentInvoiceId: '101' });
    await Promise.resolve();
    expect(api.getTableSplits).toHaveBeenLastCalledWith('101');
    const second = workflow.fetchTableSplits({ parentInvoiceId: '202', force: false });
    const latest = workflow.fetchTableSplits({ parentInvoiceId: '303', force: false });
    complete(0, 1); await first;
    expect(workflow.tableSplitsList.value).toEqual([]);
    await vi.waitFor(() => expect(api.getTableSplits).toHaveBeenCalledTimes(2));
    expect(api.getTableSplits).toHaveBeenLastCalledWith('303');
    complete(1, 3); await Promise.all([second, latest]);
    expect(workflow.tableSplitsList.value).toEqual([{ id: 3, total: 25 }]);
    const all = workflow.fetchTableSplits({ parentInvoiceId: null });
    expect(workflow.tableSplitsList.value).toEqual([]);
    await Promise.resolve(); expect(api.getTableSplits).toHaveBeenLastCalledWith(null);
    complete(2, 4); await all;
  });

  it('shares ordinary concurrent reads without duplicating the snapshot', async () => {
    const { api, workflow, complete } = harness();
    const first = workflow.fetchTableSplits({ force: false });
    const second = workflow.fetchTableSplits({ force: false });
    await Promise.resolve();
    expect(api.getTableSplits).toHaveBeenCalledTimes(1);
    complete(0, 1);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it('keeps an obsolete scope failure out of the new board and retries only its selected bill', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, workflow, pending, complete, ui } = harness();
    const old = workflow.fetchTableSplits({ parentInvoiceId: 101 });
    await Promise.resolve();
    const selected = workflow.fetchTableSplits({ parentInvoiceId: 202 });
    pending[0].reject(new Error('Old request lost'));
    expect(await old).toBe(false);
    expect(ui.tableSplitsError).toBe('');
    await vi.waitFor(() => expect(api.getTableSplits).toHaveBeenCalledTimes(2));
    complete(1, 2, { response: { ok: false } });
    expect(await selected).toBe(false);
    expect(workflow.tableSplitsList.value).toEqual([]);
    const retry = workflow.fetchTableSplits();
    await Promise.resolve(); expect(api.getTableSplits).toHaveBeenLastCalledWith('202');
    complete(2, 3); expect(await retry).toBe(true);
    expect(ui.tableSplitsError).toBe('');
  });

  it('queues one final fresh read for notifications/mutations during the current read', async () => {
    const { api, workflow, complete } = harness();
    workflow.activeTable.value = { id: 8, is_split: true, current_order_id: 88 };
    const first = workflow.fetchTableSplits();
    const forced = Array.from({ length: 10 }, () => workflow.fetchTableSplits());
    await Promise.resolve();
    expect(api.getTableSplits).toHaveBeenCalledTimes(1);
    complete(0, 1);
    await first;
    await vi.waitFor(() => expect(api.getTableSplits).toHaveBeenCalledTimes(2));
    complete(1, 2);
    expect(await Promise.all(forced)).toEqual(Array(10).fill(true));
    expect(workflow.tableSplitsList.value).toEqual([{ id: 2, total: 25 }]);
    expect(workflow.activeTable.value.current_order_id).toBe(88);
  });

  it.each(['http', 'shape', 'success'])('preserves unpaid checks after a %s failure and supports retry', async kind => {
    const { workflow, complete, ui } = harness();
    const first = workflow.fetchTableSplits();
    await Promise.resolve(); complete(0, 1); await first;
    const failed = workflow.fetchTableSplits();
    await Promise.resolve();
    complete(1, 2, kind === 'http' ? { response: { ok: false } } : { data: { success: kind !== 'success', data: null } });
    expect(await failed).toBe(false);
    expect(workflow.tableSplitsList.value).toEqual([{ id: 1, total: 25 }]);
    expect(ui.tableSplitsError).not.toBe('');
    const retry = workflow.fetchTableSplits();
    await Promise.resolve(); complete(2, 3);
    expect(await retry).toBe(true);
    expect(ui.tableSplitsError).toBe('');
  });

  it('releases a failed request and allows the queued recovery to finish', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { workflow, api, pending, complete } = harness();
    const first = workflow.fetchTableSplits();
    const recovery = workflow.fetchTableSplits();
    await Promise.resolve(); pending[0].reject(new Error('Lost connection'));
    expect(await first).toBe(false);
    await vi.waitFor(() => expect(api.getTableSplits).toHaveBeenCalledTimes(2));
    complete(1, 4);
    expect(await recovery).toBe(true);
    expect(workflow.tableSplitsList.value[0].id).toBe(4);
  });
});

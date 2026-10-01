const pool = require('../../config/db');
const cache = require('../../config/cache');
const fs = require('node:fs');
const path = require('node:path');
const { broadcastTableUpdate, broadcastTableUpdates, staffTableRooms, broadcastTableDraftChanged } = require('../../services/TableRealtime');

describe('TableRealtime', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits the canonical staff table_update payload for one table', async () => {
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    vi.spyOn(pool, 'query').mockResolvedValue([[{ id: 7, section_id: 2, status: 'available' }]]);
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');

    await broadcastTableUpdate(io, 7);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
    expect(io.to).toHaveBeenCalledWith(['table-access:all', 'table-access:section:2']);
    expect(emit).toHaveBeenCalledWith('table_update', {
      action: 'update_single_table',
      table: { id: 7, section_id: 2, status: 'available' }
    });
  });

  it('deduplicates multi-table IDs and emits one event per returned row', async () => {
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    const query = vi.spyOn(pool, 'query').mockResolvedValue([[{ id: 1 }, { id: 2 }]]);
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');

    await broadcastTableUpdates(io, [2, 1, 2]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]);
    expect(query.mock.calls[0][1]).toEqual([2, 1]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('derives trusted content rooms from session grants and assigned sections', () => {
    expect(staffTableRooms({ role: 'waiter', table_access_scope: 'selected', allowed_sections: '2,1,2' })).toEqual(['table-access:section:2', 'table-access:section:1']);
    expect(staffTableRooms({ role: 'waiter', allowed_sections: null })).toEqual([]);
    expect(staffTableRooms({ role: 'cashier', permissions: [] })).toEqual([]);
    expect(staffTableRooms({ role: 'cashier', table_access_scope: 'all', permissions: ['pos.checkout'] })).toEqual(['table-access:all']);
    expect(staffTableRooms({ role: 'call_center', permissions: ['tables.access'], allowed_sections: '1' })).toEqual([]);
  });

  it('publishes a draft notification to its section using the already-locked seat when provided', async () => {
    const emit = vi.fn(), io = { to: vi.fn(() => ({ emit })) };
    const query = vi.spyOn(pool, 'query').mockResolvedValue([[{ section_id: 2 }]]);
    await broadcastTableDraftChanged(io, 7, 1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(io.to).toHaveBeenCalledWith(['table-access:all', 'table-access:section:2']);
    await broadcastTableDraftChanged(io, 7, 0, 2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith('table_draft_changed', { tableId: 7, itemCount: 0 });
  });

  it('does nothing for empty input', async () => {
    const io = { to: vi.fn() };
    const query = vi.spyOn(pool, 'query');
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');

    await broadcastTableUpdates(io, []);

    expect(query).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates before a failed snapshot query', async () => {
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('database reset'));
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');

    await broadcastTableUpdate(io, 7);

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does nothing without io', async () => {
    const query = vi.spyOn(pool, 'query');
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');
    await broadcastTableUpdate(null, 7);
    expect(query).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('allows the status-only publisher to skip dashboard invalidation', async () => {
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    vi.spyOn(pool, 'query').mockResolvedValue([[{ id: 7, status: 'printed' }]]);
    const invalidate = vi.spyOn(cache, 'invalidateDashboardCache');

    await broadcastTableUpdates(io, [7], { invalidateDashboard: false });

    expect(invalidate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keeps markTablePrinted as the only production invalidation opt-out', () => {
    const backendRoot = path.join(process.cwd(), 'backend');
    const matches = [];
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'tests') walk(fullPath);
        } else if (entry.name.endsWith('.js')
          && fs.readFileSync(fullPath, 'utf8').includes('invalidateDashboard: false')) {
          matches.push(fullPath);
        }
      }
    };
    walk(backendRoot);
    expect(matches).toEqual([path.join(backendRoot, 'modules', 'tables', 'markTablePrinted.js')]);
  });
});

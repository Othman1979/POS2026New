const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');

const manager = require('../../services/printTemplateManager');

function revision(overrides = {}) {
    return {
        id: 11,
        template_id: 1,
        revision_no: 1,
        schema_version: 1,
        definition_json: JSON.stringify(getBuiltinTemplate('receipt')),
        definition_hash: 'a'.repeat(64),
        created_at: '2026-07-26 10:00:00',
        created_by_name: 'Admin',
        last_compile_error_code: null,
        last_compile_error_message: null,
        last_compile_failed_at: null,
        ...overrides
    };
}

function trackedExecutor(responses = []) {
    const calls = [];
    return {
        calls,
        async query(sql, values = []) {
            calls.push({ sql, values });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next === undefined ? [[]] : next;
        },
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn()
    };
}

describe('print template manager', () => {
    it('resolves the builtin template when no custom revision is active', async () => {
        const db = trackedExecutor([[[{
            printer_id: 3, printer_role: 'receipt', printer_is_active: 1,
            active_endpoint_key: 'receipt:windows:primary:counter', active_revision_id: null,
            revision_id: null, revision_no: null, definition_json: null, confirmed_at: null
        }]]]);

        const result = await manager.resolveActiveTemplate(db, 'receipt', {
            printerId: 3,
            storeInfo: { receipt_config: '{}' }
        });

        expect(result).toMatchObject({ kind: 'builtin', id: null, templateRevisionId: 'builtin:receipt-v1' });
        expect(result.definition).toEqual(getBuiltinTemplate('receipt', { storeInfo: { receipt_config: '{}' } }));
        expect(db.calls).toHaveLength(1);
        expect(db.calls[0].sql).toContain('active_endpoint_key');
    });

    it('uses the globally active custom revision for a valid matching printer without test proof', async () => {
        const custom = getBuiltinTemplate('receipt');
        custom.bands[0].nodes[0].label.en = 'Custom Store';
        const db = trackedExecutor([[[{
            printer_id: 3, printer_role: 'receipt', printer_is_active: 1,
            active_endpoint_key: 'receipt:windows:primary:counter', active_revision_id: 11,
            revision_id: 11, revision_no: 4, definition_json: JSON.stringify(custom)
        }]]]);

        const result = await manager.resolveActiveTemplate(db, 'receipt', { printerId: 3, storeInfo: { receipt_config: '{}' } });

        expect(result).toMatchObject({ kind: 'custom', id: 11, revisionNo: 4, templateRevisionId: 11 });
        expect(result.definition.bands[0].nodes[0].label.en).toBe('Custom Store');
        expect(db.calls[0].sql).not.toContain('print_template_revision_tests');
    });

    it('records custom compiler diagnostics without mutating the saved definition', async () => {
        const custom = getBuiltinTemplate('receipt');
        const db = trackedExecutor([[[{
            printer_id: 3, printer_role: 'receipt', printer_is_active: 1,
            active_endpoint_key: 'receipt:windows:primary:counter', active_revision_id: 11,
            revision_id: 11, revision_no: 4, definition_json: JSON.stringify(custom)
        }]], [[]]]);

        const resolved = await manager.resolveActiveTemplate(db, 'receipt', { printerId: 3, storeInfo: { receipt_config: '{}' } });
        const fallback = await resolved.fallback(Object.assign(new Error('bad expansion'), { code: 'TEMPLATE_EXPANSION_LIMIT' }));

        expect(fallback).toMatchObject({ kind: 'builtin', templateRevisionId: 'builtin:receipt-v1' });
        const update = db.calls.find(call => /UPDATE print_template_revisions/i.test(call.sql));
        expect(update.values).toEqual(['TEMPLATE_EXPANSION_LIMIT', 'bad expansion', 11]);
        expect(update.sql).not.toContain('definition_json');
    });

    it('rejects malformed definitions before opening a transaction', async () => {
        const db = trackedExecutor();

        await expect(manager.saveTemplateRevision(db, {
            docType: 'receipt', definition: { docType: 'receipt' }, expectedLockVersion: 0
        })).rejects.toMatchObject({ code: 'TEMPLATE_SCHEMA_INVALID' });

        expect(db.beginTransaction).not.toHaveBeenCalled();
        expect(db.calls).toEqual([]);
    });

    it('reports stale saves as a named optimistic-lock conflict', async () => {
        const db = trackedExecutor([[[{ id: 1, lock_version: 2 }]]]);

        await expect(manager.saveTemplateRevision(db, {
            docType: 'receipt', definition: getBuiltinTemplate('receipt'), expectedLockVersion: 1
        })).rejects.toMatchObject({ code: 'PRINT_TEMPLATE_CONFLICT', statusCode: 409 });

        expect(db.beginTransaction).toHaveBeenCalledOnce();
        expect(db.rollback).toHaveBeenCalledOnce();
        expect(db.calls[0].sql).toContain('FOR UPDATE');
    });

    it('refuses to activate a revision whose definition no longer validates', async () => {
        const definition = getBuiltinTemplate('receipt');
        const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
        items.nodes = items.nodes.filter(node => node.path !== 'note');
        const db = trackedExecutor([
            [[{ id: 1, active_revision_id: null, lock_version: 1 }]],
            [[{ id: 11, definition_json: JSON.stringify(definition) }]]
        ]);

        await expect(manager.activateTemplateRevision(db, {
            docType: 'receipt', revisionId: 11, reason: 'test', expectedLockVersion: 1
        })).rejects.toMatchObject({ code: 'TEMPLATE_REQUIRED_STRUCTURE_MISSING' });
        expect(db.calls.some(call => /UPDATE print_templates/i.test(call.sql))).toBe(false);
    });

    it('saves an immutable revision once and reuses the same hash thereafter', async () => {
        const db = trackedExecutor([
            [[{ id: 1, lock_version: 0 }]],
            [[]],
            [[{ revision_no: 1 }]],
            [{ insertId: 22 }],
            [[]],
            [[{ id: 1, lock_version: 1 }]],
            [[revision({ id: 22 })]],
            [[]]
        ]);

        const result = await manager.saveTemplateRevision(db, {
            docType: 'receipt', definition: getBuiltinTemplate('receipt'), expectedLockVersion: 0,
            userId: 1, ipAddress: '127.0.0.1'
        });

        expect(result).toMatchObject({ id: 22, revisionNo: 1, lockVersion: 1, reused: false });
        expect(db.calls.some(call => /INSERT INTO print_template_revisions/i.test(call.sql))).toBe(true);
        expect(db.calls.some(call => /UPDATE print_templates\s+SET draft_revision_id/i.test(call.sql))).toBe(true);
        expect(db.commit).toHaveBeenCalledOnce();
    });

    it('keeps workspace coverage set-based and history bounded', async () => {
        const db = trackedExecutor([
            [[{ id: 1, document_type: 'receipt', active_revision_id: 11, draft_revision_id: 11, lock_version: 2 }]],
            [[revision()]],
            [[{ id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter', revision_id: 11, confirmed_at: '2026-07-26 10:00:00', spooler_version: '1.2.0' }]],
            [[{ id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter' }]]
        ]);

        const workspace = await manager.getTemplateWorkspace(db, 'receipt');

        expect(workspace.active).toMatchObject({ kind: 'custom', id: 11 });
        expect(workspace.revisions).toHaveLength(1);
        expect(db.calls.some(call => /LIMIT 50/i.test(call.sql))).toBe(true);
        const coverageQuery = db.calls.find(call => /FROM print_template_revision_tests/i.test(call.sql));
        expect(coverageQuery.sql).toContain('NOT EXISTS');
        expect(db.calls).toHaveLength(5);
    });

    it('recognizes a confirmed endpoint even when a newer confirmation belongs to an old endpoint', async () => {
        const db = trackedExecutor([
            [[{ id: 1, document_type: 'receipt', active_revision_id: 11, draft_revision_id: 11, lock_version: 2 }]],
            [[revision()]],
            [[
                { id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter', revision_id: 11, printer_endpoint_key: 'receipt:windows:secondary:counter', confirmed_at: '2026-07-26 11:00:00', spooler_version: '1.2.0' },
                { id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter', revision_id: 11, printer_endpoint_key: 'receipt:windows:primary:counter', confirmed_at: '2026-07-26 10:00:00', spooler_version: '1.2.0' }
            ]],
            [[{ id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter' }]],
            [[]]
        ]);

        const workspace = await manager.getTemplateWorkspace(db, 'receipt');

        expect(workspace.revisions[0].printerCoverage).toEqual([expect.objectContaining({ id: 3, tested: true, confirmedAt: '2026-07-26 10:00:00' })]);
    });

    it('keeps old custom active and draft revisions visible beyond the 50-row history window', async () => {
        const history = Array.from({ length: 50 }, (_, index) => revision({
            id: 52 - index,
            revision_no: 52 - index
        }));
        const active = revision({ id: 1, revision_no: 1 });
        const draft = revision({ id: 2, revision_no: 2 });
        const db = trackedExecutor([
            [[{ id: 1, document_type: 'receipt', active_revision_id: 1, draft_revision_id: 2, lock_version: 52 }]],
            [history],
            [[active, draft]],
            [[
                { revision_id: 1, id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter', printer_endpoint_key: 'receipt:windows:primary:counter', confirmed_at: '2026-07-26 10:00:00', spooler_version: '1.2.0' },
                { revision_id: 2, id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter', printer_endpoint_key: 'receipt:windows:primary:counter', confirmed_at: '2026-07-26 10:00:00', spooler_version: '1.2.0' }
            ]],
            [[{ id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter' }]],
            [[]]
        ]);

        const workspace = await manager.getTemplateWorkspace(db, 'receipt');

        expect(workspace.active).toMatchObject({ kind: 'custom', id: 1, revisionNo: 1 });
        expect(workspace.draft).toMatchObject({ kind: 'custom', id: 2, revisionNo: 2 });
        expect(workspace.active.printerCoverage).toEqual([expect.objectContaining({ id: 3, tested: true })]);
        expect(workspace.draft.printerCoverage).toEqual([expect.objectContaining({ id: 3, tested: true })]);
        expect(workspace.revisions).toHaveLength(52);
        expect(db.calls.filter(call => /WHERE r\.template_id = \? AND r\.id IN/i.test(call.sql))).toHaveLength(1);
    });

    it('loads receipt_config once for builtin workspace resolution', async () => {
        const db = trackedExecutor([
            [[{ id: 1, document_type: 'receipt', active_revision_id: null, draft_revision_id: null, lock_version: 0 }]],
            [[]],
            [[{ id: 3, name: 'Counter', role: 'receipt', active_endpoint_key: 'receipt:windows:primary:counter' }]],
            [[{ setting_value: JSON.stringify({ layout: ['payment', 'header', 'items', 'totals', 'meta', 'footer'] }) }]]
        ]);

        const workspace = await manager.getTemplateWorkspace(db, 'receipt');

        expect(workspace.active).toMatchObject({ kind: 'builtin', id: null });
        expect(workspace.active.definition.bands.map(band => band.id)).toEqual([
            'payment', 'header', 'items-header', 'items', 'items-divider', 'totals', 'meta', 'jofotara', 'footer'
        ]);
        expect(db.calls.filter(call => /setting_key = 'receipt_config'/i.test(call.sql))).toHaveLength(1);
    });

    it('reuses an older identical definition without inserting a mutable duplicate', async () => {
        const db = trackedExecutor([
            [[{ id: 1, lock_version: 0 }]],
            [[{ id: 9, revision_no: 2 }]],
            [[]],
            [[]],
            [[]]
        ]);

        const result = await manager.saveTemplateRevision(db, {
            docType: 'receipt', definition: getBuiltinTemplate('receipt'), expectedLockVersion: 0, userId: 1
        });

        expect(result).toMatchObject({ id: 9, revisionNo: 2, reused: true });
        expect(db.calls.some(call => /INSERT INTO print_template_revisions/i.test(call.sql))).toBe(false);
        expect(db.commit).toHaveBeenCalledOnce();
    });
});

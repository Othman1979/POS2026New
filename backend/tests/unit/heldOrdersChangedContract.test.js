import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HELD_ORDER_ACTIONS, heldOrdersChangedPayload } = require('../../services/HeldOrderEvents');

const ALLOWED_ACTIONS = ['created', 'updated', 'claimed', 'released', 'fired', 'settled', 'removed', 'cleared'];

describe('held_orders_changed event contract', () => {
    it('builds the shared payload with coerced ids, nulls and extra fields', () => {
        expect(heldOrdersChangedPayload('updated', { id: '7', table_id: null, parent_invoice_id: '42' }))
            .toEqual({ action: 'updated', held_order_id: 7, table_id: null, parent_invoice_id: 42 });
        expect(heldOrdersChangedPayload('cleared'))
            .toEqual({ action: 'cleared', held_order_id: null, table_id: null, parent_invoice_id: null });
        expect(heldOrdersChangedPayload('created', { id: 3, table_id: null, parent_invoice_id: null }, { source: 'call_center' }))
            .toEqual({ action: 'created', held_order_id: 3, table_id: null, parent_invoice_id: null, source: 'call_center' });
        expect(() => heldOrdersChangedPayload('bogus')).toThrow('Unknown held order action');
        expect(HELD_ORDER_ACTIONS).toEqual(ALLOWED_ACTIONS);
    });
});
